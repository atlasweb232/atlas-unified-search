const base = requireEnv('UNIFIED_SEARCH_BASE_URL').replace(/\/$/, '');
const token = requireEnv('UNIFIED_SEARCH_AUTH_TOKEN');
const tenantId = process.env.UNIFIED_SEARCH_SMOKE_TENANT_ID || 'smoke_tenant';
const userId = process.env.UNIFIED_SEARCH_SMOKE_USER_ID || 'smoke_user';
const mode = process.env.UNIFIED_SEARCH_SMOKE_MODE || 'inline';
const jobPollAttempts = Number(process.env.UNIFIED_SEARCH_SMOKE_JOB_POLL_ATTEMPTS || 60);
const jobPollIntervalMs = Number(process.env.UNIFIED_SEARCH_SMOKE_JOB_POLL_INTERVAL_MS || 5000);
const marker = `unified search ${mode} smoke ${Date.now()}`;

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.auth === false ? {} : { Authorization: `Bearer ${token}` }),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, ok: response.ok, data };
}

const health = await request('/v1/health', { auth: false });
assert(health.ok, `health failed: ${health.status}`);
assert(health.data.index?.backend === 'postgres-pgvector', `expected postgres-pgvector, got ${health.data.index?.backend}`);
assert(health.data.queue?.backend === 'azure-service-bus', `expected azure-service-bus, got ${health.data.queue?.backend}`);
assert(health.data.artifacts?.backend === 'azure-blob-artifact', `expected azure-blob-artifact, got ${health.data.artifacts?.backend}`);
assert(health.data.auth?.required === true, 'auth must be required');
console.log('health ok', summarizeHealth(health.data));

const unauth = await request('/v1/connectors', { auth: false });
assert(unauth.status === 401, `expected unauthenticated connectors to return 401, got ${unauth.status}`);
console.log('auth boundary ok');

const readiness = await request('/v1/connectors/readiness');
assert(readiness.ok, `readiness failed: ${JSON.stringify(readiness.data)}`);
console.log('connector readiness', readiness.data.checks.map((check) => ({
  source: check.source,
  ready: check.ready,
  status: check.status,
})));
const readinessBySource = Object.fromEntries((readiness.data.checks || []).map((check) => [check.source, check]));
console.log('live connector coverage', {
  email: readinessBySource.email?.ready ? 'live_ready' : readinessBySource.email?.status || 'not_reported',
  conference_bridge: readinessBySource.conference_bridge?.ready ? 'live_ready' : readinessBySource.conference_bridge?.status || 'not_reported',
  knowledge_base: readinessBySource.knowledge_base?.ready ? 'live_ready' : readinessBySource.knowledge_base?.status || 'not_reported',
  slack: readinessBySource.slack?.ready ? 'live_ready' : 'not_live_tested',
  google_drive: readinessBySource.google_drive?.ready ? 'live_ready' : 'not_live_tested',
  data_fabric: readinessBySource.data_fabric?.ready ? 'live_ready' : readinessBySource.data_fabric?.status || 'not_reported',
});

const wait = mode !== 'async';
const sync = await request('/v1/sync/slack', {
  method: 'POST',
  body: JSON.stringify({
    tenantId,
    userId,
    wait,
    options: {
      fixtures: [{
        channelId: `C-${mode}`,
        channelName: `prod-${mode}`,
        timestamp: new Date().toISOString(),
        sender: 'Production Smoke',
        text: `${marker} confirms Postgres pgvector Service Bus and Blob artifact wiring.`,
        thread: [{ sender: 'Worker', text: 'The indexed content should be searchable.' }],
        files: [{ name: `${mode}-smoke.txt`, text: marker }],
      }],
    },
  }),
});
assert(sync.ok, `sync failed: ${JSON.stringify(sync.data)}`);
const jobId = sync.data.job.id;
console.log('slack fixture pipeline sync accepted', { status: sync.status, jobId, jobStatus: sync.data.job.status });

if (mode === 'async') {
  const job = await waitForJob(jobId);
  assert(job.status === 'completed', `async job did not complete: ${JSON.stringify(job)}`);
  console.log('slack fixture pipeline async worker ok', { jobId, indexed: job.indexed });
} else {
  assert(sync.data.job.status === 'completed', `inline job did not complete: ${JSON.stringify(sync.data.job)}`);
  console.log('slack fixture pipeline inline sync ok', { jobId, indexed: sync.data.indexed });
}

const run = await request('/v1/search-runs', {
  method: 'POST',
  body: JSON.stringify({ tenantId, userId, query: marker, sources: ['slack'], wait: true, limit: 5 }),
});
assert(run.ok && run.data.results?.length, `search run failed: ${JSON.stringify(run.data)}`);
console.log('slack fixture pipeline search run ok', { runId: run.data.searchRun.id, count: run.data.results.length });

const action = await request('/v1/assistant/actions', {
  method: 'POST',
  body: JSON.stringify({
    tenantId,
    userId,
    searchRunId: run.data.searchRun.id,
    actionType: 'create_pdf',
    selectedResultIds: [run.data.results[0].id],
    prompt: 'Summarize production readiness.',
  }),
});
assert(action.ok && action.data.actionJob?.status === 'completed', `assistant action failed: ${JSON.stringify(action.data)}`);
assert(action.data.actionJob.artifactIds?.length, 'assistant action did not create an artifact');
console.log('assistant artifact from fixture pipeline ok', { actionId: action.data.actionJob.id, artifactIds: action.data.actionJob.artifactIds });

if (readinessBySource.slack?.ready) {
  console.log('slack live connector ready; run /v1/reindex/slack with production channel options to test real Slack ingestion');
} else {
  console.log('slack live connector skipped', { reason: 'missing Slack bot token/channel IDs or readiness failed', status: readinessBySource.slack?.status || 'not_reported' });
}

if (readinessBySource.google_drive?.ready) {
  console.log('google drive live connector ready; run /v1/reindex/google_drive with production folder options to test real Drive ingestion');
} else {
  console.log('google drive live connector skipped', { reason: 'missing Google OAuth/service-account config or readiness failed', status: readinessBySource.google_drive?.status || 'not_reported' });
}

if (readinessBySource.conference_bridge?.ready) {
  const conferenceTenantId = `${tenantId}_conference`;
  const conferenceUserId = `${userId}_conference`;
  const prefix = process.env.UNIFIED_SEARCH_SMOKE_CONFERENCE_PREFIX || 'smoke/';
  const conference = await request('/v1/reindex/conference_bridge', {
    method: 'POST',
    body: JSON.stringify({
      tenantId: conferenceTenantId,
      userId: conferenceUserId,
      wait: true,
      options: { prefix },
    }),
  });
  assert(conference.ok && conference.data.indexed >= 1, `conference sync failed: ${JSON.stringify(conference.data)}`);
  const conferenceSearch = await request('/v1/search', {
    method: 'POST',
    body: JSON.stringify({
      tenantId: conferenceTenantId,
      userId: conferenceUserId,
      query: 'conference bridge transcript Azure Blob indexing',
      sources: ['conference_bridge'],
      limit: 5,
    }),
  });
  assert(conferenceSearch.ok && conferenceSearch.data.results?.length, `conference search failed: ${JSON.stringify(conferenceSearch.data)}`);
  await request('/v1/documents', {
    method: 'DELETE',
    body: JSON.stringify({
      tenantId: conferenceTenantId,
      userId: conferenceUserId,
      source: 'conference_bridge',
      resetCheckpoints: true,
    }),
  });
  console.log('conference bridge live source ok', { indexed: conference.data.indexed, count: conferenceSearch.data.results.length, prefix });
} else {
  console.log('conference bridge live source skipped', { status: readinessBySource.conference_bridge?.status || 'not_reported' });
}

if (readinessBySource.knowledge_base?.ready) {
  const kbTenantId = `${tenantId}_kb`;
  const kbUserId = `${userId}_kb`;
  const kb = await request('/v1/reindex/knowledge_base', {
    method: 'POST',
    body: JSON.stringify({
      tenantId: kbTenantId,
      userId: kbUserId,
      wait: true,
    }),
  });
  assert(kb.ok && kb.data.indexed >= 1, `knowledge base sync failed: ${JSON.stringify(kb.data)}`);
  const kbSearch = await request('/v1/search', {
    method: 'POST',
    body: JSON.stringify({
      tenantId: kbTenantId,
      userId: kbUserId,
      query: 'production readiness unified search',
      sources: ['knowledge_base'],
      limit: 5,
    }),
  });
  assert(kbSearch.ok && kbSearch.data.results?.length, `knowledge base search failed: ${JSON.stringify(kbSearch.data)}`);
  await request('/v1/documents', {
    method: 'DELETE',
    body: JSON.stringify({
      tenantId: kbTenantId,
      userId: kbUserId,
      source: 'knowledge_base',
      resetCheckpoints: true,
    }),
  });
  console.log('knowledge base live source ok', { indexed: kb.data.indexed, count: kbSearch.data.results.length });
} else {
  console.log('knowledge base live source skipped', { status: readinessBySource.knowledge_base?.status || 'not_reported' });
}

async function waitForJob(jobId) {
  for (let attempt = 1; attempt <= jobPollAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, jobPollIntervalMs));
    const jobs = await request('/v1/jobs');
    const job = jobs.data.jobs?.find((item) => item.id === jobId);
    console.log('job poll', { attempt, status: job?.status, indexed: job?.indexed, startedAt: job?.startedAt || '', error: job?.error || '' });
    if (job?.status === 'completed' || job?.status === 'failed') return job;
  }
  throw new Error(`job ${jobId} did not finish`);
}

function summarizeHealth(data) {
  return {
    embedding: data.embedding?.version,
    index: data.index?.backend,
    queue: data.queue?.backend,
    artifacts: data.artifacts?.backend,
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
