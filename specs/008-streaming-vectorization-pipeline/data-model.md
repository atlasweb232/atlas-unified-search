# Data Model (008 — Pipeline Messages)

No new persisted entities; this defines the **message shapes** on the broker.
Vectors land in the tenant's Qdrant silo (`007`); checkpoints reuse
`unified_checkpoints` (`001`).

## Topics (partition key = tenantId)

```
discover       control: "go fetch source X for tenant/scope from cursor"
embed-task     fine-grained: "embed these chunks and upsert"
media-task     heavy: "transcribe/vision-embed this recording/image"
*-dlq          dead-letter per topic
```

## DiscoverTask

```text
{
  taskId, tenantId, userId, source,
  scope:   { channelIds? | folderIds? | containers? | ... },
  cursor:  string | null,        # resume point (checkpoint)
  options: { forceFullSync?, limit?, ... }
}
```

## EmbedTask (fine-grained, re-embeddable)

```text
{
  taskId, tenantId, userId, source,
  documentId,
  chunks: [ {
    chunkId, text, modality: 'text'|'image',
    imageRef?,                   # for vision (005): pointer, not bytes
    sourceRef,                   # 005 reconstitution pointer
    metadata
  } ],
  embeddingModel, embeddingVersion,   # what to embed with (enables replay)
  emittedAt
}
```

- Carries **normalized content**, so a replay re-embeds without re-fetching the
  source. (Vision carries `imageRef`; the media/embed worker fetches bytes via
  `003`/`004` only when actually embedding, or the bytes are cached.)

## MediaTask

```text
{
  taskId, tenantId, userId, source: 'conference_bridge',
  recordingRef,                  # 004 reconstruction ref
  kind: 'asr' | 'vision_keyframes',
  options: { maxDuration?, ... }
}
```

- ASR result → emits `EmbedTask`s (transcript-segment chunks, modality 'text').
- Vision result → emits `EmbedTask`s (keyframe chunks, modality 'image') or
  upserts vision vectors directly.

## Vectors (destination — Qdrant tenant silo, 007/005)

```text
point {
  id:      stable(chunkId)        # idempotent upsert → at-least-once safe
  vectors: { text?: float32[TEXT_DIM], vision?: float32[VISION_DIM] }
  payload: { tenantId, userId, source, documentId, sourceRef, container, ... }
}
```

## Offsets & checkpoints

- **Consumer offsets** (broker): per consumer-group per partition — the basis for
  lag (autoscale) and replay (reset).
- **Source checkpoints** (`unified_checkpoints`): per source/scope cursor so
  discover resumes from the source side after restart.

## Idempotency / delivery

- At-least-once delivery; Qdrant upsert keyed by stable point id → re-delivery is
  a no-op overwrite. No exactly-once machinery required.
