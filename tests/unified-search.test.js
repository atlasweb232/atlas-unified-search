import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

function config(dataDir) {
  return {
    dataDir,
    embeddingProvider: 'hash',
    openaiApiKey: '',
    embeddingModel: 'test',
    auth: { required: false, token: '' },
    sourcePermissions: {},
    postgres: { connectionString: '', ssl: false },
    serviceBus: { connectionString: '', syncQueueName: 'unified-search-sync' },
    artifacts: { azureStorageConnectionString: '', container: 'unified-search-artifacts', publicBaseUrl: '' },
    slack: { botToken: '', channelIds: [], limit: 10 },
    gdrive: { clientId: '', clientSecret: '', refreshToken: '', serviceAccountJson: '', folderIds: [], limit: 10 },
    email: { baseUrl: '', sessionId: '', limit: 10 },
    conference: { azureStorageConnectionString: '', containers: [] },
    knowledgeBase: { root: '' },
    dataFabric: { baseUrl: '', apiToken: '', readinessPath: '/health', recordsPath: '/records' },
  };
}

test('api auth boundary blocks protected endpoints when enabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-unified-auth-'));
  let server;
  try {
    const app = await createApp({ ...config(dir), auth: { required: true, token: 'test-token' } });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const health = await fetch(`${base}/v1/health`).then((response) => response.json());
    assert.equal(health.success, true);
    assert.equal(health.auth.required, true);

    const unauthorized = await fetch(`${base}/v1/connectors`);
    assert.equal(unauthorized.status, 401);

    const frontend = await fetch(`${base}/`);
    assert.equal(frontend.status, 200);

    const authorized = await fetch(`${base}/v1/connectors`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(authorized.status, 200);

    const readiness = await fetch(`${base}/v1/production-readiness`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(readiness.status, 503);
    const readinessBody = await readiness.json();
    assert.equal(readinessBody.success, true);
    assert.equal(readinessBody.report.readyForProductionTesting, false);
    assert.ok(readinessBody.report.credentialBlockedSources.some((item) => item.source === 'slack'));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

async function post(base, url, body) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.success === false) throw new Error(data.error || 'request failed');
  return data;
}

async function request(base, url, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || data.success === false) throw new Error(data.error || 'request failed');
  return data;
}

test('unified search indexes fixture documents across all connector types', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-unified-'));
  let server;
  try {
    const app = await createApp(config(dir));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tenantId = 'atlasweb';
    const userId = 'rakib';

    const fixtures = {
      slack: [{ channelId: 'C1', channelName: 'engineering', timestamp: '2026-05-31T12:00:00.000Z', sender: 'Ada', text: 'Deployment failed because the Redis lease was missing.', thread: [{ sender: 'Grace', text: 'Added the Redis lease setting.' }], files: [{ name: 'deploy-log.txt', text: 'Redis lease missing' }] }],
      google_drive: [{ fileId: 'drive1', name: 'Architecture Notes', owner: 'Ada', text: 'The platform uses pgvector for unified search.', modifiedTime: '2026-05-31T12:30:00.000Z', folderPath: 'Design' }],
      email: [{ id: 'mail1', subject: 'Billing webhook', sender: 'Stripe', body: 'The subscription webhook activates the account.', receivedAt: '2026-05-31T13:00:00.000Z', attachments: [{ name: 'invoice.pdf', text: 'invoice details' }] }],
      conference_bridge: [{ meetingId: 'meet1', title: 'Launch bridge', organizer: 'Rakib', text: 'Discussed voice parity and calendar 404 cleanup.', container: 'conference-transcripts', segments: [{ speaker: 'Rakib', text: 'Calendar endpoint needs cleanup.' }] }],
      knowledge_base: [{ id: 'kb1', title: 'Runbook', text: 'If calendar events return 404, check LiveKit Sarah route registration.' }],
      data_fabric: [{ id: 'df1', title: 'Customer Usage Fact', record: { metric: 'searches', value: 42 }, text: 'Search usage metric from data fabric.' }],
    };

    for (const [source, sourceFixtures] of Object.entries(fixtures)) {
      const result = await post(base, `/v1/sync/${source}`, { tenantId, userId, wait: true, options: { fixtures: sourceFixtures } });
      assert.equal(result.success, true);
      assert.ok(result.indexed >= 1);
    }

    const search = await post(base, '/v1/search', { tenantId, userId, query: 'Redis deployment lease', limit: 5 });
    assert.equal(search.success, true);
    assert.equal(search.results[0].source, 'slack');
    assert.match(search.results[0].oneLine, /Redis|Deployment/i);
    assert.ok(search.results[0].children.length >= 1);

    const drive = await post(base, '/v1/search', { tenantId, userId, query: 'pgvector architecture', sources: ['google_drive'] });
    assert.equal(drive.results[0].source, 'google_drive');

    const otherUser = await post(base, '/v1/search', { tenantId, userId: 'other', query: 'Redis deployment lease' });
    assert.equal(otherUser.results.length, 0);

    const health = await fetch(`${base}/v1/health`).then((response) => response.json());
    assert.equal(health.index.bySource.slack, 1);
    assert.equal(health.index.bySource.google_drive, 1);
    assert.equal(health.index.bySource.email, 1);

    const readiness = await fetch(`${base}/v1/connectors/readiness`).then((response) => response.json());
    assert.equal(readiness.success, true);
    assert.ok(readiness.checks.some((check) => check.source === 'slack' && check.status === 'missing_configuration'));
    assert.ok(readiness.checks.find((check) => check.source === 'slack').requirements.some((requirement) => requirement.name === 'SLACK_BOT_TOKEN'));

    const run = await post(base, '/v1/search-runs', {
      tenantId,
      userId,
      query: 'calendar endpoint cleanup',
      sources: ['conference_bridge', 'knowledge_base', 'email'],
      wait: true,
      limit: 10,
    });
    assert.equal(run.searchRun.status, 'completed');
    assert.ok(run.searchRun.sourceStatuses.every((status) => status.status === 'completed'));
    assert.ok(run.results.some((result) => result.source === 'conference_bridge'));
    assert.ok(run.results.every((result) => result.sourceIcon && result.sourceLabel));

    const selectedResultIds = run.results.slice(0, 2).map((result) => result.id);
    const summary = await post(base, '/v1/assistant/actions', {
      tenantId,
      userId,
      searchRunId: run.searchRun.id,
      actionType: 'summarize',
      selectedResultIds,
      prompt: 'Summarize the operational issue.',
    });
    assert.equal(summary.actionJob.status, 'completed');
    assert.match(summary.actionJob.responseText, /Summary generated/);

    const ppt = await post(base, '/v1/assistant/actions', {
      tenantId,
      userId,
      searchRunId: run.searchRun.id,
      actionType: 'create_powerpoint',
      selectedResultIds,
    });
    assert.equal(ppt.actionJob.status, 'completed');
    assert.equal(ppt.actionJob.artifactIds.length, 1);

    const deleted = await request(base, '/v1/documents', {
      method: 'DELETE',
      body: { tenantId, userId, source: 'slack', resetCheckpoints: true },
    });
    assert.equal(deleted.deleted, 1);
    const deletedSearch = await post(base, '/v1/search', { tenantId, userId, query: 'Redis deployment lease', sources: ['slack'] });
    assert.equal(deletedSearch.results.length, 0);

    const reindex = await post(base, '/v1/reindex/slack', {
      tenantId,
      userId,
      wait: true,
      options: { fixtures: fixtures.slack },
    });
    assert.equal(reindex.success, true);
    assert.equal(reindex.indexed, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('source permissions block disallowed sync and search sources', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-unified-perms-'));
  let server;
  try {
    const app = await createApp({
      ...config(dir),
      sourcePermissions: { 'atlasweb:rakib': ['email'] },
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const denied = await fetch(`${base}/v1/sync/slack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'atlasweb', userId: 'rakib', wait: true, options: { fixtures: [] } }),
    });
    assert.equal(denied.status, 403);

    await post(base, '/v1/sync/email', {
      tenantId: 'atlasweb',
      userId: 'rakib',
      wait: true,
      options: { fixtures: [{ id: 'mail1', subject: 'Allowed email', body: 'Only email should be searchable.' }] },
    });
    const allowed = await post(base, '/v1/search', { tenantId: 'atlasweb', userId: 'rakib', query: 'email', sources: ['email', 'slack'] });
    assert.equal(allowed.results.length, 1);
    assert.equal(allowed.results[0].source, 'email');

    const noPermission = await fetch(`${base}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'atlasweb', userId: 'other', query: 'data' }),
    });
    assert.equal(noPermission.status, 403);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('data fabric connector syncs live HTTP records', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-unified-fabric-'));
  let fabricServer;
  let appServer;
  try {
    fabricServer = await listen((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/health') {
        res.end(JSON.stringify({ ready: true, service: 'test-fabric', version: '1' }));
        return;
      }
      if (url.pathname === '/records') {
        assert.equal(req.headers.authorization, 'Bearer fabric-token');
        assert.equal(url.searchParams.get('tenantId'), 'atlasweb');
        assert.equal(url.searchParams.get('userId'), 'rakib');
        res.end(JSON.stringify({
          records: [{
            id: 'usage-1',
            title: 'Search Usage Metric',
            text: 'Data Fabric says unified search processed 42 customer queries.',
            record: { metric: 'queries', value: 42, dataset: 'usage' },
            owner: 'fabric',
            dataset: 'usage',
            timestamp: '2026-05-31T14:00:00.000Z',
          }],
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const app = await createApp({
      ...config(dir),
      dataFabric: {
        baseUrl: `http://127.0.0.1:${fabricServer.address().port}`,
        apiToken: 'fabric-token',
        readinessPath: '/health',
        recordsPath: '/records',
      },
    });
    appServer = app.listen(0);
    await new Promise((resolve) => appServer.once('listening', resolve));
    const base = `http://127.0.0.1:${appServer.address().port}`;

    const readiness = await fetch(`${base}/v1/connectors/readiness?source=data_fabric`).then((response) => response.json());
    assert.equal(readiness.success, true);
    assert.equal(readiness.checks[0].ready, true);
    assert.equal(readiness.checks[0].status, 'ok');

    const sync = await post(base, '/v1/sync/data_fabric', {
      tenantId: 'atlasweb',
      userId: 'rakib',
      wait: true,
      options: { dataset: 'usage', limit: 5 },
    });
    assert.equal(sync.indexed, 1);

    const search = await post(base, '/v1/search', {
      tenantId: 'atlasweb',
      userId: 'rakib',
      query: 'customer queries',
      sources: ['data_fabric'],
    });
    assert.equal(search.results[0].source, 'data_fabric');
    assert.match(search.results[0].oneLine, /unified search/i);
  } finally {
    if (appServer) await new Promise((resolve) => appServer.close(resolve));
    if (fabricServer) await new Promise((resolve) => fabricServer.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, () => resolve(server));
  });
}
