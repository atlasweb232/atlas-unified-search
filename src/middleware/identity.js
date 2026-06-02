import { createHmac, timingSafeEqual } from 'node:crypto';

// Identity-bound tenancy (002 M5).
//
// Three modes, selected by IDENTITY_MODE:
//   - shared_token : legacy. No binding; scope is trusted from the request body
//                    /query. NOT multi-tenant-safe (reported as such by
//                    production-readiness). Preserves existing behaviour.
//   - jwt          : verify an HS256 bearer token; tenantId/userId/allowedSources
//                    come from verified claims. Spoofed scope is rejected.
//   - api_key      : per-tenant API key (IDENTITY_TENANT_KEYS_JSON) binds the
//                    caller to a tenant; the user must be in that tenant's list.
//
// The middleware attaches `req.identity`:
//   { mode, bound, tenantId, userId, allowedSources }
// `bound: true` means scope is verified and authoritative. Routes derive scope
// via deriveScope()/scopeOf() and reject any mismatching explicit IDs.

export function resolveIdentity(config) {
  const mode = config.identity?.mode || 'shared_token';
  return (req, res, next) => {
    if (isExempt(req.path)) return next();
    if (req.path === '/v1/auth/refresh') return next();
    if (!req.path.startsWith('/v1/')) return next();

    try {
      if (mode === 'jwt') {
        req.identity = identityFromJwt(req, config);
      } else if (mode === 'api_key') {
        req.identity = identityFromApiKey(req, config);
      } else {
        // shared_token / unknown → unbound, request-trusted scope (legacy).
        req.identity = { mode: 'shared_token', bound: false };
      }
    } catch (error) {
      return res.status(401).json({ success: false, error: error.message || 'Unauthorized' });
    }
    return next();
  };
}

// Uniform enforcement across every /v1 route: for a bound identity, reject any
// explicit tenantId/userId (body or query) that contradicts the verified scope,
// then inject the verified scope so routes are bound even if IDs were omitted.
// New routes inherit isolation automatically — no per-route wiring.
export function enforceTenantScope() {
  return (req, res, next) => {
    if (isExempt(req.path) || req.path === '/v1/auth/refresh' || !req.path.startsWith('/v1/')) return next();
    const id = req.identity;
    if (!id || !id.bound) return next();

    for (const field of ['tenantId', 'userId']) {
      const verified = field === 'tenantId' ? id.tenantId : id.userId;
      const bodyVal = req.body && !Array.isArray(req.body) ? req.body[field] : undefined;
      const queryVal = req.query ? req.query[field] : undefined;
      if (bodyVal && bodyVal !== verified) return forbid(res, field);
      if (queryVal && queryVal !== verified) return forbid(res, field);
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      req.body.tenantId = id.tenantId;
      req.body.userId = id.userId;
    }
    if (req.query && typeof req.query === 'object') {
      req.query.tenantId = id.tenantId;
      req.query.userId = id.userId;
    }
    return next();
  };
}

function forbid(res, field) {
  return res.status(403).json({ success: false, error: `Forbidden: ${field} scope mismatch` });
}

function isExempt(path) {
  return path === '/v1/health'
    || path.startsWith('/v1/onboarding/')
    || path === '/v1/webhooks/slack/events'
    || path === '/v1/webhooks/google-drive/changes'
    || path === '/v1/webhooks/azure-blob/events';
}

// ─── scope helpers used by routes ───────────────────────────────────────────────

// Authoritative scope for a request. For bound identities the verified claims
// win; for shared_token it falls back to caller-supplied values.
export function scopeOf(req, provided = {}) {
  const id = req.identity || {};
  if (id.bound) return { tenantId: id.tenantId, userId: id.userId };
  return {
    tenantId: provided.tenantId || req.query?.tenantId || req.headers?.['x-tenant-id'] || '',
    userId: provided.userId || req.query?.userId || req.headers?.['x-user-id'] || '',
  };
}

// Derive scope and reject an explicit tenantId/userId that contradicts a bound
// identity. Returns the scope, or null after sending a 403 (caller returns).
export function deriveScope(req, res, provided = {}) {
  const id = req.identity || {};
  if (id.bound) {
    if (provided.tenantId && provided.tenantId !== id.tenantId) {
      res.status(403).json({ success: false, error: 'Forbidden: tenant scope mismatch' });
      return null;
    }
    if (provided.userId && provided.userId !== id.userId) {
      res.status(403).json({ success: false, error: 'Forbidden: user scope mismatch' });
      return null;
    }
    return { tenantId: id.tenantId, userId: id.userId };
  }
  return { tenantId: provided.tenantId || '', userId: provided.userId || '' };
}

// Allowed sources entitled by the identity (jwt claim), else undefined (no extra
// restriction beyond the existing source-permission config).
export function allowedSourcesOf(req) {
  return req.identity?.allowedSources;
}

// ─── jwt mode ────────────────────────────────────────────────────────────────────

function identityFromJwt(req, config) {
  const secret = config.identity?.jwtSecret;
  if (!secret) throw new Error('IDENTITY_JWT_SECRET is required for jwt mode');
  const token = bearer(req);
  if (!token) throw new Error('Missing bearer token');
  const claims = verifyJwtHS256(token, secret);

  if (config.identity.jwtIssuer && claims.iss !== config.identity.jwtIssuer) {
    throw new Error('Invalid token issuer');
  }
  if (config.identity.jwtAudience && claims.aud !== config.identity.jwtAudience) {
    throw new Error('Invalid token audience');
  }
  const tenantId = claims.tenantId || claims.tid || '';
  const userId = claims.userId || claims.sub || '';
  if (!tenantId || !userId) throw new Error('Token missing tenantId/userId');

  const allowedSources = Array.isArray(claims.sources) ? claims.sources
    : Array.isArray(claims.allowedSources) ? claims.allowedSources
      : undefined;
  return { mode: 'jwt', bound: true, tenantId, userId, allowedSources };
}

export function verifyJwtHS256Internal(token, secret) {
  return verifyJwtHS256(token, secret);
}

function verifyJwtHS256(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [header, payload, signature] = parts;
  const head = JSON.parse(b64urlToString(header));
  if (head.alg !== 'HS256') throw new Error('Unsupported token algorithm');

  const expected = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  if (!constantTimeEquals(signature, expected)) throw new Error('Invalid token signature');

  const claims = JSON.parse(b64urlToString(payload));
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now > Number(claims.exp)) throw new Error('Token expired');
  if (claims.nbf && now < Number(claims.nbf)) throw new Error('Token not yet valid');
  return claims;
}

// ─── api_key mode ──────────────────────────────────────────────────────────────

function identityFromApiKey(req, config) {
  const presented = req.headers['x-api-key'] || bearer(req);
  if (!presented) throw new Error('Missing API key');
  const userId = req.headers['x-user-id'] || '';
  if (!userId) throw new Error('Missing x-user-id');

  const tenantKeys = config.identity?.tenantKeys || {};
  for (const [tenantId, entry] of Object.entries(tenantKeys)) {
    if (entry && typeof entry.key === 'string' && constantTimeEquals(presented, entry.key)) {
      const users = Array.isArray(entry.users) ? entry.users : [];
      if (users.length && !users.includes(userId)) {
        throw new Error('User not permitted for this tenant');
      }
      const allowedSources = Array.isArray(entry.sources) ? entry.sources : undefined;
      return { mode: 'api_key', bound: true, tenantId, userId, allowedSources };
    }
  }
  throw new Error('Invalid API key');
}

// ─── primitives ──────────────────────────────────────────────────────────────────

function bearer(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

function b64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToString(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function constantTimeEquals(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

// Mint an HS256 token. Used by onboarding to issue identity-bound user tokens,
// and by the credential-free test suite. Raw claims are signed as-is.
export function signJwtHS256(claims, secret) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

// Issue an identity-bound user token from onboarding: stamps iat/exp (and
// optional iss/aud) so the verifier accepts it and it expires. tenantId/userId
// are the verified scope; `sources` becomes the allowed-source entitlement.
export function mintIdentityToken({ tenantId, userId, sources, ttlSeconds = 3600, issuer = '', audience = '' }, secret) {
  if (!secret) throw new Error('IDENTITY_JWT_SECRET is required to mint identity tokens');
  if (!tenantId || !userId) throw new Error('tenantId and userId are required to mint a token');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    tenantId,
    userId,
    sub: userId,
    tid: tenantId,
    iat: now,
    exp: now + Math.max(60, Number(ttlSeconds) || 3600),
    ...(Array.isArray(sources) && sources.length ? { sources } : {}),
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
  };
  return { token: signJwtHS256(claims, secret), expiresAt: new Date(claims.exp * 1000).toISOString() };
}
