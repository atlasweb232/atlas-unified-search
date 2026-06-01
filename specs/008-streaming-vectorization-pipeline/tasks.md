# Tasks

Depends on `006` (Queue interface, Qdrant VectorStore, embedders), `007` (lag
autoscale, silos), `004`/`005` (media stage). Verifiable credential-free on
local Kafka/Redpanda + local Qdrant + local hash embedder.

## Speckit
- [ ] Define streaming vectorization pipeline (this spec).
- [ ] Define pipeline stage/topic contract.
- [ ] Define batched embedder contract.

## M1: Kafka adapter (extends @atlas/ingestion)
- [ ] `KafkaQueue` + `KafkaReceiver` implement 006 `Queue`/`Receiver`.
- [ ] Topics: discover, embed-task, media-task, *-dlq.
- [ ] Partition key = tenantId; consumer-group per stage.
- [ ] Optional `replay(offsetSpec)` capability on the adapter.
- [ ] Tests: produce/consume; partition-by-tenant; interface compliance.

## M2: Discover stage (stream, not fetch-all)
- [ ] `connector.discover({ scope, cursor })` async-iterator on each connector.
- [ ] Discover worker: page source → emit fine-grained embed-tasks → advance
      checkpoint per page.
- [ ] Tests: large fixture source → many embed-tasks; checkpoint resumes.

## M3: Embed stage (batched)
- [ ] Add `embedBatch(texts[])` to `TextEmbedder` (hash + OpenAI array input).
- [ ] `EmbedWorker`: accumulate to EMBED_BATCH_SIZE / EMBED_MAX_WAIT_MS → one
      batched embed → `VectorStore.upsertChunks(batch)` to tenant silo.
- [ ] Commit offsets after upsert (at-least-once; idempotent point ids).
- [ ] Tests: batch-of-N not batch-of-1; vectors land in Qdrant.

## M4: Decoupled scaling + backpressure
- [ ] Separate consumer groups scale independently (007 lag).
- [ ] Token-bucket rate limiter keyed to provider RPM/TPM.
- [ ] Tests: pause embed → discover drains → broker buffers → resume drains;
      rate cap bounds concurrency, backlog grows instead of throttling.

## M5: Tenant fairness
- [ ] Per-tenant partition + per-tenant concurrency cap.
- [ ] Tests: two tenants interleave; no head-of-line block.

## M6: Media stage (004/005)
- [ ] `media-task` topic + worker pool (own consumer group, optional GPU).
- [ ] ASR (004) → emit embed-tasks (transcript text).
- [ ] Vision (005) → upsert vision vectors.
- [ ] Tests: media work isolated from text embed throughput.

## M7: Replay-based reindex
- [ ] embed-task payload carries normalized content (re-embeddable w/o source).
- [ ] `reindex` op resets consumer offset for tenant/source → re-embed.
- [ ] Configurable `EMBED_LOG_RETENTION`.
- [ ] Tests: model change → replay re-embeds, no source re-fetch.

## M8: Failure isolation / DLQ
- [ ] Per-message retry w/ backoff → embed-task-dlq after N.
- [ ] Partition keeps flowing past poison.
- [ ] `dlq-redrive` op.
- [ ] Tests: poison task isolated; redrive works after fix.

## M9: CI + docs
- [ ] CI: local Redpanda + local Qdrant + hash embedder; full pipeline, no cloud.
- [ ] Other adapters (Service Bus sessions, BullMQ, inline) still satisfy the
      interface for light/dev.
- [ ] `docs/` pipeline + replay runbook.

## Out of scope
- Exactly-once semantics (at-least-once + idempotent upserts is the model).
- Stream processing framework (Flink/Kafka Streams) — plain consumers suffice.
- Cross-region topic replication.
