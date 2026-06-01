# Feature Spec: Search Scale & Tenant Hardening

## Summary

Close the gap between the *stated* architecture (Postgres + pgvector production
path, multi-instance API/worker/scheduler, multi-tenant isolation) and the
*current* implementation, which uses Postgres as a serialized JSON blob, loads
the entire corpus into memory on every request, scores search in-process with a
linear scan, never queries the `pgvector` index, and trusts client-supplied
`tenantId`/`userId` behind a single shared bearer token.

This feature makes retrieval query-driven and scoped, makes writes diff-based
and concurrency-safe across instances, binds tenant/user scope to a verified
identity, reconciles the embedding dimension with the vector column, and trims
operational tables in the database. All of it is verifiable **without any live
Slack, Google, or Azure connector account** using a local Postgres+pgvector,
connector fixtures, and the mock providers.

This feature does **not** add new sources, new UI surfaces, or new assistant
actions. It is a correctness, security, and scalability hardening pass over the
existing `001-unified-knowledge-search` implementation.

## Problem Statement (Observed Gaps)

The following are the concrete defects this spec resolves. File references point
at the current implementation on branch
`speckit/001-unified-knowledge-search-implementation`.

1. **Full-corpus in-memory load on every request.**
   `PostgresSearchStore.loadStateFromPostgres()` runs `SELECT *` against every
   table with no `tenant_id`/`user_id`/`limit` scoping
   (`src/stores/postgresStore.js`), and `refresh()` reruns it on essentially
   every request via `refreshStore()` in `src/app.js`.

2. **pgvector is never used for retrieval.**
   `SearchEngine.search()` loads all chunks into JS and computes cosine
   similarity in a loop (`src/store.js`). No `<=>` / `vector_cosine_ops` query
   exists in `src/`. The `ivfflat` index in
   `migrations/001_pgvector_store.sql` is dead weight.

3. **Embedding dimension mismatch.**
   The default embedder produces 384-dim hash vectors (`src/embedding.js`) but
   the column is `vector(1536)`; `upsertChunk` only writes the vector when
   `length === 1536`, so by default the `embedding` column is always NULL.

4. **Blind full-state writes / multi-instance races.**
   `save()` re-upserts the entire in-memory state (`src/stores/postgresStore.js`),
   so a process with a stale snapshot can resurrect rows another process
   deleted (the `/reindex` delete-then-reindex path is especially exposed).
   `withStoreLock` is an in-process promise chain only and provides no
   cross-instance guarantee.

5. **Tenant isolation is by claim, not identity.**
   A single static bearer token authorizes all callers; `tenantId`/`userId`
   come from the request body/query and are never verified against the caller.
   `matchesScope()` only checks the returned row equals the requested scope, not
   that the caller may use that scope. Any token holder can read or delete any
   tenant's data by changing the IDs.

6. **SSE streams re-read the whole database.**
   The `/v1/search-runs/:id/events` poller calls `refresh()` every 500ms per open
   connection (`src/app.js`), i.e. a recurring full-table scan per stream.

7. **Audit table grows unbounded.**
   In memory the audit log is capped at 1000 rows, but `unified_audit` is only
   ever inserted into (with `ON CONFLICT DO NOTHING`) and never trimmed except by
   a manual retention run, so older rows silently stop round-tripping.

## Goals

- Search and reads return identical results to today for the same corpus, but
  execute as **scoped SQL** (tenant/user/source predicates + pgvector ANN), not
  a full in-memory scan.
- Writes persist **only changed rows** and are safe under concurrent
  API + worker + scheduler instances sharing one Postgres.
- `tenantId`/`userId` used by any `/v1/*` data route are **derived from or
  verified against a caller identity**, not trusted from the request body.
- The stored embedding dimension and the vector column **always agree**, and a
  model/dimension change triggers a controlled reindex.
- Operational tables (`audit`, `jobs`, `search_runs`, `assistant_actions`) stay
  bounded by retention in the database, not just in memory.
- Everything above is provable in CI/local with **no live connector
  credentials**.

## Non-Goals

- No new connectors, sources, assistant actions, or UI panels.
- No live Slack/Google/Azure account validation (remains gated by
  `checkReadiness`, out of scope here).
- No switch away from Postgres/pgvector to Azure AI Search or Qdrant (the
  `001` open question stays open; this feature commits to making the
  pgvector path real first).
- No change to the connector normalization shape (`SearchDocument` /
  `SearchChunk` fields stay as defined in `001/data-model.md`).
- No new public blob URL exposure.

## Functional Requirements

### FR-1: Query-driven, scoped retrieval

- The store MUST expose a scoped search that filters by `tenantId`, `userId`,
  and selected `source`s in SQL, returning at most `k` candidates.
- When the configured embedder dimension matches the vector column, retrieval
  MUST use a pgvector approximate-nearest-neighbour query
  (`embedding <=> $query::vector` with the cosine operator class) ordered and
  limited in SQL.
- Hybrid scoring (vector + lexical + recency) MUST be preserved. Lexical and
  recency components MAY be computed in SQL or applied as a re-rank over the
  bounded candidate set returned by the ANN query — never over the whole
  corpus.
- A documented fallback MUST exist for environments where pgvector is
  unavailable or vectors are absent (e.g. JSON dev store): scoped lexical
  retrieval over a bounded candidate set. The fallback MUST NOT silently load
  the entire corpus.
- Ranking weights MUST be configurable (currently hard-coded `0.72/0.22/0.06`
  in `src/store.js`).

### FR-2: Scoped reads instead of full-state refresh

- `refresh()` MUST NOT load the entire database. Read endpoints
  (`/v1/index/status`, `/v1/documents/:id`, `/v1/search-runs/:id`,
  `/v1/jobs`, `/v1/audit`, `/v1/data-fabric/records`) MUST read only the rows
  in the requested scope (and, where applicable, by id).
- `/v1/index/status` counts MUST be computed by SQL aggregation, not by
  enumerating in-memory documents.
- The SSE stream (`/v1/search-runs/:id/events`) MUST refresh only the single
  search-run row (and its results) it is streaming, not the whole store. A
  push/notify mechanism (e.g. Postgres `LISTEN/NOTIFY`) MAY replace polling;
  if polling is retained it MUST be a single-row scoped read.

### FR-3: Diff-based, concurrency-safe writes

- A write MUST persist only the rows it actually created or mutated in that
  operation, not the process's entire in-memory state.
- Deletes (`/v1/documents`, `/v1/sources/:source/documents`,
  `/v1/reindex/:source`, retention) MUST be durable: a concurrent instance
  holding a stale snapshot MUST NOT re-insert deleted rows.
- Concurrent updates to the same row MUST converge deterministically
  (last-writer-wins by `updated_at`, optimistic version column, or row locks —
  chosen approach documented in `research.md`). The chosen mechanism MUST be
  cross-process, not the in-process `withStoreLock` alone.
- Sync/index, search-run, and assistant-action writes from the worker MUST be
  safe to run concurrently with API reads/writes against the same database.

### FR-4: Identity-bound tenancy

- For every `/v1/*` route that accepts `tenantId`/`userId`, the effective scope
  MUST be derived from, or validated against, an authenticated caller identity.
- Two identity modes MUST be supported and documented:
  - **Bearer/JWT identity**: a signed token carrying `tenantId`/`userId` (and
    optionally allowed sources); the API validates the signature and uses the
    claims, rejecting mismatched body/query scope.
  - **Per-tenant API key**: a key mapped to exactly one `tenantId` (and a set of
    users it may act for); requests outside that mapping are rejected `403`.
- The existing single shared-token mode MAY remain as an explicitly
  documented **single-tenant / trusted-network** mode, but MUST NOT be the
  default for multi-tenant deployment, and `production-readiness` MUST report
  it as not multi-tenant-safe.
- `matchesScope()` MUST additionally confirm the caller identity is entitled to
  the requested scope before returning a row.
- Webhook routes keep their existing signature-based verification and their
  bypass of bearer auth (unchanged).

### FR-5: Embedding dimension integrity

- The embedding dimension MUST be a single source of truth shared by the
  embedder, the chunk writer, and the schema/migration. Configuring an
  embedder whose dimension does not match the column MUST fail fast at startup
  with a clear error, not silently store NULL vectors.
- The local/deterministic test embedder MUST be able to produce vectors at the
  configured dimension so the pgvector path is exercisable with no external
  embedding API.
- Changing `embeddingModel`/`embeddingVersion` MUST be detectable per chunk and
  MUST drive a reindex (extend the existing "re-index when embedding model
  changes" requirement from `001`).

### FR-6: Bounded operational tables

- `unified_audit`, `unified_jobs`, `unified_search_runs`, and
  `unified_assistant_actions` MUST be trimmable in the database by the existing
  retention configuration without requiring a full reload.
- Audit reads MUST return the most recent events for a scope directly from SQL
  (`ORDER BY created_at DESC LIMIT n`) rather than from a 1000-row in-memory
  slice.

### FR-7: Backwards-compatible API surface

- No `/v1/*` request/response contract changes beyond authentication semantics
  (FR-4). Field shapes for search results, search runs, documents, and assistant
  actions are unchanged so the existing frontend and `atlas-emailreact`
  embedding keep working.

## Security & Tenancy

- A caller MUST only be able to read/write/delete records within a scope its
  identity is entitled to (FR-4); cross-tenant access via ID substitution MUST
  be impossible in the JWT and per-tenant-key modes.
- Connector, LLM, and artifact secrets remain backend-only (unchanged).
- Audit events MUST continue to be redacted (`redactObject`) and MUST now record
  the authenticated identity that performed the action, not only the claimed
  `tenantId`/`userId`.

## No-Live-Credentials Verification Strategy

This feature MUST be fully verifiable with no Slack/Google/Azure account:

- **Local Postgres + pgvector** (Docker) is the system under test; the JSON
  store remains the zero-dependency dev fallback.
- **Connector data** comes from `options.fixtures` (already supported by every
  connector's `sync`) — Slack/Drive/email/conference/KB-shaped fixtures are
  indexed and searched for real through the full queue → index → pgvector →
  search → assistant path.
- **Embeddings** use the local deterministic embedder at the configured
  dimension (FR-5); no embedding API key required.
- **Chat/artifacts** use the existing `MockChatProvider` and local artifact
  provider.
- **Identity** is exercised with locally minted JWTs / synthetic per-tenant keys.
- Live connector readiness (`checkReadiness` against real Slack/Google/Azure)
  is explicitly **excluded** from this feature's acceptance and remains gated.

## Acceptance Criteria

1. With a corpus indexed into Postgres, `/v1/search` and `/v1/search-runs`
   return the same documents (same ordering within tolerance) as the current
   in-memory implementation, but the query plan shows a **scoped, bounded** SQL
   query using the pgvector index — verified with `EXPLAIN`/query logging, not a
   full table scan.
2. Indexing a single new document and then performing an unrelated audit-only
   write does **not** rewrite previously stored documents/chunks (verified by
   row `updated_at` not changing, or by write-count instrumentation).
3. A concurrency test simulating two store instances: instance A deletes a
   document via reindex while instance B holds a stale snapshot and writes an
   audit event; the deleted document does **not** reappear.
4. A request presenting an identity for `tenantA` but a body `tenantId` of
   `tenantB` is rejected (`403`) in JWT and per-tenant-key modes; in shared-token
   single-tenant mode the response and `production-readiness` clearly mark it as
   not multi-tenant-safe.
5. Configuring an embedder whose dimension ≠ the vector column **fails fast at
   startup**; configuring a matching local embedder lets the full
   fixture → pgvector → search path run with no external API.
6. After retention cleanup, `unified_audit`/`unified_jobs`/`unified_search_runs`/
   `unified_assistant_actions` row counts in the database reflect the cutoff,
   and audit reads come from SQL `ORDER BY created_at DESC LIMIT n`.
7. An open SSE stream for one search run performs only single-row scoped reads
   (or LISTEN/NOTIFY), verified by query logging — no full-store refresh per
   tick.
8. The entire test suite for the above runs in CI against a local
   Postgres+pgvector container with **no Slack/Google/Azure/embedding/LLM
   credentials** configured.
9. Existing `/v1/*` response shapes are unchanged; the current frontend still
   works against the hardened backend.

## Open Questions

- Concurrency model for FR-3: optimistic `version` column vs. `updated_at`
  last-writer-wins vs. `SELECT ... FOR UPDATE` — decide in `research.md`.
- Identity: adopt an existing Atlas auth/JWT issuer, or define a minimal local
  issuer + per-tenant key table here?
- SSE: move to Postgres `LISTEN/NOTIFY`, or keep scoped polling at a higher
  interval for MVP?
- Should `001`'s "load whole state into memory" `JsonSearchStore` remain the dev
  store, or should dev also run pgvector via Docker for parity?
- Do we keep a re-rank-in-Node step over the ANN candidate set, or push lexical
  + recency fully into SQL?
