import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
    postgres: { connectionString: '', ssl: false },
    serviceBus: { connectionString: '', syncQueueName: 'unified-search-sync' },
    artifacts: { azureStorageConnectionString: '', container: 'unified-search-artifacts', publicBaseUrl: '' },
    slack: { botToken: '', channelIds: [], limit: 10 },
    gdrive: { clientId: '', clientSecret: '', refreshToken: '', serviceAccountJson: '', folderIds: [], limit: 10 },
    email: { baseUrl: '', sessionId: '', limit: 10 },
    conference: { azureStorageConnectionString: '', containers: [] },
    knowledgeBase: { root: '' },
    dataFabric: { baseUrl: '' },
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

    const authorized = await fetch(`${base}/v1/connectors`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(authorized.status, 200);
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
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
