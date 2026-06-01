# Tasks

Structural refactor only. No behaviour changes. `npm test` passes after every
milestone. All milestones are credential-free.

## Speckit
- [x] Define monorepo service interfaces (this spec).
- [ ] Define package interface contracts (embedding, store, queue, chat,
      artifact, identity, media, extraction).
- [ ] Record workspace name convention and config package decision in research.

## M1: Workspace scaffold
- [ ] Add `workspaces: ["packages/*"]` to root `package.json`.
- [ ] Add `test:packages` and `test:all` scripts to root.
- [ ] Verify `npm test` still passes (no packages yet, just scaffold).

## M2: `@atlas/embedding` package (priority 1 — blocks 005)
- [ ] `packages/embedding/package.json` with `@atlas/embedding`.
- [ ] `interfaces.js` — `TextEmbedder` + `VisionEmbedder` shape + dim contract.
- [ ] Extract `hashEmbedding`, `normalize`, `cosineSimilarity` from
      `src/embedding.js` → `packages/embedding/src/text/hash.js`.
- [ ] Extract `openaiEmbedding` → `packages/embedding/src/text/openai.js`.
- [ ] `LocalClipProvider` stub (real impl in 005).
- [ ] `createTextEmbedder(config)` factory.
- [ ] `src/embedding.js` → thin re-export of `@atlas/embedding`.
- [ ] Package unit tests pass; root `npm test` still passes.

## M3: `@atlas/store` package (priority 2 — unblocks 002 M3 + 005)
- [ ] `packages/store/package.json`.
- [ ] `interfaces.js` — `DocumentStore` + `VectorStore` explicit contracts.
- [ ] Extract ops-only `JsonDocumentStore` from `src/store.js`.
- [ ] Extract in-memory `JsonVectorStore` (uses `searchChunks` from 002 M1).
- [ ] `pgvector-store.js` stub (ANN impl lands in 002 M3).
- [ ] `qdrant-store.js` stub.
- [ ] Extract `PostgresDocumentStore` (ops tables only) from
      `src/stores/postgresStore.js`.
- [ ] `src/store.js` + `src/stores/postgresStore.js` → thin re-exports.
- [ ] `createDocumentStore(config)` + `createVectorStore(config)` factories.
- [ ] Package unit tests; root `npm test` still passes.

## M4: `@atlas/search` package
- [ ] `packages/search/package.json`.
- [ ] `SearchEngine` constructor takes `{ documentStore, vectorStore, embedder,
      weights }` (split from combined `store` dep).
- [ ] `SearchRunCoordinator` takes `{ documentStore, searchEngine, registry }`.
- [ ] `src/store.js` `SearchEngine` → re-export; `src/searchRun.js` → re-export.
- [ ] Package unit tests; root `npm test` passes.

## M5: `@atlas/connectors` package
- [ ] Move `src/connectors/` → `packages/connectors/src/`.
- [ ] `interfaces.js` — `Connector` contract (sync, search?, checkReadiness,
      isConfigured, requirements).
- [ ] `src/connectors/` → thin re-exports.
- [ ] Package unit tests; root `npm test` passes.

## M6: `@atlas/ingestion` package
- [ ] `packages/ingestion/package.json`.
- [ ] `interfaces.js` — `Queue` + `Receiver` contracts.
- [ ] `InlineQueue`, `ServiceBusQueue` (from `src/queue/`).
- [ ] `BullMQQueue` stub (local Redis dev path).
- [ ] `JobRunner`, `SchedulerRunner`, `TokenProvider` extracted.
- [ ] `src/queue/`, `src/jobRunner.js`, `src/scheduler.js`,
      `src/tokenProvider.js` → thin re-exports.
- [ ] `src/worker.js` + `src/scheduler.js` entrypoints → import from
      `@atlas/ingestion`.
- [ ] Package unit tests; root `npm test` passes.

## M7: `@atlas/identity` package
- [ ] `packages/identity/package.json`.
- [ ] `interfaces.js` — `IdentityResolver` contract.
- [ ] `SharedTokenResolver` (current behaviour).
- [ ] `JwtResolver` + `ApiKeyResolver` stubs (full impl in 002 M5).
- [ ] `src/middleware/auth.js` → thin re-export.
- [ ] Package unit tests; root `npm test` passes.

## M8: `@atlas/assistant` package
- [ ] Move `src/assistant/` → `packages/assistant/src/`.
- [ ] `interfaces.js` — `ChatProvider` + `ArtifactProvider` explicit contracts.
- [ ] `OrganicArtifactProvider` stub (real impl in 003 M5).
- [ ] `LlmArtifactProvider` stub.
- [ ] `src/assistant/` → thin re-exports.
- [ ] Package unit tests; root `npm test` passes.

## M9: `@atlas/api` package (last — thin HTTP surface)
- [ ] `packages/api/package.json`.
- [ ] `packages/api/src/app.js` ≤ 200 lines, pure route wiring.
- [ ] Routes extracted to `packages/api/src/routes/`.
- [ ] Webhook verification logic moved into `@atlas/ingestion` or
      `@atlas/connectors`.
- [ ] Production readiness logic moved to a `readiness.js` in appropriate
      package.
- [ ] `src/app.js` → re-export or replaced by `packages/api`.
- [ ] Root `npm test` passes; `test:all` passes.

## M10: CI + docs
- [ ] CI runs `npm run test:all` (workspaces + root).
- [ ] `docs/production-readiness-checklist.md` updated.
- [ ] `README.md` updated with monorepo structure.
- [ ] Each package has a `README.md` with its interface and swap instructions.

## Out of scope
- TypeScript migration.
- Qdrant / BullMQ / Hono production implementations (stubs only here).
- New features — those land as new packages after this structure is in place.
