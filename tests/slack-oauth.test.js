import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

// Self-serve "Sign in with Slack" in STUB mode (no real Slack app): proves the
// full flow — consent URL, signed state, callback that auto-creates the user,
// mints our JWT, stores the workspace bot token, and enqueues backfill.
function baseConfig(dataDir) {
  return {
    dataDir,
    embeddingProvider: 'hash',
    embeddingDim: 768,
    enabledSources: ['email', 'slack', 'google_drive'],
    openaiApiKey: '',
    embeddingModel: 'test',
    auth: { required: false, token: '' },
    identity: { mode: 'jwt', jwtSecret: 'oauth-secret', jwtIssuer: '', jwtAudience: '', tenantKeys: {} },
    onboarding: { adminToken: '', tokenTtlSeconds: 3600 },
    cors: { origins: [] },
    sourcePermissions: {},
    connectorTokens: {},
    syncRetry: { maxAttempts: 1, baseDelayMs: 1 },
    retention: { documentDays: 90, operationalDays: 30, auditDays: 90 },
    search: { vectorWeight: 0.72, lexicalWeight: 0.22, recencyWeight: 0.06, candidateMultiplier: 5 },
    postgres: { connectionString: '', ssl: false },
    serviceBus: { connectionString: '', syncQueueName: 'q' },
    artifacts: { azureStorageConnectionString: '', container: 'c', publicBaseUrl: '' },
    slack: {
      botToken: '', channelIds: [], limit: 10, signingSecret: '', eventTenantId: '', eventUserId: '',
      oauth: { clientId: '', clientSecret: '', redirectUri: '', scopes: ['channels:history'], userScopes: ['openid'], postLoginRedirect: '' },
    },
    gdrive: { clientId: '', clientSecret: '', refreshToken: '', serviceAccountJson: '', folderIds: [], limit: 10, webhookToken: '', webhookChannelIds: [], eventTenantId: '', eventUserId: '' },
    email: { baseUrl: '', sessionId: '', limit: 10 },
    conference: { azureStorageConnectionString: '', containers: [], eventGridToken: '', eventTenantId: '', eventUserId: '' },
    knowledgeBase: { root: '' },
    dataFabric: { baseUrl: '', apiToken: '', readinessPath: '/health', recordsPath: '/records' },
  };
}

async function withServer(config, fn) {
  const app = await createApp(config);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('slack oauth start returns a Slack consent URL + signed state (stub mode)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-oauth-'));
  try {
    await withServer(baseConfig(dir), async (base) => {
      const res = await fetch(`${base}/v1/onboarding/oauth/slack/start`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.authorizeUrl.startsWith('https://slack.com/oauth/v2/authorize'), 'points at Slack consent');
      assert.ok(data.state && data.state.includes('.'), 'a signed state is issued');
      assert.equal(data.stub, true, 'no real app → stub mode');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('slack oauth callback auto-logs-in: creates user, mints JWT, connects, enqueues backfill', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-oauth2-'));
  try {
    await withServer(baseConfig(dir), async (base) => {
      const start = await (await fetch(`${base}/v1/onboarding/oauth/slack/start`)).json();
      // Stub code carries the identity: stub:<team>:<user>:<email>
      const code = 'stub:T123:U456:ada@acme.test';
      const cb = await fetch(`${base}/v1/onboarding/oauth/slack/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(start.state)}`);
      assert.equal(cb.status, 200);
      const data = await cb.json();
      assert.equal(data.tenantId, 'slack:T123', 'workspace maps to a tenant');
      assert.equal(data.userId, 'U456', 'authed user becomes the platform user');
      assert.ok(data.token, 'a session JWT is minted (auto-login)');
      assert.equal(data.connected, 'slack');
      assert.ok(data.backfillJobId, 'backfill (vectorization) is auto-enqueued');

      // The minted token works AND the workspace bot token now resolves for this user.
      const list = (await (await fetch(`${base}/v1/connectors`, {
        headers: { Authorization: `Bearer ${data.token}` },
      })).json()).connectors;
      assert.equal(list.find((c) => c.source === 'slack').configured, true, 'slack configured via workspace token');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('slack oauth callback rejects a forged/missing state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-oauth3-'));
  try {
    await withServer(baseConfig(dir), async (base) => {
      const forged = await fetch(`${base}/v1/onboarding/oauth/slack/callback?code=stub:T1:U1&state=not.valid`);
      assert.equal(forged.status, 400, 'forged state must be rejected');
      const missing = await fetch(`${base}/v1/onboarding/oauth/slack/callback?code=stub:T1:U1`);
      assert.equal(missing.status, 400, 'missing state must be rejected');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('repeat login for the same Slack user is idempotent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-oauth4-'));
  try {
    await withServer(baseConfig(dir), async (base) => {
      const code = 'stub:T9:U9:u9@acme.test';
      const once = await (await fetch(`${base}/v1/onboarding/oauth/slack/start`)).json();
      const r1 = await fetch(`${base}/v1/onboarding/oauth/slack/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(once.state)}`);
      assert.equal(r1.status, 200);
      const twice = await (await fetch(`${base}/v1/onboarding/oauth/slack/start`)).json();
      const r2 = await fetch(`${base}/v1/onboarding/oauth/slack/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(twice.state)}`);
      assert.equal(r2.status, 200, 'second login must not 500 on existing tenant/user');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
