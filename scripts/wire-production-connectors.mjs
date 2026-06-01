import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createConnectorRegistry } from '../src/connectors/index.js';

const resourceGroup = process.env.RESOURCE_GROUP || 'atlas-azure-backend-rg';
const apiApp = process.env.APP_NAME || 'atlas-unified-search';
const workerApp = process.env.WORKER_APP_NAME || 'atlas-unified-search-worker';
const baseUrl = process.env.UNIFIED_SEARCH_BASE_URL || '';
const token = process.env.UNIFIED_SEARCH_AUTH_TOKEN || '';
const validateFirst = truthy(process.env.WIRE_CONNECTORS_VALIDATE_FIRST);
const dryRun = truthy(process.env.WIRE_CONNECTORS_DRY_RUN);
const keyVaultName = process.env.CONNECTOR_KEYVAULT_NAME || process.env.KEYVAULT_NAME || '';
const keyVaultIdentity = process.env.CONNECTOR_KEYVAULT_IDENTITY || 'system';
const useKeyVaultRefs = truthy(process.env.WIRE_CONNECTORS_USE_KEYVAULT_REFS);

const apps = [
  { role: 'api', name: apiApp },
  { role: 'worker', name: workerApp },
];

const secretInputs = [
  ['SLACK_BOT_TOKEN', 'slack-bot-token'],
  ['SLACK_SIGNING_SECRET', 'slack-signing-secret'],
  ['GOOGLE_CLIENT_ID', 'google-client-id'],
  ['GOOGLE_CLIENT_SECRET', 'google-client-secret'],
  ['GOOGLE_REFRESH_TOKEN', 'google-refresh-token'],
  ['GOOGLE_SERVICE_ACCOUNT_JSON', 'google-service-account-json'],
  ['GDRIVE_WEBHOOK_TOKEN', 'gdrive-webhook-token'],
  ['CONFERENCE_EVENT_GRID_TOKEN', 'conference-event-grid-token'],
  ['DATA_FABRIC_API_TOKEN', 'data-fabric-api-token'],
];

const valueInputs = [
  'SLACK_CHANNEL_IDS',
  'SLACK_EVENT_TENANT_ID',
  'SLACK_EVENT_USER_ID',
  'GDRIVE_FOLDER_IDS',
  'GDRIVE_WEBHOOK_CHANNEL_IDS',
  'GDRIVE_WATCH_RESOURCE_ID',
  'GDRIVE_WATCH_START_PAGE_TOKEN',
  'GDRIVE_WATCH_EXPIRATION',
  'GDRIVE_EVENT_TENANT_ID',
  'GDRIVE_EVENT_USER_ID',
  'DATA_FABRIC_BASE_URL',
  'DATA_FABRIC_READINESS_PATH',
  'DATA_FABRIC_RECORDS_PATH',
  'CONFERENCE_EVENT_TENANT_ID',
  'CONFERENCE_EVENT_USER_ID',
];

const configured = [];
const plannedCommands = [];
const keyVaultSecrets = new Map();

if (keyVaultName) {
  hydrateSecretsFromKeyVault();
}

if (validateFirst) {
  const validation = await validateConfiguredSources();
  if (!validation.ok) {
    console.error(JSON.stringify({
      ok: false,
      error: 'Connector credential preflight failed; Azure apps were not updated.',
      validation,
    }, null, 2));
    process.exit(1);
  }
}

for (const app of apps) {
  const secrets = secretInputs
    .filter(([envName, secretName]) => has(envName) || hasKeyVaultSecret(secretName))
    .map(([envName, secretName]) => {
      if (useKeyVaultRefs && hasKeyVaultSecret(secretName)) {
        return `${secretName}=keyvaultref:${keyVaultSecretUrl(secretName)},identityref:${keyVaultIdentity}`;
      }
      return `${secretName}=${process.env[envName]}`;
    });

  if (secrets.length) {
    az(app, [
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
    az(app, [
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
  dryRun,
  keyVault: keyVaultName
    ? {
        name: keyVaultName,
        refsEnabled: useKeyVaultRefs,
        identity: useKeyVaultRefs ? keyVaultIdentity : undefined,
        hydratedSecrets: secretInputs
          .filter(([, secretName]) => hasKeyVaultSecret(secretName))
          .map(([, secretName]) => secretName),
      }
    : undefined,
  configured,
  plannedCommands,
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

function hasKeyVaultSecret(secretName) {
  return keyVaultSecrets.has(secretName);
}

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function az(app, args) {
  const redactedArgs = args.map((arg) => redactCommandArg(arg));
  plannedCommands.push({ role: app.role, app: app.name, args: redactedArgs });
  if (dryRun) return;
  execFileSync('az', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function hydrateSecretsFromKeyVault() {
  for (const [envName, secretName] of secretInputs) {
    if (has(envName) && !useKeyVaultRefs) continue;
    const value = readKeyVaultSecret(secretName);
    if (!value) continue;
    if (!has(envName)) process.env[envName] = value;
    keyVaultSecrets.set(secretName, true);
  }
}

function readKeyVaultSecret(secretName) {
  try {
    return execFileSync('az', [
      'keyvault',
      'secret',
      'show',
      '--vault-name',
      keyVaultName,
      '--name',
      secretName,
      '--query',
      'value',
      '-o',
      'tsv',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function keyVaultSecretUrl(secretName) {
  return `https://${keyVaultName}.vault.azure.net/secrets/${secretName}`;
}

function redactCommandArg(arg) {
  const text = String(arg);
  if (text.includes('=')) {
    const [name, ...rest] = text.split('=');
    const value = rest.join('=');
    if (/token|secret|key|connection|string|json/i.test(name) && !value.startsWith('secretref:')) {
      return `${name}=[REDACTED]`;
    }
  }
  return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1[REDACTED]');
}

async function validateConfiguredSources() {
  const sources = [
    ...(has('SLACK_BOT_TOKEN') || has('SLACK_CHANNEL_IDS') ? ['slack'] : []),
    ...(has('GOOGLE_SERVICE_ACCOUNT_JSON') || has('GOOGLE_CLIENT_ID') || has('GOOGLE_CLIENT_SECRET') || has('GOOGLE_REFRESH_TOKEN') ? ['google_drive'] : []),
    ...(has('DATA_FABRIC_BASE_URL') || has('DATA_FABRIC_API_TOKEN') ? ['data_fabric'] : []),
  ];
  const webhookMappings = validateWebhookMappings(sources);
  if (!sources.length) return { ok: webhookMappings.ok, sources: [], webhookMappings };

  const registry = createConnectorRegistry(loadConfig());
  const results = [];
  for (const source of sources) {
    const connector = registry.get(source);
    const readiness = (await registry.readiness(source))[0];
    const item = {
      source,
      ok: Boolean(readiness.ready),
      status: readiness.status,
      missing: (readiness.requirements || [])
        .filter((requirement) => !requirement.configured && !requirement.optional)
        .map((requirement) => requirement.name),
      error: readiness.error || '',
      probes: [],
    };
    if (item.ok) {
      item.probes = await probeConfiguredSource(source, connector);
      item.ok = item.probes.every((probe) => probe.ok);
    }
    results.push(item);
  }
  return { ok: results.every((item) => item.ok) && webhookMappings.ok, sources: results, webhookMappings };
}

function validateWebhookMappings(sources) {
  const checks = [];
  if (sources.includes('slack')) {
    checks.push(requiredEnvGroup('slack_events', [
      'SLACK_SIGNING_SECRET',
      'SLACK_EVENT_TENANT_ID',
      'SLACK_EVENT_USER_ID',
    ]));
  }
  if (sources.includes('google_drive')) {
    checks.push(requiredEnvGroup('google_drive_changes', [
      'GDRIVE_WEBHOOK_TOKEN',
      'GDRIVE_WEBHOOK_CHANNEL_IDS',
      'GDRIVE_EVENT_TENANT_ID',
      'GDRIVE_EVENT_USER_ID',
    ]));
  }
  return { ok: checks.every((check) => check.ok), checks };
}

function requiredEnvGroup(name, envNames) {
  const missing = envNames.filter((envName) => !has(envName));
  return {
    name,
    ok: missing.length === 0,
    missing,
  };
}

async function probeConfiguredSource(source, connector) {
  if (source === 'slack') return probeSlack(connector);
  if (source === 'google_drive') return probeGoogleDrive(connector);
  if (source === 'data_fabric') return probeDataFabric(connector);
  return [{ name: 'readiness', ok: true }];
}

async function probeSlack(connector) {
  const channelIds = connector.config.channelIds.slice(0, 3);
  const probes = [];
  for (const channelId of channelIds) {
    try {
      const history = await connector.call('conversations.history', { channel: channelId, limit: '1' });
      probes.push({
        name: 'slack_channel_history',
        ok: true,
        channelId,
        sampleMessageVisible: Boolean(history.messages?.length),
      });
    } catch (error) {
      probes.push({ name: 'slack_channel_history', ok: false, channelId, error: error.message });
    }
  }
  return probes.length ? probes : [{ name: 'slack_channel_history', ok: false, error: 'No Slack channel IDs configured' }];
}

async function probeGoogleDrive(connector) {
  try {
    const drive = (await import('googleapis')).google.drive({ version: 'v3', auth: await connector.auth() });
    const files = await connector.listFiles(drive, { limit: 1, folderIds: connector.config.folderIds });
    return [{
      name: 'google_drive_file_list',
      ok: true,
      folderScoped: Boolean(connector.config.folderIds.length),
      sampleFileVisible: Boolean(files.length),
    }];
  } catch (error) {
    return [{ name: 'google_drive_file_list', ok: false, error: error.message }];
  }
}

async function probeDataFabric(connector) {
  try {
    const readinessResult = await connector.checkReadiness();
    return [{ name: 'data_fabric_readiness', ok: Boolean(readinessResult.ready), status: readinessResult.status }];
  } catch (error) {
    return [{ name: 'data_fabric_readiness', ok: false, error: error.message }];
  }
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
