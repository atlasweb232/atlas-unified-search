import crypto from 'node:crypto';
import { google } from 'googleapis';
import { loadConfig } from '../src/config.js';
import { GoogleDriveConnector } from '../src/connectors/gdrive.js';

const config = loadConfig();
const connector = new GoogleDriveConnector(config);
const baseUrl = (process.env.UNIFIED_SEARCH_BASE_URL || '').replace(/\/$/, '');
const webhookToken = config.gdrive.webhookToken;
const previousChannelId = process.env.GDRIVE_PREVIOUS_WATCH_CHANNEL_ID || config.gdrive.webhookChannelIds[0] || '';
const previousResourceId = process.env.GDRIVE_PREVIOUS_WATCH_RESOURCE_ID || process.env.GDRIVE_WATCH_RESOURCE_ID || '';
const channelId = process.env.GDRIVE_WATCH_CHANNEL_ID || `atlas-gdrive-${crypto.randomUUID()}`;
const expirationMs = positiveInt(process.env.GDRIVE_WATCH_EXPIRATION_MS, 6 * 24 * 60 * 60 * 1000);
const dryRun = truthy(process.env.GDRIVE_WATCH_DRY_RUN);
const stopPrevious = !['0', 'false', 'no'].includes(String(process.env.GDRIVE_WATCH_STOP_PREVIOUS || 'true').toLowerCase());
const ignoreStopFailure = truthy(process.env.GDRIVE_WATCH_IGNORE_STOP_FAILURE);

if (!baseUrl) fail('UNIFIED_SEARCH_BASE_URL is required.');
if (!webhookToken) fail('GDRIVE_WEBHOOK_TOKEN is required.');
if (!config.gdrive.eventTenantId || !config.gdrive.eventUserId) {
  fail('GDRIVE_EVENT_TENANT_ID and GDRIVE_EVENT_USER_ID are required.');
}
if (!connector.isConfigured()) {
  fail('Google Drive OAuth refresh-token or service-account credentials are required.');
}
if (stopPrevious && previousChannelId && !previousResourceId) {
  fail('GDRIVE_PREVIOUS_WATCH_RESOURCE_ID or GDRIVE_WATCH_RESOURCE_ID is required to stop the previous watch channel.');
}

const address = `${baseUrl}/v1/webhooks/google-drive/changes`;
const drive = google.drive({ version: 'v3', auth: await connector.auth() });
const stoppedPrevious = await stopPreviousWatch(drive);
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

const expiration = watch.data.expiration ? new Date(Number(watch.data.expiration)).toISOString() : null;
const report = {
  ok: true,
  dryRun,
  address,
  renewedAt: new Date().toISOString(),
  previousChannel: previousChannelId ? {
    id: previousChannelId,
    resourceId: previousResourceId || null,
    stopAttempted: Boolean(stopPrevious),
    stopped: stoppedPrevious.stopped,
    warning: stoppedPrevious.warning || undefined,
  } : null,
  channel: {
    id: watch.data.id,
    resourceId: watch.data.resourceId,
    expiration,
  },
  startPageToken: startPageToken.data.startPageToken,
  wireEnv: {
    GDRIVE_WEBHOOK_CHANNEL_IDS: watch.data.id,
    GDRIVE_WATCH_RESOURCE_ID: watch.data.resourceId,
    GDRIVE_WATCH_START_PAGE_TOKEN: startPageToken.data.startPageToken,
    GDRIVE_WATCH_EXPIRATION: expiration,
  },
  next: [
    'Wire the values in wireEnv into the API Container App.',
    'Run WIRE_CONNECTORS_VALIDATE_FIRST=true npm run wire:production-connectors if using the connector wiring helper.',
    'Run npm run audit:production-config and confirm gdriveWatchRenewalStatus=ok.',
    'Run npm run status:webhooks.',
  ],
};

console.log(JSON.stringify(report, null, 2));

async function stopPreviousWatch(driveClient) {
  if (!stopPrevious || !previousChannelId) return { stopped: false };
  if (dryRun) return { stopped: true };
  try {
    await driveClient.channels.stop({
      requestBody: {
        id: previousChannelId,
        resourceId: previousResourceId,
      },
    });
    return { stopped: true };
  } catch (error) {
    if (ignoreStopFailure) return { stopped: false, warning: error.message };
    throw error;
  }
}

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
