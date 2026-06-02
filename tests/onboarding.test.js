import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

// Admin-provisioned onboarding with self-minted JWT identity. Fully credential-free:
// the only secret is a locally-chosen IDENTITY_JWT_SECRET + admin token.
function baseConfig(dataDir) {
  return {
    dataDir,
    embeddingProvider: 'hash',
    embeddingDim: 768,
    enabledSources: ['email', 'slack', 'google_drive'],
    openaiApiKey: '',
    embeddingModel: 'test',
    auth: { required: false, token: '' },
    identity: { mode: 'jwt', jwtSecret: 'onboarding-secret', jwtIssuer: '', jwtAudience: '', tenantKeys: {} },
    onboarding: { adminToken: 'admin-secret', tokenTtlSeconds: 3600 },
    cors: { origins: [] },
    sourcePermissions: {},
    connectorTokens: {},
    syncRetry: { maxAttempts: 3, baseDelayMs: 1 },
    retention: { documentDays: 90, operationalDays: 30, auditDays: 90 },
    search: { vectorWeight: 0.72, lexicalWeight: 0.22, recencyWeight: 0.06, candidateMultiplier: 5 },
    postgres: { connectionString: '', ssl: false },
    serviceBus: { connectionString: '', syncQueueName: 'q' },
    artifacts: { azureStorageConnectionString: '', container: 'c', publicBaseUrl: '' },
    slack: { botToken: '', channelIds: [], limit: 10, signingSecret: '', eventTenantId: '', eventUserId: '' },
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

const admin = { 'x-admin-token': 'admin-secret' };

function post(base, p, body, headers = {}) {
  return fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('onboarding funnel: tenant -> user(JWT) -> connect source -> token authorizes scoped search', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-onboard-'));
  try {
    const config = baseConfig(dir);
    await withServer(config, async (base) => {
      // Stage 0: create tenant (entity level).
      const tenantRes = await post(base, '/v1/onboarding/tenants', { tenantId: 'acme', name: 'Acme' }, admin);
      assert.equal(tenantRes.status, 201);

      // Stage 1: create user → minted identity token bound to {acme, u1}.
      const userRes = await post(base, '/v1/onboarding/users', { tenantId: 'acme', userId: 'u1', email: 'u1@acme.test', sources: ['slack', 'email'] }, admin);
      assert.equal(userRes.status, 201);
      const { token } = await userRes.json();
      assert.ok(token, 'a JWT must be minted for the user');
      const userAuth = { Authorization: `Bearer ${token}` };

      // The minted token authorizes a scoped request (no body IDs needed).
      const connectorsBefore = await fetch(`${base}/v1/connectors`, { headers: userAuth });
      assert.equal(connectorsBefore.status, 200);
      const beforeList = (await connectorsBefore.json()).connectors;
      const slackBefore = beforeList.find((c) => c.source === 'slack');
      assert.equal(slackBefore.configured, false, 'slack not connected yet');

      // Stage 2: connect slack (credential-free: just store a token).
      const connectRes = await post(base, '/v1/onboarding/connections/slack', {
        tenantId: 'acme', userId: 'u1',
        credentials: { botToken: 'xoxb-test', channelIds: ['C1'] },
      }, admin);
      assert.equal(connectRes.status, 201);
      assert.equal((await connectRes.json()).configured, true, 'slack should read as configured after connect');

      // Now the connector resolves the runtime credential for this exact scope.
      const connectorsAfter = await fetch(`${base}/v1/connectors`, { headers: userAuth });
      const afterList = (await connectorsAfter.json()).connectors;
      assert.equal(afterList.find((c) => c.source === 'slack').configured, true);

      // Stage 4: the token authorizes search end-to-end.
      const searchRes = await post(base, '/v1/search', { query: 'anything' }, userAuth);
      assert.equal(searchRes.status, 200);
      assert.equal((await searchRes.json()).success, true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('onboarding credentials are scoped: another user in the tenant does not inherit them', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-onboard2-'));
  try {
    const config = baseConfig(dir);
    await withServer(config, async (base) => {
      await post(base, '/v1/onboarding/tenants', { tenantId: 'acme' }, admin);
      const u1 = await (await post(base, '/v1/onboarding/users', { tenantId: 'acme', userId: 'u1' }, admin)).json();
      const u2 = await (await post(base, '/v1/onboarding/users', { tenantId: 'acme', userId: 'u2' }, admin)).json();
      await post(base, '/v1/onboarding/connections/slack', {
        tenantId: 'acme', userId: 'u1', credentials: { botToken: 'xoxb-u1', channelIds: ['C1'] },
      }, admin);

      const u1List = (await (await fetch(`${base}/v1/connectors`, { headers: { Authorization: `Bearer ${u1.token}` } })).json()).connectors;
      const u2List = (await (await fetch(`${base}/v1/connectors`, { headers: { Authorization: `Bearer ${u2.token}` } })).json()).connectors;
      assert.equal(u1List.find((c) => c.source === 'slack').configured, true, 'u1 connected');
      assert.equal(u2List.find((c) => c.source === 'slack').configured, false, 'u2 must NOT inherit u1 credentials');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('onboarding endpoints require the admin token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-onboard3-'));
  try {
    const config = baseConfig(dir);
    await withServer(config, async (base) => {
      const noAuth = await post(base, '/v1/onboarding/tenants', { tenantId: 'acme' });
      assert.equal(noAuth.status, 401, 'missing admin token must be rejected');
      const wrong = await post(base, '/v1/onboarding/tenants', { tenantId: 'acme' }, { 'x-admin-token': 'nope' });
      assert.equal(wrong.status, 401, 'wrong admin token must be rejected');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('deferred sources are not connectable in phase 1', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-onboard4-'));
  try {
    const config = baseConfig(dir);
    await withServer(config, async (base) => {
      await post(base, '/v1/onboarding/tenants', { tenantId: 'acme' }, admin);
      await post(base, '/v1/onboarding/users', { tenantId: 'acme', userId: 'u1' }, admin);
      const res = await post(base, '/v1/onboarding/connections/conference_bridge', {
        tenantId: 'acme', userId: 'u1', credentials: {},
      }, admin);
      assert.equal(res.status, 400, 'a deferred/unregistered source cannot be connected');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
