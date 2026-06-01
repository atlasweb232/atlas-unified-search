import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { SearchRunCoordinator } from '../src/searchRun.js';
import { JsonSearchStore } from '../src/store.js';

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
    assert.equal(health.schedules.ready, true);
    assert.equal(health.schedules.detail, 'not_configured_manual_only');

    const unauthorized = await fetch(`${base}/v1/connectors`);
    assert.equal(unauthorized.status, 401);

    const frontend = await fetch(`${base}/`);
    assert.equal(frontend.status, 200);

    const authorized = await fetch(`${base}/v1/connectors`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(authorized.status, 200);
    const authorizedBody = await authorized.json();
    assert.ok(authorizedBody.connectors.every((connector) => connector.vectorizationMode));

    const readiness = await fetch(`${base}/v1/production-readiness`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(readiness.status, 503);
    const readinessBody = await readiness.json();
    assert.equal(readinessBody.success, true);
    assert.equal(readinessBody.report.readyForProductionTesting, false);
    assert.ok(readinessBody.report.credentialBlockedSources.some((item) => item.source === 'slack'));

    const setup = await fetch(`${base}/v1/connectors/setup`, {
      headers: { Authorization: 'Bearer test-token' },
    }).then((response) => response.json());
    assert.equal(setup.success, true);
    const slack = setup.setup.find((item) => item.source === 'slack');
    assert.ok(slack.missing.includes('SLACK_BOT_TOKEN'));
    assert.match(slack.nextAction, /Slack app/);
    assert.ok(slack.liveSmoke.env.includes('UNIFIED_SEARCH_SMOKE_SLACK_CHANNEL_IDS'));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('search run source-agent timeout returns partial results', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-unified-timeout-'));
  try {
    const store = new JsonSearchStore({ dataDir: dir });
    await store.load();
    const searchEngine = {
      async search({ sources }) {
        return [{
          id: `doc-${sources[0]}`,
          tenantId: 'atlasweb',
          userId: 'rakib',
          source: sources[0],
          title: 'Fast result',
          summary: 'Fast source completed',
          body: 'Fast source completed',
          score: 0.9,
          metadata: {},
          children: [],
        }];
      },
    };
    const registry = {
      get(source) {
        if (source === 'slow') {
          return { search: () => new Promise(() => {}) };
        }
        return {};
      },
    };
    const coordinator = new SearchRunCoordinator({ store, searchEngine, registry, sourceTimeoutMs: 20 });
    const run = await coordinator.start({
      tenantId: 'atlasweb',
      userId: 'rakib',
      query: 'timeout check',
      sources: ['slow', 'fast'],
      wait: true,
      limit: 10,
    });

    assert.equal(run.status, 'partial');
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].source, 'fast');
    const slow = run.sourceStatuses.find((status) => status.source === 'slow');
    const fast = run.sourceStatuses.find((status) => status.source === 'fast');
    assert.equal(slow.status, 'failed');
    assert.match(slow.error, /timed out/);
    assert.equal(fast.status, 'completed');
  } finally {
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
    assert.ok(run.searchRun.sourceStatuses.every((status) => status.liveConnectorCoverage === false));
    assert.ok(run.searchRun.sourceStatuses.some((status) => status.source === 'knowledge_base' && status.searchMode === 'local_index_only'));
    assert.ok(run.searchRun.sourceStatuses.some((status) => status.source === 'email' && status.searchMode === 'federated_unconfigured'));
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

    await post(base, '/v1/search', { tenantId, userId: 'other', query: 'Redis deployment lease', sources: ['slack'] });
    const audit = await request(base, `/v1/audit?tenantId=${tenantId}&userId=${userId}&eventType=search&limit=10`);
    assert.equal(audit.success, true);
    assert.ok(audit.events.length >= 1);
    assert.ok(audit.events.every((event) => event.tenantId === tenantId && event.userId === userId && event.eventType === 'search'));
    assert.ok(audit.events.every((event) => event.userId !== 'other'));

    const auditMissingScope = await fetch(`${base}/v1/audit?tenantId=${tenantId}`);
    assert.equal(auditMissingScope.status, 400);

    const reindex = await post(base, '/v1/reindex/slack', {
      tenantId,
      userId,
      wait: true,
      options: { fixtures: fixtures.slack },
    });
    assert.equal(reindex.success, true);
    assert.equal(reindex.indexed, 1);

    const jobs = await request(base, `/v1/jobs?tenantId=${tenantId}&userId=${userId}`);
    assert.equal(jobs.success, true);
    assert.ok(jobs.jobs.every((job) => job.tenantId === tenantId && job.userId === userId));
    const missingJobScope = await fetch(`${base}/v1/jobs`);
    assert.equal(missingJobScope.status, 400);
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

test('reindex keeps existing source data when live connector readiness fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-unified-reindex-gate-'));
  let server;
  const originalFetch = globalThis.fetch;
  try {
    const app = await createApp({
      ...config(dir),
      slack: { botToken: 'xoxb-invalid', channelIds: ['C1'], limit: 10 },
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    await post(base, '/v1/sync/slack', {
      tenantId: 'atlasweb',
      userId: 'rakib',
      wait: true,
      options: {
        fixtures: [{
          channelId: 'C1',
          channelName: 'engineering',
          timestamp: '2026-05-31T12:00:00.000Z',
          sender: 'Ada',
          text: 'Do not delete this stale Slack result when auth fails.',
        }],
      },
    });

    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://slack.com/api/')) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url, options);
    };

    const reindex = await fetch(`${base}/v1/reindex/slack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'atlasweb', userId: 'rakib', wait: false }),
    });
    assert.equal(reindex.status, 409);
    const body = await reindex.json();
    assert.equal(body.success, false);
    assert.equal(body.details.source, 'slack');
    assert.equal(body.details.status, 'check_failed');
    assert.equal(body.details.error, 'invalid_auth');

    const search = await post(base, '/v1/search', {
      tenantId: 'atlasweb',
      userId: 'rakib',
      query: 'stale Slack result',
      sources: ['slack'],
    });
    assert.equal(search.results.length, 1);
    assert.match(search.results[0].oneLine, /Do not delete/);
  } finally {
    globalThis.fetch = originalFetch;
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

test('email connector readiness exposes smoke user and federated search completes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-unified-email-'));
  let emailServer;
  let appServer;
  try {
    const requests = [];
    emailServer = await listen((req, res) => {
      assert.equal(req.method, 'POST');
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        requests.push(payload);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          success: true,
          results: payload.userEmail === 'indexed@atlasweb.info' ? [{
            id: 'email-smoke-1',
            subject: 'Readiness smoke email',
            sender: 'support@atlasweb.info',
            preview: 'Readiness smoke confirms federated email search.',
            receivedAt: '2026-05-31T15:00:00.000Z',
          }] : [],
        }));
      });
    });

    const app = await createApp({
      ...config(dir),
      email: {
        baseUrl: '',
        searchUrl: `http://127.0.0.1:${emailServer.address().port}/search`,
        apiToken: 'email-token',
        readinessUserEmail: 'indexed@atlasweb.info',
        sessionId: '',
        limit: 10,
      },
    });
    appServer = app.listen(0);
    await new Promise((resolve) => appServer.once('listening', resolve));
    const base = `http://127.0.0.1:${appServer.address().port}`;

    const readiness = await fetch(`${base}/v1/connectors/readiness?source=email`).then((response) => response.json());
    assert.equal(readiness.checks[0].ready, true);
    assert.equal(readiness.checks[0].vectorizationMode, 'external_federated');
    assert.equal(readiness.checks[0].details.readinessUserEmail, 'indexed@atlasweb.info');

    const setup = await fetch(`${base}/v1/connectors/setup?source=email`).then((response) => response.json());
    assert.equal(setup.setup[0].vectorizationMode, 'external_federated');
    assert.match(setup.setup[0].vectorizationBoundary, /existing Atlas email vector service/);

    const run = await post(base, '/v1/search-runs', {
      tenantId: 'atlasweb',
      userId: 'indexed@atlasweb.info',
      query: 'readiness',
      sources: ['email'],
      wait: true,
      limit: 5,
    });
    assert.equal(run.searchRun.sourceStatuses[0].status, 'completed');
    assert.equal(run.results[0].source, 'email');
    assert.ok(requests.some((payload) => payload.userEmail === 'indexed@atlasweb.info'));
  } finally {
    if (appServer) await new Promise((resolve) => appServer.close(resolve));
    if (emailServer) await new Promise((resolve) => emailServer.close(resolve));
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
