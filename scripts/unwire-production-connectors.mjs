import { execFileSync } from 'node:child_process';

const resourceGroup = process.env.RESOURCE_GROUP || 'atlas-azure-backend-rg';
const apiApp = process.env.APP_NAME || 'atlas-unified-search';
const workerApp = process.env.WORKER_APP_NAME || 'atlas-unified-search-worker';
const dryRun = truthy(process.env.UNWIRE_CONNECTORS_DRY_RUN);
const sources = parseSources(process.env.UNWIRE_CONNECTOR_SOURCES || process.env.CONNECTOR_SOURCES || '');

const apps = [
  { role: 'api', name: apiApp },
  { role: 'worker', name: workerApp },
];

const sourceEnv = {
  slack: ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_IDS', 'SLACK_SIGNING_SECRET', 'SLACK_EVENT_TENANT_ID', 'SLACK_EVENT_USER_ID'],
  google_drive: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'GDRIVE_FOLDER_IDS'],
  data_fabric: ['DATA_FABRIC_BASE_URL', 'DATA_FABRIC_API_TOKEN', 'DATA_FABRIC_READINESS_PATH', 'DATA_FABRIC_RECORDS_PATH'],
};

const plannedCommands = [];
const selected = sources.length ? sources : Object.keys(sourceEnv);
const unknown = selected.filter((source) => !sourceEnv[source]);
if (unknown.length) {
  console.error(JSON.stringify({ ok: false, error: 'Unsupported connector source', unknown, supported: Object.keys(sourceEnv) }, null, 2));
  process.exit(1);
}

for (const app of apps) {
  const envNames = [...new Set(selected.flatMap((source) => sourceEnv[source]))];
  if (!envNames.length) continue;
  az(app, [
    'containerapp',
    'update',
    '--resource-group',
    resourceGroup,
    '--name',
    app.name,
    '--remove-env-vars',
    ...envNames,
    '--output',
    'none',
  ]);
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  resourceGroup,
  apps: apps.map((app) => app.name),
  sources: selected,
  removedEnvVars: Object.fromEntries(selected.map((source) => [source, sourceEnv[source]])),
  plannedCommands,
  note: 'Secrets are not deleted; only Container App env var bindings are removed.',
}, null, 2));

function az(app, args) {
  plannedCommands.push({ role: app.role, app: app.name, args });
  if (dryRun) return;
  execFileSync('az', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function parseSources(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}
