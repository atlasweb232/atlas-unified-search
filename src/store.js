import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cosineSimilarity } from './embedding.js';

const EMPTY_STATE = {
  schemaVersion: 1,
  documents: {},
  chunks: {},
  checkpoints: {},
  jobs: {},
  audit: [],
};

export class JsonSearchStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'unified-search.json');
    this.state = structuredClone(EMPTY_STATE);
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

  setCheckpoint(key, checkpoint) {
    this.state.checkpoints[key] = { ...checkpoint, updatedAt: new Date().toISOString() };
  }

  getCheckpoint(key) {
    return this.state.checkpoints[key] || null;
  }

  createJob({ source, tenantId, userId }) {
    const id = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const job = { id, source, tenantId, userId, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), indexed: 0, error: '' };
    this.state.jobs[id] = job;
    return job;
  }

  updateJob(id, patch) {
    this.state.jobs[id] = { ...(this.state.jobs[id] || { id }), ...patch, updatedAt: new Date().toISOString() };
    return this.state.jobs[id];
  }

  listJobs() {
    return Object.values(this.state.jobs).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  audit(event) {
    this.state.audit.unshift({ id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`, createdAt: new Date().toISOString(), ...event });
    this.state.audit = this.state.audit.slice(0, 1000);
  }

  status() {
    const documents = this.listDocuments();
    const chunks = this.listChunks();
    return {
      documents: documents.length,
      chunks: chunks.length,
      jobs: Object.keys(this.state.jobs).length,
      bySource: documents.reduce((acc, document) => {
        acc[document.source] = (acc[document.source] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}

export class SearchEngine {
  constructor({ store, embedder }) {
    this.store = store;
    this.embedder = embedder;
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
    const sourceSet = new Set(sources.filter(Boolean));
    const chunks = this.store.listChunks().filter((chunk) => {
      if (chunk.tenantId !== tenantId || chunk.userId !== userId) return false;
      if (sourceSet.size && !sourceSet.has(chunk.source)) return false;
      return true;
    });
    const candidates = new Map();
    for (const chunk of chunks) {
      const document = this.store.getDocument(chunk.documentId);
      if (!document || !passesFilters(document, filters)) continue;
      const vector = cosineSimilarity(queryVector, chunk.embedding);
      const lexical = lexicalScore(query, `${document.title} ${document.summary} ${chunk.text}`);
      const recency = recencyBoost(document.timestamp);
      const score = vector * 0.72 + lexical * 0.22 + recency * 0.06;
      const existing = candidates.get(document.id);
      if (!existing || score > existing.score) {
        candidates.set(document.id, { document, score, matchedChunk: chunk.summary });
      }
    }
    return [...candidates.values()]
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
