# Implementation Plan

## Architecture

Use a decoupled backend with connector workers and a three-panel embeddable
frontend.

```text
UnifiedSearchWorkspace
  -> Left Connector Panel
  -> Center Query + Result Stream
  -> Right Assistant/Artifact Panel

Search API
  -> SearchRun Coordinator
      -> Email SourceSearchAgent
      -> Slack SourceSearchAgent
      -> Google Drive SourceSearchAgent
      -> Conference Bridge SourceSearchAgent
      -> Knowledge Base SourceSearchAgent
      -> Data Fabric SourceSearchAgent
          -> Hybrid Search Engine
          -> Document Store
          -> Vector Store
          -> Access Filter
      -> Merge/Rank/Dedupe Layer

Assistant API
  -> LLM Provider Adapter
  -> Artifact Provider Adapter
  -> Provenance/Audit Store

Sync Scheduler
  -> Slack Connector
  -> Google Drive Connector
  -> Azure Blob Connector
  -> Email Connector
  -> Knowledge Base Connector
  -> Data Fabric Connector
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
- Email source: Atlas email assistant connector
- Frontend: Vite React workspace component
- LLM provider: pluggable backend adapter, mock provider for tests
- Artifact provider: pluggable backend adapter, local file generator for MVP

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

## Federated Query Runtime

Every user query creates a `SearchRun`. The run coordinator fans out work to one
`SourceSearchAgent` per selected source. Each agent returns normalized line
items as soon as its source search completes. The merge/rank layer appends
partial results to the run, deduplicates related hits, and makes the current
ranked list available through polling/SSE.

MVP can use in-process async promises and polling. Production should move to a
queue plus SSE or WebSocket streaming.

## UI Layout

Left panel:

- connector list with icons
- include/exclude checkboxes
- connector sync/config status
- source filters

Center panel:

- search box
- query status by source
- line-item results from Email, Slack, Google Drive, Conference Bridge,
  Knowledge Base, and Data Fabric
- expandable rows with thread/replies, source sections, transcript segments,
  links, and attachments
- result multi-select for assistant actions

Right panel:

- chatbot bound to retrieved results
- action buttons for summarize, answer, draft, PowerPoint, PDF, action items,
  and compare
- artifact job status and downloads

## LLM/Artifact Provider Boundary

Provider adapters:

- `ChatProvider.generate({ messages, contextDocuments, action })`
- `ArtifactProvider.create({ type, title, sections, provenance })`

The first implementation should include:

- `mock` provider for deterministic tests
- OpenAI-compatible provider contract
- placeholders for Azure OpenAI, Anthropic-compatible, Cerebras-compatible
  providers

Provider credentials are backend-only.

## Milestones

### M1: Platform Skeleton

- Repo scaffolding
- connector interface
- normalized document model
- in-memory store
- hash embedding test provider
- search API
- React workspace/widget

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

### M7: Federated UI And Assistant

- connector source panel
- source selection filters
- search run coordinator
- source search agents
- partial result stream/polling
- expandable result rows with attachments
- right-side assistant panel
- pluggable LLM provider adapter
- PowerPoint/PDF artifact job contract
- provenance and audit for assistant actions

## Testing

- connector fixture tests
- normalization tests
- chunking tests
- hybrid ranking tests
- ACL/tenancy tests
- widget rendering tests
- full local E2E with fixture data
- source-agent fanout tests
- assistant action mock-provider tests
- artifact provenance tests
