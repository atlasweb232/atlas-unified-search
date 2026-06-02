import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { signJwtHS256 } from '../src/middleware/identity.js';

function baseConfig(dataDir, identity) {
  return {
    dataDir,
    embeddingProvider: 'hash',
    embeddingDim: 768,
    openaiApiKey: '',
    embeddingModel: 'test',
    auth: { required: false, token: '' },
    identity,
    cors: { origins: [] },
    sourcePermissions: {},
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

function postSearch(base, headers, body) {
  return fetch(`${base}/v1/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ─── JWT mode ────────────────────────────────────────────────────────────────────

test('jwt: cross-tenant ID substitution is rejected with 403', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-jwt-'));
  try {
    const secret = 'dev-only-secret';
    const config = baseConfig(dir, { mode: 'jwt', jwtSecret: secret, tenantKeys: {} });
    const token = signJwtHS256({ tenantId: 'tenantA', userId: 'u1' }, secret);
    const auth = { Authorization: `Bearer ${token}` };

    await withServer(config, async (base) => {
      // Caller is tenantA/u1 but claims tenantB in the body → 403.
      const cross = await postSearch(base, auth, { tenantId: 'tenantB', userId: 'u1', query: 'x' });
      assert.equal(cross.status, 403, 'cross-tenant substitution must be forbidden');

      // Cross-user within the same tenant → 403.
      const crossUser = await postSearch(base, auth, { tenantId: 'tenantA', userId: 'u2', query: 'x' });
      assert.equal(crossUser.status, 403, 'cross-user substitution must be forbidden');

      // Matching scope → 200.
      const ok = await postSearch(base, auth, { tenantId: 'tenantA', userId: 'u1', query: 'x' });
      assert.equal(ok.status, 200);

      // Omitted scope → injected from the verified identity → 200.
      const injected = await postSearch(base, auth, { query: 'x' });
      assert.equal(injected.status, 200);
      const body = await injected.json();
      assert.equal(body.success, true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('jwt: invalid signature is rejected with 401', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-jwt2-'));
  try {
    const config = baseConfig(dir, { mode: 'jwt', jwtSecret: 'real-secret', tenantKeys: {} });
    const forged = signJwtHS256({ tenantId: 'tenantA', userId: 'u1' }, 'wrong-secret');
    await withServer(config, async (base) => {
      const res = await postSearch(base, { Authorization: `Bearer ${forged}` }, { query: 'x' });
      assert.equal(res.status, 401, 'forged token must be unauthorized');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('jwt: expired token is rejected with 401', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-jwt3-'));
  try {
    const secret = 's';
    const config = baseConfig(dir, { mode: 'jwt', jwtSecret: secret, tenantKeys: {} });
    const expired = signJwtHS256({ tenantId: 'tenantA', userId: 'u1', exp: 1 }, secret);
    await withServer(config, async (base) => {
      const res = await postSearch(base, { Authorization: `Bearer ${expired}` }, { query: 'x' });
      assert.equal(res.status, 401);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── API-key mode ──────────────────────────────────────────────────────────────

test('api_key: key binds tenant; cross-tenant body is rejected with 403', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-key-'));
  try {
    const config = baseConfig(dir, {
      mode: 'api_key',
      jwtSecret: '',
      tenantKeys: { tenantA: { key: 'kA', users: ['u1'] }, tenantB: { key: 'kB', users: ['u9'] } },
    });
    const auth = { 'x-api-key': 'kA', 'x-user-id': 'u1' };

    await withServer(config, async (base) => {
      const cross = await postSearch(base, auth, { tenantId: 'tenantB', userId: 'u1', query: 'x' });
      assert.equal(cross.status, 403, 'tenantA key cannot act as tenantB');

      const ok = await postSearch(base, auth, { tenantId: 'tenantA', userId: 'u1', query: 'x' });
      assert.equal(ok.status, 200);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('api_key: user not in tenant allowlist is rejected with 401', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-key2-'));
  try {
    const config = baseConfig(dir, {
      mode: 'api_key', jwtSecret: '',
      tenantKeys: { tenantA: { key: 'kA', users: ['u1'] } },
    });
    await withServer(config, async (base) => {
      const res = await postSearch(base, { 'x-api-key': 'kA', 'x-user-id': 'intruder' }, { query: 'x' });
      assert.equal(res.status, 401, 'user outside the tenant allowlist must be unauthorized');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('api_key: invalid key is rejected with 401', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-key3-'));
  try {
    const config = baseConfig(dir, {
      mode: 'api_key', jwtSecret: '',
      tenantKeys: { tenantA: { key: 'kA', users: ['u1'] } },
    });
    await withServer(config, async (base) => {
      const res = await postSearch(base, { 'x-api-key': 'nope', 'x-user-id': 'u1' }, { query: 'x' });
      assert.equal(res.status, 401);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── shared_token (legacy) stays backward-compatible ───────────────────────────

test('shared_token: request-supplied scope is trusted (legacy, unbound)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-shared-'));
  try {
    const config = baseConfig(dir, { mode: 'shared_token', jwtSecret: '', tenantKeys: {} });
    await withServer(config, async (base) => {
      const res = await postSearch(base, {}, { tenantId: 'anyTenant', userId: 'anyUser', query: 'x' });
      assert.equal(res.status, 200, 'shared_token mode preserves legacy request-trusted scope');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
