import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Google Drive "Sign in with Google" OAuth. Same pattern as Slack:
// - start: build consent URL + signed state
// - callback: exchange code → tokens + identity → auto-create user, mint JWT,
//   store refresh token tenant-wide, auto-enqueue backfill.
// STUB mode when clientId/clientSecret absent: code = `stub:<email>:<name>`.

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export function isStubMode(config) {
  return !(config.gdrive?.clientId && config.gdrive?.clientSecret);
}

export function buildAuthorizeUrl({ config, state }) {
  const params = new URLSearchParams({
    client_id: config.gdrive?.clientId || 'STUB_CLIENT_ID',
    redirect_uri: config.gdrive?.oauth?.redirectUri || '',
    response_type: 'code',
    scope: (config.gdrive?.oauth?.scopes || []).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ─── signed state ─────────────────────────────────────────────────────────────

export function signState(payload, secret, ttlSeconds = 600) {
  if (!secret) throw new Error('IDENTITY_JWT_SECRET is required for OAuth state');
  const body = { ...payload, nonce: randomBytes(8).toString('hex'), exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyState(state, secret) {
  const [encoded, sig] = String(state || '').split('.');
  if (!encoded || !sig) throw new Error('Malformed OAuth state');
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid OAuth state signature');
  const body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (body.exp && Math.floor(Date.now() / 1000) > body.exp) throw new Error('OAuth state expired');
  return body;
}

// ─── code → tokens + identity ─────────────────────────────────────────────────

export async function exchangeCode({ config, code }) {
  if (isStubMode(config)) return stubExchange(code);

  const params = new URLSearchParams({
    code,
    client_id: config.gdrive.clientId,
    client_secret: config.gdrive.clientSecret,
    redirect_uri: config.gdrive.oauth.redirectUri,
    grant_type: 'authorization_code',
  });
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokens.error) throw new Error(`Google token exchange failed: ${tokens.error || tokenRes.statusText}`);

  const userRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const user = await userRes.json().catch(() => ({}));

  return {
    refreshToken: tokens.refresh_token || '',
    accessToken: tokens.access_token || '',
    email: user.email || '',
    name: user.name || '',
    googleUserId: user.id || '',
    stub: false,
  };
}

function stubExchange(code) {
  const parts = String(code || '').split(':');
  const [, email = 'stub@gdrive.test', name = 'Stub User'] = parts;
  const googleUserId = `g-${Buffer.from(email).toString('hex').slice(0, 12)}`;
  return { refreshToken: 'stub-refresh-token', accessToken: 'stub-access-token', email, name, googleUserId, stub: true };
}
