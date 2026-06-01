# Research & Decisions

## 1. Why zero pgvector vectors exist today

The default embedder produces 384-dim vectors. `upsertChunk` only writes the
vector column when `chunk.embedding.length === 1536`. So every default-mode run
stores NULL in `embedding`. The `embedding_json` fallback keeps in-memory search
working, but the ivfflat index is empty and ANN queries would return nothing.
This is the single highest-priority fix — `002 M2` patches it; `005` makes the
fix permanent and generalises it to all spaces.

## 2. Storage: separate columns vs. side table

**Option A — separate columns (recommended for MVP):**
- `embedding_text vector(TEXT_DIM)`, `embedding_vision vector(VISION_DIM)` on
  `unified_chunks`.
- Pros: simple ANN queries (`ORDER BY embedding_text <=> $vec LIMIT k`); no
  joins; Postgres handles each column's index independently.
- Cons: adding a third space requires another migration; column must be fixed
  at schema time.

**Option B — `unified_chunk_vectors (chunk_id, space, embedding vector(N))`:**
- Flexible: any number of spaces, any dimension.
- Cons: requires a join for every retrieval; partitioning by space for index
  efficiency is complex; pgvector partial indexes on `space` column are less
  mature.

**Decision: Option A for `005`.** Two spaces (text + vision) is stable; if a
third space (audio) is added later, revisit. Columns are simpler and queries
are faster.

## 3. Vision embedding model choice

| Model | Dim | Notes |
|---|---|---|
| CLIP ViT-B/32 | 512 | Smallest, fast, widely available locally |
| CLIP ViT-L/14 | 768 | Better quality, heavier |
| ColPali | 128 | Document-optimised, per-patch; requires custom pooling |
| OpenAI vision | 1536 | Same space as text embeddings (joint); API only |

**Decision: CLIP ViT-B/32 (dim 512) as default** — runnable locally, no account,
reasonable quality for slide/image/keyframe similarity. `VISION_EMBEDDING_DIM=512`.
ColPali is a future option for document-page search.

## 4. Cross-modal text→vision queries

CLIP has a joint text+image embedding space — the same model that embeds images
also embeds text queries into the same space, so a text query like "revenue chart"
can be compared to image vectors directly. This is the right long-term model.

**Decision: defer the text→vision bridge for now.** For `005` MVP: a text query
searches the `text` space only; an image query searches the `vision` space only.
Cross-modal bridge (CLIP text encoder on text queries searched against vision
vectors) is spec'd as a future extension. This avoids requiring the full CLIP
text encoder in the worker for text-only queries.

## 5. sourceRef model

Each chunk kind maps to a retrieval endpoint:

| `sourceRef.type` | Resolves via |
|---|---|
| `document_body` | inline in search result |
| `attachment` | `003` `GET /v1/attachments/:ref/content` |
| `transcript_segment` | `004` `GET /v1/conference/:ref/segment?start=&end=` |
| `page_image` | `003` attachment proxy with `?page=N` hint |
| `keyframe` | `004` clip endpoint at `frameTime` |

Storing this at index time (not computed at query time) avoids the need for the
retrieval layer to know how chunk kinds map to endpoints.

## 6. Backfill strategy

Existing rows have `embedding` (now renamed `embedding_text`) that is NULL due
to the dim bug. Options:
- **Manual reindex** via existing `/v1/reindex/:source` — simplest, operator
  triggers it.
- **Background backfill job** — automated but adds complexity.

**Decision: flag NULL rows in `005` migration (add `needs_reindex boolean
DEFAULT false` column set to `true` where `embedding_text IS NULL`); operator
runs reindex. Document in quickstart.**

## 7. Audio space deferral

A CLAP-style audio embedding space (raw waveform → float32[512]) would let you
search audio without a text transcript — useful for music, non-speech sounds.
It is deferred because:
- `004` already covers speech via ASR transcripts (text space);
- CLAP models are less mature and harder to run locally than CLIP;
- the dim and storage shape can reuse Option A once confirmed.

Spec it in `006` if needed.

## 8. Credential-free CI

- Local CLIP via a small JS/Python bridge or ONNX runtime: no account.
- Fixture images (small PNGs committed under `tests/fixtures/`) exercised in CI.
- Text embedder stays as the local hash at `TEXT_EMBEDDING_DIM`.
- No OpenAI / vision API key required for any acceptance criterion.
