# Implementation Plan

## Architecture

Use a decoupled backend with connector workers and a small embeddable frontend.

```text
UnifiedSearchWidget
  -> Search API
      -> Hybrid Search Engine
          -> Document Store
          -> Vector Store
          -> Access Filter

Sync Scheduler
  -> Slack Connector
  -> Google Drive Connector
  -> Azure Blob Connector
  -> Email Connector
      -> Normalizer
      -> Chunker
      -> Embedding Queue
      -> Document Store + Vector Store
```

## Recommended MVP Stack

- Runtime: Node.js/TypeScript
- API: Express or Fastify
- Worker: same process for MVP, queue-ready interface
- Store: Postgres with pgvector for production path
- Dev/test store: SQLite or in-memory adapter
- Blob source: `@azure/storage-blob`
- Slack source: Slack Web API bot token
- Drive source: Google Drive API v3
- Frontend: Vite React component

## Vector Store Recommendation

Use Postgres + pgvector first.

Reasons:

- simpler operational footprint than adding a separate vector DB
- strong metadata filtering for tenant/user/source ACLs
- good enough for first deployment scale
- can migrate hot corpora to Azure AI Search/Qdrant later if needed

## Hybrid Search

Combine:

- vector cosine similarity
- lexical rank over title/body/summary
- recency boost
- source-specific boosts

## Milestones

### M1: Platform Skeleton

- Repo scaffolding
- connector interface
- normalized document model
- in-memory store
- hash embedding test provider
- search API
- React widget

### M2: Slack Personal Connector

- bot token config
- channel history sync
- thread replies
- files/links metadata
- checkpoint by channel timestamp

### M3: Google Drive Connector

- OAuth/service auth config
- files list
- download/export text
- folder path metadata
- checkpoint by modified time/page token

### M4: Azure Blob Conference Connector

- list blobs by prefix/container
- parse transcript JSON/TXT/VTT/SRT
- preserve meeting/speaker/time metadata
- issue secure references only

### M5: Email Connector

- adapter over existing Atlas email vector/index data
- normalized email documents
- conversation/thread expansion

### M6: Production Hardening

- Postgres/pgvector
- queue-backed embedding worker
- audit logs
- access control
- deletion/reindex jobs
- Azure deployment

## Testing

- connector fixture tests
- normalization tests
- chunking tests
- hybrid ranking tests
- ACL/tenancy tests
- widget rendering tests
- full local E2E with fixture data
