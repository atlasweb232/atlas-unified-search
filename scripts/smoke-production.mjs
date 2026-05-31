const base = requireEnv('UNIFIED_SEARCH_BASE_URL').replace(/\/$/, '');
const token = requireEnv('UNIFIED_SEARCH_AUTH_TOKEN');
const tenantId = process.env.UNIFIED_SEARCH_SMOKE_TENANT_ID || 'smoke_tenant';
const userId = process.env.UNIFIED_SEARCH_SMOKE_USER_ID || 'smoke_user';
const mode = process.env.UNIFIED_SEARCH_SMOKE_MODE || 'inline';
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
console.log('sync accepted', { status: sync.status, jobId, jobStatus: sync.data.job.status });

if (mode === 'async') {
  const job = await waitForJob(jobId);
  assert(job.status === 'completed', `async job did not complete: ${JSON.stringify(job)}`);
  console.log('async worker ok', { jobId, indexed: job.indexed });
} else {
  assert(sync.data.job.status === 'completed', `inline job did not complete: ${JSON.stringify(sync.data.job)}`);
  console.log('inline sync ok', { jobId, indexed: sync.data.indexed });
}

const run = await request('/v1/search-runs', {
  method: 'POST',
  body: JSON.stringify({ tenantId, userId, query: marker, sources: ['slack'], wait: true, limit: 5 }),
});
assert(run.ok && run.data.results?.length, `search run failed: ${JSON.stringify(run.data)}`);
console.log('search run ok', { runId: run.data.searchRun.id, count: run.data.results.length });

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
console.log('assistant artifact ok', { actionId: action.data.actionJob.id, artifactIds: action.data.actionJob.artifactIds });

async function waitForJob(jobId) {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const jobs = await request('/v1/jobs');
    const job = jobs.data.jobs?.find((item) => item.id === jobId);
    console.log('job poll', { attempt, status: job?.status, indexed: job?.indexed, error: job?.error || '' });
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
