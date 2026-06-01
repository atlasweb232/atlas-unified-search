# Requirements Checklist

## Dimension integrity
- [ ] `TEXT_EMBEDDING_DIM` / `VISION_EMBEDDING_DIM` single config source of truth.
- [ ] Startup fails fast if embedder dim ≠ configured space dim (both spaces).
- [ ] No silent NULL vectors from any path.

## Vector space registry
- [ ] `VectorSpaceRegistry` with `text` + `vision` spaces.
- [ ] Wrong-dim registration → startup error.
- [ ] `embedQuery` returns only spaces with available input.

## Vision embedder
- [ ] `VisionEmbedder` interface defined.
- [ ] `LocalClipProvider` (no account, offline CI) produces float32[VISION_DIM].
- [ ] `ApiVisionEmbedder` optional, same contract.
- [ ] Unsupported mime type → clear error, not zero vector.

## Schema
- [ ] `migrations/005_*.sql`: rename `embedding` → `embedding_text`,
      add `embedding_vision vector(VISION_DIM)`, `embedding_space`.
- [ ] Separate ANN indexes per column.
- [ ] Backfill: NULL `embedding_text` rows flagged `needs_reindex=true`.

## Chunk routing
- [ ] `chunk.metadata.modality` set by all chunkers.
- [ ] Text chunks → `embedding_text`; image chunks → `embedding_vision`.
- [ ] No cross-modality column writes.

## searchChunks multi-space
- [ ] `spaces[]` param accepted; one ANN sub-query per space.
- [ ] Distances normalised [0,1] per space before merge.
- [ ] Text-only query skips vision column; image query skips text column.

## sourceRef
- [ ] Every chunk kind carries `sourceRef` at index time.
- [ ] `sourceRef` included in search result line items.
- [ ] Resolves to correct endpoint per type; identity-scoped.

## Compatibility & CI
- [ ] Text-space result parity with pre-005 (same top-N on text fixtures).
- [ ] `EXPLAIN` shows bounded ANN index scans, no seq scans.
- [ ] CI runs all milestones credential-free (local CLIP + hash text + fixtures).
- [ ] Quickstart updated; `production-readiness-checklist.md` updated.

## Out of scope (future)
- [ ] (Deferred) `audio` space (CLAP).
- [ ] (Deferred) Cross-modal text→vision bridge (CLIP joint text encoder).
- [ ] (Deferred) `unified_chunk_vectors` side table for N-space flexibility.
