import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cosineSimilarity } from './embedding.js';

const EMPTY_STATE = {
  schemaVersion: 1,
  documents: {},
  chunks: {},
  checkpoints: {},
  jobs: {},
  searchRuns: {},
  assistantActions: {},
  artifacts: {},
  audit: [],
};

export class JsonSearchStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'unified-search.json');
    this.state = structuredClone(EMPTY_STATE);
    this.lock = Promise.resolve();
  }

  async withStoreLock(callback) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.state = { ...structuredClone(EMPTY_STATE), ...JSON.parse(await readFile(this.filePath, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
  }

  async save() {
    await mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.filePath);
  }

  upsertDocument(document, chunks) {
    this.state.documents[document.id] = {
      ...(this.state.documents[document.id] || {}),
      ...document,
      updatedAt: new Date().toISOString(),
    };
    for (const chunk of chunks) {
      this.state.chunks[chunk.id] = chunk;
    }
  }

  listDocuments() {
    return Object.values(this.state.documents);
  }

  listChunks() {
    return Object.values(this.state.chunks);
  }

  getDocument(id) {
    return this.state.documents[id] || null;
  }

  deleteDocuments({ tenantId, userId, source = '', documentIds = [] }) {
    const idSet = new Set(documentIds.filter(Boolean));
    const deletedDocumentIds = [];
    for (const document of Object.values(this.state.documents)) {
      if (document.tenantId !== tenantId || document.userId !== userId) continue;
      if (source && document.source !== source) continue;
      if (idSet.size && !idSet.has(document.id)) continue;
      deletedDocumentIds.push(document.id);
      delete this.state.documents[document.id];
    }
    const deletedSet = new Set(deletedDocumentIds);
    for (const [chunkId, chunk] of Object.entries(this.state.chunks)) {
      if (deletedSet.has(chunk.documentId)) delete this.state.chunks[chunkId];
    }
    return { deleted: deletedDocumentIds.length, documentIds: deletedDocumentIds };
  }

  setCheckpoint(key, checkpoint) {
    this.state.checkpoints[key] = { ...checkpoint, updatedAt: new Date().toISOString() };
  }

  getCheckpoint(key) {
    return this.state.checkpoints[key] || null;
  }

  deleteCheckpoints({ tenantId, userId, source = '' }) {
    const prefix = source ? `${source}:${tenantId}:${userId}:` : '';
    let deleted = 0;
    for (const key of Object.keys(this.state.checkpoints)) {
      const inScope = prefix
        ? key.startsWith(prefix)
        : key.includes(`:${tenantId}:${userId}:`);
      if (!inScope) continue;
      delete this.state.checkpoints[key];
      deleted += 1;
    }
    return { deleted };
  }

  createJob({ source, tenantId, userId }) {
    const id = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const job = { id, source, tenantId, userId, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), indexed: 0, error: '' };
    this.state.jobs[id] = job;
    return job;
  }

  updateJob(id, patch) {
    const now = new Date().toISOString();
    const existing = this.state.jobs[id] || { id, createdAt: now, indexed: 0, error: '' };
    this.state.jobs[id] = { ...existing, ...patch, createdAt: existing.createdAt || patch.createdAt || now, updatedAt: now };
    return this.state.jobs[id];
  }

  listJobs({ tenantId = '', userId = '' } = {}) {
    return Object.values(this.state.jobs)
      .filter((job) => (!tenantId || job.tenantId === tenantId))
      .filter((job) => (!userId || job.userId === userId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  audit(event) {
    this.state.audit.unshift({ id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`, createdAt: new Date().toISOString(), ...redactObject(event) });
    this.state.audit = this.state.audit.slice(0, 1000);
  }

  listAudit({ tenantId, userId, eventType = '', limit = 100 }) {
    return this.state.audit
      .filter((event) => (!tenantId || event.tenantId === tenantId))
      .filter((event) => (!userId || event.userId === userId))
      .filter((event) => (!eventType || event.eventType === eventType))
      .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500));
  }

  cleanupRetention({ tenantId, userId, documentRetentionDays, operationalRetentionDays, auditRetentionDays, dryRun = false }) {
    const documentCutoff = cutoffDate(documentRetentionDays);
    const operationalCutoff = cutoffDate(operationalRetentionDays);
    const auditCutoff = cutoffDate(auditRetentionDays);
    const documents = Object.values(this.state.documents).filter((document) => (
      inScope(document, tenantId, userId) && isOlderThan(document.updatedAt || document.timestamp, documentCutoff)
    ));
    const documentIds = new Set(documents.map((document) => document.id));
    const checkpoints = Object.entries(this.state.checkpoints).filter(([key, checkpoint]) => (
      key.includes(`:${tenantId}:${userId}:`) && isOlderThan(checkpoint.updatedAt || checkpoint.lastSyncedAt, operationalCutoff)
    ));
    const jobs = Object.values(this.state.jobs).filter((job) => inScope(job, tenantId, userId) && isOlderThan(job.updatedAt || job.createdAt, operationalCutoff));
    const searchRuns = Object.values(this.state.searchRuns).filter((run) => inScope(run, tenantId, userId) && isOlderThan(run.updatedAt || run.createdAt, operationalCutoff));
    const assistantActions = Object.values(this.state.assistantActions).filter((action) => inScope(action, tenantId, userId) && isOlderThan(action.completedAt || action.createdAt, operationalCutoff));
    const artifacts = Object.values(this.state.artifacts).filter((artifact) => inScope(artifact, tenantId, userId) && isOlderThan(artifact.createdAt, operationalCutoff));
    const audit = this.state.audit.filter((event) => inScope(event, tenantId, userId) && isOlderThan(event.createdAt, auditCutoff));

    const report = {
      tenantId,
      userId,
      dryRun: Boolean(dryRun),
      cutoffs: {
        documentsBefore: documentCutoff.toISOString(),
        operationalBefore: operationalCutoff.toISOString(),
        auditBefore: auditCutoff.toISOString(),
      },
      deleted: {
        documents: documents.length,
        chunks: Object.values(this.state.chunks).filter((chunk) => documentIds.has(chunk.documentId)).length,
        checkpoints: checkpoints.length,
        jobs: jobs.length,
        searchRuns: searchRuns.length,
        assistantActions: assistantActions.length,
        artifacts: artifacts.length,
        audit: audit.length,
      },
      documentIds: documents.map((document) => document.id),
      artifactIds: artifacts.map((artifact) => artifact.id),
    };

    if (dryRun) return report;

    for (const document of documents) delete this.state.documents[document.id];
    for (const [chunkId, chunk] of Object.entries(this.state.chunks)) {
      if (documentIds.has(chunk.documentId)) delete this.state.chunks[chunkId];
    }
    for (const [key] of checkpoints) delete this.state.checkpoints[key];
    for (const job of jobs) delete this.state.jobs[job.id];
    for (const run of searchRuns) delete this.state.searchRuns[run.id];
    for (const action of assistantActions) delete this.state.assistantActions[action.id];
    for (const artifact of artifacts) delete this.state.artifacts[artifact.id];
    const auditIds = new Set(audit.map((event) => event.id));
    this.state.audit = this.state.audit.filter((event) => !auditIds.has(event.id));
    return report;
  }

  createSearchRun({ tenantId, userId, query, selectedSources, filters }) {
    const id = `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const run = {
      id,
      tenantId,
      userId,
      query,
      selectedSources,
      filters: filters || {},
      status: 'queued',
      sourceStatuses: selectedSources.map((source) => ({ source, status: 'queued', resultCount: 0, error: '' })),
      results: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.state.searchRuns[id] = run;
    return run;
  }

  updateSearchRun(id, patch) {
    const run = this.state.searchRuns[id];
    if (!run) return null;
    this.state.searchRuns[id] = { ...run, ...patch, updatedAt: new Date().toISOString() };
    return this.state.searchRuns[id];
  }

  updateSourceStatus(searchRunId, source, patch) {
    const run = this.state.searchRuns[searchRunId];
    if (!run) return null;
    run.sourceStatuses = run.sourceStatuses.map((status) => (
      status.source === source ? { ...status, ...patch } : status
    ));
    run.updatedAt = new Date().toISOString();
    return run;
  }

  getSearchRun(id) {
    return this.state.searchRuns[id] || null;
  }

  createAssistantAction(action) {
    const id = `act_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const row = {
      id,
      status: 'queued',
      responseText: '',
      artifactIds: [],
      error: '',
      createdAt: new Date().toISOString(),
      completedAt: null,
      ...redactObject(action),
    };
    this.state.assistantActions[id] = row;
    return row;
  }

  updateAssistantAction(id, patch) {
    this.state.assistantActions[id] = { ...(this.state.assistantActions[id] || { id }), ...redactObject(patch) };
    return this.state.assistantActions[id];
  }

  getAssistantAction(id) {
    return this.state.assistantActions[id] || null;
  }

  createArtifact(artifact) {
    const id = `art_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const row = { id, createdAt: new Date().toISOString(), ...redactObject(artifact) };
    this.state.artifacts[id] = row;
    return row;
  }

  searchChunks({ tenantId, userId, sources = [], queryVector, candidateLimit, filters = {} }) {
    const sourceSet = new Set(sources.filter(Boolean));
    const candidates = [];
    for (const chunk of Object.values(this.state.chunks)) {
      if (chunk.tenantId !== tenantId || chunk.userId !== userId) continue;
      if (sourceSet.size && !sourceSet.has(chunk.source)) continue;
      const document = this.state.documents[chunk.documentId];
      if (!document || !passesFilters(document, filters)) continue;
      const distance = cosineSimilarity(queryVector, chunk.embedding);
      candidates.push({ document, chunk, distance });
    }
    candidates.sort((a, b) => b.distance - a.distance);
    return candidates.slice(0, candidateLimit);
  }

  status() {
    const documents = this.listDocuments();
    const chunks = this.listChunks();
    return {
      backend: 'json',
      documents: documents.length,
      chunks: chunks.length,
      jobs: Object.keys(this.state.jobs).length,
      bySource: documents.reduce((acc, document) => {
        acc[document.source] = (acc[document.source] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  scopedStatus({ tenantId, userId }) {
    const documents = this.listDocuments().filter((document) => document.tenantId === tenantId && document.userId === userId);
    const documentIds = new Set(documents.map((document) => document.id));
    const chunks = this.listChunks().filter((chunk) => documentIds.has(chunk.documentId));
    return {
      backend: 'json',
      tenantId,
      userId,
      documents: documents.length,
      chunks: chunks.length,
      bySource: documents.reduce((acc, document) => {
        acc[document.source] = (acc[document.source] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}

function inScope(row, tenantId, userId) {
  return row?.tenantId === tenantId && row?.userId === userId;
}

function cutoffDate(days) {
  const parsed = Number(days);
  const safeDays = Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
  return new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
}

function isOlderThan(value, cutoff) {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() < cutoff.getTime();
}

export function redactObject(value) {
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactSecret(value) : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/token|secret|password|api[_-]?key|authorization/i.test(key)) return [key, '[REDACTED]'];
    return [key, redactObject(entry)];
  }));
}

function redactSecret(value) {
  return value
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]');
}

export class SearchEngine {
  constructor({ store, embedder, weights = {} }) {
    this.store = store;
    this.embedder = embedder;
    this.weights = {
      vector: Number.isFinite(weights.vector) ? weights.vector : 0.72,
      lexical: Number.isFinite(weights.lexical) ? weights.lexical : 0.22,
      recency: Number.isFinite(weights.recency) ? weights.recency : 0.06,
    };
    this.candidateMultiplier = Number.isFinite(weights.candidateMultiplier) ? weights.candidateMultiplier : 5;
  }

  async indexDocuments(documents, { chunker }) {
    let indexed = 0;
    for (const document of documents) {
      const chunks = chunker(document);
      for (const chunk of chunks) {
        chunk.embedding = await this.embedder.embed(chunk.text);
        chunk.embeddingModel = this.embedder.model;
        chunk.embeddingVersion = this.embedder.version;
      }
      this.store.upsertDocument(document, chunks);
      indexed += 1;
    }
    return indexed;
  }

  async search({ tenantId, userId, query, sources = [], filters = {}, limit = 10 }) {
    const queryVector = await this.embedder.embed(query);
    const candidateLimit = Math.max(limit * this.candidateMultiplier, 50);
    const rawCandidates = this.store.searchChunks({
      tenantId, userId, sources, queryVector, candidateLimit, filters,
    });
    const best = new Map();
    for (const { document, chunk, distance } of rawCandidates) {
      const lexical = lexicalScore(query, `${document.title} ${document.summary} ${chunk.text}`);
      const recency = recencyBoost(document.timestamp);
      const score = distance * this.weights.vector
        + lexical * this.weights.lexical
        + recency * this.weights.recency;
      const existing = best.get(document.id);
      if (!existing || score > existing.score) {
        best.set(document.id, { document, score, matchedChunk: chunk.summary });
      }
    }
    return [...best.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(limit, 50))
      .map(({ document, score, matchedChunk }) => ({
        id: document.id,
        source: document.source,
        title: document.title,
        oneLine: document.summary || matchedChunk,
        author: document.author,
        timestamp: document.timestamp,
        container: document.container,
        score: Number(score.toFixed(4)),
        sourceUri: document.sourceUri,
        children: document.children || [],
        metadata: document.metadata || {},
      }));
  }
}

function lexicalScore(query, text) {
  const tokens = String(query || '').toLowerCase().match(/[a-z0-9_@#.-]+/g) || [];
  if (!tokens.length) return 0;
  const haystack = String(text || '').toLowerCase();
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return hits / tokens.length;
}

function recencyBoost(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 0;
  const days = Math.max(0, (Date.now() - date.getTime()) / 86400000);
  return Math.max(0, 1 - days / 365);
}

function passesFilters(document, filters) {
  if (filters.containers?.length && !filters.containers.includes(document.container)) return false;
  if (filters.authors?.length && !filters.authors.includes(document.author)) return false;
  if (filters.from && new Date(document.timestamp) < new Date(filters.from)) return false;
  if (filters.to && new Date(document.timestamp) > new Date(filters.to)) return false;
  return true;
}
