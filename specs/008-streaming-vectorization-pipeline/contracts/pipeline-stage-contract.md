# Contract: Pipeline Stages & Topics

## Stages

```text
DISCOVER worker   consumes discover     → emits embed-task(s) + advances checkpoint
EMBED worker      consumes embed-task   → batched embed → Qdrant upsert
MEDIA worker      consumes media-task   → ASR/vision → emits embed-task / upsert
```

Each stage is a separate consumer group → independent scaling (007 lag),
independent failure domain.

## Topic rules (MUST)

- Partition key = `tenantId` (per-tenant ordering + fairness).
- At-least-once delivery; consumers commit offsets only after the durable
  side-effect (embed-task emitted / vectors upserted) succeeds.
- Qdrant upserts keyed by stable point id → re-delivery is idempotent.
- Poison messages → `<topic>-dlq` after N retries with backoff; the partition
  keeps flowing.

## Discover worker contract

```text
for await (page of connector.discover({ scope, cursor })):
   for doc in page.documents:
      produce embed-task(doc → normalized chunks)   [key=tenantId]
   advanceCheckpoint(page.nextCursor)
```

- MUST NOT embed. MUST NOT fetch everything into memory — streams pages.
- Checkpoint advances per page so restart resumes from the source cursor.

## Embed worker contract

```text
batch = pullUntil(EMBED_BATCH_SIZE | EMBED_MAX_WAIT_MS)
vectors = embedder.embedBatch(batch.texts)         # ONE call per batch
vectorStore.upsertChunks(tenantSilo, batch.points) # ONE upsert per batch
commitOffsets(batch)
```

- Concurrency ≤ `EMBED_MAX_CONCURRENCY` AND ≤ provider rate cap (token bucket).
- When rate-capped, stop pulling (lag grows; broker buffers) — never emit
  requests destined to be throttled.
- Writes ONLY to the message's tenant silo (007).

## Replay contract

```text
replay({ tenantId, source, fromOffset='earliest', embeddingModel })
  reset embed consumer-group offset → re-consume retained embed-tasks
  → re-embed with embeddingModel → upsert (idempotent overwrite)
```

- No source re-fetch. Requires embed-task log retention ≥ desired replay window.

## Verification (credential-free)

- Large fixture → many embed-tasks, batched embed (assert N>1 per call).
- Pause embed → discover drains, lag grows; resume → drains.
- Two tenants interleave.
- Offset reset re-embeds with no connector calls.
- Poison → DLQ; partition keeps flowing; redrive works.
