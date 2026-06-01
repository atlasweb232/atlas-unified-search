import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSyncSchedules, summarizeSchedules } from '../src/scheduleConfig.js';

test('parseSyncSchedules validates and normalizes enabled schedules', () => {
  const schedules = parseSyncSchedules(JSON.stringify([
    {
      name: 'email-smoke',
      source: 'email',
      tenantId: 'atlasweb',
      userId: 'rakib',
      everySeconds: 900,
      options: { limit: 10 },
    },
    {
      source: 'slack',
      tenantId: 'atlasweb',
      userId: 'rakib',
      everySeconds: 900,
      enabled: false,
    },
  ]));

  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].name, 'email-smoke');
  assert.equal(schedules[0].runOnStart, true);
  assert.equal(schedules[0].reindex, false);
  assert.deepEqual(summarizeSchedules(schedules)[0], {
    name: 'email-smoke',
    action: 'sync',
    source: 'email',
    tenantId: 'atlasweb',
    userId: 'rakib',
    everySeconds: 900,
    runOnStart: true,
    reindex: false,
  });
});

test('parseSyncSchedules supports retention cleanup schedules', () => {
  const schedules = parseSyncSchedules(JSON.stringify([
    {
      action: 'retention_cleanup',
      tenantId: 'atlasweb',
      userId: 'rakib',
      everySeconds: 86400,
      runOnStart: false,
      options: {
        dryRun: true,
        documentRetentionDays: 90,
      },
    },
  ]));

  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].name, 'atlasweb:rakib:retention_cleanup:retention');
  assert.equal(schedules[0].action, 'retention_cleanup');
  assert.equal(schedules[0].source, 'retention');
  assert.equal(schedules[0].runOnStart, false);
  assert.equal(schedules[0].options.dryRun, true);
  assert.deepEqual(summarizeSchedules(schedules)[0], {
    name: 'atlasweb:rakib:retention_cleanup:retention',
    action: 'retention_cleanup',
    source: 'retention',
    tenantId: 'atlasweb',
    userId: 'rakib',
    everySeconds: 86400,
    runOnStart: false,
    reindex: false,
  });
});

test('parseSyncSchedules rejects unsafe intervals and invalid shape', () => {
  assert.throws(() => parseSyncSchedules('{}'), /JSON array/);
  assert.throws(() => parseSyncSchedules('[{"source":"email"}]'), /tenantId/);
  assert.throws(() => parseSyncSchedules('[{"source":"email","tenantId":"t","userId":"u","everySeconds":30}]'), /at least 300/);
  assert.throws(() => parseSyncSchedules('[{"action":"delete_everything","tenantId":"t","userId":"u","everySeconds":300}]'), /action/);
});
