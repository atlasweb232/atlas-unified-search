# Research & Decisions

## 1. Why the current pgvector path does not scale

`PostgresSearchStore` extends `JsonSearchStore` and uses Postgres as a JSON
state blob: `loadStateFromPostgres()` issues `SELECT *` on every table with no
scope, `refresh()` reruns it per request, `save()` re-upserts the entire
in-memory state, and `SearchEngine.search` scores cosine similarity in JS over
`store.listChunks()`. The `ivfflat` index is never used. This is O(corpus) memory
and CPU per request and breaks under multiple instances. Confirmed by: no
`<=>`/`vector_cosine` query in `src/`; `loadStateFromPostgres` `SELECT *` calls;
`upsertChunk` NULLing the vector unless `length === 1536` while the default
embedder is 384-dim.

## 2. ANN index: ivfflat vs hnsw

- **ivfflat** (current): smaller build, needs `ANALYZE` + tuned `lists`, recall
  depends on `probes`; poor on tiny corpora.
- **hnsw**: better recall/latency, no training step, larger memory/build cost.
- **Decision (proposed):** keep `ivfflat` for parity, but make the index
  swappable in `migrations/002`; benchmark hnsw on a fixture corpus before
  committing. For correctness tests, exact KNN over a small fixture set is fine
  regardless of index.

## 3. Hybrid scoring with a bounded candidate set

Pure ANN returns vector-nearest rows but loses lexical/recency boosts. Decision:
ANN (or scoped lexical fallback) returns the top `k*` candidates in SQL, then the
existing hybrid formula (vector + lexical + recency, configurable weights)
re-ranks those candidates in Node to top `N`. This preserves current ranking
behaviour while bounding work to `k*` rows, not the whole corpus. `k*` is
configurable (default e.g. `max(50, 5*limit)`).

## 4. Concurrency model (FR-3)

Options:

- **updated_at last-writer-wins (no schema change):** simplest; acceptable because
  syncs are idempotent by stable source IDs and re-running a sync converges.
  Risk: a stale full-state writer could still clobber — *mitigated by removing
  full-state writes entirely (M4)*, which is the real fix.
- **version column optimistic concurrency:** strongest for hot rows; adds a
  column + retry logic.
- **row locks (`FOR UPDATE`):** good for read-modify-write of a single row
  (e.g. `updateSourceStatus`).

**Decision (proposed):** the primary fix is eliminating whole-state writes
(diff-based, row-scoped writes); combine with `updated_at` LWW for
documents/chunks and short `FOR UPDATE` transactions for search-run/source-status
mutations. Revisit a `version` column only if contention is observed.

## 5. Identity model (FR-4)

Current: one shared bearer token; `tenantId`/`userId` trusted from the request.
This is auth-by-claim and allows trivial cross-tenant access.

Decision (proposed): support three modes via `IDENTITY_MODE`:

- `jwt` (recommended for multi-tenant): verify HS256 shared secret or RS256/JWKS;
  claims carry `tenantId`/`userId`/sources; mismatched body scope → 403.
- `api_key`: per-tenant key → tenant/user binding from
  `IDENTITY_TENANT_KEYS_JSON` (or Key Vault); out-of-scope → 403.
- `shared_token`: keep current behaviour for single-tenant / trusted-network;
  flagged not multi-tenant-safe in `production-readiness`.

Open: reuse an existing Atlas issuer vs. a minimal local issuer for dev/tests.
Tests use locally minted tokens, so no external IdP is required to verify the
mechanism.

## 6. SSE efficiency (FR-2)

Current poller calls `refresh()` (full DB) every 500ms per stream. Decision:
either scoped single-row `getSearchRun` per tick, or Postgres `LISTEN/NOTIFY` on
a `search_run_updated` channel emitting on run/source-status writes. LISTEN/NOTIFY
removes polling latency but adds a dedicated connection per listener; for MVP a
scoped single-row read at the current cadence is acceptable and far cheaper than
today.

## 7. Credential-free verification (answers "can you do it without the account?")

Yes. Every gap is in store/retrieval/auth/concurrency, none requiring a live
connector:

- Local Postgres+pgvector via Docker is the system under test.
- Connectors already accept `options.fixtures`, so the full
  queue → index → pgvector → search → assistant path runs on fixtures.
- A deterministic local embedder at `EMBEDDING_DIM` exercises the real ANN path
  with no embedding API.
- Mock chat provider + local artifact provider cover the assistant path.
- Identity is verified with locally minted JWTs / synthetic per-tenant keys.

Only live `checkReadiness` against real Slack/Google/Azure needs accounts, and
that is out of scope here.

## 8. Backwards compatibility

No `/v1/*` response shape changes (only auth semantics). The existing
`UnifiedSearchWorkspace` frontend and `atlas-emailreact` embedding keep working;
verified by reusing current contract tests in `unified-search.test.js`.
