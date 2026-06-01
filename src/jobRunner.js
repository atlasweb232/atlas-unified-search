import { runConnectorSync } from './connectors/base.js';

export class JobRunner {
  constructor({ registry, store, searchEngine, queue, retry = {} }) {
    this.registry = registry;
    this.store = store;
    this.searchEngine = searchEngine;
    this.queue = queue;
    this.retry = {
      maxAttempts: Math.max(Number(retry.maxAttempts) || 1, 1),
      baseDelayMs: Math.max(Number(retry.baseDelayMs) || 0, 0),
    };
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
      const result = await this.runWithRetry({
        connector,
        jobId,
        source,
        tenantId,
        userId,
        options,
      });
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

  async runWithRetry({ connector, jobId, source, tenantId, userId, options }) {
    let lastError;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        const markAttempt = async () => {
          this.store.updateJob(jobId, { attempts: attempt, lastAttemptAt: new Date().toISOString() });
          await this.store.save();
        };
        if (typeof this.store.withStoreLock === 'function') await this.store.withStoreLock(markAttempt);
        else await markAttempt();
        return await runConnectorSync({ connector, tenantId, userId, store: this.store, searchEngine: this.searchEngine, options });
      } catch (error) {
        lastError = error;
        if (attempt >= this.retry.maxAttempts || !isRetryableSyncError(error)) break;
        const delayMs = retryDelayMs(this.retry.baseDelayMs, attempt);
        const markRetry = async () => {
          this.store.updateJob(jobId, { attempts: attempt, lastRetryAt: new Date().toISOString(), error: error.message });
          this.store.audit({ eventType: 'sync_retry', tenantId, userId, source, metadata: { jobId, attempt, nextAttempt: attempt + 1, delayMs, error: error.message } });
          await this.store.save();
        };
        if (typeof this.store.withStoreLock === 'function') await this.store.withStoreLock(markRetry);
        else await markRetry();
        if (delayMs > 0) await sleep(delayMs);
      }
    }
    throw lastError;
  }

  listJobs(scope = {}) {
    return this.store.listJobs(scope);
  }
}

export function isRetryableSyncError(error) {
  if (error?.retryable === true) return true;
  if (error?.retryable === false) return false;
  const status = Number(error?.status || error?.statusCode || error?.code);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return status !== 409;
  const message = String(error?.message || error || '').toLowerCase();
  if (/missing_configuration|not configured|invalid_auth|invalid_grant|unauthorized|forbidden|permission|access_denied/.test(message)) return false;
  return /timeout|timed out|temporar|transient|rate.?limit|econnreset|etimedout|eai_again|fetch failed|socket hang up|503|502|504|429/.test(message);
}

function retryDelayMs(baseDelayMs, attempt) {
  if (!baseDelayMs) return 0;
  return baseDelayMs * (2 ** Math.max(attempt - 1, 0));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
