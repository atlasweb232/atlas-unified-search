const base = requireEnv('UNIFIED_SEARCH_BASE_URL').replace(/\/$/, '');
const token = requireEnv('UNIFIED_SEARCH_AUTH_TOKEN');
const tenantId = process.env.UNIFIED_SEARCH_SMOKE_TENANT_ID || 'smoke_tenant';
const userId = process.env.UNIFIED_SEARCH_SMOKE_USER_ID || 'smoke_user';
const mode = process.env.UNIFIED_SEARCH_SMOKE_MODE || 'inline';
const jobPollAttempts = Number(process.env.UNIFIED_SEARCH_SMOKE_JOB_POLL_ATTEMPTS || 60);
const jobPollIntervalMs = Number(process.env.UNIFIED_SEARCH_SMOKE_JOB_POLL_INTERVAL_MS || 5000);
const marker = `unified search ${mode} smoke ${Date.now()}`;
const liveLimit = Number(process.env.UNIFIED_SEARCH_SMOKE_LIVE_LIMIT || 5);
const configuredEmailSmokeUserId = process.env.UNIFIED_SEARCH_SMOKE_EMAIL_USER_ID || process.env.EMAIL_READINESS_USER_EMAIL || '';
const emailSmokeQuery = process.env.UNIFIED_SEARCH_SMOKE_EMAIL_QUERY || 'readiness';
const requireEmailResults = truthy(process.env.UNIFIED_SEARCH_SMOKE_REQUIRE_EMAIL_RESULTS || '');
const requiredLiveSources = listEnv('UNIFIED_SEARCH_SMOKE_REQUIRE_LIVE_SOURCES');
const requestTimeoutMs = Number(process.env.UNIFIED_SEARCH_SMOKE_REQUEST_TIMEOUT_MS || 180000);

async function request(path, options = {}) {
  const timeoutMs = options.timeoutMs || requestTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.auth === false ? {} : { Authorization: `Bearer ${token}` }),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (error.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`production smoke request timeout: ${path} after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
assertPublicHealthIsNonEnumerating(health.data);
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
for (const source of requiredLiveSources) {
  const check = readinessBySource[source];
  assert(check?.ready === true, `required live source is not ready: ${source} ${JSON.stringify({
    status: check?.status || 'not_reported',
    missing: check?.requirements?.filter((requirement) => !requirement.configured && !requirement.optional).map((requirement) => requirement.name) || [],
  })}`);
}
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
const slackFixtureStatus = run.data.searchRun?.sourceStatuses?.find((item) => item.source === 'slack');
assert(slackFixtureStatus?.searchMode === 'local_index_only', `slack fixture search should report indexed-only mode while live auth is unconfigured: ${JSON.stringify(slackFixtureStatus)}`);
assert(slackFixtureStatus?.liveConnectorCoverage === false, `slack fixture search should not claim live connector coverage: ${JSON.stringify(slackFixtureStatus)}`);
console.log('slack fixture pipeline search run ok', { runId: run.data.searchRun.id, count: run.data.results.length, searchMode: slackFixtureStatus.searchMode });

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

const audit = await request(`/v1/audit?tenantId=${encodeURIComponent(tenantId)}&userId=${encodeURIComponent(userId)}&limit=20`);
assert(audit.ok, `audit endpoint failed: ${JSON.stringify(audit.data)}`);
assert(audit.data.events?.some((event) => event.eventType === 'search_run_complete'), `audit did not include search_run_complete: ${JSON.stringify(audit.data)}`);
assert(audit.data.events.every((event) => event.tenantId === tenantId && event.userId === userId), `audit returned out-of-scope events: ${JSON.stringify(audit.data.events)}`);
console.log('scoped audit endpoint ok', { count: audit.data.events.length });

if (readinessBySource.slack?.ready) {
  await liveConnectorSmoke({
    source: 'slack',
    query: process.env.UNIFIED_SEARCH_SMOKE_SLACK_QUERY || 'meeting customer support project',
    options: {
      ...(listEnv('UNIFIED_SEARCH_SMOKE_SLACK_CHANNEL_IDS').length ? { channelIds: listEnv('UNIFIED_SEARCH_SMOKE_SLACK_CHANNEL_IDS') } : {}),
      limit: liveLimit,
    },
  });
} else {
  await assertUnreadyConnectorReindexBlocked('slack', readinessBySource.slack);
  console.log('slack live connector skipped', { reason: 'missing Slack bot token/channel IDs or readiness failed', status: readinessBySource.slack?.status || 'not_reported' });
}

if (readinessBySource.google_drive?.ready) {
  await liveConnectorSmoke({
    source: 'google_drive',
    query: process.env.UNIFIED_SEARCH_SMOKE_GDRIVE_QUERY || 'document project support',
    options: {
      ...(listEnv('UNIFIED_SEARCH_SMOKE_GDRIVE_FOLDER_IDS').length ? { folderIds: listEnv('UNIFIED_SEARCH_SMOKE_GDRIVE_FOLDER_IDS') } : {}),
      limit: liveLimit,
    },
  });
} else {
  await assertUnreadyConnectorReindexBlocked('google_drive', readinessBySource.google_drive);
  console.log('google drive live connector skipped', { reason: 'missing Google OAuth/service-account config or readiness failed', status: readinessBySource.google_drive?.status || 'not_reported' });
}

if (readinessBySource.data_fabric?.ready) {
  await liveConnectorSmoke({
    source: 'data_fabric',
    query: process.env.UNIFIED_SEARCH_SMOKE_DATA_FABRIC_QUERY || 'customer event operational record',
    options: {
      ...(process.env.UNIFIED_SEARCH_SMOKE_DATA_FABRIC_DATASET ? { dataset: process.env.UNIFIED_SEARCH_SMOKE_DATA_FABRIC_DATASET } : {}),
      limit: liveLimit,
    },
  });
} else {
  console.log('data fabric live source skipped', { status: readinessBySource.data_fabric?.status || 'not_reported' });
}

if (readinessBySource.email?.ready) {
  const emailSmokeUserId = configuredEmailSmokeUserId || readinessBySource.email?.details?.readinessUserEmail || '';
  if (!emailSmokeUserId) {
    console.log('email federated live search skipped', { reason: 'no smoke email user configured or reported by readiness' });
  } else {
    const emailSearch = await request('/v1/search-runs', {
      method: 'POST',
      body: JSON.stringify({
        tenantId,
        userId: emailSmokeUserId,
        query: emailSmokeQuery,
        sources: ['email'],
        wait: true,
        limit: liveLimit,
      }),
    });
    assert(emailSearch.ok, `email federated search failed: ${JSON.stringify(emailSearch.data)}`);
    const emailStatus = emailSearch.data.searchRun?.sourceStatuses?.find((item) => item.source === 'email');
    assert(emailStatus?.status === 'completed', `email source-agent did not complete: ${JSON.stringify(emailSearch.data.searchRun?.sourceStatuses)}`);
    if (requireEmailResults) {
      assert(emailSearch.data.results?.length, `email live search returned no results for ${emailSmokeUserId}; index a known smoke email or set UNIFIED_SEARCH_SMOKE_EMAIL_QUERY`);
    }
    console.log('email federated live search ok', {
      userId: emailSmokeUserId,
      query: emailSmokeQuery,
      count: emailSearch.data.results?.length || 0,
      requireResults: requireEmailResults,
    });
  }
} else {
  console.log('email live source skipped', { status: readinessBySource.email?.status || 'not_reported' });
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
  await request('/v1/sources/conference_bridge/documents', {
    method: 'DELETE',
    body: JSON.stringify({
      tenantId: conferenceTenantId,
      userId: conferenceUserId,
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
  await request('/v1/sources/knowledge_base/documents', {
    method: 'DELETE',
    body: JSON.stringify({
      tenantId: kbTenantId,
      userId: kbUserId,
      resetCheckpoints: true,
    }),
  });
  console.log('knowledge base live source ok', { indexed: kb.data.indexed, count: kbSearch.data.results.length });
} else {
  console.log('knowledge base live source skipped', { status: readinessBySource.knowledge_base?.status || 'not_reported' });
}

const fixtureCleanup = await request('/v1/sources/slack/documents', {
  method: 'DELETE',
  body: JSON.stringify({
    tenantId,
    userId,
    resetCheckpoints: true,
  }),
});
console.log('slack fixture pipeline cleanup', { status: fixtureCleanup.status, deleted: fixtureCleanup.data?.deleted || 0 });

async function waitForJob(jobId) {
  for (let attempt = 1; attempt <= jobPollAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, jobPollIntervalMs));
    const jobs = await request(`/v1/jobs?tenantId=${encodeURIComponent(tenantId)}&userId=${encodeURIComponent(userId)}`);
    const job = jobs.data.jobs?.find((item) => item.id === jobId);
    console.log('job poll', { attempt, status: job?.status, indexed: job?.indexed, startedAt: job?.startedAt || '', error: job?.error || '' });
    if (job?.status === 'completed' || job?.status === 'failed') return job;
  }
  throw new Error(`job ${jobId} did not finish`);
}

async function liveConnectorSmoke({ source, query, options = {} }) {
  const liveTenantId = `${tenantId}_${source}_live`;
  const liveUserId = `${userId}_${source}_live`;
  let indexed = 0;
  let count = 0;
  try {
    const reindex = await request(`/v1/reindex/${source}`, {
      method: 'POST',
      body: JSON.stringify({
        tenantId: liveTenantId,
        userId: liveUserId,
        wait: true,
        options,
      }),
    });
    assert(reindex.ok, `${source} live reindex failed: ${JSON.stringify(reindex.data)}`);
    indexed = reindex.data.indexed || 0;
    assert(indexed >= 1, `${source} live reindex returned no documents; configure a smoke channel/folder/dataset with at least one readable item`);

    const search = await request('/v1/search-runs', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: liveTenantId,
        userId: liveUserId,
        query,
        sources: [source],
        wait: true,
        limit: liveLimit,
      }),
    });
    assert(search.ok && search.data.results?.length, `${source} live search failed: ${JSON.stringify(search.data)}`);
    count = search.data.results.length;
    const status = search.data.searchRun?.sourceStatuses?.find((item) => item.source === source);
    assert(status?.status === 'completed', `${source} source-agent did not complete: ${JSON.stringify(status)}`);
    assert(status.connectorConfigured === true, `${source} search did not prove configured connector coverage: ${JSON.stringify(status)}`);
    assert(status.searchMode !== 'local_index_only', `${source} search fell back to unconfigured indexed-only mode: ${JSON.stringify(status)}`);

    console.log(`${source} live source ok`, {
      indexed,
      count,
      query,
      searchMode: status.searchMode,
    });
  } finally {
    const cleanup = await request(`/v1/sources/${source}/documents`, {
      method: 'DELETE',
      body: JSON.stringify({
        tenantId: liveTenantId,
        userId: liveUserId,
        resetCheckpoints: true,
      }),
    });
    console.log(`${source} live source cleanup`, { status: cleanup.status, deleted: cleanup.data?.deleted || 0, indexedBeforeCleanup: indexed, resultCount: count });
  }
}

async function assertUnreadyConnectorReindexBlocked(source, readinessCheck) {
  const blocked = await request(`/v1/reindex/${source}`, {
    method: 'POST',
    body: JSON.stringify({
      tenantId: `${tenantId}_${source}_blocked_probe`,
      userId: `${userId}_${source}_blocked_probe`,
      wait: false,
    }),
  });
  assert(blocked.status === 409, `${source} unready reindex should return 409, got ${blocked.status}: ${JSON.stringify(blocked.data)}`);
  assert(blocked.data.details?.source === source, `${source} blocked response did not include source details: ${JSON.stringify(blocked.data)}`);
  assert(blocked.data.details?.status === readinessCheck?.status, `${source} blocked status did not match readiness: ${JSON.stringify({ readiness: readinessCheck, blocked: blocked.data })}`);
  console.log(`${source} unready live reindex blocked`, {
    status: blocked.data.details.status,
    missing: blocked.data.details.missing || [],
  });
}

function listEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function summarizeHealth(data) {
  return {
    embedding: data.embedding?.version,
    index: data.index?.backend,
    queue: data.queue?.backend,
    artifacts: data.artifacts?.backend,
  };
}

function assertPublicHealthIsNonEnumerating(data) {
  assert(data.connectors === undefined, 'public health must not expose connector configuration');
  assert(data.documents === undefined, 'public health must not expose global document count');
  assert(data.chunks === undefined, 'public health must not expose global chunk count');
  assert(data.jobs === undefined, 'public health must not expose global job count');
  const indexKeys = Object.keys(data.index || {}).sort();
  assert(JSON.stringify(indexKeys) === JSON.stringify(['backend', 'ready']), `public health index must only expose backend/ready, got ${indexKeys.join(',')}`);
  for (const key of ['documents', 'chunks', 'jobs', 'bySource', 'connectors']) {
    assert(data.index?.[key] === undefined, `public health index must not expose ${key}`);
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
