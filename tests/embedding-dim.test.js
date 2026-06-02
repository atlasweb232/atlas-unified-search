import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createEmbedder, assertEmbedderDimension, hashEmbedding } from '../src/embedding.js';
import { createDocument, createChunks } from '../src/model.js';
import { JsonSearchStore, SearchEngine } from '../src/store.js';

// ─── embedder emits the configured dimension ───────────────────────────────────

test('createEmbedder emits vectors at the configured EMBEDDING_DIM (default 768)', async () => {
  const embedder = await createEmbedder({ embeddingProvider: 'hash', embeddingDim: 768 });
  assert.equal(embedder.dimensions, 768);
  const vec = await embedder.embed('quarterly revenue report');
  assert.equal(vec.length, 768, 'embedding width must equal configured dim');
});

test('createEmbedder honours a custom EMBEDDING_DIM', async () => {
  const embedder = await createEmbedder({ embeddingProvider: 'hash', embeddingDim: 512 });
  assert.equal(embedder.dimensions, 512);
  assert.equal((await embedder.embed('x')).length, 512);
});

test('embedder version encodes the dimension so a dim change is detectable', async () => {
  const a = await createEmbedder({ embeddingProvider: 'hash', embeddingDim: 768 });
  const b = await createEmbedder({ embeddingProvider: 'hash', embeddingDim: 384 });
  assert.notEqual(a.version, b.version, 'different dims must produce different versions');
});

// ─── fail-fast assertion ────────────────────────────────────────────────────────

test('assertEmbedderDimension passes on match, throws on mismatch', () => {
  assert.doesNotThrow(() => assertEmbedderDimension({ dimensions: 768 }, 768));
  assert.throws(() => assertEmbedderDimension({ dimensions: 384 }, 768), /dimension mismatch/i);
  assert.throws(() => assertEmbedderDimension({}, 768), /must declare/i);
  assert.throws(() => assertEmbedderDimension({ dimensions: 768 }, 0), /Invalid EMBEDDING_DIM/i);
});

test('SearchEngine construction fails fast when embedder dim != EMBEDDING_DIM', () => {
  const embedder = { model: 'm', version: 'v', dimensions: 384, embed: async () => [] };
  assert.throws(
    () => new SearchEngine({ store: null, embedder, embeddingDim: 768 }),
    /dimension mismatch/i,
    'mismatched dim must throw at startup, not silently write NULL',
  );
});

test('SearchEngine accepts a matching embedder dim', () => {
  const embedder = { model: 'm', version: 'v', dimensions: 768, embed: async () => [] };
  assert.doesNotThrow(() => new SearchEngine({ store: null, embedder, embeddingDim: 768 }));
});

// ─── matching dim indexes real vectors; version drift is flagged stale ──────────

test('matching dim indexes non-empty vectors and stamps the embedding version', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-dim-'));
  try {
    const store = new JsonSearchStore({ dataDir: dir });
    await store.load();
    const embedder = await createEmbedder({ embeddingProvider: 'hash', embeddingDim: 768 });
    const engine = new SearchEngine({ store, embedder, embeddingDim: 768 });

    await engine.indexDocuments([
      createDocument({
        tenantId: 't', userId: 'u', source: 'slack', sourceId: 's1',
        title: 'budget', body: 'annual budget planning numbers', timestamp: new Date().toISOString(),
      }),
    ], { chunker: createChunks });

    const chunks = store.listChunks();
    assert.ok(chunks.length > 0, 'expected indexed chunks');
    assert.ok(chunks.every((c) => c.embedding.length === 768), 'every chunk vector must be 768-wide');
    assert.ok(chunks.every((c) => c.embeddingVersion === embedder.version), 'version must be stamped');

    // No drift against the current embedder.
    assert.equal(engine.findStaleChunks().length, 0, 'nothing should be stale at the current version');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findStaleChunks flags chunks embedded under a prior version/dimension', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uss-stale-'));
  try {
    const store = new JsonSearchStore({ dataDir: dir });
    await store.load();

    // Index under an old 384-dim embedder.
    const oldEmbedder = await createEmbedder({ embeddingProvider: 'hash', embeddingDim: 384 });
    const oldEngine = new SearchEngine({ store, embedder: oldEmbedder, embeddingDim: 384 });
    await oldEngine.indexDocuments([
      createDocument({
        tenantId: 't', userId: 'u', source: 'slack', sourceId: 's1',
        title: 'old', body: 'legacy content', timestamp: new Date().toISOString(),
      }),
    ], { chunker: createChunks });

    // Now the system runs at 768: those chunks are stale.
    const newEmbedder = await createEmbedder({ embeddingProvider: 'hash', embeddingDim: 768 });
    const newEngine = new SearchEngine({ store, embedder: newEmbedder, embeddingDim: 768 });
    const stale = newEngine.findStaleChunks();
    assert.ok(stale.length > 0, 'old-version chunks must be flagged stale for reindex');
    assert.ok(stale.every((s) => s.embeddingVersion === oldEmbedder.version));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// keep hashEmbedding's default importable (sanity)
test('hashEmbedding default width is 384 (legacy default)', () => {
  assert.equal(hashEmbedding('x').length, 384);
});
