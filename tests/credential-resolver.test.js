import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

function baseConfig(dataDir, extra = {}) {
  return {
    dataDir,
    embeddingProvider: 'hash',
    embeddingDim: 768,
    enabledSources: ['email', 'slack', 'google_drive'],
    openaiApiKey: '',
    embeddingModel: 'test',
    auth: { required: false, token: '' },
    identity: { mode: 'jwt', jwtSecret: 'resolver-secret', jwtIssuer: '', jwtAudience: '', tenantKeys: {} },
    onboarding: { adminToken: 'admin-secret', tokenTtlSeconds: 3600 },
    cors: { origins: [] },
    sourcePermissions: {},
    connectorTokens: {},
    syncRetry: { maxAttempts: 1, baseDelayMs: 1 },
    retention: { documentDays: 90, operationalDays: 30, auditDays: 90 },
    search: { vectorWeight: 0.72, lexicalWeight: 0.22, recencyWeight: 0.06, candidateMultiplier: 5 },
    postgres: { connectionString: '', ssl: false },
    serviceBus: { connectionString: '', syncQueueName: 'q' },
    artifacts: { azureStorageConnectionString: '', container: 'c', publicBaseUrl: '' },
    slack: { botToken: '', channelIds: [], limit: 10, signingSecret: '', eventTenantId: '', eventUserId: '' },
    gdrive: { clientId: 'gci', clientSecret: 'gcs', refreshToken: '', serviceAccountJson: '', folderIds: [], limit: 10, webhookToken: '', webhookChannelIds: [], eventTenantId: '', eventUserId: '' },
    email: { baseUrl: '', sessionId: '', limit: 10 },
    conference: { azureStorageConnectionString: '', containers: [], eventGridToken: '', eventTenantId: '', eventUserId: '' },
    knowledgeBase: { root: '' },
    dataFabric: { baseUrl: '', apiToken: '', readinessPath: '/health', recordsPath: '/records' },
    sourceLifecycle: { connectCallbackUrl: '', connectCallbackToken: '', credentialResolverToken: 'resolver-token', ...extra },
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

function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const admin = { 'x-admin-token': 'admin-secret' };
const resolver = { Authorization: 'Bearer resolver-token' };

test('credential resolver: 503 when token not configured', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-cr-'));
  try {
    const config = baseConfig(dir, { credentialResolverToken: '' });
    await withServer(config, async (base) => {
      const res = await post(base, '/internal/credentials/resolve', {
        credential_ref: 'slack:T1:*:slack', tenant_id: 't', user_id: 'u', source_id: 'slack', provider_id: 'slack',
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'RESOLVER_NOT_CONFIGURED');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('credential resolver: 401 on missing or wrong token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-cr-'));
  try {
    await withServer(baseConfig(dir), async (base) => {
      const noAuth = await post(base, '/internal/credentials/resolve', {
        credential_ref: 'slack:T1:*:slack', tenant_id: 't', user_id: 'u', source_id: 'slack', provider_id: 'slack',
      });
      assert.equal(noAuth.status, 401);

      const badAuth = await post(base, '/internal/credentials/resolve', {
        credential_ref: 'slack:T1:*:slack', tenant_id: 't', user_id: 'u', source_id: 'slack', provider_id: 'slack',
      }, { Authorization: 'Bearer wrong-token' });
      assert.equal(badAuth.status, 401);
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('credential resolver: 400 on missing required fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-cr-'));
  try {
    await withServer(baseConfig(dir), async (base) => {
      const res = await post(base, '/internal/credentials/resolve', {
        credential_ref: 'slack:T1:*:slack',
        // missing tenant_id, user_id, source_id, provider_id
      }, resolver);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'MISSING_FIELDS');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('credential resolver: 400 on malformed credential_ref (< 3 parts)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-cr-'));
  try {
    await withServer(baseConfig(dir), async (base) => {
      const res = await post(base, '/internal/credentials/resolve', {
        credential_ref: 'badref', tenant_id: 't', user_id: 'u', source_id: 'slack', provider_id: 'slack',
      }, resolver);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'INVALID_CREDENTIAL_REF');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('credential resolver: 404 when credential not in store', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-cr-'));
  try {
    await withServer(baseConfig(dir), async (base) => {
      const res = await post(base, '/internal/credentials/resolve', {
        credential_ref: 'slack:T-UNKNOWN:*:slack',
        tenant_id: 'atlas-tenant', user_id: 'atlas-user', source_id: 'slack', provider_id: 'slack',
      }, resolver);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, 'CREDENTIAL_NOT_FOUND');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('credential resolver: returns Slack bot token via tenant-wide ref', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-cr-'));
  try {
    await withServer(baseConfig(dir), async (base) => {
      // Provision tenant + wildcard user + connect (mirrors what OAuth callback does).
      await post(base, '/v1/onboarding/tenants', { tenantId: 'slack:T123', name: 'Test Workspace' }, admin);
      await post(base, '/v1/onboarding/users', { tenantId: 'slack:T123', userId: '*', email: '', sources: ['slack'] }, admin);
      await post(base, '/v1/onboarding/connections/slack', {
        tenantId: 'slack:T123', userId: '*',
        credentials: { botToken: 'xoxb-live-bot-token', channelIds: ['C1', 'C2'] },
      }, admin);

      const res = await post(base, '/internal/credentials/resolve', {
        credential_ref: 'slack:T123:*:slack',
        tenant_id: 'atlasweb', user_id: 'db-uuid-001', source_id: 'slack', provider_id: 'slack',
      }, resolver);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      // Binding fields echo the REQUEST values, not the unified-search internal IDs.
      assert.equal(data.credential.tenant_id, 'atlasweb');
      assert.equal(data.credential.user_id, 'db-uuid-001');
      assert.equal(data.credential.source_id, 'slack');
      assert.equal(data.credential.provider_id, 'slack');
      assert.equal(data.credential.access_token, 'xoxb-live-bot-token');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('credential resolver: returns Google refresh token via tenant-wide ref', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-cr-'));
  try {
    await withServer(baseConfig(dir), async (base) => {
      await post(base, '/v1/onboarding/tenants', { tenantId: 'google:example.com', name: 'Example' }, admin);
      await post(base, '/v1/onboarding/users', { tenantId: 'google:example.com', userId: '*', email: '', sources: ['google_drive'] }, admin);
      await post(base, '/v1/onboarding/connections/google_drive', {
        tenantId: 'google:example.com', userId: '*',
        credentials: { clientId: 'gci', clientSecret: 'gcs', refreshToken: 'google-refresh-xyz' },
      }, admin);

      const res = await post(base, '/internal/credentials/resolve', {
        credential_ref: 'google:example.com:*:google_drive',
        tenant_id: 'atlasweb', user_id: 'db-uuid-002', source_id: 'gdrive', provider_id: 'google-workspace',
      }, resolver);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.credential.tenant_id, 'atlasweb');
      assert.equal(data.credential.user_id, 'db-uuid-002');
      assert.equal(data.credential.source_id, 'gdrive');
      assert.equal(data.credential.provider_id, 'google-workspace');
      assert.equal(data.credential.refresh_token, 'google-refresh-xyz');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('connect-callback wiring: Slack OAuth callback fires notify when configured', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-cr-'));
  try {
    // Spin up a stub auth-service that records the connect-callback call.
    const received = [];
    const express = (await import('express')).default;
    const stub = express();
    stub.use(express.json());
    stub.post('/v1/sources/:sourceId/connect-callback', (req, res) => {
      received.push({ sourceId: req.params.sourceId, body: req.body, auth: req.headers.authorization });
      res.status(202).json({ success: true });
    });
    const stubServer = stub.listen(0);
    await new Promise((resolve) => stubServer.once('listening', resolve));
    const stubBase = `http://127.0.0.1:${stubServer.address().port}`;

    const config = baseConfig(dir, {
      connectCallbackUrl: stubBase,
      connectCallbackToken: 'lifecycle-token',
    });
    // Need slack oauth config for OAuth to work
    config.slack = { ...config.slack, oauth: { clientId: '', clientSecret: '', redirectUri: '', scopes: ['channels:history'], userScopes: ['openid'], postLoginRedirect: '' } };

    await withServer(config, async (base) => {
      const start = await (await fetch(`${base}/v1/onboarding/oauth/slack/start`)).json();
      const code = 'stub:T-FIRE:U-FIRE:fire@test.test';
      await fetch(`${base}/v1/onboarding/oauth/slack/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(start.state)}`);
      // give fire-and-forget a tick to settle
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    stubServer.close();
    assert.ok(received.length >= 1, 'connect-callback must be called at least once');
    const call = received[0];
    assert.equal(call.sourceId, 'slack');
    assert.equal(call.body.provider_id, 'slack');
    assert.ok(call.body.credential_ref.startsWith('slack:T-FIRE:*:slack'));
    assert.equal(call.body.user_email, 'fire@test.test');
    assert.equal(call.auth, 'Bearer lifecycle-token');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
