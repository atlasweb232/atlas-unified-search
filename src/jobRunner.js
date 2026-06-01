import { runConnectorSync } from './connectors/base.js';

export class JobRunner {
  constructor({ registry, store, searchEngine, queue }) {
    this.registry = registry;
    this.store = store;
    this.searchEngine = searchEngine;
    this.queue = queue;
  }

  async enqueue({ source, tenantId, userId, options = {}, autoStart = true }) {
    const createJob = async () => {
      const job = this.store.createJob({ source, tenantId, userId });
      await this.store.save();
      return job;
    };
    const job = typeof this.store.withStoreLock === 'function'
      ? await this.store.withStoreLock(createJob)
      : await createJob();
    if (autoStart && this.queue?.name !== 'inline') {
      await this.queue.enqueue({ jobId: job.id, source, tenantId, userId, options });
      return job;
    }
    if (autoStart) {
      setTimeout(() => {
        this.run(job.id, { source, tenantId, userId, options }).catch(() => {});
      }, 0);
    }
    return job;
  }

  async run(jobId, { source, tenantId, userId, options = {} }) {
    const markRunning = async () => {
      this.store.updateJob(jobId, { source, tenantId, userId, status: 'running', startedAt: new Date().toISOString() });
      this.store.audit({ eventType: 'sync_start', tenantId, userId, source, metadata: { jobId } });
      await this.store.save();
    };
    if (typeof this.store.withStoreLock === 'function') await this.store.withStoreLock(markRunning);
    else await markRunning();
    try {
      const connector = this.registry.get(source);
      const result = await runConnectorSync({ connector, tenantId, userId, store: this.store, searchEngine: this.searchEngine, options });
      const completeJob = async () => {
        const job = this.store.updateJob(jobId, { status: 'completed', completedAt: new Date().toISOString(), indexed: result.indexed });
        this.store.audit({ eventType: 'sync_complete', tenantId, userId, source, metadata: { jobId, indexed: result.indexed } });
        await this.store.save();
        return job;
      };
      const job = typeof this.store.withStoreLock === 'function'
        ? await this.store.withStoreLock(completeJob)
        : await completeJob();
      return { ...result, job };
    } catch (error) {
      const failJob = async () => {
        this.store.updateJob(jobId, { status: 'failed', error: error.message, completedAt: new Date().toISOString() });
        this.store.audit({ eventType: 'sync_failed', tenantId, userId, source, metadata: { jobId, error: error.message } });
        await this.store.save();
      };
      if (typeof this.store.withStoreLock === 'function') await this.store.withStoreLock(failJob);
      else await failJob();
      throw error;
    }
  }

  listJobs(scope = {}) {
    return this.store.listJobs(scope);
  }
}
