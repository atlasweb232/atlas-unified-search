# Requirements Checklist

## Broker adapter
- [ ] `KafkaQueue`/`KafkaReceiver` satisfy 006 `Queue`/`Receiver`.
- [ ] Topics: discover, embed-task, media-task, *-dlq; partition key=tenantId.
- [ ] Other adapters (Service Bus sessions, BullMQ, inline) still satisfy interface.

## Decoupled stages
- [ ] Discover streams pages (not fetch-all); emits fine-grained embed-tasks.
- [ ] Embed and discover are separate consumer groups, scale independently.
- [ ] Media stage isolated (own group + pool) — never blocks text embed.

## Fine-grained & durable
- [ ] Message = doc/small-batch, not whole sync.
- [ ] Each embed-task upsert independently durable; crash loses ≤ one batch.
- [ ] Checkpoint advances per discover page; restart resumes from cursor.

## Batched embedding
- [ ] `embedBatch` on TextEmbedder (+ VisionEmbedder for 005).
- [ ] One embed call + one Qdrant upsert per batch (not per chunk).
- [ ] Worker concurrency capped to provider RPM/TPM (token bucket).
- [ ] Rate-capped → backlog grows in broker, no throttled requests.

## Fairness
- [ ] Per-tenant partition + concurrency cap.
- [ ] Two tenants interleave; no head-of-line block.

## Replay reindex
- [ ] embed-task carries re-embeddable content.
- [ ] Offset reset re-embeds with new model; no source re-fetch.
- [ ] Configurable embed-task log retention.

## Failure isolation
- [ ] Per-message retry w/ backoff → DLQ after N.
- [ ] Partition keeps flowing past poison; DLQ redrive works.

## Delivery
- [ ] At-least-once; Qdrant point ids make re-delivery idempotent.

## CI
- [ ] Full pipeline on local Redpanda + local Qdrant + hash embedder, no cloud/API.
- [ ] Decoupling, batching, fairness, replay, DLQ, rate-cap all exercised.
