# Feature Spec: Unified Knowledge Search

## Summary

Create a separate backend-first unified search platform that ingests content
from Slack, Google Drive, conference bridge blob storage, and the current
user's email vectorization pipeline. The platform indexes normalized documents
and exposes a single search API plus an embeddable React search widget.

## Product Goal

A user can search one place and retrieve relevant results across Slack
conversations, Drive documents, email messages, and conference bridge
transcripts/recordings. Results must identify the source, owner/sender,
timestamp, channel/folder/mailbox/container, and a one-line summary with an
expandable detail view.

## Sources

### Slack

Use the Slack bot-token path for personal usage now. Later, add WorkOS or
per-user OAuth.

Indexed objects:

- parent messages
- thread replies
- message links
- file metadata
- optional file text extraction when downloadable and permitted

Official API references:

- Slack Web API methods use `https://slack.com/api/METHOD`.
- `conversations.history` retrieves conversation history.
- `conversations.replies` retrieves thread replies.

### Google Drive

Use Google Drive API v3 OAuth/service auth depending on deployment mode.

Indexed objects:

- file metadata
- folder path
- Google Docs/Sheets/Slides exported text when possible
- PDFs/text/Office files after text extraction
- file web links and modified timestamps

Official API references:

- `files.list` for file discovery.
- `files.get` with `alt=media` for blob download.
- `files.export` for Google Workspace document export.

### Conference Bridge Blob Storage

Use Azure Blob Storage as source of truth for conference bridge artifacts.

Indexed objects:

- transcript text blobs
- recording metadata blobs
- diarization/speaker metadata if present
- meeting title, bridge ID, participants, start/end time
- secure blob reference, not public raw URL

Official API reference:

- Azure Storage Blob SDK for JavaScript lists blobs via container clients and
  `listBlobsFlat`.

### Current User Email

Integrate with the current Atlas email vectorization/search pipeline.

Indexed objects:

- email message metadata
- sender/recipient
- subject
- body chunks
- attachments metadata
- thread/conversation ID
- mailbox/account ID

The unified platform should not duplicate email-specific business logic. It
should ingest normalized email documents from the existing email backend or read
from a shared vector/document store through a connector.

## Functional Requirements

### Ingestion

- Provide connector interfaces for Slack, Drive, Blob, and Email.
- Each connector emits normalized `SearchDocument` records.
- Sync jobs are resumable by cursor/checkpoint.
- Sync jobs are idempotent by source-specific stable IDs.
- Sync jobs can run manually and on a schedule.
- Failed source records are logged with retry metadata.
- Secrets are backend-only.

### Normalization

Every indexed item must include:

- `tenantId`
- `userId`
- `source`
- `sourceId`
- `sourceUri`
- `title`
- `summary`
- `body`
- `author`
- `timestamp`
- `container`
- `access`
- `metadata`

### Chunking

- Chunk long documents into semantically useful segments.
- Preserve parent-child relationships.
- Slack thread replies should stay attached to the parent conversation.
- Email threads should preserve conversation context.
- Drive files should preserve file-level metadata on every chunk.
- Conference transcripts should preserve speaker/time ranges.

### Vectorization

- Support pluggable embedding providers.
- Default provider can be OpenAI embeddings.
- Local deterministic hash embeddings may exist for tests only.
- Store embedding version and model per chunk.
- Re-index when embedding model changes.

### Search

- Search across all sources by default.
- Filter by source, channel/folder/mailbox/container, author, and date range.
- Return ranked results with lexical + vector hybrid scoring.
- Results include a one-line summary and expandable detail payload.
- Detail payload includes source-specific children:
  - Slack thread replies
  - Drive file metadata and extracted sections
  - email thread context
  - conference transcript segments
- Return stable links to open source records when permitted.

### Embeddable UI

- Provide a standalone React app.
- Export a reusable `UnifiedSearchWidget`.
- Widget accepts `apiBaseUrl`, `tenantId`, `userId`, and optional filters.
- Widget does not know provider secrets.
- Widget can be embedded into `atlas-emailreact` with minimal plumbing.

### Security And Tenancy

- All records are scoped by `tenantId` and `userId`.
- A search request must only return records the caller can access.
- Connector secrets are stored in backend secret store only.
- Raw blob URLs are not exposed; issue short-lived access URLs only when needed.
- Audit all sync, search, and source-open events.
- Deletion requests propagate to source documents, chunks, and embeddings.

## Non-Goals

- No direct frontend Slack/Drive/blob/email credentials.
- No public blob URLs in search results.
- No cross-user search without explicit organization/admin mode.
- No WorkOS multi-user Slack install in the first personal-use milestone.

## Acceptance Criteria

1. Spec repo exists with connector, API, data model, and rollout artifacts.
2. MVP implementation can ingest sample Slack, Drive, Blob, and Email fixtures.
3. Search returns mixed-source results with source, container, timestamp, author,
   one-line summary, score, and expandable details.
4. Widget can be mounted standalone and imported by another React app.
5. Search API enforces `tenantId`/`userId` filters.
6. Sync jobs are resumable and idempotent.
7. Tests cover normalization, chunking, ranking, and access filtering.

## Open Questions

- Should production vector storage be Postgres/pgvector, Azure AI Search, or
  Qdrant?
- Should email records be copied into this service or queried federated from the
  existing email vector service?
- Should conference bridge transcript generation live here or upstream of blob
  ingestion?
- What is the first deployment target: Azure Container App or local VM?
