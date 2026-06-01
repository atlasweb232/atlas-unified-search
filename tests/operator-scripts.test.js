import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('google drive watch renewal dry-run prints new wireable metadata without real Google calls', async () => {
  const { stdout } = await execFileAsync('node', ['scripts/renew-google-drive-watch.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      UNIFIED_SEARCH_BASE_URL: 'https://search.example.com',
      GDRIVE_WEBHOOK_TOKEN: 'test-webhook-token',
      GDRIVE_EVENT_TENANT_ID: 'tenant-a',
      GDRIVE_EVENT_USER_ID: 'user-a',
      GDRIVE_WEBHOOK_CHANNEL_IDS: 'old-channel',
      GDRIVE_WATCH_RESOURCE_ID: 'old-resource',
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        type: 'service_account',
        project_id: 'atlas-test',
        client_email: 'atlas-test@example.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----\\n',
      }),
      GDRIVE_WATCH_DRY_RUN: 'true',
      GDRIVE_WATCH_CHANNEL_ID: 'new-channel',
    },
  });

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.address, 'https://search.example.com/v1/webhooks/google-drive/changes');
  assert.equal(report.previousChannel.id, 'old-channel');
  assert.equal(report.previousChannel.resourceId, 'old-resource');
  assert.equal(report.previousChannel.stopAttempted, true);
  assert.equal(report.previousChannel.stopped, true);
  assert.equal(report.channel.id, 'new-channel');
  assert.equal(report.wireEnv.GDRIVE_WEBHOOK_CHANNEL_IDS, 'new-channel');
  assert.equal(report.wireEnv.GDRIVE_WATCH_RESOURCE_ID, '[DRY_RUN_RESOURCE_ID]');
  assert.equal(report.wireEnv.GDRIVE_WATCH_START_PAGE_TOKEN, '[DRY_RUN_START_PAGE_TOKEN]');
  assert.ok(report.wireEnv.GDRIVE_WATCH_EXPIRATION);
  assert.ok(report.next.some((item) => item.includes('audit:production-config')));
});
