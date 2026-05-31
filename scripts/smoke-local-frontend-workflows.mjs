const frontend = requireEnv('UNIFIED_SEARCH_LOCAL_FRONTEND_URL').replace(/\/$/, '');
const api = requireEnv('UNIFIED_SEARCH_BASE_URL').replace(/\/$/, '');
const token = requireEnv('UNIFIED_SEARCH_AUTH_TOKEN');
const tenantId = process.env.UNIFIED_SEARCH_SMOKE_TENANT_ID || 'atlasweb';
const defaultUserId = process.env.UNIFIED_SEARCH_SMOKE_USER_ID || 'local-workflow-user';
const liveLimit = Number(process.env.UNIFIED_SEARCH_SMOKE_LIVE_LIMIT || 5);
const requireEmailResults = truthy(process.env.UNIFIED_SEARCH_SMOKE_REQUIRE_EMAIL_RESULTS || '');

const report = {
  frontend,
  api,
  checks: [],
};

await checkFrontend();
await checkAuthBoundary();
const readiness = await apiRequest('/v1/connectors/readiness');
const readinessBySource = Object.fromEntries((readiness.checks || []).map((item) => [item.source, item]));
report.checks.push({
  name: 'connector_readiness',
  status: 'ok',
  sources: readiness.checks.map((item) => ({ source: item.source, ready: item.ready, status: item.status })),
});

const setup = await apiRequest('/v1/connectors/setup');
report.checks.push({
  name: 'connector_setup_guidance',
  status: 'ok',
  blocked: setup.setup.filter((item) => !item.ready).map((item) => ({ source: item.source, missing: item.missing })),
});

if (readinessBySource.email?.ready) {
  await checkEmailFederation(readinessBySource.email);
} else {
  report.checks.push({ name: 'email_federated_search', status: 'skipped', reason: readinessBySource.email?.status || 'not_reported' });
}

if (readinessBySource.conference_bridge?.ready) {
  await checkIndexedSource({
    source: 'conference_bridge',
    tenantId: `${tenantId}_local_conference`,
    userId: `${defaultUserId}_conference`,
    query: 'conference bridge transcript Azure Blob indexing',
    options: { prefix: process.env.UNIFIED_SEARCH_SMOKE_CONFERENCE_PREFIX || 'smoke/' },
  });
} else {
  report.checks.push({ name: 'conference_bridge_index_search_cleanup', status: 'skipped', reason: readinessBySource.conference_bridge?.status || 'not_reported' });
}

if (readinessBySource.knowledge_base?.ready) {
  await checkIndexedSource({
    source: 'knowledge_base',
    tenantId: `${tenantId}_local_kb`,
    userId: `${defaultUserId}_kb`,
    query: 'production readiness unified search',
  });
} else {
  report.checks.push({ name: 'knowledge_base_index_search_cleanup', status: 'skipped', reason: readinessBySource.knowledge_base?.status || 'not_reported' });
}

await checkFixturePipelineAndAssistant();

console.log(JSON.stringify(report, null, 2));

async function checkFrontend() {
  const html = await fetchText(frontend);
  assert(/<div id="root"><\/div>/.test(html), 'local frontend root shell missing');
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|jsx|css))"/g)].map((match) => match[1]);
  assert(assets.length >= 1, 'local frontend did not reference JS/JSX/CSS assets');
  for (const asset of assets) {
    const response = await fetch(`${frontend}${asset}`);
    assert(response.ok, `frontend asset failed: ${asset} ${response.status}`);
  }
  report.checks.push({ name: 'local_frontend_shell_assets', status: 'ok', assets });
}

async function checkAuthBoundary() {
  const unauth = await fetch(`${api}/v1/connectors`);
  assert(unauth.status === 401, `expected protected API to reject unauthenticated connectors, got ${unauth.status}`);
  const health = await fetchJson(`${api}/v1/health`);
  assert(health.index?.backend === 'postgres-pgvector', `expected postgres-pgvector, got ${health.index?.backend}`);
  assert(health.queue?.backend === 'azure-service-bus', `expected azure-service-bus, got ${health.queue?.backend}`);
  assert(health.artifacts?.backend === 'azure-blob-artifact', `expected azure blob artifacts, got ${health.artifacts?.backend}`);
  report.checks.push({
    name: 'api_auth_and_infrastructure',
    status: 'ok',
    index: health.index?.backend,
    queue: health.queue?.backend,
    artifacts: health.artifacts?.backend,
    schedules: health.schedules,
  });
}

async function checkEmailFederation(emailReadiness) {
  const before = await apiRequest('/v1/health');
  const beforeEmailDocs = before.index?.bySource?.email || 0;
  const emailUserId = process.env.UNIFIED_SEARCH_SMOKE_EMAIL_USER_ID || emailReadiness.details?.readinessUserEmail || '';
  assert(emailUserId, 'email readiness did not expose a smoke user and UNIFIED_SEARCH_SMOKE_EMAIL_USER_ID is unset');
  const query = process.env.UNIFIED_SEARCH_SMOKE_EMAIL_QUERY || 'readiness';
  const run = await apiRequest('/v1/search-runs', {
    method: 'POST',
    body: {
      tenantId,
      userId: emailUserId,
      query,
      sources: ['email'],
      wait: true,
      limit: liveLimit,
    },
  });
  const emailStatus = run.searchRun?.sourceStatuses?.find((item) => item.source === 'email');
  assert(emailStatus?.status === 'completed', `email source-agent failed: ${JSON.stringify(run.searchRun?.sourceStatuses)}`);
  if (requireEmailResults) {
    assert(run.results?.length, `email search returned no results for ${emailUserId}`);
  }
  const after = await apiRequest('/v1/health');
  const afterEmailDocs = after.index?.bySource?.email || 0;
  assert(beforeEmailDocs === afterEmailDocs, `email federation should not create unified-search email documents (${beforeEmailDocs} -> ${afterEmailDocs})`);
  report.checks.push({
    name: 'email_federated_existing_vector_space',
    status: 'ok',
    userId: emailUserId,
    query,
    resultCount: run.results?.length || 0,
    unifiedSearchEmailDocsBefore: beforeEmailDocs,
    unifiedSearchEmailDocsAfter: afterEmailDocs,
  });
}

async function checkIndexedSource({ source, tenantId: sourceTenantId, userId, query, options = {} }) {
  const reindex = await apiRequest(`/v1/reindex/${source}`, {
    method: 'POST',
    body: { tenantId: sourceTenantId, userId, wait: true, options },
  });
  assert(reindex.indexed >= 1, `${source} reindex returned no documents`);
  const search = await apiRequest('/v1/search', {
    method: 'POST',
    body: { tenantId: sourceTenantId, userId, query, sources: [source], limit: liveLimit },
  });
  assert(search.results?.length >= 1, `${source} search returned no results`);
  const deleted = await apiRequest('/v1/documents', {
    method: 'DELETE',
    body: { tenantId: sourceTenantId, userId, source, resetCheckpoints: true },
  });
  report.checks.push({
    name: `${source}_index_search_cleanup`,
    status: 'ok',
    indexed: reindex.indexed,
    resultCount: search.results.length,
    deleted: deleted.deleted,
  });
}

async function checkFixturePipelineAndAssistant() {
  const marker = `local frontend workflow ${Date.now()}`;
  const sourceTenantId = `${tenantId}_local_fixture`;
  const sourceUserId = `${defaultUserId}_fixture`;
  const sync = await apiRequest('/v1/sync/slack', {
    method: 'POST',
    body: {
      tenantId: sourceTenantId,
      userId: sourceUserId,
      wait: true,
      options: {
        fixtures: [{
          channelId: 'C-local',
          channelName: 'local-workflow',
          timestamp: new Date().toISOString(),
          sender: 'Local Workflow',
          text: `${marker} verifies UI-to-API fixture ingestion and assistant artifact generation.`,
          thread: [{ sender: 'Worker', text: 'The local workflow test should retrieve this thread.' }],
          files: [{ name: 'local-workflow.txt', text: marker }],
        }],
      },
    },
  });
  assert(sync.indexed >= 1, 'fixture sync did not index documents');
  const run = await apiRequest('/v1/search-runs', {
    method: 'POST',
    body: { tenantId: sourceTenantId, userId: sourceUserId, query: marker, sources: ['slack'], wait: true, limit: 5 },
  });
  assert(run.results?.length >= 1, 'fixture search-run returned no results');
  const action = await apiRequest('/v1/assistant/actions', {
    method: 'POST',
    body: {
      tenantId: sourceTenantId,
      userId: sourceUserId,
      searchRunId: run.searchRun.id,
      actionType: 'create_pdf',
      selectedResultIds: [run.results[0].id],
      prompt: 'Summarize the local frontend workflow test.',
    },
  });
  assert(action.actionJob?.status === 'completed', `assistant action did not complete: ${JSON.stringify(action.actionJob)}`);
  assert(action.actionJob?.artifactIds?.length, 'assistant action did not create an artifact');
  const deleted = await apiRequest('/v1/documents', {
    method: 'DELETE',
    body: { tenantId: sourceTenantId, userId: sourceUserId, source: 'slack', resetCheckpoints: true },
  });
  report.checks.push({
    name: 'fixture_ingestion_search_assistant_artifact_cleanup',
    status: 'ok',
    indexed: sync.indexed,
    resultCount: run.results.length,
    artifactIds: action.actionJob.artifactIds,
    deleted: deleted.deleted,
  });
}

async function apiRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  assert(response.ok && data.success !== false, `${method} ${path} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  assert(response.ok && data.success !== false, `GET ${url} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function fetchText(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert(response.ok, `GET ${url} failed: ${response.status}`);
  return text;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
