# Handover — Local Postgres + pgvector for `atlas-unified-search`

**Date:** 2026-06-21
**Branch:** `speckit/170-source-credential-resolver` (running locally; not part of any open PR)
**Scope:** Phase 1 of "desktop-only unified search" — bring vector storage to the desktop side without changing app code.

## What's done ✅

- **Postgres + pgvector running locally** via Docker container `atlas-unified-search-pg` (image `pgvector/pgvector:pg16`, port `5432`, DB `unified_search`, user/password `postgres`/`postgres`).
- **Migrations applied** — `npm run db:migrate` ran `migrations/001_pgvector_store.sql` (8 `unified_*` tables + ivfflat cosine index on `unified_chunks.embedding vector(768)`) and `migrations/002_connector_installations.sql`.
- **`.env` pointed at local Postgres** — `POSTGRES_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:5432/unified_search`, `POSTGRES_SSL=false`. Dev cipher key `CONNECTOR_CREDENTIAL_ENCRYPTION_KEY` also added (the cipher at `src/credentialCipher.js:4` requires one and `.env.example` doesn't ship one).
- **Existing `createSearchStore` factory (`src/stores/postgresStore.js:329`) picked up the new connection string on restart** — `/v1/health` now reports `"index":{"backend":"postgres-pgvector","ready":true}`. Zero code changes to either app.
- **Slack fixture roundtripped through the new backend** — `npm run seed:fixtures` indexed the Slack fixture into 1 document + 3 chunks (body + thread reply + file attachment), each with a real 768-dim `hash-embedding` vector written to `unified_chunks.embedding`.
- **`atlas-email-desktop` not touched** — that repo is unchanged; this Phase 1 only affects `atlas-unified-search`'s storage layer.

## Quick start (cold machine)

```bash
# 1. Bring up local Postgres+pgvector
docker run -d --name atlas-unified-search-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=unified_search \
  -p 5432:5432 \
  pgvector/pgvector:pg16

# 2. Point the app at it (one-time per clone)
cd /home/rakib232/git/atlas-unified-search
test -f .env || cp .env.example .env
# edit .env: set POSTGRES_CONNECTION_STRING + POSTGRES_SSL=false
# also add CONNECTOR_CREDENTIAL_ENCRYPTION_KEY=<dev-only-string>

# 3. Apply migrations
npm run db:migrate

# 4. Boot the web app (still on Node, Slack connector still runs here)
npm run dev
# API → http://localhost:4420  (search, sync, /v1/health)
# Web → http://localhost:4421  (the React UI)

# 5. Verify
curl -sS http://localhost:4420/v1/health | jq '.index'
# → { "backend": "postgres-pgvector", "ready": true }
```

## Common commands

```bash
# Inspect the vector store directly
docker exec -it atlas-unified-search-pg psql -U postgres -d unified_search

# Count documents / chunks per source
docker exec atlas-unified-search-pg psql -U postgres -d unified_search -c \
  "SELECT source, COUNT(*) AS docs FROM unified_documents GROUP BY source;
   SELECT source, COUNT(*) AS chunks, COUNT(embedding) AS with_vec FROM unified_chunks GROUP BY source;"

# Run an ivfflat cosine KNN (the same operator the app uses)
docker exec atlas-unified-search-pg psql -U postgres -d unified_search -c \
  "SELECT c.id, 1 - (c.embedding <=> <query_vec>) AS cosine
   FROM unified_chunks c
   WHERE c.tenant_id = '<tenant>' AND c.user_id = '<user>'
   ORDER BY c.embedding <=> <query_vec>
   LIMIT 10;"
# Replace <query_vec> with a literal `vector` literal, e.g. `'[0.1,0.2,...]'::vector`

# Re-seed fixtures (clears via DELETE first if you wire it; otherwise POSTs new)
npm run seed:fixtures

# Stop / start / nuke the DB
docker stop atlas-unified-search-pg
docker start atlas-unified-search-pg        # data persists in container overlay
docker rm -f atlas-unified-search-pg        # DESTROYS data
```

## What diverges from production

| Concern | Production (Azure) | This local dev |
|---|---|---|
| Postgres host | Azure Database for Postgres Flexible Server | Docker container `atlas-unified-search-pg` on `127.0.0.1:5432` |
| TLS | `POSTGRES_SSL=true` | `POSTGRES_SSL=false` (plaintext local socket) |
| pgvector extension | Provisioned by Azure | Pre-built into `pgvector/pgvector:pg16` image |
| Service Bus worker | Real Azure Service Bus + `npm run start:worker` | Inline queue (`queue.backend: 'inline'`) |
| Cipher key | Key Vault or IDENTITY_JWT_SECRET | `CONNECTOR_CREDENTIAL_ENCRYPTION_KEY=atlas-unified-search-dev-...` (rotate per environment; never use in prod) |
| Vector index | ivfflat with `lists=100` (pgvector `0.8.x`) | same — built by `001_pgvector_store.sql` |
| Embeddings | Either hash (default), `bge_api`, or `openai` | Hash embedder, 768 dims (`hash:v1:768`) |

The existing schema and `PostgresSearchStore` (`src/stores/postgresStore.js`) are unchanged — the local container is just a different connection target. Any code path that works in production also works against this local DB.

## Why this is "Phase 1" (not the whole desktop story)

The goal is a **desktop-only unified search** with no separate Postgres server. This Phase 1 gets the vector storage onto a local file/process boundary so the rest of the architecture can be ported without surprises. What's still server-side (and will move in Phase 2):

- Slack connector (`src/connectors/slack.js`, `src/oauth/slack.js`) — currently runs as the Node web app
- Service Bus worker / scheduler (`src/worker.js`, `src/scheduler.js`, `src/apiScheduler.js`)
- Embedder pipeline (`src/embedding.js`) — calls external BGE / OpenAI / hash
- API surface (`src/app.js`) — Express on port 4420

The schema and DDL in `migrations/001_pgvector_store.sql` are intentionally portable so a Phase 2 port can either keep using Postgres (run as a container alongside the desktop app) or migrate to SQLite + sqlite-vec using the same `unified_*` table shapes.

## Gotchas / things that bit while setting this up

1. **`CONNECTOR_CREDENTIAL_ENCRYPTION_KEY` is required at boot.** `src/credentialCipher.js:4` throws if both it and `IDENTITY_JWT_SECRET` are empty. `.env.example` doesn't include either. The dev value in `.env` is for local only.
2. **`POSTGRES_SSL=true` is the production default.** Without `POSTGRES_SSL=false`, the local container connect fails on TLS handshake (no server cert).
3. **`smoke:local-frontend` enforces auth.** It calls `checkAuthBoundary` (line 85) which expects `UNIFIED_SEARCH_REQUIRE_AUTH=true`. Our dev env has auth off, so the script errors. The pgvector path is still proven — verify with the `/v1/health` + `psql` KNN queries above.
4. **Single writer.** SQLite WAL allows many readers + one writer; Postgres doesn't have this constraint. Fine for desktop, but if a Phase 2 port runs both a Node ingest process and a C# reader against the same DB, writes will serialize.
5. **The `JsonSearchStore` JSON file (`atlas-unified-search/.data/unified-search.json`) is now unused** when `POSTGRES_CONNECTION_STRING` is set. Safe to delete; not auto-cleaned.
6. **Embedding dim is hardcoded `vector(768)`** in `001_pgvector_store.sql`. Switching embedders (e.g. OpenAI at 1536 dims) needs a new migration that drops + recreates `unified_chunks.embedding`. `assertVectorColumnDim` (`src/stores/postgresStore.js:31`) will block startup if there's a mismatch.

## Next phase pointers

- Phase 2 port to desktop app — start with the Slack connector + scheduler → embedder pipeline → API surface.
- Embedder consolidation — `atlas-email-desktop` already runs its own BGE path; `atlas-unified-search` calls BGE via HTTP. Decide one direction.
- The `pgvector` extension version here is `0.8.3`. Match in production before relying on newer features (HNSW indexes arrived in `0.7.0`; we're not using them yet).
