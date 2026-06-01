# Research & Decisions

## 1. The current pipeline is maximally blocking (measured from code)

`worker.js` → `jobRunner.run` → `runConnectorSync`:
- `connector.sync()` fetches the entire source into an array, THEN
- `indexDocuments()` does `for chunk → await embedder.embed(chunk.text)` —
  strictly sequential, one HTTP round-trip per chunk, then
- `store.save()` once at the end.

`createReceiver(queueName)` uses Service Bus defaults: concurrency 1, `peekLock`
(5-min max). A large backfill is one multi-hour message on one worker that will
lose its lock and redeliver. This is the opposite of "unblocked." `008` exists
to fix exactly this.

## 2. Why Kafka over Service Bus for this (decision)

- **Partitions + consumer groups** → natural per-tenant parallelism; lag is a
  first-class, per-group metric (KEDA Kafka-lag scaler).
- **Replayable log** → reindex on embedding-model change = reset offset and
  re-consume, instead of re-fetching from Slack/Drive. This recurs across
  `002 M2` and `005`, so replay is a real, repeated need.
- **Throughput** → built for high-volume streaming.

Service Bus sessions can give per-tenant FIFO and queue-depth autoscale and is
simpler all-Azure, but it is not a replay log and partition-parallelism is
weaker. It remains a valid `006` adapter for light deployments. Managed Kafka
options: **Azure Event Hubs (Kafka surface)** keeps it all-Azure; Confluent Cloud
and self-hosted Redpanda are alternatives.

## 3. Decouple fetch from embed (the core idea)

Fetch is I/O-bound and source-rate-limited (Slack/Google quotas). Embed is
compute/API-bound and embedding-rate-limited (OpenAI RPM/TPM or GPU). Coupling
them in one job means each stalls the other and they can't scale separately.
Splitting them with the broker as the buffer lets each run at its own rate; the
broker absorbs the mismatch. This is standard producer/consumer decoupling and
is the single most important change.

## 4. Batching is the biggest throughput win

The embeddings API accepts arrays (OpenAI: up to 2048 inputs/request); local
models batch on GPU. Going from batch-of-1 to batch-of-N cuts API calls by ~N×
and is the dominant cost/latency factor for large corpora. `embedBatch()` is
added to the `TextEmbedder` interface.

## 5. At-least-once + idempotent upserts (not exactly-once)

Exactly-once across a broker + two datastores is expensive and usually
unnecessary. Decision: **at-least-once** delivery, with Qdrant upserts keyed by a
**stable point id** (derived from chunkId) so a re-delivered message overwrites
identically — effectively idempotent. Offsets commit only after a successful
upsert.

## 6. Replay requires self-contained embed-tasks

For replay-based reindex to avoid re-fetching sources, the `embed-task` must
carry the normalized text (and image refs) needed to re-embed. This trades log
size for not hammering source APIs on every model change. Log retention is
configurable (`EMBED_LOG_RETENTION`); for very large corpora, a periodic
compacted snapshot + shorter log is a future option.

## 7. Rate limiting via backpressure, not failure

When the embedding provider's rate limit is reached, the right behaviour is to
**stop pulling** (let lag grow, broker holds the backlog), not to fire requests
that get 429'd. A token-bucket keyed to provider RPM/TPM gates worker
concurrency. Lag growth then signals autoscale (`007`) — but scaling workers
won't help if the provider limit is the ceiling, so the cap is per-provider, not
per-worker. This is an important subtlety: you scale workers up to the provider
ceiling, then the broker simply buffers until throughput catches up.

## 8. Heavy media on its own stage

ASR (`004`) and vision embedding (`005`) are far more expensive per item than
text embedding and may need GPU. Putting them on a separate topic + worker pool
(own consumer group, own autoscale) means a backlog of recordings never blocks
cheap text-chunk embedding, and the GPU pool scales independently of the text
pool.

## 9. Credential-free CI

- **Redpanda** (Kafka API, single small container) or `bitnami/kafka` locally.
- Local Qdrant for upserts; local hash embedder with a real `embedBatch`.
- All FRs (decoupling, batching, fairness, replay, DLQ, rate cap) are verifiable
  with fixtures and local infra — no cloud broker, no embedding API key.
