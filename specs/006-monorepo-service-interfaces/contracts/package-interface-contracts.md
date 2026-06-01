# Contract: Package Interface Compliance

## Rule

Every concrete provider in a package MUST satisfy its package's interface.
Satisfying the interface means:

1. All required methods are present with matching signatures.
2. Output types match (e.g. `embed()` returns `float32[]` of length `dim`).
3. Errors are thrown as standard `Error` objects with descriptive messages.
4. `configured()` returns `false` rather than throwing when credentials are
   absent — the caller decides whether to error or fallback.

## Compliance tests (each package ships these)

```js
// packages/embedding/test/interfaces.test.js
test('TextEmbedder contract', async () => {
  for (const Provider of [HashTextEmbedder, OpenAITextEmbedder]) {
    const p = new Provider(testConfig);
    assert.equal(typeof p.model, 'string');
    assert.equal(typeof p.version, 'string');
    assert.equal(typeof p.dim, 'number');
    assert.equal(typeof p.embed, 'function');
    // dim integrity: output must match p.dim
    if (p.configured()) {
      const vec = await p.embed('test');
      assert.equal(vec.length, p.dim);
    }
  }
});

// packages/store/test/interfaces.test.js
test('VectorStore contract', () => {
  for (const Store of [JsonVectorStore, PgVectorStoreStub, QdrantStoreStub]) {
    const s = new Store(testConfig);
    assert.equal(typeof s.upsertChunks, 'function');
    assert.equal(typeof s.deleteChunks, 'function');
    assert.equal(typeof s.searchChunks, 'function');
  }
});
```

## Factory contract

Each package exports a factory that returns the right concrete class based on
config, and MUST throw a descriptive error if the config is unrecognised:

```js
// packages/embedding/src/index.js
export function createTextEmbedder(config) {
  const provider = config.embeddingProvider || 'hash';
  if (provider === 'hash')   return new HashTextEmbedder(config);
  if (provider === 'openai') return new OpenAITextEmbedder(config);
  throw new Error(`Unknown EMBEDDING_PROVIDER: ${provider}`);
}
```

## Stub contract

Stubs implement the interface and throw `NotImplementedError`:

```js
export class QdrantVectorStore {
  // implements VectorStore interface
  async searchChunks() {
    throw new Error('QdrantVectorStore is not yet implemented');
  }
}
```

This proves the interface is correct (a class can satisfy it) and gives
future implementers a starting template.
