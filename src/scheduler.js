import { loadConfig } from './config.js';
import { createConnectorRegistry } from './connectors/index.js';
import { createEmbedder } from './embedding.js';
import { JobRunner } from './jobRunner.js';
import { createJobQueue } from './queue/serviceBusQueue.js';
import { parseSyncSchedules, summarizeSchedules } from './scheduleConfig.js';
import { createSearchStore } from './stores/postgresStore.js';
import { SearchEngine } from './store.js';

const config = loadConfig();
const schedules = parseSyncSchedules(process.env.UNIFIED_SEARCH_SYNC_SCHEDULES || '');

if (!schedules.length) {
  console.error('UNIFIED_SEARCH_SYNC_SCHEDULES has no enabled schedules');
  process.exit(1);
}

const store = await createSearchStore(config);
await store.load();
const embedder = await createEmbedder(config);
const searchEngine = new SearchEngine({ store, embedder });
const registry = createConnectorRegistry(config);
const queue = createJobQueue(config);
const jobs = new JobRunner({ registry, store, searchEngine, queue });
const timers = [];
let shuttingDown = false;

console.log('Unified search scheduler started', {
  queue: queue.name,
  schedules: summarizeSchedules(schedules),
});

for (const schedule of schedules) {
  const run = () => runSchedule(schedule).catch((error) => {
    console.error('Scheduled sync failed', {
      schedule: schedule.name,
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
  const connector = registry.get(schedule.source);
  const readiness = await registry.readiness(schedule.source);
  if (!readiness[0]?.ready) {
    console.warn('Scheduled sync skipped because connector is not ready', {
      schedule: schedule.name,
      source: schedule.source,
      status: readiness[0]?.status,
    });
    return;
  }
  const options = schedule.reindex ? { ...schedule.options, forceFullSync: true } : schedule.options;
  if (schedule.reindex) {
    await store.refresh?.();
    const deleted = store.deleteDocuments({ tenantId: schedule.tenantId, userId: schedule.userId, source: schedule.source });
    const checkpoints = store.deleteCheckpoints({ tenantId: schedule.tenantId, userId: schedule.userId, source: schedule.source });
    store.audit({
      eventType: 'scheduled_reindex_start',
      tenantId: schedule.tenantId,
      userId: schedule.userId,
      source: schedule.source,
      metadata: { schedule: schedule.name, deleted: deleted.deleted, checkpointDeleted: checkpoints.deleted },
    });
    await store.save();
  }
  const job = await jobs.enqueue({
    source: connector.source,
    tenantId: schedule.tenantId,
    userId: schedule.userId,
    options,
    autoStart: true,
  });
  console.log('Scheduled sync queued', {
    schedule: schedule.name,
    jobId: job.id,
    source: schedule.source,
    tenantId: schedule.tenantId,
    userId: schedule.userId,
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    shuttingDown = true;
    for (const timer of timers) clearInterval(timer);
    await queue.close?.();
    await store.close?.();
    process.exit(0);
  });
}
