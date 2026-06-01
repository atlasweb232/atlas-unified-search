import { parseSyncSchedules, summarizeSchedules } from './scheduleConfig.js';

const apiBaseUrl = String(process.env.UNIFIED_SEARCH_API_BASE_URL || '').replace(/\/+$/, '');
const authToken = process.env.UNIFIED_SEARCH_AUTH_TOKEN || '';
const schedules = parseSyncSchedules(process.env.UNIFIED_SEARCH_SYNC_SCHEDULES || '');

if (!apiBaseUrl) {
  console.error('UNIFIED_SEARCH_API_BASE_URL is required for the API scheduler');
  process.exit(1);
}

if (!authToken) {
  console.error('UNIFIED_SEARCH_AUTH_TOKEN is required for the API scheduler');
  process.exit(1);
}

if (!schedules.length) {
  console.error('UNIFIED_SEARCH_SYNC_SCHEDULES has no enabled schedules');
  process.exit(1);
}

const timers = [];
let shuttingDown = false;

console.log('Unified search API scheduler started', {
  apiBaseUrl,
  schedules: summarizeSchedules(schedules),
});

for (const schedule of schedules) {
  const run = () => runSchedule(schedule).catch((error) => {
    console.error('Scheduled API task failed', {
      schedule: schedule.name,
      action: schedule.action,
      source: schedule.source,
      tenantId: schedule.tenantId,
      userId: schedule.userId,
      error: error.message,
    });
  });
  if (schedule.runOnStart) run();
  timers.push(setInterval(run, schedule.everySeconds * 1000));
}

async function runSchedule(schedule) {
  if (shuttingDown) return;
  if (schedule.action === 'retention_cleanup') {
    const response = await request('/v1/retention/cleanup', {
      method: 'POST',
      body: {
        tenantId: schedule.tenantId,
        userId: schedule.userId,
        dryRun: Boolean(schedule.options?.dryRun),
        documentRetentionDays: schedule.options?.documentRetentionDays,
        operationalRetentionDays: schedule.options?.operationalRetentionDays,
        auditRetentionDays: schedule.options?.auditRetentionDays,
      },
    });
    console.log('Scheduled API retention cleanup completed', {
      schedule: schedule.name,
      tenantId: schedule.tenantId,
      userId: schedule.userId,
      dryRun: response.report?.dryRun,
      deleted: response.report?.deleted,
    });
    return;
  }

  const readiness = await request(`/v1/connectors/readiness?source=${encodeURIComponent(schedule.source)}`);
  const check = readiness.checks?.[0];
  if (!check?.ready) {
    console.warn('Scheduled API sync skipped because connector is not ready', {
      schedule: schedule.name,
      source: schedule.source,
      status: check?.status || 'unknown',
    });
    return;
  }

  const endpoint = schedule.reindex ? `/v1/reindex/${schedule.source}` : `/v1/sync/${schedule.source}`;
  const response = await request(endpoint, {
    method: 'POST',
    body: {
      tenantId: schedule.tenantId,
      userId: schedule.userId,
      wait: false,
      options: schedule.options,
    },
  });

  console.log('Scheduled API sync queued', {
    schedule: schedule.name,
    action: schedule.action,
    jobId: response.job?.id,
    source: schedule.source,
    tenantId: schedule.tenantId,
    userId: schedule.userId,
    reindex: schedule.reindex,
  });
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(`${method} ${path} failed: ${response.status} ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true;
    for (const timer of timers) clearInterval(timer);
    process.exit(0);
  });
}
