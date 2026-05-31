import { sourceIcon, sourceLabel } from './model.js';

export class SearchRunCoordinator {
  constructor({ store, searchEngine, registry }) {
    this.store = store;
    this.searchEngine = searchEngine;
    this.registry = registry;
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
    this.store.updateSearchRun(runId, { status: 'running' });
    const settled = await Promise.allSettled(selectedSources.map(async (source) => {
      this.store.updateSourceStatus(runId, source, { status: 'running', startedAt: new Date().toISOString() });
      const connector = this.registry?.get(source);
      const federatedResults = connector?.search
        ? await connector.search({ tenantId, userId, query, filters, limit })
        : null;
      const results = federatedResults || await this.searchEngine.search({ tenantId, userId, query, sources: [source], filters, limit });
      const lineItems = results.map((result) => normalizeLineItem(runId, result));
      this.store.updateSourceStatus(runId, source, { status: 'completed', completedAt: new Date().toISOString(), resultCount: lineItems.length });
      return lineItems;
    }));
    const results = [];
    const finalSourceStatuses = [];
    for (const [index, result] of settled.entries()) {
      const source = selectedSources[index];
      if (result.status === 'fulfilled') {
        results.push(...result.value);
        finalSourceStatuses.push({
          source,
          status: 'completed',
          completedAt: new Date().toISOString(),
          resultCount: result.value.length,
          error: '',
        });
      } else {
        const error = result.reason?.message || 'Search failed';
        this.store.updateSourceStatus(runId, source, { status: 'failed', completedAt: new Date().toISOString(), error: result.reason?.message || 'Search failed' });
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
