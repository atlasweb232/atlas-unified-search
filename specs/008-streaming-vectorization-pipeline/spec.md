# Feature Spec: Streaming Vectorization Pipeline

## Summary

Replace the current all-in-one sync job — where one queue message triggers a
full source fetch *and* sequential, one-at-a-time embedding on a single worker —
with a **decoupled, partitioned, batched streaming pipeline** on a
Kafka-compatible broker. Fetch and embed become separate stages that scale
independently; heavy media (ASR/vision) gets its own stage; work is partitioned
by tenant for fairness; embedding is batched; and the broker's consumer lag is
the backpressure and autoscale signal. This keeps heavy-duty vectorization from
many sources flowing without blocking.

## Decisions (locked)

- **Substrate = Kafka-compatible** (Azure Event Hubs Kafka surface / Confluent /
  Redpanda). Partitioned, replayable, consumer-lag autoscale. The `006` `Queue`
  interface is preserved so Service Bus / BullMQ / inline remain valid adapters
  for light or dev deployments.
- **Decoupled stages:** fetch/discover (I/O-bound) and embed (compute/API-bound)
  are separate consumers on separate topics. Heavy media (ASR `004`, vision
  `005`) is a third stage on its own topic + worker pool.
- **Partition key = tenantId** for per-tenant ordering and fairness (aligns with
  `007` silo). No tenant head-of-line-blocks another.
- **Batched embedding:** embed workers pull N tasks and call the batched
  embedding API / GPU batch, not one chunk at a time.
- **Replay = reindex:** changing embedding model/dimension reprocesses by
  replaying topic offsets, not by re-fetching from sources.

## Dependencies

- `006` — `Queue`/`Receiver` interfaces and `@atlas/ingestion`; `VectorStore`
  (Qdrant) for batch upserts; `TextEmbedder`/`VisionEmbedder`.
- `007` — consumer lag is its autoscale signal; partitioning aligns with silos.
- `004`/`005` — heavy-media stage consumers (ASR, vision embedding).

## Problem Statement (the current jam)

1. **One message = one whole source sync.** `runConnectorSync` fetches every
   document then embeds; a backfill is one multi-hour unit on one worker.
2. **Default Service Bus receiver, concurrency 1**, `peekLock` — long jobs
   exceed the lock and redeliver → duplicate/poison.
3. **Sequential embedding** — `for chunk → await embed(chunk.text)`, one API
   round-trip per chunk; the embeddings API accepts arrays up to 2048 but is
   used with batches of one.
4. **Fetch and embed coupled** — source rate limits and embedding rate limits
   share one job with opposite scaling profiles; each stalls the other.
5. **No tenant fairness** — one tenant's backfill blocks all others.
6. **Whole-job retry** — a failure re-fetches and re-embeds everything;
   nothing is durable until the entire job completes.

## Functional Requirements

### FR-1: Staged topics

- **`discover`** (control): a sync request emits a discover task per
  source/scope. Discover workers page the source incrementally (cursor/
  checkpoint) and emit fine-grained **`embed-task`** messages — one per document
  or small document batch — carrying normalized text chunks (no embeddings yet).
- **`embed-task`**: embed workers consume, batch, embed, and upsert vectors.
- **`media-task`**: heavy media (ASR `004`, vision `005`) on its own topic + a
  separate (optionally GPU) worker pool, so expensive media never blocks cheap
  text embedding.
- All topics partitioned by `tenantId`.

### FR-2: Fine-grained, durable units

- A message is a document or small batch, not a whole sync — short processing
  time, short lock, cheap retry.
- Each embed-task completion is independently durable (vectors upserted to
  Qdrant per `007` silo); a crash loses at most one in-flight batch, not the
  backfill.
- Discover checkpoints advance as tasks are emitted, so a restart resumes from
  the cursor, not from zero.

### FR-3: Decoupled, independent scaling

- Discover (fetch) workers scale on `discover` lag; embed workers scale on
  `embed-task` lag; media workers on `media-task` lag — each independently, each
  to zero when idle (`007` autoscale).
- The broker is the buffer: fetch may run ahead and park millions of embed-tasks;
  embed drains at its own rate. A throttled embedder does not stall fetching; a
  slow source does not starve embedding of other tenants.

### FR-4: Batched embedding + rate respect

- Embed workers accumulate up to `EMBED_BATCH_SIZE` chunks (or a max-wait) and
  issue one batched embedding call (text: array input; vision: GPU batch).
- Worker concurrency is capped to the embedding provider's RPM/TPM; excess work
  stays in the broker (backpressure), never becomes failed/throttled requests.
- Batched vectors are upserted to Qdrant in one call per batch.

### FR-5: Tenant fairness

- Partitioning by `tenantId` plus per-tenant consumer concurrency caps ensure a
  single tenant's large backfill cannot monopolize embed throughput or
  head-of-line-block other tenants.
- Optional per-tenant priority/quota integration with `007` quotas.

### FR-6: Replay-based reindex

- Changing embedding model/dimension (`002 M2`, `005`) triggers a **replay**:
  reset the consumer offset for the affected tenant/source and re-embed from the
  log — no re-fetch from Slack/Drive/etc.
- Requires embed-tasks to carry enough normalized content to re-embed without
  the source. Retention of the embed-task log is configurable.

### FR-7: Failure isolation & dead-letter

- A poison embed-task dead-letters after N retries without blocking its
  partition or requiring human triage.
- Retries are per-message with backoff, not whole-job.
- Dead-letter contents are inspectable and re-drivable.

### FR-8: Interface preservation

- All of the above is implemented behind the `006` `Queue`/`Receiver`
  interfaces. Kafka is the primary adapter; Service Bus (sessions),
  BullMQ (Redis), and inline remain valid adapters selected by config. The
  pipeline logic (stages, batching, partitioning) is broker-agnostic where
  possible; broker-specific bits (offset reset for replay) live in the adapter.

## Security & Tenancy

- Messages carry `tenantId`/`userId`; embed workers write only to that tenant's
  silo (`007`). A message can never cause a write to another tenant's collection.
- Message payloads with content are subject to redaction/retention; the
  embed-task log retention is bounded and configurable.

## No-Live-Credentials Verification

- **Local Kafka/Redpanda** (Docker) as the broker; local Qdrant for upserts;
  local hash text embedder (batched) — no cloud, no embedding API.
- Fixture sources feed discover; assert fine-grained embed-tasks are emitted,
  batched, embedded, and upserted; assert decoupling (fetch ahead of embed),
  fairness (two tenants interleave), replay (offset reset re-embeds), and
  dead-letter (poison task isolated).

## Acceptance Criteria

1. A sync of a large fixture source emits **many fine-grained embed-tasks**, not
   one monolithic job; embedding is **batched** (one API call per N chunks, not
   per chunk).
2. Fetch and embed scale independently: with embedding paused, discover still
   drains and the broker buffers embed-tasks; resuming embed drains the backlog.
3. Two tenants syncing simultaneously interleave fairly; neither head-of-line-
   blocks the other (tenant-partitioned).
4. A crash mid-backfill loses at most one in-flight batch; restart resumes from
   the checkpoint, and already-embedded vectors remain in Qdrant.
5. Changing the embedding model triggers a **replay** that re-embeds from the
   log with **no source re-fetch**.
6. A poison embed-task dead-letters after N retries without blocking its
   partition.
7. Worker concurrency respects a configured embedding rate cap; excess waits in
   the broker rather than failing.
8. The whole pipeline runs in CI on local Kafka/Redpanda + local Qdrant + local
   hash embedder — no cloud or API credentials.

## Open Questions

- Managed Kafka choice: Azure Event Hubs (Kafka surface, fits all-Azure) vs
  Confluent Cloud vs self-hosted Redpanda — cost/ops trade-off.
- embed-task log retention for replay: days? size-bounded? per-tenant?
- Batch size / max-wait tuning per embedding provider (OpenAI vs local vs vision).
- Does discover emit per-document or per-small-batch by default (latency vs
  overhead)?
- Exactly-once vs at-least-once: Qdrant upserts are idempotent by point id, so
  at-least-once is acceptable — confirm point-id strategy makes re-delivery safe.
