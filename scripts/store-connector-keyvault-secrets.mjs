import { execFileSync } from 'node:child_process';

const keyVaultName = process.env.CONNECTOR_KEYVAULT_NAME || process.env.KEYVAULT_NAME || '';
const dryRun = truthy(process.env.CONNECTOR_KEYVAULT_DRY_RUN);

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

if (!keyVaultName) {
  console.error(JSON.stringify({
    ok: false,
    error: 'CONNECTOR_KEYVAULT_NAME or KEYVAULT_NAME is required',
  }, null, 2));
  process.exit(1);
}

const configured = [];
const plannedCommands = [];

for (const [envName, secretName] of secretInputs) {
  if (!has(envName)) continue;
  const args = [
    'keyvault',
    'secret',
    'set',
    '--vault-name',
    keyVaultName,
    '--name',
    secretName,
    '--value',
    process.env[envName],
    '--output',
    'none',
  ];
  plannedCommands.push(redactArgs(args));
  if (!dryRun) execFileSync('az', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  configured.push({ envName, secretName });
}

console.log(JSON.stringify({
  ok: true,
  dryRun,
  keyVaultName,
  configured,
  plannedCommands,
  next: [
    'CONNECTOR_KEYVAULT_NAME=<vault> WIRE_CONNECTORS_VALIDATE_FIRST=true WIRE_CONNECTORS_DRY_RUN=true npm run wire:production-connectors',
    'CONNECTOR_KEYVAULT_NAME=<vault> WIRE_CONNECTORS_VALIDATE_FIRST=true npm run wire:production-connectors',
  ],
}, null, 2));

function has(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim() !== '';
}

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function redactArgs(args) {
  const redacted = [];
  for (let index = 0; index < args.length; index += 1) {
    redacted.push(args[index] === '--value' ? '--value' : args[index - 1] === '--value' ? '[REDACTED]' : args[index]);
  }
  return redacted;
}
