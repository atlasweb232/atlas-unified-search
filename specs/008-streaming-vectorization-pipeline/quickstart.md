# Quickstart: Streaming Vectorization (credential-free)

Prereqs: local Kafka-API broker + local Qdrant.

## 1. Local broker + vector store

```bash
docker run --rm -d --name uss-redpanda -p 9092:9092 \
  redpandadata/redpanda redpanda start --smp 1 --overprovisioned \
  --kafka-addr 0.0.0.0:9092 --advertise-kafka-addr localhost:9092
docker run --rm -d --name uss-qdrant -p 6333:6333 qdrant/qdrant

export QUEUE=kafka
export KAFKA_BROKERS=localhost:9092
export VECTOR_STORE=qdrant
export QDRANT_URL=http://localhost:6333
export EMBEDDING_PROVIDER=hash          # local, batched, no key
export EMBED_BATCH_SIZE=256
export EMBED_MAX_WAIT_MS=200
```

## 2. Start the stages

```bash
npm run worker:discover    # fetch/discover consumers
npm run worker:embed       # batched embed consumers (scale on lag)
npm run worker:media       # ASR/vision pool (004/005)
```

## 3. Trigger a sync → watch it stream

```bash
curl -s localhost:4420/v1/sync/slack -H "$AUTH" \
  -d '{"tenantId":"acme","userId":"u","options":{"fixtures":"large"}}'

# discover emits many fine-grained embed-tasks; embed batches them:
npm run kafka:lag           # show per-group lag draining
```

## 4. Prove decoupling

```bash
# Pause embed workers; discover keeps draining and the broker buffers:
docker pause $(embed worker)        # or stop the embed consumer
npm run kafka:lag                   # embed-task lag grows, discover still runs
# Resume → backlog drains:
docker unpause $(embed worker)
```

## 5. Prove fairness

```bash
# Two tenants backfilling at once interleave; neither blocks the other:
curl -s localhost:4420/v1/sync/slack -H "$ACME" -d '{"tenantId":"acme","userId":"u","options":{"fixtures":"large"}}'
curl -s localhost:4420/v1/sync/slack -H "$GLOBEX" -d '{"tenantId":"globex","userId":"u","options":{"fixtures":"small"}}'
# globex (small) completes promptly despite acme's large backfill.
```

## 6. Prove replay = reindex (no source re-fetch)

```bash
# Change the embedding model, then replay the log:
EMBEDDING_MODEL=other npm run reindex:replay -- --tenant acme --source slack
# embed workers re-consume embed-tasks from the retained log; Slack is NOT hit.
```

## 7. Prove failure isolation

```bash
npm run sim:poison -- --tenant acme   # inject a bad embed-task
npm run kafka:lag                     # partition keeps flowing; poison → embed-task-dlq
npm run dlq:redrive -- --topic embed-task-dlq
```

## What needs accounts (production)

- Managed Kafka (Event Hubs / Confluent) and managed Qdrant.
- Real embedding API (`EMBEDDING_PROVIDER=openai`) — optional; hash works offline.
