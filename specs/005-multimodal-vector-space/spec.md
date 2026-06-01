# Feature Spec: Multimodal Vector Space

## Summary

Replace the single broken text-only vector space with a correct, multi-space
architecture that separates text embeddings from vision embeddings, fixes the
dimension mismatch that currently stores NULL vectors for all default-mode
chunks, and provides a clear reconstitution path from any vector hit back to
the original bytes or media segment.

This is a prerequisite for meaningful attachment search, document-page search,
and the visual layer of conference video search.

## Current state (what is actually broken)

1. **Dimension mismatch — zero usable pgvector vectors today.**
   The default embedder (`hashEmbedding`) produces 384-dim vectors. The
   column is `vector(1536)`. The write guard
   `chunk.embedding.length === 1536` stores NULL for every default-mode chunk.
   With no OpenAI key, the pgvector index is empty and the `ivfflat` index is
   wasted. `002 M2` is the minimal fix; this spec makes the full solution
   correct.

2. **One flat vector space for everything.**
   Text chunks, transcript segments, PDF-extracted text, and (once `003`/`004`
   land) keyframes and audio are all funnelled into one `embed(text)` call and
   one `vector(N)` column. Mixing vision embeddings into a text ANN index
   produces meaningless distances. A CLIP image vector and an OpenAI text
   vector are not comparable.

3. **No vision embedder exists anywhere in the codebase.**
   There is no image embedding path, no document-page embedding, no frame
   embedding. Visual search (slide thumbnails, document page images, video
   keyframes) is completely absent.

4. **Reconstitution is untracked from the vector layer.**
   A chunk carries `documentId` and `metadata` but the vector space has no
   concept of how to get back the original bytes, time range, or page number
   that produced it. `003 M2` adds the attachment proxy and `004 M4` adds the
   clip endpoint; this spec formalises the **vector-hit → source-bytes** chain
   across all modalities so those endpoints are built on a consistent model.

## Dependencies

- `002 M2` dimension fix is a hard prerequisite (the dimension must be a single
  configured truth before this spec adds a second space).
- `003 M2` attachment reconstruction and `004 M4` clip endpoint are the
  reconstitution implementations this spec's model describes.

## Decisions

- **Two named vector spaces minimum:** `text` and `vision`. Audio transcript
  segments live in `text` (transcript text is embedded as text). A third
  `audio` space (CLAP-style raw audio embeddings) is a future extension.
- **Spaces are stored separately:** either separate columns
  (`embedding_text`, `embedding_vision`) on `unified_chunks`, or a separate
  `unified_chunk_vectors` table keyed by `(chunk_id, space)`. Decision in
  `research.md`.
- **Cross-space search fusion:** a query may search one space, multiple spaces,
  or all spaces; per-space ANN scores are normalised and merged before hybrid
  re-rank.
- **Vision embedder is pluggable** (same pattern as text): local CLIP model
  (no account, offline CI) by default, API-backed option behind the same
  interface.
- **Reconstitution model** is formalised here: every chunk carries a
  `sourceRef` (type + pointer) that resolves back to original bytes via the
  existing connector + `003`/`004` endpoints.

## Functional Requirements

### FR-1: Named vector spaces

- Define a `VectorSpace` registry with at least two named spaces:
  - `text` — for all text-derived embeddings (document body, transcript
    segments, extracted attachment text). Dimension = `TEXT_EMBEDDING_DIM`
    (default 1536 to match `text-embedding-3-small`; must satisfy `002 M2`).
  - `vision` — for image-derived embeddings (document page thumbnails, video
    keyframes, slide captures). Dimension = `VISION_EMBEDDING_DIM`
    (default 512 for CLIP ViT-B/32).
- Each space has its own embedder, its own storage column/table, and its own
  ANN index.
- A chunk MAY have embeddings in one or both spaces depending on its modality.
  A text chunk has a `text` embedding; a keyframe chunk has a `vision`
  embedding; a document-page chunk MAY have both (text from OCR + vision from
  the page image).

### FR-2: Dimension integrity (extends `002 M2`)

- `TEXT_EMBEDDING_DIM` and `VISION_EMBEDDING_DIM` are single configured values
  shared by their embedders, writers, and migration columns.
- Startup MUST fail fast if any configured embedder's dimension does not match
  its space's configured dimension.
- Writing a vector of the wrong dimension MUST be an error, never a silent
  NULL.

### FR-3: Pluggable vision embedder

- `VisionEmbedder` interface: `embed({ imagePath | imageBuffer, mimeType })
  → float32[VISION_EMBEDDING_DIM]`.
- **Local CLIP provider (default):** runs a local CLIP model (e.g.
  `clip-vit-base-patch32`). No account, offline CI.
- **API provider (optional):** OpenAI `text-embedding-3-*` with image input,
  or a compatible vision embedding API. Backend-only credentials.
- Selected by `VISION_EMBEDDING_PROVIDER=local|api`.

### FR-4: Per-space storage

- `migrations/005_*.sql` adds vision embedding storage. Decision (research):
  - Option A: additional columns on `unified_chunks`:
    `embedding_text vector(TEXT_EMBEDDING_DIM)`,
    `embedding_vision vector(VISION_EMBEDDING_DIM)`.
  - Option B: separate `unified_chunk_vectors (chunk_id, space, embedding
    vector(N))` — flexible dim per space, more complex queries.
- Separate ANN indexes per space (`ivfflat` or `hnsw`, per `002 M3` decision).
- `searchChunks` (from `002 M1/M3`) is extended to accept `spaces[]` and
  queries the appropriate column(s), normalising distances before merge.

### FR-5: Cross-space search fusion

- A query string is embedded in each requested space (text space uses the text
  embedder; vision space uses the vision embedder on a query image if provided,
  or is skipped for text-only queries).
- Per-space ANN scores are normalised (0–1) and merged via a configurable
  fusion weight per space before the existing hybrid re-rank.
- A text-only query searches only the `text` space by default.
- A query with an attached image searches the `vision` space (and optionally
  the `text` space using extracted image metadata/caption).

### FR-6: Formalised reconstitution model

Every chunk carries a `sourceRef` that the retrieval layer can resolve to
original bytes without guessing:

```text
sourceRef = {
  type:        'document_body' | 'attachment' | 'transcript_segment'
             | 'page_image' | 'keyframe'
  documentId
  # type-specific:
  attachmentId?    → resolves via 003 GET /v1/attachments/:ref/content
  segmentStart?    → resolves via 004 GET /v1/conference/:ref/segment?start=&end=
  pageNumber?      → resolves via 003 attachment proxy with page hint
  frameTime?       → resolves via 004 clip endpoint
}
```

- All new chunk kinds (vision chunks from `003`/`004`) MUST populate
  `sourceRef` at index time.
- The retrieval response includes `sourceRef` so the UI knows how to fetch
  the original without additional round-trips to figure out the type.

### FR-7: Backwards compatibility

- Existing text-only search behaviour is unchanged. `sources`, `filters`, and
  response shapes from `001` are preserved.
- Text chunks that were indexed before this migration are reindexed into
  `embedding_text`; their existing `embedding` column (where non-NULL) is
  migrated or re-embedded.

## No-Live-Credentials Verification

- Local CLIP model (no account) covers vision embedding for CI.
- Fixture images (small PNGs/JPEGs under `tests/fixtures/`) are indexed and
  searched via their vision embeddings.
- Text embedding uses the local hash embedder at the configured dimension.
- Reconstitution is tested with fixture bytes (no live Slack/Google/Azure).

## Acceptance Criteria

1. Startup fails fast if `TEXT_EMBEDDING_DIM` ≠ text embedder dimension OR
   `VISION_EMBEDDING_DIM` ≠ vision embedder dimension.
2. Indexing a fixture image chunk stores a non-NULL vector in the vision
   embedding column and a NULL in the text column (and vice versa for a text
   chunk). No silent NULLs.
3. A text query returns ranked text-space results; an image query returns
   ranked vision-space results; a combined query fuses both.
4. `EXPLAIN` on each space shows a bounded ANN index scan, not a sequential
   scan.
5. Every chunk in a search result carries a populated `sourceRef`; the UI
   can resolve it to the original bytes via the `003`/`004` endpoints without
   additional discovery.
6. Existing text-only search results are unchanged after migration (result
   parity test from `002 M1`).
7. Full suite runs credential-free (local CLIP + local hash embedder + fixture
   images + local Postgres).

## Open Questions

- Storage shape: separate columns vs. `unified_chunk_vectors` side table?
  (columns simpler for queries; side table handles arbitrary future spaces.)
- Vision dimension: 512 (CLIP ViT-B/32) vs. 768 (larger CLIP) vs. 1024?
  Must be fixed at migration time or use a side table.
- Cross-modal query: for a text query, should the vision space be searched
  using a text→vision bridge embedding (e.g. CLIP's joint text+image space),
  or only searched when an image is explicitly provided?
- `audio` space (CLAP-style raw audio embedding): spec in `005` or defer
  to a `006`?
- Backfill: reindex existing text chunks into `embedding_text` column in a
  background job, or require a full manual reindex?
