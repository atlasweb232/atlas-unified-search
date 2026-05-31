import { runConnectorSync } from './connectors/base.js';

export class JobRunner {
  constructor({ registry, store, searchEngine }) {
    this.registry = registry;
    this.store = store;
    this.searchEngine = searchEngine;
  }

  async enqueue({ source, tenantId, userId, options = {}, autoStart = true }) {
    const job = this.store.createJob({ source, tenantId, userId });
    await this.store.save();
    if (autoStart) {
      setTimeout(() => {
        this.run(job.id, { source, tenantId, userId, options }).catch(() => {});
      }, 0);
    }
    return job;
  }

  async run(jobId, { source, tenantId, userId, options = {} }) {
    this.store.updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
    this.store.audit({ eventType: 'sync_start', tenantId, userId, source, metadata: { jobId } });
    await this.store.save();
    try {
      const connector = this.registry.get(source);
      const result = await runConnectorSync({ connector, tenantId, userId, store: this.store, searchEngine: this.searchEngine, options });
      this.store.updateJob(jobId, { status: 'completed', completedAt: new Date().toISOString(), indexed: result.indexed });
      this.store.audit({ eventType: 'sync_complete', tenantId, userId, source, metadata: { jobId, indexed: result.indexed } });
      await this.store.save();
      return result;
    } catch (error) {
      this.store.updateJob(jobId, { status: 'failed', error: error.message, completedAt: new Date().toISOString() });
      this.store.audit({ eventType: 'sync_failed', tenantId, userId, source, metadata: { jobId, error: error.message } });
      await this.store.save();
      throw error;
    }
  }

  listJobs() {
    return this.store.listJobs();
  }
}
