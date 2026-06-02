import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Slack "Sign in with Slack" + bot-install OAuth, self-serve (no admin token).
//
// One platform-wide Slack app (clientId/clientSecret) serves every workspace.
// A workspace ≈ a tenant: the install yields a workspace bot token (stored
// tenant-wide) and the authed user becomes a platform user. When clientId/secret
// are empty, exchangeCode runs in STUB mode so the whole flow is testable with
// no real Slack app — the `code` carries the identity: `stub:<team>:<user>:<email>`.

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const ACCESS_URL = 'https://slack.com/api/oauth.v2.access';

export function isStubMode(config) {
  const oauth = config.slack?.oauth || {};
  return !(oauth.clientId && oauth.clientSecret);
}

export function buildAuthorizeUrl({ config, state }) {
  const oauth = config.slack?.oauth || {};
  const params = new URLSearchParams({
    client_id: oauth.clientId || 'STUB_CLIENT_ID',
    scope: (oauth.scopes || []).join(','),
    user_scope: (oauth.userScopes || []).join(','),
    state,
  });
  if (oauth.redirectUri) params.set('redirect_uri', oauth.redirectUri);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ─── signed state (CSRF + carries tenant hint + expiry) ──────────────────────

export function signState(payload, secret, ttlSeconds = 600) {
  if (!secret) throw new Error('A signing secret (IDENTITY_JWT_SECRET) is required for OAuth state');
  const body = {
    ...payload,
    nonce: randomBytes(8).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyState(state, secret) {
  const [encoded, sig] = String(state || '').split('.');
  if (!encoded || !sig) throw new Error('Malformed OAuth state');
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid OAuth state signature');
  const body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (body.exp && Math.floor(Date.now() / 1000) > body.exp) throw new Error('OAuth state expired');
  return body;
}

// ─── code → tokens + identity ────────────────────────────────────────────────

export async function exchangeCode({ config, code }) {
  if (isStubMode(config)) return stubExchange(code);

  const oauth = config.slack.oauth;
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    code,
  });
  if (oauth.redirectUri) params.set('redirect_uri', oauth.redirectUri);

  const response = await fetch(ACCESS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(`Slack OAuth exchange failed: ${data.error || response.statusText}`);
  }
  return {
    botToken: data.access_token || '',
    teamId: data.team?.id || '',
    teamName: data.team?.name || '',
    slackUserId: data.authed_user?.id || '',
    email: '', // populated below via users.identity if openid scope granted
    raw: data,
  };
}

// Stub identity encoded in the code: `stub:<teamId>:<userId>:<email>`.
// Missing parts default deterministically so a bare code still works.
function stubExchange(code) {
  const parts = String(code || '').split(':');
  const [, teamId = 'T-STUB', slackUserId = 'U-STUB', email = ''] = parts;
  return {
    botToken: `xoxb-stub-${teamId}`,
    teamId,
    teamName: `Workspace ${teamId}`,
    slackUserId,
    email: email || `${slackUserId}@${teamId}.slack.test`.toLowerCase(),
    stub: true,
    raw: { ok: true, stub: true },
  };
}

// Channels the bot can read. Stub returns a demo channel so backfill has a target;
// real mode lists channels the bot is a member of (channels:read scope).
export async function discoverChannels({ config, botToken, stub }) {
  if (stub || isStubMode(config)) return ['C-DEMO'];
  try {
    // List all public channels, join any we're not yet a member of, return all ids.
    const channels = await paginateChannels(botToken);
    await Promise.allSettled(
      channels.filter((c) => !c.is_member).map((c) => joinChannel(botToken, c.id)),
    );
    return channels.map((c) => c.id);
  } catch {
    return [];
  }
}

async function paginateChannels(botToken) {
  const channels = [];
  let cursor = '';
  do {
    const url = new URL('https://slack.com/api/conversations.list');
    url.searchParams.set('types', 'public_channel');
    url.searchParams.set('limit', '200');
    url.searchParams.set('exclude_archived', 'true');
    if (cursor) url.searchParams.set('cursor', cursor);
    const data = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } })
      .then((r) => r.json()).catch(() => ({}));
    if (!data.ok) break;
    channels.push(...(data.channels || []));
    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);
  return channels;
}

async function joinChannel(botToken, channelId) {
  await fetch('https://slack.com/api/conversations.join', {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId }),
  });
}
