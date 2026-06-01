import { execFileSync } from 'node:child_process';

const resourceGroup = process.env.RESOURCE_GROUP || 'atlas-azure-backend-rg';
const apiAppName = process.env.APP_NAME || 'atlas-unified-search';
const workerAppName = process.env.WORKER_APP_NAME || 'atlas-unified-search-worker';
const schedulerAppName = process.env.SCHEDULER_APP_NAME || 'atlas-unified-search-scheduler';
const serviceBusNamespace = process.env.SERVICE_BUS_NAMESPACE || 'atlas-reg-sb-2ba6c25e';
const serviceBusQueue = process.env.SERVICE_BUS_SYNC_QUEUE_NAME || 'unified-search-sync';
const authToken = process.env.UNIFIED_SEARCH_AUTH_TOKEN || '';

const apiApp = loadContainerApp(apiAppName);
const workerApp = loadContainerApp(workerAppName);
const schedulerApp = loadContainerApp(schedulerAppName, { optional: true });
const baseUrl = (process.env.UNIFIED_SEARCH_BASE_URL || `https://${apiApp.properties?.configuration?.ingress?.fqdn || ''}`).replace(/\/$/, '');

const [health, queue] = await Promise.all([
  fetchJson(`${baseUrl}/v1/health`, { optional: true }),
  loadQueueCounts({ optional: true }),
]);

const protectedRuntime = authToken
  ? await protectedStatus(baseUrl, authToken)
  : { skipped: true, reason: 'UNIFIED_SEARCH_AUTH_TOKEN is not set' };

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  apps: {
    api: summarizeApp(apiApp),
    worker: summarizeApp(workerApp),
    scheduler: schedulerApp ? summarizeApp(schedulerApp) : { name: schedulerAppName, present: false },
  },
  queue,
  publicHealth: summarizeHealth(health),
  protectedRuntime,
};

report.summary = summarizeReadiness(report);
console.log(JSON.stringify(report, null, 2));

function loadContainerApp(name, { optional = false } = {}) {
  try {
    return JSON.parse(execFileSync('az', [
      'containerapp',
      'show',
      '--resource-group',
      resourceGroup,
      '--name',
      name,
      '-o',
      'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', optional ? 'ignore' : 'inherit'] }));
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

function loadQueueCounts({ optional = false } = {}) {
  try {
    return JSON.parse(execFileSync('az', [
      'servicebus',
      'queue',
      'show',
      '--resource-group',
      resourceGroup,
      '--namespace-name',
      serviceBusNamespace,
      '--name',
      serviceBusQueue,
      '--query',
      '{active:countDetails.activeMessageCount,deadLetter:countDetails.deadLetterMessageCount,scheduled:countDetails.scheduledMessageCount}',
      '-o',
      'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', optional ? 'ignore' : 'inherit'] }));
  } catch (error) {
    if (optional) return { unavailable: true, error: error.message };
    throw error;
  }
}

function summarizeApp(app) {
  const container = app.properties?.template?.containers?.[0] || {};
  return {
    name: app.name,
    image: container.image || '',
    latestRevision: app.properties?.latestRevisionName || '',
    readyRevision: app.properties?.latestReadyRevisionName || '',
    runningStatus: app.properties?.runningStatus || '',
    ready: Boolean(app.properties?.latestRevisionName && app.properties.latestRevisionName === app.properties?.latestReadyRevisionName),
  };
}

async function protectedStatus(url, token) {
  const [readiness, productionReadiness, indexStatus] = await Promise.all([
    fetchJson(`${url}/v1/connectors/readiness`, { token, optional: true }),
    fetchJson(`${url}/v1/production-readiness`, { token, optional: true }),
    fetchJson(`${url}/v1/index/status?tenantId=atlasweb&userId=rakib.mahmood%40tridentinter.io`, { token, optional: true }),
  ]);
  const checks = readiness.body?.checks || [];
  const report = productionReadiness.body?.report || {};
  return {
    connectors: checks.map((item) => ({
      source: item.source,
      ready: Boolean(item.ready),
      status: item.status,
      missing: item.ready ? [] : (item.requirements || [])
        .filter((requirement) => !requirement.configured && !requirement.optional)
        .map((requirement) => requirement.name),
    })),
    productionReadiness: {
      status: productionReadiness.status,
      readyForProductionTesting: Boolean(report.readyForProductionTesting),
      productionComplete: Boolean(report.productionComplete),
      credentialBlockedSources: (report.credentialBlockedSources || []).map((item) => item.source),
      futureSources: report.futureSources || [],
    },
    scopedIndexStatus: indexStatus.ok ? indexStatus.body?.index : { unavailable: true, status: indexStatus.status },
  };
}

async function fetchJson(url, { token = '', optional = false } = {}) {
  try {
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    if (optional) return { ok: false, status: 0, body: {}, error: error.message };
    throw error;
  }
}

function summarizeHealth(result) {
  const body = result.body || {};
  return {
    status: result.status,
    ok: Boolean(result.ok),
    service: body.service || '',
    authRequired: Boolean(body.auth?.required),
    indexBackend: body.index?.backend || '',
    queueBackend: body.queue?.backend || '',
    artifactBackend: body.artifacts?.backend || '',
    nonEnumerating: body.connectors === undefined
      && body.index?.bySource === undefined
      && body.index?.documents === undefined
      && body.index?.chunks === undefined
      && body.index?.jobs === undefined,
  };
}

function summarizeReadiness(status) {
  const appsReady = Object.values(status.apps).every((app) => app.present === false || app.ready);
  const queueClean = status.queue && !status.queue.unavailable
    && status.queue.active === 0
    && status.queue.deadLetter === 0
    && status.queue.scheduled === 0;
  const healthReady = status.publicHealth.ok
    && status.publicHealth.authRequired
    && status.publicHealth.indexBackend === 'postgres-pgvector'
    && status.publicHealth.queueBackend === 'azure-service-bus'
    && status.publicHealth.artifactBackend === 'azure-blob-artifact'
    && status.publicHealth.nonEnumerating;
  const runtime = status.protectedRuntime.productionReadiness || {};
  return {
    productionTestable: Boolean(appsReady && queueClean && healthReady && runtime.readyForProductionTesting),
    productionComplete: Boolean(runtime.productionComplete),
    appsReady,
    queueClean,
    healthReady,
    credentialBlocked: runtime.credentialBlockedSources || [],
    futureSources: runtime.futureSources || [],
  };
}
