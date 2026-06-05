import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { signJwtHS256 } from '../src/middleware/identity.js';

function config(dataDir, overrides = {}) {
  return {
    dataDir,
    embeddingProvider: 'hash',
    openaiApiKey: '',
    embeddingModel: 'test',
    auth: { required: false, token: '' },
    identity: { mode: 'shared_token' },
    cors: { origins: [] },
    sourcePermissions: {},
    syncRetry: { maxAttempts: 3, baseDelayMs: 1 },
    retention: { documentDays: 90, operationalDays: 30, auditDays: 90 },
    postgres: { connectionString: '', ssl: false },
    serviceBus: { connectionString: '', syncQueueName: 'unified-search-sync' },
    artifacts: { azureStorageConnectionString: '', container: 'unified-search-artifacts', publicBaseUrl: '' },
    slack: { botToken: '', channelIds: [], limit: 10, signingSecret: '', eventTenantId: '', eventUserId: '' },
    gdrive: { clientId: '', clientSecret: '', refreshToken: '', serviceAccountJson: '', folderIds: [], limit: 10, webhookToken: '', webhookChannelIds: [], eventTenantId: '', eventUserId: '' },
    email: { baseUrl: '', sessionId: '', limit: 10 },
    conference: { azureStorageConnectionString: '', containers: [], eventGridToken: '', eventTenantId: '', eventUserId: '' },
    knowledgeBase: { root: '' },
    dataFabric: { baseUrl: '', apiToken: '', readinessPath: '/health', recordsPath: '/records' },
    ...overrides,
  };
}

async function withServer(callback, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-meeting-production-'));
  let server;
  try {
    const app = await createApp(config(dir, overrides));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return await callback({ base, dir });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function post(base, pathName, body) {
  const response = await fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'atlas-desktop', 'x-user-id': 'owner@example.com' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { response, json };
}

async function postWithHeaders(base, pathName, body, headers = {}) {
  const response = await fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { response, json };
}

test('meeting archive and ingest endpoints store searchable conference documents', async () => withServer(async ({ base }) => {
  const envelope = {
    archive: {
      meetingId: 'meet-prod-1',
      requestId: 'req-prod-1',
      meetUrl: 'https://meet.google.com/prod-one',
      ownerEmail: 'owner@example.com',
      ownerDisplayName: 'Owner Example',
      botDisplayName: 'Atlas',
      selectedSourceScopes: ['conference_bridge', 'knowledge_base'],
      securityLabels: ['meeting-attendant', 'tenant:atlas-desktop'],
      participants: ['Owner Example', 'Alice Vendor'],
      participantContexts: [{ displayName: 'Alice Vendor', identityHint: 'alice@example.com' }],
      agenda: 'Vendor rollout blockers',
      transcript: [
        'Alice Vendor: Vendor access blocks rollout this week.',
        'Owner Example: Escalate the access issue and prepare mitigation.',
      ],
      actionItems: ['Escalate vendor access'],
      pendingQuestions: ['Can access be restored by Friday?'],
      decisionLog: ['Escalate vendor access immediately.'],
      knowledgeReferences: [{ title: 'Vendor rollout plan', uri: 'https://kb/vendor-rollout' }],
      archivedAtUtc: '2026-06-05T12:00:00Z',
    },
    artifacts: [
      { kind: 'transcript', inlineContent: 'Vendor access blocks rollout this week.' },
      { kind: 'minutes', inlineContent: 'Escalate vendor access and prepare mitigation.' },
    ],
  };

  const archive = await post(base, '/v1/meeting/archive', envelope);
  assert.equal(archive.response.status, 202);
  assert.equal(archive.json.success, true);
  assert.equal(archive.json.status, 'accepted');
  assert.ok(archive.json.archiveId);

  const ingest = await post(base, '/v1/meeting/ingest', envelope);
  assert.equal(ingest.response.status, 202);
  assert.equal(ingest.json.success, true);
  assert.ok(ingest.json.ingestId);

  const search = await post(base, '/v1/search', {
    tenantId: 'atlas-desktop',
    userId: 'owner@example.com',
    query: 'vendor access rollout mitigation',
    sources: ['conference_bridge'],
    limit: 5,
  });
  assert.equal(search.response.status, 200);
  assert.equal(search.json.success, true);
  assert.ok(search.json.results.length >= 1);
  assert.equal(search.json.results[0].source, 'conference_bridge');
  assert.equal(search.json.results[0].metadata.meetingId, 'meet-prod-1');
}));

test('meeting recording upload endpoint accepts bytes and completion receipt', async () => withServer(async ({ base }) => {
  const recordingBytes = Buffer.from('recording-bytes');
  const checksum = createHash('sha256').update(recordingBytes).digest('hex');
  const upload = await post(base, '/v1/meeting/recording/upload', {
    tenantId: 'atlas-desktop',
    userId: 'owner@example.com',
    meetingId: 'meet-prod-2',
    requestId: 'req-prod-2',
    meetUrl: 'https://meet.google.com/prod-two',
    ownerEmail: 'owner@example.com',
    contentType: 'audio/wav',
    fileName: 'meeting.wav',
    checksumSha256: checksum,
  });
  assert.equal(upload.response.status, 201);
  assert.equal(upload.json.success, true);
  assert.ok(upload.json.recordingId);
  assert.ok(upload.json.uploadUrl);
  assert.ok(upload.json.recordingUri);

  const put = await fetch(upload.json.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'audio/wav', 'x-tenant-id': 'atlas-desktop', 'x-user-id': 'owner@example.com' },
    body: recordingBytes,
  });
  assert.equal(put.status, 200);
  const putJson = await put.json();
  assert.equal(putJson.status, 'uploaded');

  const complete = await post(base, '/v1/meeting/recording/complete', {
    tenantId: 'atlas-desktop',
    userId: 'owner@example.com',
    recordingId: upload.json.recordingId,
    meetingId: 'meet-prod-2',
    requestId: 'req-prod-2',
    recordingUri: upload.json.recordingUri,
    sizeBytes: 15,
    checksumSha256: checksum,
  });
  assert.equal(complete.response.status, 200);
  assert.equal(complete.json.success, true);
  assert.equal(complete.json.status, 'accepted');
  assert.ok(complete.json.receiptId);
}));

test('meeting endpoints enforce JWT identity and allowed source claims', async () => {
  const secret = 'meeting-secret';
  const jwtConfig = {
    identity: { mode: 'jwt', jwtSecret: secret, jwtIssuer: '', jwtAudience: '', tenantKeys: {} },
  };
  await withServer(async ({ base }) => {
    const archive = {
      archive: {
        meetingId: 'meet-jwt-1',
        requestId: 'req-jwt-1',
        ownerEmail: 'owner@example.com',
        transcript: ['Owner: JWT meeting archive'],
      },
    };

    const unauth = await fetch(`${base}/v1/meeting/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(archive),
    });
    assert.equal(unauth.status, 401);

    const noConference = signJwtHS256({ tenantId: 'tenant-a', userId: 'owner@example.com', sources: ['email'] }, secret);
    const forbidden = await postWithHeaders(base, '/v1/meeting/archive', archive, { Authorization: `Bearer ${noConference}` });
    assert.equal(forbidden.response.status, 403);

    const token = signJwtHS256({ tenantId: 'tenant-a', userId: 'owner@example.com', sources: ['conference_bridge'] }, secret);
    const accepted = await postWithHeaders(base, '/v1/meeting/archive', archive, { Authorization: `Bearer ${token}` });
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.json.success, true);

    const mismatch = await postWithHeaders(base, '/v1/meeting/archive', {
      archive: {
        ...archive.archive,
        tenantId: 'tenant-b',
      },
    }, { Authorization: `Bearer ${token}` });
    assert.equal(mismatch.response.status, 403);
  }, jwtConfig);
});

test('meeting recording completion requires uploaded bytes and validates checksum', async () => withServer(async ({ base }) => {
  const upload = await post(base, '/v1/meeting/recording/upload', {
    tenantId: 'atlas-desktop',
    userId: 'owner@example.com',
    meetingId: 'meet-prod-3',
    requestId: 'req-prod-3',
    meetUrl: 'https://meet.google.com/prod-three',
    ownerEmail: 'owner@example.com',
    contentType: 'audio/wav',
    fileName: 'meeting.wav',
  });
  assert.equal(upload.response.status, 201);

  const earlyComplete = await post(base, '/v1/meeting/recording/complete', {
    tenantId: 'atlas-desktop',
    userId: 'owner@example.com',
    recordingId: upload.json.recordingId,
    meetingId: 'meet-prod-3',
    requestId: 'req-prod-3',
  });
  assert.equal(earlyComplete.response.status, 409);

  const put = await fetch(upload.json.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'audio/wav', 'x-tenant-id': 'atlas-desktop', 'x-user-id': 'owner@example.com' },
    body: Buffer.from('recording-bytes'),
  });
  assert.equal(put.status, 200);

  const badChecksum = await post(base, '/v1/meeting/recording/complete', {
    tenantId: 'atlas-desktop',
    userId: 'owner@example.com',
    recordingId: upload.json.recordingId,
    meetingId: 'meet-prod-3',
    requestId: 'req-prod-3',
    checksumSha256: 'not-the-real-checksum',
  });
  assert.equal(badChecksum.response.status, 409);
}));
