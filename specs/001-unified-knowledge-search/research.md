# Research Notes

## Source APIs

Slack:

- Use Slack Web API with bot token for personal usage.
- `conversations.history` gets channel messages.
- `conversations.replies` gets thread messages.
- Bot must be a member of private channels.

Google Drive:

- Use Drive API v3.
- `files.list` discovers files.
- `files.get` plus `alt=media` downloads blob files.
- `files.export` exports Google Workspace docs to a target MIME type.

Azure Blob:

- Use Azure Storage Blob SDK for JavaScript.
- Container clients can list blobs with `listBlobsFlat`.
- Store blob references internally; issue short-lived access only when needed.

Email:

- Prefer connector over existing Atlas email vectorization rather than duplicate
  all IMAP/Graph sync logic.

## Storage Options

### Postgres + pgvector

Best MVP production path because it combines vector search and metadata filters
in one database. Strong fit for tenant/user segregation.

### Azure AI Search

Good later for managed hybrid search and scale, but adds more provisioning and
mapping complexity.

### Qdrant

Good dedicated vector DB option if semantic search load grows, but still needs
separate durable metadata/ACL store.

Recommendation: Postgres + pgvector first, keep store interface pluggable.

## Chunking Strategy

- Slack: parent message plus thread replies as one document, with reply chunks.
- Drive: file-level document, chunk text by headings/paragraph boundaries.
- Conference: transcript document, chunk by speaker/time windows.
- Email: conversation document, chunk by message and body sections.

## Security Strategy

- Backend-only credentials.
- Tenant/user scoped rows.
- Access filter before ranking response leaves backend.
- No raw public blob URLs.
- Audit search and result-open events.
