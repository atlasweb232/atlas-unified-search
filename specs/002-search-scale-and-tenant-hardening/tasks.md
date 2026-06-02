# Tasks

All milestones below are verifiable with **no live Slack/Google/Azure/embedding/
LLM credentials** — local Postgres+pgvector (Docker), connector fixtures,
deterministic local embedder, and mock providers only.

## Speckit

- [ ] Define the scale/tenant-hardening feature (this spec).
- [ ] Define the pgvector retrieval contract.
- [ ] Define the auth/identity contract.
- [ ] Record concurrency + identity decisions in research.

## M1: Store interface decoupling

- [x] Define explicit `SearchStore` interface (retrieval / scoped reads /
      row-scoped writes / operational).
- [x] Make `JsonSearchStore` implement it with a **scoped, bounded** lexical
      search (no full-corpus scan).
- [x] Stop `SearchEngine.search` from calling `store.listChunks()`; delegate to
      `store.searchChunks(scope, queryVector, k)` and only re-rank candidates.
- [x] Make ranking weights configurable (replace hard-coded 0.72/0.22/0.06).
- [x] Unit tests for scoped retrieval + re-rank parity (no DB required).

## M2: Embedding dimension integrity

- [x] Single source of truth for `EMBEDDING_DIM` shared by embedder, chunk
      writer, and migration.
- [x] Local deterministic embedder can emit vectors at the configured dimension.
- [x] Fail fast at startup when embedder dim ≠ vector column dim.
- [x] Detect `embeddingModel`/`embeddingVersion` change per chunk and flag for
      reindex.
- [x] Tests: matching dim → indexes vectors; mismatched dim → startup error.

## M3: pgvector scoped retrieval

- [ ] `migrations/002_*.sql`: parameterized vector dimension, scope-supporting
      indexes, hnsw vs ivfflat decision applied.
- [ ] Implement `PostgresSearchStore.searchChunks` using
      `ORDER BY embedding <=> $vec::vector LIMIT k` with scope + document filters.
- [ ] Document-level filters (containers/authors/date range) pushed into SQL.
- [ ] Lexical + recency re-rank over the bounded candidate set.
- [ ] Documented fallback (lexical, bounded) when pgvector/vectors absent.
- [ ] `EXPLAIN`/query-log test proving a bounded indexed query, not a full scan.

## M4: Diff-based, concurrency-safe writes

- [ ] Replace blind full-state `save()` with row-scoped upserts/deletes per op.
- [ ] Make deletes (`/v1/documents`, `/v1/sources/:source/documents`,
      `/v1/reindex/:source`, retention) authoritative and non-resurrecting.
- [ ] Add the chosen concurrency mechanism (updated_at LWW / version column /
      row locks) cross-process.
- [ ] Scoped reads for `refresh()`-backed routes (`/v1/index/status`,
      `/v1/documents/:id`, `/v1/jobs`, `/v1/search-runs/:id`).
- [ ] Test: index 1 doc + unrelated audit write does not rewrite prior rows.
- [ ] Test: two-instance delete-vs-stale-write → deleted row stays deleted.

## M5: Identity-bound tenancy

- [x] `src/middleware/identity.js` with `IDENTITY_MODE` = `jwt` | `api_key` |
      `shared_token`.
- [x] JWT mode: verify signature, read `tenantId`/`userId`/allowed sources,
      reject scope mismatch.
- [x] API-key mode: per-tenant key → tenant/user binding; reject out-of-scope.
- [x] Compose with `requireApiAuth`; keep webhooks + `/v1/health` behaviour.
- [x] `matchesScope()` enforces identity entitlement, not just row equality.
- [x] Data routes derive scope from identity instead of trusting raw body IDs.
- [x] `production-readiness` reports shared-token as not multi-tenant-safe.
- [x] Tests: cross-tenant ID substitution → 403 (jwt + api_key modes).

## M6: Bounded operational tables & SSE

- [ ] Audit reads come from SQL `ORDER BY created_at DESC LIMIT n`.
- [ ] Retention trims `audit`/`jobs`/`search_runs`/`assistant_actions` in DB
      without a full reload.
- [ ] SSE stream reads only the single search-run row per tick (or migrate to
      Postgres `LISTEN/NOTIFY`).
- [ ] Tests: retention cutoff reflected in DB counts; SSE does no full refresh.

## M7: Backwards compatibility & CI

- [ ] Confirm `/v1/*` response shapes unchanged; existing frontend works.
- [ ] `docker-compose` (or script) bringing up local Postgres+pgvector for tests.
- [ ] CI job runs the full M1–M6 suite with **no** connector/LLM/embedding
      credentials set.
- [ ] Update `quickstart.md` with the credential-free local verification flow.
- [ ] Update `docs/production-readiness-checklist.md` with identity modes and the
      real pgvector retrieval path.

## Explicitly Out of Scope (still credential-gated, unchanged)

- Live Slack/Google/Azure connector readiness against real accounts.
- New sources, UI panels, or assistant action types.
- Migration to Azure AI Search / Qdrant.
