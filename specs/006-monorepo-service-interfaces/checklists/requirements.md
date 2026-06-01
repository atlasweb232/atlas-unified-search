# Requirements Checklist

## Scaffold
- [ ] npm workspaces configured at root; `test:packages` + `test:all` scripts.
- [ ] `npm test` still passes after scaffold (no packages yet).

## @atlas/embedding (M2)
- [ ] `TextEmbedder` + `VisionEmbedder` interfaces defined.
- [ ] `HashTextEmbedder`, `OpenAITextEmbedder` implement `TextEmbedder`.
- [ ] `LocalClipProvider` stub implements `VisionEmbedder`.
- [ ] `dim` integrity: output length === configured dim enforced.
- [ ] `src/embedding.js` → thin re-export; root tests still pass.

## @atlas/store (M3)
- [ ] `VectorStore` interface defined (upsertChunks, deleteChunks, searchChunks).
- [ ] `DocumentStore` interface defined (all ops methods).
- [ ] `JsonVectorStore` + `JsonDocumentStore` extracted; no full-state blob.
- [ ] `PgVectorStore` stub + `QdrantStore` stub implement `VectorStore`.
- [ ] `PostgresDocumentStore` extracted (ops tables only).
- [ ] `src/store.js` + `src/stores/postgresStore.js` → thin re-exports.
- [ ] Root tests still pass.

## @atlas/search (M4)
- [ ] `SearchEngine` takes `{ documentStore, vectorStore, embedder, weights }`.
- [ ] `SearchRunCoordinator` takes `{ documentStore, searchEngine, registry }`.
- [ ] Re-exports in place; root tests still pass.

## @atlas/connectors (M5)
- [ ] `Connector` interface defined.
- [ ] All 6 connectors implement it.
- [ ] `src/connectors/` → re-exports; root tests still pass.

## @atlas/ingestion (M6)
- [ ] `Queue` + `Receiver` interfaces defined.
- [ ] `InlineQueue`, `ServiceBusQueue`, `BullMQQueue` stub implement `Queue`.
- [ ] Worker + scheduler entrypoints import from `@atlas/ingestion`.
- [ ] Root tests still pass.

## @atlas/identity (M7)
- [ ] `IdentityResolver` interface defined.
- [ ] `SharedTokenResolver` implements it (current behaviour).
- [ ] `JwtResolver` + `ApiKeyResolver` stubs implement it.
- [ ] `src/middleware/auth.js` → re-export; root tests still pass.

## @atlas/assistant (M8)
- [ ] `ChatProvider` + `ArtifactProvider` interfaces explicit.
- [ ] All existing providers implement `ChatProvider`.
- [ ] `OrganicArtifactProvider` + `LlmArtifactProvider` stubs.
- [ ] `src/assistant/` → re-exports; root tests still pass.

## @atlas/api (M9)
- [ ] `packages/api/src/app.js` ≤ 200 lines, zero business logic.
- [ ] Routes in `packages/api/src/routes/`.
- [ ] Webhook verification in `@atlas/ingestion` or `@atlas/connectors`.
- [ ] Root tests still pass.

## CI + docs (M10)
- [ ] CI runs `npm run test:all`.
- [ ] Each package has a `README.md` with interface + swap instructions.
- [ ] `src/` re-exports removed once all files are migrated.
- [ ] Root `README.md` updated with monorepo layout.

## Invariant throughout
- [ ] `npm test` passes after every single milestone.
- [ ] No API response shape changes.
- [ ] No behaviour changes.
