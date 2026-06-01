# Feature Spec: Monorepo Service Interfaces

## Summary

Restructure the codebase from a single-folder monolith into an **npm workspaces
monorepo** where each functional domain is an independently importable, testable,
and swappable package. Define explicit JS interfaces for every pluggable boundary
so that the HTTP framework, vector store, queue broker, and LLM/embedding
providers can each be replaced by changing one adapter file rather than hunting
through business logic.

This is a prerequisite for `005` (vision embedder doesn't fit the current
`embed(text)` signature) and makes every subsequent feature (`003`, `004`, `005`)
buildable as clean packages rather than new files dropped into the existing
monolith.

## Motivation from the code

| Problem | Location today |
|---|---|
| Business logic mixed with Express `req`/`res` | `src/app.js` (1114 lines) |
| Vector math + document store + search engine in one file | `src/store.js` |
| Postgres store handles vectors, documents, jobs, audit — all mixed | `src/stores/postgresStore.js` |
| `embed(text)` hard-coded — vision embedder can't fit this signature | `src/embedding.js` |
| No `VectorStore` interface — pgvector ↔ Qdrant swap touches everything | — |
| Queue interface exists but receiver side is Azure-specific in the worker | `src/worker.js` |
| No store interface — `PostgresSearchStore extends JsonSearchStore` inherits full-state blob behaviour | `src/stores/postgresStore.js:4` |

## Decisions (locked)

- **Packaging:** npm workspaces monorepo (`packages/`). Each package has its
  own `package.json`, is independently testable, and exports a clean public API.
- **Swap priority order:** (1) embedding interface — blocks `005`; (2) store
  interface — splits vector from operational, unblocks pgvector ANN and future
  Qdrant; (3) HTTP decoupling — `app.js` routes delegate to services; (4) queue
  abstraction — receiver side made framework-agnostic for local-dev parity.
- **No behaviour changes.** This is a structural refactor. Every existing test
  must pass unchanged. API response shapes are identical.
- **Primary adapters (decision updated):** the production `VectorStore` is
  **Qdrant** (named vectors, per-tenant collection — `005`/`007`), with
  pgvector + JSON as dev/fallback adapters; the production `Queue` is
  **Kafka-compatible** (`008`), with Service Bus / BullMQ / inline as
  alternative adapters. The interfaces are unchanged — only which concrete
  adapter is "primary" is now decided. Qdrant and Kafka are therefore real
  implementations, not stubs, once `007`/`008` land.
- **Incremental migration.** Packages are extracted one at a time; `src/` files
  become thin re-exports of the new packages during the transition so nothing
  breaks mid-flight.

## Package map

```
atlas-unified-search/               ← repo root (npm workspaces)
  packages/
    embedding/                      priority 1
      src/
        interfaces.js               TextEmbedder + VisionEmbedder contracts
        text/
          hash-provider.js          (from src/embedding.js hashEmbedding)
          openai-provider.js        (from src/embedding.js openaiEmbedding)
        vision/
          local-clip-provider.js    (new, 005)
          api-provider.js           (new, 005)
        vector-spaces.js            VectorSpaceRegistry (new, 005)
        index.js

    store/                          priority 2
      src/
        interfaces.js               SearchStore + VectorStore contracts
        document-store/
          json-document-store.js    (from src/store.js JsonSearchStore — docs/jobs/audit)
          postgres-document-store.js (operational tables only)
        vector-store/
          json-vector-store.js      (in-memory cosine, dev fallback)
          pgvector-store.js         (ANN queries, 002 M3)
          qdrant-store.js           (stub, future)
        workbench/
          in-memory-workbench.js    (003 M4)
          redis-workbench.js        (003 M4)
        index.js

    search/                         (after store)
      src/
        search-engine.js            (from src/store.js SearchEngine)
        search-run.js               (from src/searchRun.js)
        index.js

    connectors/                     (after embedding)
      src/
        interfaces.js               Connector contract
        registry.js                 (from src/connectors/base.js)
        slack/index.js
        gdrive/index.js
        conference/index.js
        email/index.js
        knowledge-base/index.js
        data-fabric/index.js
        index.js

    ingestion/                      (after connectors + store)
      src/
        job-runner.js               (from src/jobRunner.js)
        scheduler.js                (from src/scheduler.js)
        queue/
          interfaces.js             Queue + Receiver contracts
          inline-queue.js
          service-bus-queue.js
          bullmq-queue.js           (stub, local-dev Redis)
        token-provider.js           (from src/tokenProvider.js)
        index.js

    extraction/                     (003 M1 — new)
      src/
        interfaces.js               TextExtractor + AttachmentFetcher
        text-extractor.js           PDF/Office/text extraction
        attachment-fetcher.js       download bytes from source
        index.js

    assistant/                      (after store)
      src/
        actions.js                  (from src/assistant/actions.js)
        providers/
          interfaces.js             ChatProvider contract
          mock.js
          openai-compatible.js
          azure-openai.js
          anthropic.js
          cerebras.js
        artifact-providers/
          interfaces.js             ArtifactProvider contract (003 M5)
          local-artifact.js         (from src/assistant/artifacts.js)
          organic-artifact.js       (003 M5 — real pptx/pdf)
          llm-artifact.js           (003 M5)
        index.js

    identity/                       (002 M5 — new)
      src/
        interfaces.js               Identity contract
        middleware.js               (from src/middleware/auth.js + 002 M5)
        resolvers/
          jwt-resolver.js
          api-key-resolver.js
          shared-token-resolver.js
        index.js

    media/                          (004 — new)
      src/
        interfaces.js               TranscriptionProvider contract
        transcription/
          local-whisper.js
          cloud-provider.js
        clip-server.js              (segment streaming)
        index.js

    api/                            (HTTP surface — last)
      src/
        app.js                      ← thin route wiring only, < 200 lines
        routes/
          search.js
          sync.js
          webhooks.js
          assistant.js
          attachments.js            (003 M2)
          conference.js             (004 M4)
          workbench.js              (003 M4)
        server.js
        index.js
```

## Functional Requirements

### FR-1: Package interfaces — all pluggable boundaries are contracts

Every package MUST export an explicit interface (JS object shape or class with
documented methods) that its adapters implement. Calling code imports the
interface, not a concrete provider. Concrete providers are selected by config
or dependency injection.

- `embedding`: `TextEmbedder`, `VisionEmbedder`, `VectorSpaceRegistry`
- `store`: `SearchStore`, `VectorStore`, `DocumentStore`, `WorkbenchStore`
- `ingestion`: `Queue`, `Receiver`
- `assistant`: `ChatProvider`, `ArtifactProvider`
- `identity`: `IdentityResolver`
- `media`: `TranscriptionProvider`
- `extraction`: `TextExtractor`, `AttachmentFetcher`

### FR-2: `api` package contains no business logic

`packages/api/src/app.js` MUST only:
- Wire routes to service packages
- Serialize/deserialize HTTP request/response
- Apply middleware from `identity` package

It MUST NOT contain: vector math, store queries, sync logic, webhook
verification business rules, or production readiness computation. Those stay
in their respective packages and are called through their interfaces.

### FR-3: `store` package splits vector from operational

`VectorStore` handles: `upsertChunks`, `deleteChunks`, `searchChunks` (ANN).
`DocumentStore` handles: documents, jobs, search runs, assistant actions,
audit, checkpoints, retention.

These MAY share one Postgres connection pool but MUST be separate interfaces
so that the vector backend (pgvector today, Qdrant tomorrow) can be swapped
without touching operational record-keeping.

### FR-4: Incremental migration — no big-bang rewrite

- During migration, `src/` files become thin re-exports of `packages/`:
  `export { SearchEngine } from '@atlas/search';`
- Tests continue to import from `src/` during transition and pass unchanged.
- Each package is extracted in priority order; the monolith shrinks file by
  file, never breaks mid-flight.

### FR-5: Each package is independently testable

- Each package has its own `test/` directory and runs `node --test` in
  isolation with no dependency on other packages (except declared ones).
- CI runs `npm test --workspaces` plus the root integration suite.

### FR-6: No behaviour changes

All existing `/v1/*` response shapes, search results, job/audit formats, and
webhook behaviours are identical before and after this refactor. The `002 M1`
`search-engine.test.js` parity tests are the benchmark.

## Non-Goals

- No new features in this spec. `003`/`004`/`005` features are built as new
  packages once the structure is in place.
- No TypeScript migration (interfaces are documented JS shapes; TS is a future
  option).
- No deployment topology changes — still the same three Container Apps
  (api, worker, scheduler).
- No Qdrant, BullMQ, or Hono implementations in `006` — only the **stubs and
  interfaces** that make them slottable.

## Acceptance Criteria

1. `npm test --workspaces` passes. All 32 currently-passing tests still pass.
2. `packages/embedding` exports `TextEmbedder` and `VisionEmbedder` interfaces;
   swapping `EMBEDDING_PROVIDER` selects a different concrete provider with no
   other code change.
3. `packages/store` exports separate `VectorStore` and `DocumentStore`
   interfaces; `pgvector-store.js` implements only `VectorStore`.
4. `packages/api/src/app.js` is ≤ 200 lines; no vector math, store queries,
   or sync logic inside it.
5. `packages/ingestion` exports a `Queue` interface; `InlineQueue`,
   `ServiceBusQueue`, and a `BullMQQueue` stub all satisfy it; the worker
   consumes through the interface only.
6. Each package's unit tests run in isolation (`cd packages/X && npm test`)
   with no other package running.
7. `src/` re-exports preserve all existing import paths during the transition
   period; nothing outside `packages/` needs updating yet.

## Open Questions

- Workspace package names: `@atlas/embedding` vs `@atlas-unified-search/embedding`?
- Should `config.js` become its own package (`@atlas/config`) or stay at root
  and be imported by all packages?
- Worker and scheduler entrypoints: do they move into `packages/api` or stay
  as root-level entrypoints consuming the packages?
- During transition, do `src/` files re-export from packages, or do packages
  re-export from `src/` (reverse direction)?
