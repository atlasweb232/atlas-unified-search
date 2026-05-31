import { execFileSync } from 'node:child_process';

const resourceGroup = process.env.RESOURCE_GROUP || 'atlas-azure-backend-rg';
const apiApp = process.env.APP_NAME || 'atlas-unified-search';
const workerApp = process.env.WORKER_APP_NAME || 'atlas-unified-search-worker';
const baseUrl = process.env.UNIFIED_SEARCH_BASE_URL || '';
const token = process.env.UNIFIED_SEARCH_AUTH_TOKEN || '';

const apps = [
  { role: 'api', name: apiApp },
  { role: 'worker', name: workerApp },
];

const secretInputs = [
  ['SLACK_BOT_TOKEN', 'slack-bot-token'],
  ['GOOGLE_CLIENT_ID', 'google-client-id'],
  ['GOOGLE_CLIENT_SECRET', 'google-client-secret'],
  ['GOOGLE_REFRESH_TOKEN', 'google-refresh-token'],
  ['GOOGLE_SERVICE_ACCOUNT_JSON', 'google-service-account-json'],
  ['DATA_FABRIC_API_TOKEN', 'data-fabric-api-token'],
];

const valueInputs = [
  'SLACK_CHANNEL_IDS',
  'GDRIVE_FOLDER_IDS',
  'DATA_FABRIC_BASE_URL',
  'DATA_FABRIC_READINESS_PATH',
  'DATA_FABRIC_RECORDS_PATH',
];

const configured = [];

for (const app of apps) {
  const secrets = secretInputs
    .filter(([envName]) => has(envName))
    .map(([envName, secretName]) => `${secretName}=${process.env[envName]}`);

  if (secrets.length) {
    az([
      'containerapp',
      'secret',
      'set',
      '--resource-group',
      resourceGroup,
      '--name',
      app.name,
      '--secrets',
      ...secrets,
    ]);
  }

  const envVars = [
    ...secretInputs
      .filter(([envName]) => has(envName))
      .map(([envName, secretName]) => `${envName}=secretref:${secretName}`),
    ...valueInputs
      .filter((envName) => has(envName))
      .map((envName) => `${envName}=${process.env[envName]}`),
  ];

  if (envVars.length) {
    az([
      'containerapp',
      'update',
      '--resource-group',
      resourceGroup,
      '--name',
      app.name,
      '--set-env-vars',
      ...envVars,
    ]);
  }

  configured.push({
    role: app.role,
    app: app.name,
    secrets: secretInputs.filter(([envName]) => has(envName)).map(([, secretName]) => secretName),
    values: valueInputs.filter((envName) => has(envName)),
  });
}

const report = {
  resourceGroup,
  configured,
  nextChecks: [
    'npm run audit:production-config',
    'GET /v1/connectors/readiness with Authorization bearer token',
    'Run /v1/reindex/slack and /v1/reindex/google_drive with real tenant/user scope after readiness is true',
  ],
};

if (baseUrl && token) {
  report.runtime = await readiness(baseUrl, token);
}

console.log(JSON.stringify(report, null, 2));

function has(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim() !== '';
}

function az(args) {
  execFileSync('az', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

async function readiness(url, authToken) {
  const base = url.replace(/\/$/, '');
  const [connectors, production] = await Promise.all([
    getJson(`${base}/v1/connectors/readiness`, authToken),
    getJson(`${base}/v1/production-readiness`, authToken),
  ]);

  return {
    connectorReadiness: connectors.body?.checks?.map((item) => ({
      source: item.source,
      ready: item.ready,
      status: item.status,
      missing: item.missing,
    })),
    productionReadiness: {
      readyForProductionTesting: production.body?.report?.readyForProductionTesting,
      productionComplete: production.body?.report?.productionComplete,
      credentialBlockedSources: production.body?.report?.credentialBlockedSources?.map((item) => item.source),
    },
  };
}

async function getJson(url, authToken) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}
