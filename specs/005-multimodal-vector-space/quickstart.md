# Quickstart: Credential-Free Multimodal Vector Search

Prereqs: `002` foundation (pgvector + identity) from its quickstart.

## 1. Configure both spaces (no accounts needed)

```bash
# Text space — local hash at correct dimension
export EMBEDDING_PROVIDER=hash
export TEXT_EMBEDDING_DIM=1536         # must match embedding_text column

# Vision space — local CLIP, no account
export VISION_EMBEDDING_PROVIDER=local
export VISION_EMBEDDING_MODEL=clip-vit-base-patch32
export VISION_EMBEDDING_DIM=512        # must match embedding_vision column
```

Startup will fail fast if either dim mismatches the configured embedder output.

## 2. Run migration 005

```bash
npm run db:migrate   # applies 005_multimodal_vector_space.sql
# renames embedding → embedding_text; adds embedding_vision vector(512)
# flags existing NULL embedding_text rows as needs_reindex=true
```

## 3. Reindex existing text content (fixes the dim-mismatch backlog)

```bash
curl -s localhost:4420/v1/reindex/slack \
  -H "$AUTH" -d '{"tenantId":"t","userId":"u"}'
# repeat per source; now writes real vectors into embedding_text
```

## 4. Index fixture images (vision space)

```bash
# Fixture docs with image children (slide PNGs, page thumbnails) are indexed
# automatically; the chunker sets modality='image' and routes to CLIP:
npm run seed:fixtures
```

## 5. Search by text (text space)

```bash
curl -s localhost:4420/v1/search -H "$AUTH" \
  -d '{"tenantId":"t","userId":"u","query":"quarterly revenue"}'
# hits → text ANN on embedding_text, EXPLAIN shows index scan
```

## 6. Search by image (vision space)

```bash
# POST with an image body — searches embedding_vision via CLIP
curl -s localhost:4420/v1/search -H "$AUTH" \
  -F 'tenantId=t' -F 'userId=u' -F 'query=revenue chart' \
  -F 'queryImage=@tests/fixtures/sample-slide.png'
# hits include sourceRef so the UI can reconstruct the original page/frame
```

## 7. Verify sourceRef reconstitution

```bash
# Every result carries sourceRef; resolve an attachment:
curl -s "localhost:4420/v1/attachments/<sourceRef.attachmentId>/content" -H "$AUTH"
# Or a transcript segment:
curl -s "localhost:4420/v1/conference/<ref>/segment?start=14&end=47" -H "$AUTH"
```

## What still needs accounts

- OpenAI text embedding (`EMBEDDING_PROVIDER=openai`) — optional quality upgrade.
- API vision embedding (`VISION_EMBEDDING_PROVIDER=api`) — optional.
- Live connector readiness — unrelated, still gated.
