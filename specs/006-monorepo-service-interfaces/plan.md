# Implementation Plan

## Guiding principle

Extract one package at a time, smallest-dependency-first. After each extraction,
`npm test` must still pass. `src/` files become thin re-exports so no import
paths break during transition.

## Extraction order (dependency graph drives it)

```
1. embedding    ← no internal deps; blocks 005
2. store        ← depends on embedding (vectors); unblocks 002 M3 + 005
3. search       ← depends on store + embedding
4. connectors   ← depends on embedding (for fixtures); largely self-contained
5. ingestion    ← depends on connectors + store + queue interface
6. extraction   ← depends on connectors (fetch); 003 M1/M2
7. assistant    ← depends on store + extraction
8. identity     ← depends on nothing (pure auth logic)
9. media        ← depends on store + connectors; 004
10. api         ← depends on everything; last
```

## Step-by-step

### Phase 1 — embedding package (priority 1, blocks 005)

```
packages/embedding/
  package.json  { "name": "@atlas/embedding", "type": "module" }
  src/
    interfaces.js     TextEmbedder { model, version, dim, embed(text)->float32[] }
                      VisionEmbedder { model, dim, embed({buffer,mimeType})->float32[] }
    text/
      hash.js         hashEmbedding + normalize (from src/embedding.js)
      openai.js       openaiEmbedding (from src/embedding.js)
    vision/
      local-clip.js   LocalClipProvider stub (real impl in 005)
      api.js          ApiVisionEmbedder stub
    vector-spaces.js  VectorSpaceRegistry (full impl in 005; stub here)
    index.js          createTextEmbedder(config), createVisionEmbedder(config)
  test/
    hash.test.js
    interfaces.test.js   asserts dim integrity contract
```

`src/embedding.js` becomes:
```js
export { createTextEmbedder as createEmbedder, cosineSimilarity }
  from '@atlas/embedding';
```

### Phase 2 — store package (priority 2, unblocks 002 M3 + 005)

```
packages/store/
  src/
    interfaces.js
      DocumentStore  { upsertDocument, getDocument, deleteDocuments,
                       setCheckpoint, getCheckpoint, deleteCheckpoints,
                       createJob, updateJob, listJobs,
                       createSearchRun, updateSearchRun, updateSourceStatus, getSearchRun,
                       createAssistantAction, updateAssistantAction, getAssistantAction,
                       createArtifact, appendAudit, listAudit,
                       scopedIndexStatus, cleanupRetention }
      VectorStore    { upsertChunks, deleteChunks,
                       searchChunks({scope, queryVectors, spaces, candidateLimit, filters}) }
    document/
      json-document-store.js   (extract from src/store.js JsonSearchStore — ops only)
      postgres-document-store.js (extract from src/stores/postgresStore.js — ops tables)
    vector/
      json-vector-store.js     (in-memory cosine; from src/store.js searchChunks)
      pgvector-store.js        (ANN queries; 002 M3; stub here, impl in 002 M3)
      qdrant-store.js          (stub only)
    workbench/
      in-memory.js             (003 M4)
      redis.js                 (003 M4 stub)
    index.js  createDocumentStore(config), createVectorStore(config)
  test/
    interfaces.test.js   contract compliance for both stores
    json-vector-store.test.js
```

`src/store.js` and `src/stores/postgresStore.js` become re-exports during transition.

### Phase 3 — search package

```
packages/search/
  src/
    search-engine.js   SearchEngine (from src/store.js) — now takes
                       DocumentStore + VectorStore as injected deps
    search-run.js      SearchRunCoordinator (from src/searchRun.js)
    index.js
```

`SearchEngine` constructor changes from `{ store, embedder }` to
`{ documentStore, vectorStore, embedder, weights }`. The search-run
coordinator changes from `{ store, searchEngine }` to
`{ documentStore, searchEngine }`.

### Phase 4 — connectors package

Move `src/connectors/` → `packages/connectors/src/`, keeping all connector
logic unchanged. `ConnectorRegistry`, `ConnectorTokenProvider`, and all six
connectors are exported from `@atlas/connectors`.

### Phase 5 — ingestion package

```
packages/ingestion/
  src/
    interfaces.js   Queue { enqueue(msg) }, Receiver { subscribe, close }
    queue/
      inline.js
      service-bus.js
      bullmq.js       stub (real impl: npm install bullmq, no account needed)
    job-runner.js   (from src/jobRunner.js)
    scheduler.js    (from src/scheduler.js)
    token-provider.js
    index.js
```

Worker (`src/worker.js`) and scheduler (`src/scheduler.js`) become thin
entrypoints that import from `@atlas/ingestion`.

### Phase 6 — extraction package (003 M1/M2)

New package; no migration needed — these files don't exist yet.

### Phase 7 — assistant package

Move `src/assistant/` → `packages/assistant/src/`, extend with `003 M5`
artifact providers behind the `ArtifactProvider` interface.

### Phase 8 — identity package (002 M5)

New package. `src/middleware/auth.js` shrinks to a re-export.

### Phase 9 — media package (004)

New package. Transcription provider + clip server.

### Phase 10 — api package (last)

`src/app.js` (1114 lines) is rewritten to ~150 lines of pure route wiring:

```js
import { searchEngine, searchRuns } from '@atlas/search';
import { jobs, queue } from '@atlas/ingestion';
import { assistant } from '@atlas/assistant';
import { requireIdentity } from '@atlas/identity';

app.post('/v1/search', requireIdentity, async (req, res) => {
  const results = await searchEngine.search(req.identity.scope(req.body));
  res.json({ success: true, results });
});
```

All webhook verification logic moves into `@atlas/ingestion` (connector-specific
concern). All production readiness logic moves into a `readiness.js` module in
the right package.

## Root workspace package.json

```json
{
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "test": "node scripts/check-specs.mjs && node --test tests/*.test.js",
    "test:packages": "npm test --workspaces",
    "test:all": "npm run test:packages && npm test"
  }
}
```

## What does NOT change

- `migrations/` — stays at root
- `scripts/` — stays at root
- `frontend/` — stays at root (separate Vite build)
- `specs/` — stays at root
- `.env.example` — stays at root
- Deployment topology — same three Container Apps
