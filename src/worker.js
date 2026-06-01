import { loadConfig } from './config.js';
import { createConnectorRegistry } from './connectors/index.js';
import { createEmbedder } from './embedding.js';
import { JobRunner } from './jobRunner.js';
import { createJobQueue } from './queue/serviceBusQueue.js';
import { createSearchStore } from './stores/postgresStore.js';
import { SearchEngine } from './store.js';

const config = loadConfig();
const store = await createSearchStore(config);
await store.load();
const embedder = await createEmbedder(config);
const searchEngine = new SearchEngine({ store, embedder, weights: config.search });
const registry = createConnectorRegistry(config);
const queue = createJobQueue(config);
const jobs = new JobRunner({ registry, store, searchEngine, queue: { name: 'inline' }, retry: config.syncRetry });

if (queue.name !== 'azure-service-bus') {
  console.error('SERVICE_BUS_CONNECTION_STRING is required for the worker');
  process.exit(1);
}

const receiver = queue.createReceiver();
console.log(`Unified search worker listening on ${config.serviceBus.syncQueueName}`);

receiver.subscribe({
  processMessage: async (message) => {
    const body = message.body || {};
    console.log('Service Bus sync received', {
      jobId: body.jobId,
      source: body.source,
      tenantId: body.tenantId,
      userId: body.userId,
    });
    try {
      await store.refresh?.();
      const result = await jobs.run(body.jobId, {
        source: body.source,
        tenantId: body.tenantId,
        userId: body.userId,
        options: body.options || {},
      });
      console.log('Service Bus sync completed', {
        jobId: body.jobId,
        source: body.source,
        tenantId: body.tenantId,
        userId: body.userId,
        indexed: result.indexed,
      });
    } catch (error) {
      console.error('Service Bus sync failed', {
        jobId: body.jobId,
        source: body.source,
        tenantId: body.tenantId,
        userId: body.userId,
        error: error.message,
      });
      throw error;
    }
  },
  processError: async (error) => {
    console.error('Service Bus worker error', error);
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await receiver.close();
    await queue.close();
    if (store.close) await store.close();
    process.exit(0);
  });
}
