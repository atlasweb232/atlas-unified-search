# Feature Spec: Unified Knowledge Search

## Summary

Create a separate backend-first unified search platform that ingests content
from Slack, Google Drive, conference bridge blob storage, the current user's
email vectorization pipeline, knowledge base content, and future data fabric
records. The platform indexes normalized documents and exposes a single search
API plus an embeddable React search workspace.

## Product Goal

A user can search one place and retrieve relevant results across Slack
conversations, Drive documents, email messages, conference bridge
transcripts/recordings, knowledge base pages, and future data fabric records.
Results must identify the source, owner/sender, timestamp,
channel/folder/mailbox/container, and a one-line summary with an expandable
detail view. A right-side assistant panel can summarize retrieved information
or create export artifacts such as PowerPoint/PDF through pluggable LLM and
document-generation providers.

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

### Knowledge Base

Support internal knowledge base/wiki/runbook content. The MVP may read local
Markdown/text files or fixtures; production connectors can later target CMS,
wiki, SharePoint, Confluence, Git docs, or an Atlas-managed knowledge base.

Indexed objects:

- page/document title
- body chunks
- author/owner
- space/project/container
- attachments or embedded links
- source link

### Data Fabric

Provide a connector boundary for future structured operational data. This is
not a live connector in the first practical milestone, but search results must
be able to carry structured metadata from datasets, tables, facts, metrics, and
lineage records.

## Functional Requirements

### Ingestion

- Provide connector interfaces for Slack, Drive, Blob, Email, Knowledge Base,
  and Data Fabric.
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
- Allow users to explicitly choose which sources/connectors participate in a
  query.
- Execute selected-source search through parallel source search agents, one per
  source, so slow sources do not block fast sources from streaming results.
- Merge source-agent results into one ranked result stream while preserving
  per-source provenance.
- Return ranked results with lexical + vector hybrid scoring.
- Results include a source icon, one-line summary, source label, timestamp,
  author/sender, container label, score/confidence, and expandable detail
  payload.
- Detail payload includes source-specific children:
  - Slack thread replies
  - Drive file metadata and extracted sections
  - email thread context
  - conference transcript segments
- Detail payload must include attachment metadata. If an email/Slack/Drive
  result has an attachment, the attachment travels with the row and can be
  opened/downloaded through backend-controlled access.
- Return stable links to open source records when permitted.

### Search Workspace UI

The primary user interface is a three-region workspace:

1. Left connector/source panel
   - lists available connectors: Email, Slack, Google Drive, Conference Bridge,
     Knowledge Base, and Data Fabric
   - shows configured/not configured/syncing/error status per connector
   - lets user include/exclude sources before a query
   - exposes source-specific filters such as channel, folder, mailbox,
     container, author, and date range

2. Center search/results panel
   - contains the main search box
   - starts a query against the selected sources
   - shows line items as they arrive from source search agents
   - each line item shows source icon, source name, one-liner, timestamp,
     sender/author, container, and score
   - each line item expands on click to show full excerpt, thread/replies,
     transcript segments, file sections, attachments, links, and source-open
     actions
   - supports multi-select results for downstream assistant actions

3. Right assistant/action panel
   - contains a chatbot bound to the retrieved result set and user-selected
     line items
   - can summarize retrieved information
   - can compare sources and identify conflicts
   - can draft answers/emails
   - can create export jobs for PowerPoint and PDF files
   - displays artifact job status and download/open links

### Parallel Source Agents

- A query creates a `SearchRun`.
- A `SearchRun` fans out into `SourceSearchAgent` jobs for selected sources.
- Each source agent searches its source's vector/index space and returns
  normalized `SearchResultLineItem` records.
- Source agents can complete independently.
- The frontend can poll or subscribe to stream partial results.
- The merge/rank layer deduplicates related results and preserves source
  grouping.
- Errors from one source are surfaced inline without failing the entire query.

### LLM And Artifact Actions

- LLM providers must be pluggable.
- Initial contract should support OpenAI-compatible chat completions, Azure
  OpenAI, Anthropic-compatible APIs, Cerebras-compatible APIs, and a local mock
  provider for tests.
- The selected provider is backend-side only; no frontend provider keys.
- Assistant actions operate on retrieved result IDs and selected source
  documents, not unbounded raw corpus access.
- Supported action types:
  - `summarize`
  - `answer_question`
  - `draft_email`
  - `create_powerpoint`
  - `create_pdf`
  - `extract_action_items`
  - `compare_sources`
- Artifact generation providers are also pluggable. PowerPoint/PDF generation
  may start with backend libraries and later move to a worker service.
- Generated artifacts must carry provenance metadata listing included source
  result IDs.

### Embeddable UI

- Provide a standalone React app.
- Export a reusable `UnifiedSearchWorkspace` and smaller
  `UnifiedSearchWidget`.
- Components accept `apiBaseUrl`, `tenantId`, `userId`, default selected
  sources, and optional filters.
- Widget does not know provider secrets.
- Widget can be embedded into `atlas-emailreact` with minimal plumbing.

### Security And Tenancy

- All records are scoped by `tenantId` and `userId`.
- A search request must only return records the caller can access.
- Connector secrets are stored in backend secret store only.
- LLM and artifact provider secrets are stored backend-side only.
- Assistant actions must only use result IDs from the current user's accessible
  search run unless an explicit broader permission exists.
- Raw blob URLs are not exposed; issue short-lived access URLs only when needed.
- Audit all sync, search, and source-open events.
- Audit assistant actions and artifact generation.
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
8. UI spec supports left connector panel, center result list, and right
   assistant/action panel.
9. Search run contract supports parallel per-source agents and partial result
   status.
10. Assistant action contract is provider-pluggable and can create summary,
    PowerPoint, and PDF artifact jobs from retrieved result IDs.

## Open Questions

- Should production vector storage be Postgres/pgvector, Azure AI Search, or
  Qdrant?
- Should email records be copied into this service or queried federated from the
  existing email vector service?
- Should conference bridge transcript generation live here or upstream of blob
  ingestion?
- What is the first deployment target: Azure Container App or local VM?
- Should search result streaming use SSE, WebSocket, or polling for MVP?
- Which LLM provider should be the first production provider?
- Should PowerPoint/PDF generation happen in this service or a separate worker?
