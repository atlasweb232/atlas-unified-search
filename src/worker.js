import { loadConfig } from './config.js';
import { createConnectorRegistry } from './connectors/index.js';
import { createEmbedder } from './embedding.js';
import { JobRunner } from './jobRunner.js';
import { InstallationStore } from './installationStore.js';
import { createJobQueue } from './queue/serviceBusQueue.js';
import { createSearchStore } from './stores/postgresStore.js';
import { SearchEngine } from './store.js';

const config = loadConfig();
const store = await createSearchStore(config);
await store.load();
const embedder = await createEmbedder(config);
const searchEngine = new SearchEngine({ store, embedder, weights: config.search, embeddingDim: config.embeddingDim });
const installations = new InstallationStore(config);
await installations.load();
const registry = createConnectorRegistry(config, {
  credentialResolver: (source, scope) => installations.credentialsFor(source, scope),
});
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
      await installations.refresh();
      await store.refresh?.();
      const result = await jobs.run(body.jobId, {
        source: body.source,
        tenantId: body.tenantId,
        userId: body.userId,
        options: body.options || {},
      });
      await installations.markEventOutcome(body.jobId, 'completed');
      console.log('Service Bus sync completed', {
        jobId: body.jobId,
        source: body.source,
        tenantId: body.tenantId,
        userId: body.userId,
        indexed: result.indexed,
      });
    } catch (error) {
      await installations.markEventOutcome(body.jobId, 'failed');
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
}, {
  maxConcurrentCalls: 1,
  maxAutoLockRenewalDurationInMs: 30 * 60 * 1000,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await receiver.close();
    await queue.close();
    await installations.close();
    if (store.close) await store.close();
    process.exit(0);
  });
}
