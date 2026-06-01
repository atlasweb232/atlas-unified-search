# Tasks

Depends on `002 M2` (dimension fix), `002 M3` (pgvector queries), `003 M2`
(attachment proxy), `004 M4` (clip endpoint). Verifiable credential-free:
local CLIP + local hash embedder + fixture images + local Postgres.

## Speckit
- [ ] Define multimodal vector space feature (this spec).
- [ ] Define vector space registry contract.
- [ ] Define vision embedder contract.
- [ ] Define cross-space fusion + sourceRef contracts.
- [ ] Record storage shape decision (columns vs. side table) in research.

## M1: Dimension integrity + space registry
- [ ] Single `TEXT_EMBEDDING_DIM` / `VISION_EMBEDDING_DIM` config values.
- [ ] Fail fast at startup if any embedder dimension ≠ configured space dim.
- [ ] `src/vectorSpaces.js` — `VectorSpaceRegistry` with `text` + `vision`
      spaces; routes embed calls to correct embedder.
- [ ] Tests: dim mismatch → startup error; correct dims → no error.

## M2: Vision embedder
- [ ] `VisionEmbedder` interface: `embed({ imagePath|buffer, mimeType })
      → float32[VISION_DIM]`.
- [ ] `LocalClipProvider` (default, no account).
- [ ] `ApiVisionEmbedder` (optional, same interface).
- [ ] `VISION_EMBEDDING_PROVIDER=local|api` selection.
- [ ] Tests: fixture image → non-zero float32[VISION_DIM] vector; dim matches.

## M3: Schema — separate embedding columns
- [ ] `migrations/005_*.sql`: rename `embedding` → `embedding_text`,
      `embedding_json` → `embedding_text_json`; add `embedding_vision
      vector(VISION_DIM)`, `embedding_vision_json jsonb`, `embedding_space text`.
- [ ] Separate ANN indexes per column.
- [ ] `upsertChunk` writes to the correct column(s) based on modality.
- [ ] Backfill existing text chunks into `embedding_text`.
- [ ] Flag NULL `embedding_text` rows (dim-mismatch bug) for reindex.

## M4: Chunk routing by modality
- [ ] `chunk.metadata.modality` set by chunkers: `text` | `image` | `audio`.
- [ ] `SearchEngine.indexDocuments` routes to TextEmbedder or VisionEmbedder.
- [ ] Image chunks (from `003`) write `embedding_vision`; text chunks write
      `embedding_text`; document-page chunks may write both.
- [ ] Tests: image fixture → vision column non-NULL, text column NULL.

## M5: searchChunks — multi-space ANN + fusion
- [ ] `searchChunks` accepts `spaces: string[]`.
- [ ] One ANN sub-query per space; normalise distances; merge by documentId.
- [ ] Configurable per-space fusion weight.
- [ ] Text-only query skips vision column; image query may skip text.
- [ ] Tests: text query → correct text-space results; image query → correct
      vision-space results; mixed → fused ranking.

## M6: sourceRef on every chunk
- [ ] `sourceRef` populated at index time for all chunk kinds:
      `document_body`, `attachment`, `transcript_segment`, `page_image`,
      `keyframe`.
- [ ] `searchChunks` returns `sourceRef` in each candidate.
- [ ] API result line items include `sourceRef`.
- [ ] Tests: every result in a search has a non-null `sourceRef`; resolves
      via `003`/`004` endpoints.

## M7: Result parity + CI
- [ ] Text-space result parity: same top-N as pre-005 on text fixtures.
- [ ] `EXPLAIN` shows bounded ANN index scans per space, no seq scan.
- [ ] CI runs M1–M6 with local CLIP + hash text embedder + fixture images +
      local Postgres. No external account.
- [ ] Quickstart updated with dual-space local setup.
- [ ] `docs/production-readiness-checklist.md` updated.

## Out of scope (future)
- [ ] (Deferred) `audio` space — CLAP-style raw audio embeddings.
- [ ] (Deferred) Cross-modal bridge: CLIP joint text+image space for
      text→vision queries without an explicit image.
- [ ] (Deferred) Arbitrary N-space side table if a third space is needed.
