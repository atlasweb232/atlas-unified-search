import { execFileSync } from 'node:child_process';

const resourceGroup = process.env.RESOURCE_GROUP || 'atlas-azure-backend-rg';
const apiApp = process.env.APP_NAME || 'atlas-unified-search';
const workerApp = process.env.WORKER_APP_NAME || 'atlas-unified-search-worker';
const schedulerApp = process.env.SCHEDULER_APP_NAME || 'atlas-unified-search-scheduler';
const baseUrl = process.env.UNIFIED_SEARCH_BASE_URL || '';
const token = process.env.UNIFIED_SEARCH_AUTH_TOKEN || '';

const api = loadContainerApp(apiApp);
const worker = loadContainerApp(workerApp);
const scheduler = loadContainerApp(schedulerApp, { optional: true });
const apiEnv = envMap(api);
const workerEnv = envMap(worker);
const schedulerEnv = scheduler ? envMap(scheduler) : {};

const report = {
  generatedAt: new Date().toISOString(),
  resourceGroup,
  apps: {
    api: summarizeApp(api, apiEnv),
    worker: summarizeApp(worker, workerEnv),
    scheduler: scheduler ? summarizeApp(scheduler, schedulerEnv) : { name: schedulerApp, present: false },
  },
  gates: {
    infrastructure: [
      envGate(apiEnv, 'UNIFIED_SEARCH_AUTH_TOKEN', 'secretRef'),
      envGate(apiEnv, 'POSTGRES_CONNECTION_STRING', 'secretRef'),
      envGate(apiEnv, 'SERVICE_BUS_CONNECTION_STRING', 'secretRef'),
      envGate(apiEnv, 'OPENAI_API_KEY', 'secretRef'),
      envGate(apiEnv, 'ARTIFACT_STORAGE_CONNECTION_STRING', 'secretRef'),
      envGate(workerEnv, 'POSTGRES_CONNECTION_STRING', 'secretRef', 'worker'),
      envGate(workerEnv, 'SERVICE_BUS_CONNECTION_STRING', 'secretRef', 'worker'),
    ],
    scheduler: [
      {
        name: 'scheduler_app',
        present: Boolean(scheduler),
        satisfied: Boolean(scheduler) || !truthyEnv(apiEnv, 'UNIFIED_SEARCH_SCHEDULER_REQUIRED'),
        kind: scheduler ? 'containerApp' : 'missing',
      },
      ...(scheduler ? [
        envGate(schedulerEnv, 'UNIFIED_SEARCH_SYNC_SCHEDULES', 'secretRef', 'scheduler'),
        alternativeGate('scheduler_backend', [
          groupGate('api_scheduler', [
            envGate(schedulerEnv, 'UNIFIED_SEARCH_API_BASE_URL', 'value', 'scheduler'),
            envGate(schedulerEnv, 'UNIFIED_SEARCH_AUTH_TOKEN', 'secretRef', 'scheduler'),
          ]),
          groupGate('direct_store_scheduler', [
            envGate(schedulerEnv, 'POSTGRES_CONNECTION_STRING', 'secretRef', 'scheduler'),
            envGate(schedulerEnv, 'SERVICE_BUS_CONNECTION_STRING', 'secretRef', 'scheduler'),
          ]),
        ]),
      ] : []),
    ],
    liveConnectors: [
      groupGate('email', [
        envGate(apiEnv, 'EMAIL_VECTOR_SEARCH_URL', 'value'),
        envGate(apiEnv, 'EMAIL_READINESS_USER_EMAIL', 'value'),
      ]),
      groupGate('conference_bridge', [
        envGate(apiEnv, 'AZURE_STORAGE_CONNECTION_STRING', 'secretRef'),
        envGate(apiEnv, 'CONFERENCE_BLOB_CONTAINERS', 'value'),
        envGate(workerEnv, 'AZURE_STORAGE_CONNECTION_STRING', 'secretRef', 'worker'),
        envGate(workerEnv, 'CONFERENCE_BLOB_CONTAINERS', 'value', 'worker'),
      ]),
      groupGate('knowledge_base', [
        envGate(apiEnv, 'KNOWLEDGE_BASE_ROOT', 'value'),
        envGate(workerEnv, 'KNOWLEDGE_BASE_ROOT', 'value', 'worker'),
      ]),
    ],
    credentialBlockedConnectors: [
      groupGate('slack', [
        envGate(apiEnv, 'SLACK_BOT_TOKEN', 'secretRef'),
        envGate(apiEnv, 'SLACK_CHANNEL_IDS', 'value'),
        envGate(workerEnv, 'SLACK_BOT_TOKEN', 'secretRef', 'worker'),
        envGate(workerEnv, 'SLACK_CHANNEL_IDS', 'value', 'worker'),
      ]),
      groupGate('google_drive', [
        alternativeGate('google_auth', [
          groupGate('oauth_refresh_token', [
            envGate(apiEnv, 'GOOGLE_CLIENT_ID', 'secretRef'),
            envGate(apiEnv, 'GOOGLE_CLIENT_SECRET', 'secretRef'),
            envGate(apiEnv, 'GOOGLE_REFRESH_TOKEN', 'secretRef'),
            envGate(workerEnv, 'GOOGLE_CLIENT_ID', 'secretRef', 'worker'),
            envGate(workerEnv, 'GOOGLE_CLIENT_SECRET', 'secretRef', 'worker'),
            envGate(workerEnv, 'GOOGLE_REFRESH_TOKEN', 'secretRef', 'worker'),
          ]),
          groupGate('service_account', [
            envGate(apiEnv, 'GOOGLE_SERVICE_ACCOUNT_JSON', 'secretRef'),
            envGate(workerEnv, 'GOOGLE_SERVICE_ACCOUNT_JSON', 'secretRef', 'worker'),
          ]),
        ]),
      ]),
    ],
    futureConnectors: [
      groupGate('data_fabric', [
        envGate(apiEnv, 'DATA_FABRIC_BASE_URL', 'value'),
        envGate(apiEnv, 'DATA_FABRIC_API_TOKEN', 'secretRef', 'api', true),
        envGate(apiEnv, 'DATA_FABRIC_READINESS_PATH', 'value', 'api', true),
        envGate(apiEnv, 'DATA_FABRIC_RECORDS_PATH', 'value', 'api', true),
        envGate(workerEnv, 'DATA_FABRIC_BASE_URL', 'value', 'worker'),
        envGate(workerEnv, 'DATA_FABRIC_API_TOKEN', 'secretRef', 'worker', true),
        envGate(workerEnv, 'DATA_FABRIC_READINESS_PATH', 'value', 'worker', true),
        envGate(workerEnv, 'DATA_FABRIC_RECORDS_PATH', 'value', 'worker', true),
      ]),
    ],
  },
};

if (baseUrl && token) {
  report.runtime = await runtimeReadiness(baseUrl, token);
}

report.summary = {
  infrastructureReady: report.gates.infrastructure.every((gate) => gate.present),
  liveConnectorConfigReady: report.gates.liveConnectors.every((gate) => gate.ready),
  credentialBlocked: report.gates.credentialBlockedConnectors
    .filter((gate) => !gate.ready)
    .map((gate) => gate.name),
  futureBlocked: report.gates.futureConnectors
    .filter((gate) => !gate.ready)
    .map((gate) => gate.name),
  productionReadinessEndpointReady: Boolean(report.runtime?.productionReadiness?.readyForProductionTesting),
  productionComplete: Boolean(report.runtime?.productionReadiness?.productionComplete),
  schedulerReady: report.gates.scheduler.every((gate) => gateReady(gate)),
};

console.log(JSON.stringify(redact(report), null, 2));

function loadContainerApp(name, { optional = false } = {}) {
  try {
    const raw = execFileSync('az', [
      'containerapp',
      'show',
      '--resource-group',
      resourceGroup,
      '--name',
      name,
      '-o',
      'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', optional ? 'ignore' : 'inherit'] });
    return JSON.parse(raw);
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

function envMap(app) {
  const env = app.properties?.template?.containers?.[0]?.env || [];
  return Object.fromEntries(env.map((item) => [item.name, item]));
}

function summarizeApp(app, env) {
  return {
    name: app.name,
    latestRevision: app.properties?.latestRevisionName,
    image: app.properties?.template?.containers?.[0]?.image,
    fqdn: app.properties?.configuration?.ingress?.fqdn || '',
    envNames: Object.keys(env).sort(),
  };
}

function truthyEnv(env, name) {
  return ['1', 'true', 'yes'].includes(String(env[name]?.value || '').toLowerCase());
}

function envGate(env, name, expectedKind, app = 'api', optional = false) {
  const item = env[name] || {};
  const kind = item.secretRef ? 'secretRef' : item.value ? 'value' : 'missing';
  const present = kind !== 'missing';
  return {
    app,
    name,
    optional,
    present,
    satisfied: optional || kind === expectedKind || (expectedKind === 'any' && present),
    kind,
  };
}

function groupGate(name, gates) {
  return {
    name,
    ready: gates.every((gate) => gate.ready ?? gate.satisfied ?? gate.present),
    gates,
  };
}

function alternativeGate(name, alternatives) {
  return {
    name,
    ready: alternatives.some((alternative) => alternative.ready),
    alternatives,
  };
}

function gateReady(gate) {
  return gate.ready ?? gate.satisfied ?? gate.present ?? false;
}

async function runtimeReadiness(url, authToken) {
  const base = url.replace(/\/$/, '');
  const response = await fetch(`${base}/v1/production-readiness`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const data = await response.json().catch(() => ({}));
  return {
    status: response.status,
    ok: response.ok,
    productionReadiness: data.report ? {
      readyForProductionTesting: data.report.readyForProductionTesting,
      productionComplete: data.report.productionComplete,
      credentialBlockedSources: data.report.credentialBlockedSources?.map((item) => ({
        source: item.source,
        status: item.status,
        missing: item.missing,
      })),
      liveSources: data.report.liveSources,
      futureSources: data.report.futureSources,
    } : null,
  };
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/token|secret|password|connection/i.test(key)) return [key, '[REDACTED]'];
    return [key, redact(entry)];
  }));
}
