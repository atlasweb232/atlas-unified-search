# Implementation Plan

## Pipeline shape

```
sync request
   │  emit discover-task (per source/scope)          topic: discover  [key=tenantId]
   ▼
DISCOVER workers (I/O-bound, source-rate-limited)
   page source incrementally (cursor) → normalize + chunk (text)
   → emit embed-task per doc / small batch           topic: embed-task [key=tenantId]
   → advance checkpoint
   ▼                                                 broker buffers backlog
EMBED workers (compute/API-bound)                    scale on embed-task lag (007)
   accumulate up to EMBED_BATCH_SIZE
   → batched embed (text array / vision GPU batch)
   → batch upsert to Qdrant (tenant silo, named vectors)
   ▼
MEDIA workers (004 ASR / 005 vision)                 topic: media-task [key=tenantId]
   own pool (optionally GPU); emit embed-task for resulting text/vision
```

## 1. Topics & adapter (extends @atlas/ingestion)

- `KafkaQueue` + `KafkaReceiver` implementing the `006` `Queue`/`Receiver`
  interfaces (kafkajs or node-rdkafka). Topics: `discover`, `embed-task`,
  `media-task`, plus `*-dlq` dead-letters.
- Producer sets partition key = `tenantId`. Consumers are consumer-groups per
  stage (independent scaling).
- Broker-specific `replay(offsetSpec)` lives in the Kafka adapter; the interface
  gains an optional `seek/replay` capability flag.

## 2. Discover stage (refactor connector.sync)

- Today `connector.sync()` returns ALL documents. Split into:
  - `connector.discover({ scope, cursor })` → yields pages of normalized
    documents + next cursor (generator/async-iterator).
- A discover worker consumes a `discover-task`, iterates pages, emits one
  `embed-task` per document (or small batch), advances the checkpoint after each
  emitted page. Connectors keep their existing fetch logic; only the "return
  everything at once" shape changes to streaming.

## 3. Embed stage (replace indexDocuments loop)

- Current: `for chunk → await embed(chunk.text)` (sequential, batch-of-1).
- New `EmbedWorker`:
  - pull embed-tasks until `EMBED_BATCH_SIZE` chunks or `EMBED_MAX_WAIT_MS`,
  - one batched `TextEmbedder.embedBatch(texts[])` (add batch method to the
    interface; hash + OpenAI both support it — OpenAI array input),
  - `VectorStore.upsertChunks(batch)` to the tenant's Qdrant collection,
  - commit offsets after successful upsert (at-least-once; Qdrant point ids make
    re-delivery idempotent).
- Concurrency capped by `EMBED_MAX_CONCURRENCY` + provider RPM/TPM token bucket.

## 4. Media stage (004 / 005 hooks)

- `media-task` carries a recording/image ref. Media workers run ASR (`004`) or
  vision embedding (`005`), then emit `embed-task`s (transcript text) or directly
  upsert vision vectors. Separate consumer group + pool so GPU/long jobs never
  block text embedding.

## 5. Backpressure & autoscale (ties to 007)

- KEDA Kafka-lag scaler per consumer group → `minReplicas: 0`. Lag is the single
  source of truth for "how much vectorization is pending."
- Token-bucket rate limiter in embed workers keyed to provider limits; when the
  bucket is empty workers idle and lag grows (broker holds work) rather than
  hammering the provider.

## 6. Replay-based reindex (002 M2 / 005)

- `embed-task` payload includes normalized chunk text (and image refs) — enough
  to re-embed without the source.
- A `reindex` control op resets the embed consumer-group offset for a
  tenant/source to the earliest retained offset → re-embeds with the new model.
- Requires configurable log retention (`EMBED_LOG_RETENTION`).

## 7. Failure isolation

- Per-message retry with backoff; after N, produce to `embed-task-dlq` with the
  error + original payload. Partition keeps flowing.
- A `dlq-redrive` op replays DLQ messages after a fix.

## Local / CI substrate

- `docker run redpanda` (Kafka API, lightweight) or `bitnami/kafka`.
- Local Qdrant for upserts; local hash embedder with a real `embedBatch`.
- `npm run sim:source` feeds fixtures into discover.

## Verification order (credential-free)

1. Kafka adapter satisfies `Queue`/`Receiver`; partition-by-tenant.
2. Discover streams pages → fine-grained embed-tasks; checkpoint advances.
3. Embed worker batches + upserts to Qdrant; batch-of-N not batch-of-1.
4. Decoupling: pause embed → discover still drains → resume drains backlog.
5. Fairness: two tenants interleave.
6. Replay: offset reset re-embeds with no source re-fetch.
7. DLQ: poison task isolated; partition keeps flowing.
8. Rate cap: concurrency bounded; backlog grows instead of throttling.
