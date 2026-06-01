import { sourceIcon, sourceLabel } from './model.js';

export class SearchRunCoordinator {
  constructor({ store, searchEngine, registry, sourceTimeoutMs = 30000 }) {
    this.store = store;
    this.searchEngine = searchEngine;
    this.registry = registry;
    this.sourceTimeoutMs = sourceTimeoutMs;
  }

  async start({ tenantId, userId, query, sources, filters = {}, limit = 10, wait = false }) {
    const selectedSources = sources?.length ? sources : defaultSources(this.store, tenantId, userId);
    const createRun = async () => {
      const run = this.store.createSearchRun({ tenantId, userId, query, selectedSources, filters });
      this.store.audit({ eventType: 'search_run_start', tenantId, userId, queryHash: hashQuery(query), metadata: { runId: run.id, selectedSources } });
      await this.store.save();
      return run;
    };
    const run = typeof this.store.withStoreLock === 'function'
      ? await this.store.withStoreLock(createRun)
      : await createRun();
    const promise = this.execute(run.id, { tenantId, userId, query, selectedSources, filters, limit });
    if (wait) return await promise;
    return this.store.getSearchRun(run.id);
  }

  async execute(runId, { tenantId, userId, query, selectedSources, filters, limit }) {
    await persistStoreMutation(this.store, () => {
      this.store.updateSearchRun(runId, { status: 'running' });
    });
    const settled = await Promise.allSettled(selectedSources.map(async (source) => {
      const connector = this.registry?.get(source);
      const sourceContext = describeSourceSearch(connector);
      await persistStoreMutation(this.store, () => {
        this.store.updateSourceStatus(runId, source, {
          status: 'running',
          startedAt: new Date().toISOString(),
          ...sourceContext,
        });
      });
      const results = await withTimeout(
        source,
        this.sourceTimeoutMs,
        async () => {
          const federatedResults = connector?.search
            ? await connector.search({ tenantId, userId, query, filters, limit })
            : null;
          return federatedResults || await this.searchEngine.search({ tenantId, userId, query, sources: [source], filters, limit });
        },
      );
      const lineItems = results.map((result) => normalizeLineItem(runId, result));
      await persistStoreMutation(this.store, () => {
        this.store.updateSourceStatus(runId, source, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          resultCount: lineItems.length,
          ...sourceContext,
        });
        appendRunResults(this.store, runId, lineItems, limit);
      });
      return { lineItems, sourceContext };
    }));
    const results = [];
    const finalSourceStatuses = [];
    for (const [index, result] of settled.entries()) {
      const source = selectedSources[index];
      if (result.status === 'fulfilled') {
        results.push(...result.value.lineItems);
        finalSourceStatuses.push({
          source,
          status: 'completed',
          completedAt: new Date().toISOString(),
          resultCount: result.value.lineItems.length,
          error: '',
          ...result.value.sourceContext,
        });
      } else {
        const error = result.reason?.message || 'Search failed';
        await persistStoreMutation(this.store, () => {
          this.store.updateSourceStatus(runId, source, { status: 'failed', completedAt: new Date().toISOString(), error });
        });
        finalSourceStatuses.push({
          source,
          status: 'failed',
          completedAt: new Date().toISOString(),
          resultCount: 0,
          error,
        });
      }
    }
    const deduped = dedupe(results).sort((left, right) => right.score - left.score).slice(0, limit);
    const completeRun = async () => {
      const currentRun = this.store.getSearchRun(runId);
      if (!currentRun) throw new Error(`Search run ${runId} was not found while completing`);
      const failed = finalSourceStatuses.some((status) => status.status === 'failed');
      this.store.updateSearchRun(runId, {
        status: failed ? 'partial' : 'completed',
        sourceStatuses: finalSourceStatuses,
        results: deduped,
        completedAt: new Date().toISOString(),
      });
      this.store.audit({ eventType: 'search_run_complete', tenantId, userId, metadata: { runId, resultCount: deduped.length, failed } });
      await this.store.save();
      return this.store.getSearchRun(runId);
    };
    return typeof this.store.withStoreLock === 'function'
      ? this.store.withStoreLock(completeRun)
      : completeRun();
  }
}

async function persistStoreMutation(store, mutation) {
  const apply = async () => {
    mutation();
    await store.save();
  };
  return typeof store.withStoreLock === 'function'
    ? store.withStoreLock(apply)
    : apply();
}

function appendRunResults(store, runId, lineItems, limit) {
  if (!lineItems.length) return;
  const run = store.getSearchRun(runId);
  if (!run) return;
  const results = dedupe([...(run.results || []), ...lineItems])
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  store.updateSearchRun(runId, { results });
}

function normalizeLineItem(searchRunId, result) {
  const attachments = result.metadata?.attachments || result.metadata?.files || [];
  const links = result.metadata?.links || [];
  return {
    ...result,
    id: `${searchRunId}:${result.id}`,
    searchRunId,
    documentId: result.id,
    sourceIcon: sourceIcon(result.source),
    sourceLabel: sourceLabel(result.source),
    attachments,
    links,
    expandable: Boolean((result.children || []).length || attachments.length || links.length),
    selected: false,
  };
}

function describeSourceSearch(connector) {
  const connectorConfigured = Boolean(connector?.isConfigured?.());
  const vectorizationMode = connector?.vectorizationMode || 'local_index';
  const federated = typeof connector?.search === 'function';
  return {
    connectorConfigured,
    vectorizationMode,
    searchMode: federated
      ? (connectorConfigured ? 'federated_live' : 'federated_unconfigured')
      : (connectorConfigured ? 'local_index_with_configured_connector' : 'local_index_only'),
    liveConnectorCoverage: federated && connectorConfigured,
  };
}

function dedupe(results) {
  const byDocument = new Map();
  for (const result of results) {
    const existing = byDocument.get(result.documentId);
    if (!existing || result.score > existing.score) byDocument.set(result.documentId, result);
  }
  return [...byDocument.values()];
}

function defaultSources(store, tenantId, userId) {
  const sources = [...new Set(store.listDocuments()
    .filter((document) => document.tenantId === tenantId && document.userId === userId)
    .map((document) => document.source))];
  return sources.length ? sources : ['email', 'slack', 'google_drive', 'conference_bridge', 'knowledge_base', 'data_fabric'];
}

function hashQuery(query) {
  let hash = 0;
  for (const char of String(query || '')) hash = Math.imul(31, hash) + char.charCodeAt(0) | 0;
  return `q_${Math.abs(hash)}`;
}

async function withTimeout(source, timeoutMs, callback) {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) return callback();
  let timer;
  try {
    return await Promise.race([
      callback(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Source agent ${source} timed out after ${timeout}ms`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
