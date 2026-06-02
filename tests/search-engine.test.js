import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { hashEmbedding } from '../src/embedding.js';
import { createDocument, createChunks } from '../src/model.js';
import { JsonSearchStore, SearchEngine } from '../src/store.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeEmbedder() {
  return {
    model: 'hash-embedding',
    version: 'hash:v1:384',
    dimensions: 384,
    embed: async (text) => hashEmbedding(text),
  };
}

async function indexedStore(dataDir, docs) {
  const store = new JsonSearchStore({ dataDir });
  await store.load();
  const embedder = makeEmbedder();
  const engine = new SearchEngine({ store, embedder });
  await engine.indexDocuments(docs, { chunker: createChunks });
  return { store, engine };
}

function doc(overrides) {
  return createDocument({
    tenantId: 'tenant-a',
    userId: 'user-1',
    source: 'slack',
    sourceId: `msg-${Math.random().toString(16).slice(2)}`,
    title: 'Test message',
    body: 'hello world',
    timestamp: new Date().toISOString(),
    ...overrides,
  });
}

// ─── scoped retrieval ─────────────────────────────────────────────────────────

test('searchChunks returns only chunks in the requested scope', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-sc-'));
  try {
    const { store, engine } = await indexedStore(dir, [
      doc({ tenantId: 'tenant-a', userId: 'user-1', source: 'slack', title: 'alpha', body: 'alpha content' }),
      doc({ tenantId: 'tenant-b', userId: 'user-1', source: 'slack', title: 'beta',  body: 'beta content' }),
      doc({ tenantId: 'tenant-a', userId: 'user-2', source: 'slack', title: 'gamma', body: 'gamma content' }),
    ]);

    const qv = await makeEmbedder().embed('alpha');
    const results = store.searchChunks({
      tenantId: 'tenant-a', userId: 'user-1', sources: [], queryVector: qv, candidateLimit: 50, filters: {},
    });

    assert.ok(results.every((r) => r.document.tenantId === 'tenant-a'), 'wrong tenant returned');
    assert.ok(results.every((r) => r.document.userId === 'user-1'), 'wrong user returned');
    assert.ok(results.length > 0, 'no results for valid scope');

    const _ = engine; // silence unused warning
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('searchChunks respects source filter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-sf-'));
  try {
    const { store } = await indexedStore(dir, [
      doc({ source: 'slack',        title: 'slack doc',  body: 'same query text' }),
      doc({ source: 'google_drive', title: 'drive doc',  body: 'same query text' }),
    ]);

    const qv = await makeEmbedder().embed('same query text');
    const slackOnly = store.searchChunks({
      tenantId: 'tenant-a', userId: 'user-1', sources: ['slack'], queryVector: qv, candidateLimit: 50, filters: {},
    });
    assert.ok(slackOnly.every((r) => r.document.source === 'slack'), 'non-slack source leaked in');
    assert.ok(slackOnly.length > 0, 'expected slack chunks');

    const driveOnly = store.searchChunks({
      tenantId: 'tenant-a', userId: 'user-1', sources: ['google_drive'], queryVector: qv, candidateLimit: 50, filters: {},
    });
    assert.ok(driveOnly.every((r) => r.document.source === 'google_drive'), 'non-drive source leaked in');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('searchChunks respects container filter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-cf-'));
  try {
    const { store } = await indexedStore(dir, [
      doc({ container: 'general',  body: 'budget report' }),
      doc({ container: 'private',  body: 'budget report' }),
    ]);

    const qv = await makeEmbedder().embed('budget report');
    const results = store.searchChunks({
      tenantId: 'tenant-a', userId: 'user-1', sources: [], queryVector: qv, candidateLimit: 50,
      filters: { containers: ['general'] },
    });
    assert.ok(results.every((r) => r.document.container === 'general'), 'wrong container leaked');
    assert.ok(results.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('searchChunks returns at most candidateLimit results', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-lim-'));
  try {
    const docs = Array.from({ length: 20 }, (_, i) =>
      doc({ title: `doc ${i}`, body: `content about topic number ${i}` }),
    );
    const { store } = await indexedStore(dir, docs);
    const qv = await makeEmbedder().embed('topic');
    const results = store.searchChunks({
      tenantId: 'tenant-a', userId: 'user-1', sources: [], queryVector: qv, candidateLimit: 5, filters: {},
    });
    assert.ok(results.length <= 5, `expected ≤5 candidates, got ${results.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── SearchEngine.search via searchChunks ────────────────────────────────────

test('search does not return results from another tenant', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-iso-'));
  try {
    const { engine } = await indexedStore(dir, [
      doc({ tenantId: 'tenant-a', userId: 'user-1', body: 'quarterly revenue report' }),
      doc({ tenantId: 'tenant-b', userId: 'user-1', body: 'quarterly revenue report' }),
    ]);

    const results = await engine.search({
      tenantId: 'tenant-a', userId: 'user-1', query: 'quarterly revenue',
    });
    assert.ok(results.every((r) => r.id.startsWith('tenant-a:')), 'results from wrong tenant');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('search result order is stable — most relevant document ranks first', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-rank-'));
  try {
    const { engine } = await indexedStore(dir, [
      doc({ sourceId: 'irrelevant',  title: 'cat pictures',        body: 'fluffy cats' }),
      doc({ sourceId: 'relevant',    title: 'quarterly earnings',   body: 'quarterly revenue earnings growth profit margin' }),
    ]);

    const results = await engine.search({
      tenantId: 'tenant-a', userId: 'user-1', query: 'quarterly revenue earnings',
    });
    assert.ok(results.length >= 1, 'no results');
    assert.ok(
      results[0].id.includes('relevant'),
      `expected relevant doc first, got: ${results[0].id}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── configurable weights ────────────────────────────────────────────────────

test('SearchEngine respects custom weights', () => {
  const engine = new SearchEngine({
    store: null,
    embedder: makeEmbedder(),
    weights: { vector: 0.5, lexical: 0.3, recency: 0.2, candidateMultiplier: 10 },
  });
  assert.equal(engine.weights.vector, 0.5);
  assert.equal(engine.weights.lexical, 0.3);
  assert.equal(engine.weights.recency, 0.2);
  assert.equal(engine.candidateMultiplier, 10);
});

test('SearchEngine falls back to default weights when none supplied', () => {
  const engine = new SearchEngine({ store: null, embedder: makeEmbedder() });
  assert.equal(engine.weights.vector, 0.72);
  assert.equal(engine.weights.lexical, 0.22);
  assert.equal(engine.weights.recency, 0.06);
  assert.equal(engine.candidateMultiplier, 5);
});

// ─── result parity ───────────────────────────────────────────────────────────

test('search returns identical top document with default and custom multiplier', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-par-'));
  try {
    const docs = [
      doc({ sourceId: 'a', body: 'machine learning neural network deep learning' }),
      doc({ sourceId: 'b', body: 'quarterly sales report revenue growth' }),
      doc({ sourceId: 'c', body: 'project management agile sprint planning' }),
    ];
    const store = new JsonSearchStore({ dataDir: dir });
    await store.load();
    const embedder = makeEmbedder();

    const engineDefault = new SearchEngine({ store, embedder });
    const engineCustom  = new SearchEngine({ store, embedder, weights: { candidateMultiplier: 3 } });
    await engineDefault.indexDocuments(docs, { chunker: createChunks });

    const query = 'neural network machine learning';
    const [r1] = await engineDefault.search({ tenantId: 'tenant-a', userId: 'user-1', query, limit: 1 });
    const [r2] = await engineCustom.search({ tenantId: 'tenant-a', userId: 'user-1', query, limit: 1 });

    assert.ok(r1, 'default engine returned no results');
    assert.ok(r2, 'custom engine returned no results');
    assert.equal(r1.id, r2.id, 'top document differs between multipliers');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
