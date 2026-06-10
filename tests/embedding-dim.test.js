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

test('bge_api embedder calls the configured authenticated 768-dimension service', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: new Array(768).fill(1) }] }),
    };
  };
  try {
    const embedder = await createEmbedder({
      embeddingProvider: 'bge_api',
      embeddingDim: 768,
      embeddingModel: 'BAAI/bge-base-en-v1.5',
      embeddingApiUrl: 'https://bge.internal',
      embeddingApiKey: 'secret',
    });
    const vector = await embedder.embed('quarterly planning');
    assert.equal(vector.length, 768);
    assert.equal(request.url, 'https://bge.internal/v1/embeddings');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    assert.deepEqual(JSON.parse(request.options.body), {
      model: 'BAAI/bge-base-en-v1.5',
      input: ['quarterly planning'],
      dimensions: 768,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bge_api embedder batches multiple texts in one request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const input = JSON.parse(options.body).input;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: input.map(() => ({ embedding: new Array(768).fill(1) })) }),
    };
  };
  try {
    const embedder = await createEmbedder({
      embeddingProvider: 'bge_api',
      embeddingDim: 768,
      embeddingApiUrl: 'https://bge.internal',
    });
    const vectors = await embedder.embedMany(['one', 'two', 'three']);
    assert.equal(calls, 1);
    assert.equal(vectors.length, 3);
    assert.ok(vectors.every((vector) => vector.length === 768));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bge_api requires an endpoint', async () => {
  await assert.rejects(
    createEmbedder({ embeddingProvider: 'bge_api', embeddingDim: 768 }),
    /EMBEDDING_API_URL/,
  );
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

test('SearchEngine sends remote embeddings in batches with concurrency two', async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const stored = [];
  const embedder = {
    model: 'bge',
    version: 'bge:v1',
    dimensions: 768,
    embed: async () => new Array(768).fill(0),
    embedMany: async (texts) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return texts.map(() => new Array(768).fill(1));
    },
  };
  const engine = new SearchEngine({
    store: { upsertDocument: (document, chunks) => stored.push({ document, chunks }) },
    embedder,
    embeddingDim: 768,
  });
  const documents = Array.from({ length: 65 }, (_, index) => ({ id: `d${index}` }));
  await engine.indexDocuments(documents, {
    chunker: (document) => [{ id: `${document.id}:0`, text: document.id }],
  });
  assert.equal(calls, 3);
  assert.equal(maxActive, 2);
  assert.equal(stored.length, 65);
  assert.ok(stored.every(({ chunks }) => chunks[0].embeddingVersion === 'bge:v1'));
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
