import crypto from 'node:crypto';
import { google } from 'googleapis';
import { loadConfig } from '../src/config.js';
import { GoogleDriveConnector } from '../src/connectors/gdrive.js';

const config = loadConfig();
const connector = new GoogleDriveConnector(config);
const baseUrl = (process.env.UNIFIED_SEARCH_BASE_URL || '').replace(/\/$/, '');
const webhookToken = config.gdrive.webhookToken;
const channelId = process.env.GDRIVE_WATCH_CHANNEL_ID || `atlas-gdrive-${crypto.randomUUID()}`;
const expirationMs = positiveInt(process.env.GDRIVE_WATCH_EXPIRATION_MS, 6 * 24 * 60 * 60 * 1000);
const dryRun = truthy(process.env.GDRIVE_WATCH_DRY_RUN);

if (!baseUrl) fail('UNIFIED_SEARCH_BASE_URL is required.');
if (!webhookToken) fail('GDRIVE_WEBHOOK_TOKEN is required.');
if (!config.gdrive.eventTenantId || !config.gdrive.eventUserId) {
  fail('GDRIVE_EVENT_TENANT_ID and GDRIVE_EVENT_USER_ID are required.');
}
if (!connector.isConfigured()) {
  fail('Google Drive OAuth refresh-token or service-account credentials are required.');
}

const address = `${baseUrl}/v1/webhooks/google-drive/changes`;
const drive = google.drive({ version: 'v3', auth: await connector.auth() });
const startPageToken = dryRun
  ? { data: { startPageToken: '[DRY_RUN_START_PAGE_TOKEN]' } }
  : await drive.changes.getStartPageToken({ supportsAllDrives: true });

const requestBody = {
  id: channelId,
  type: 'web_hook',
  address,
  token: webhookToken,
  expiration: String(Date.now() + expirationMs),
};

const watch = dryRun
  ? { data: { id: channelId, resourceId: '[DRY_RUN_RESOURCE_ID]', expiration: requestBody.expiration } }
  : await drive.changes.watch({
    pageToken: startPageToken.data.startPageToken,
    supportsAllDrives: true,
    requestBody,
  });

const report = {
  ok: true,
  dryRun,
  address,
  createdAt: new Date().toISOString(),
  channel: {
    id: watch.data.id,
    resourceId: watch.data.resourceId,
    expiration: watch.data.expiration ? new Date(Number(watch.data.expiration)).toISOString() : null,
  },
  startPageToken: startPageToken.data.startPageToken,
  wireEnv: {
    GDRIVE_WEBHOOK_CHANNEL_IDS: watch.data.id,
  },
  optionalPersistence: {
    GDRIVE_WATCH_RESOURCE_ID: watch.data.resourceId,
    GDRIVE_WATCH_START_PAGE_TOKEN: startPageToken.data.startPageToken,
    GDRIVE_WATCH_EXPIRATION: watch.data.expiration ? new Date(Number(watch.data.expiration)).toISOString() : null,
  },
  next: [
    `export GDRIVE_WEBHOOK_CHANNEL_IDS='${watch.data.id}'`,
    'WIRE_CONNECTORS_VALIDATE_FIRST=true npm run wire:production-connectors',
    'npm run status:webhooks',
    'UNIFIED_SEARCH_SMOKE_REQUIRE_LIVE_SOURCES=google_drive npm run smoke:production',
    'Persist startPageToken if you want the first webhook-triggered sync to resume from this exact point.',
  ],
};

console.log(JSON.stringify(report, null, 2));

function truthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
