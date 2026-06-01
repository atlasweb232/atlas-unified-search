# Implementation Plan

## Architecture shift

```
Current (broken):
  any chunk → embed(text) → float32[384|1536] → unified_chunks.embedding vector(1536)
              └── NULL for default embedder (dim mismatch)

Target:
  text chunk  → TextEmbedder  → float32[TEXT_DIM]   → embedding_text  vector(TEXT_DIM)
  image chunk → VisionEmbedder → float32[VISION_DIM] → embedding_vision vector(VISION_DIM)
  (future)
  audio chunk → AudioEmbedder → float32[AUDIO_DIM]  → embedding_audio vector(AUDIO_DIM)

  searchChunks(query, spaces=['text'|'vision'|...]):
    ANN per space → normalise scores → merge → hybrid re-rank → top N
```

## 1. Dimension fix (extends 002 M2)

- Single `TEXT_EMBEDDING_DIM` env var (default 1536); single
  `VISION_EMBEDDING_DIM` (default 512).
- `createEmbedder` and `createVisionEmbedder` assert their output matches the
  configured dim; startup throws if not.
- The existing `embedding` column is renamed/migrated to `embedding_text` in
  `migrations/005_*.sql`. The `embedding_json` fallback column follows.

## 2. VectorSpace registry

```text
src/embedding.js  ← extend with VisionEmbedder interface + LocalClipProvider
src/vectorSpaces.js  ← new: VectorSpaceRegistry({ text, vision })
                         register(name, { embedder, dim, columnName })
                         embed(space, input) → float32[]
                         searchSpaces(spaces, query, queryImage?) → per-space vectors
```

## 3. Storage (Option A: separate columns — recommended for MVP)

`migrations/005_*.sql`:
- Rename `embedding` → `embedding_text`, `embedding_json` → `embedding_text_json`.
- Add `embedding_vision vector(VISION_EMBEDDING_DIM)`,
  `embedding_vision_json jsonb`.
- Separate `ivfflat`/`hnsw` indexes per column.
- `embedding_space text` column on `unified_chunks` records which spaces are
  populated for that chunk (`text`, `vision`, `both`).

Revisit Option B (side table) if a third space is added.

## 4. Chunk writer

- `SearchEngine.indexDocuments` routes each chunk to the right embedder based
  on `chunk.metadata.modality` (`text` | `image` | `audio`):
  - `text` → TextEmbedder → writes `embedding_text`.
  - `image` → VisionEmbedder → writes `embedding_vision`.
  - Missing modality defaults to `text`.
- `upsertChunk` in `PostgresSearchStore` writes the correct column(s).

## 5. searchChunks (extends 002 M3)

- Accepts `spaces: string[]` (default `['text']`).
- Issues one ANN sub-query per space, unions results, normalises distances
  (each space's min-max to 0–1), merges by `documentId` (best score wins),
  then re-ranks with the hybrid formula.
- Text-only queries skip the vision column entirely; image queries skip text
  if no text embedder output is available.

## 6. sourceRef on every chunk

- `createChunks` and the future image/audio chunkers populate `sourceRef` in
  chunk metadata at index time.
- `searchChunks` returns `sourceRef` alongside each candidate so the API
  includes it in the result line item.

## 7. Vision embedder implementations

- `LocalClipProvider`: loads CLIP model locally via a JS/Python bridge or
  a small sidecar; no account. Default.
- `ApiVisionEmbedder`: sends image bytes to a configured endpoint. Optional.

## Migration / backfill

- `migrations/005_*.sql` renames existing column (data preserved).
- A backfill script re-embeds existing text chunks into `embedding_text`.
- Existing NULL vectors (from the dim-mismatch bug) are flagged for reindex.

## Verification order (credential-free)

1. Dimension fail-fast (unit test, no DB).
2. VectorSpaceRegistry + LocalClipProvider + fixture images.
3. `migrations/005` column rename + new columns against local Postgres.
4. Text-space parity: same top-N as pre-005 on text fixtures.
5. Vision-space: fixture image query returns correct image chunk.
6. Cross-space fusion on a mixed corpus.
7. sourceRef populated and resolvable through 003/004 endpoints.
