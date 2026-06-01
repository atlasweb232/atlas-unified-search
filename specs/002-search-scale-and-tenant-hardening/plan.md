# Implementation Plan

## Architecture Shift

Today the store layer is one class doing two jobs: `PostgresSearchStore extends
JsonSearchStore`, where Postgres is treated as a place to serialize/deserialize
the whole in-memory JSON state. The plan splits responsibilities so Postgres is
queried like a database.

```text
Before (current):
  API request
    -> refreshStore()                  # SELECT * FROM every table (full corpus)
    -> SearchEngine.search()           # JS cosine over ALL chunks in memory
    -> store.save()                    # re-UPSERT entire in-memory state

After (target):
  API request
    -> AuthIdentity (JWT / per-tenant key)   # derive + verify {tenantId,userId}
    -> SearchStore.search(scope, queryVec, k)
         -> SQL: WHERE tenant_id/user_id/source
                 ORDER BY embedding <=> $vec   (pgvector ivfflat/hnsw)
                 LIMIT k                         (bounded candidate set)
         -> re-rank candidates (vector+lexical+recency) -> top N
    -> SearchStore.persist(changedRowsOnly)      # diff-based, scoped write
```

## Store Interface (decouple from JSON state)

Define an explicit `SearchStore` interface and make both backends implement it,
instead of inheriting full-state behaviour:

```text
SearchStore
  init() / close()
  # retrieval
  searchChunks({ tenantId, userId, sources, queryVector, limit, filters }) -> candidates
  getDocument(id, scope)
  scopedIndexStatus(scope)                  # SQL COUNT/GROUP BY
  # writes (row-scoped, not whole-state)
  upsertDocuments(docs) / upsertChunks(chunks)
  deleteDocuments(scope, ids?)              # durable; no resurrection
  setCheckpoint(key, cp) / getCheckpoint(key)
  # operational
  createJob / updateJob / listJobs(scope, limit)
  createSearchRun / updateSearchRun / updateSourceStatus / getSearchRun(id)
  createAssistantAction / updateAssistantAction / getAssistantAction(id)
  createArtifact / ...
  appendAudit(event) / listAudit(scope, eventType, limit)   # SQL LIMIT
  cleanupRetention(scope, cutoffs, { dryRun })               # already SQL in PG
```

- `PostgresSearchStore` implements each method with a scoped query. It stops
  caching the full corpus in `this.state` and stops blind full-state `save()`.
- `JsonSearchStore` stays as the dev/test fallback but its `search` becomes a
  scoped, bounded lexical search (no behavioural promise of pgvector ANN).
- `SearchEngine.search` delegates retrieval to `store.searchChunks(...)` and only
  performs the bounded re-rank, instead of pulling `store.listChunks()`.

## pgvector Retrieval

- Add `searchChunks` SQL: join `unified_chunks` to `unified_documents`, filter by
  scope/source and document-level `filters` (containers/authors/date range),
  `ORDER BY embedding <=> $queryVector::vector LIMIT $k`.
- Keep hybrid scoring: the ANN query bounds candidates; lexical overlap + recency
  are applied as a re-rank over those candidates, weights from config.
- Index: keep `ivfflat (vector_cosine_ops)`; evaluate `hnsw` (see `research.md`).
  Ensure a partial/secondary index supports the scope predicate efficiently.
- Dimension: parameterize the vector column dimension. The migration's
  `vector(1536)` must equal `EMBEDDING_DIM`. Startup asserts embedder dim ==
  column dim (FR-5).

## Concurrency-Safe Writes

- Replace `save()`-everything with targeted upserts/deletes per operation.
- Deletes use authoritative `DELETE ... WHERE` and do not depend on any process's
  in-memory document set; no path re-inserts a row it did not just create.
- Add an `updated_at`-based last-writer-wins (default) or optional `version`
  column for documents/chunks; decision recorded in `research.md`. The
  in-process `withStoreLock` is retained only for local critical sections, not as
  the cross-instance guarantee.

## Identity Layer

- New `src/middleware/identity.js` resolving the effective `{ tenantId, userId,
  allowedSources }` from:
  - `IDENTITY_MODE=jwt`: verify signature (shared secret or JWKS), read claims,
    reject mismatched body/query scope.
  - `IDENTITY_MODE=api_key`: look up the presented key in a tenant-key map
    (config/Key Vault), bind to its tenant + permitted users.
  - `IDENTITY_MODE=shared_token` (current behaviour): single-tenant / trusted
    network only; `production-readiness` marks multi-tenant unsafe.
- `requireApiAuth` composes with identity: webhooks unchanged; `/v1/health`
  unchanged. Data routes consume `req.identity` and stop trusting raw body
  `tenantId`/`userId` (they must equal the identity scope or be derived from it).
- `matchesScope()` checks `req.identity` entitlement, not just row equality.

## SSE / Operational Reads

- `/v1/search-runs/:id/events`: read only that run row per tick (scoped
  `getSearchRun`), or migrate to Postgres `LISTEN/NOTIFY` on a
  `search_run_updated` channel. `/v1/index/status` and `/v1/audit` become SQL
  aggregations / `LIMIT` reads.

## Recommended Stack (unchanged from 001, made real)

- Postgres + pgvector as the production store — now actually queried via ANN.
- Local Postgres+pgvector via Docker for dev/CI parity.
- Deterministic local embedder at configurable dimension for credential-free tests.
- Mock chat + local artifact providers for credential-free tests.

## Migration Strategy

- `migrations/002_*.sql`: parameterized vector dimension, optional `version`
  column, any index changes (hnsw eval), and supporting indexes for scoped reads.
- Provide a reindex path (reuse `/v1/reindex/:source` with `forceFullSync`) to
  repopulate vectors after a dimension/model change.
- Backfill note: existing rows with NULL `embedding` (384-vs-1536 bug) require a
  reindex to become searchable via ANN; documented in `quickstart.md`.

## Rollout / Verification Order

1. Store interface + JsonStore scoped search (no DB needed) + unit tests.
2. Embedding dimension reconciliation + fail-fast (FR-5).
3. pgvector scoped retrieval + diff-based writes against local Postgres.
4. Identity layer + scope enforcement.
5. Concurrency tests (two-instance simulation).
6. SSE + operational read/retention trimming.
7. Backwards-compat check against the existing frontend.

Each step is gated by tests that run with **no live connector/LLM/embedding
credentials**.
