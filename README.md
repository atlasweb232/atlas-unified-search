# Atlas Unified Search

Atlas Unified Search is the backend search and knowledge-ingestion service used
by the desktop, web, and connector workflows.

It provides one secured search/indexing plane across:

- Slack messages, threads, links, and attachments
- Google Drive files and exported Google Workspace documents
- conference bridge transcripts/recordings stored in Azure Blob Storage
- current user's email vector index
- meeting archives produced by Atlas Desktop
- knowledge-base and data-fabric records

This repository is intentionally separate from `atlas-emailreact` and
`slack-integration`. The platform should expose a small search API and a React
widget that can be embedded into Atlas Email or used standalone.

## Current Deployment

Production API:

`https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io`

Desktop should use the `/v1` base:

`https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io/v1`

Current deployed image:

`atlasbackend2ba6c25e.azurecr.io/atlas-unified-search:meeting-backend-prod-202606051200-a33d915`

Azure Container Apps:

- API: `atlas-unified-search`
- worker: `atlas-unified-search-worker`

## Architecture

The service has four main parts:

1. **API server**
   - Express app in `src/app.js`
   - exposes `/v1/search`, connector APIs, meeting ingestion APIs, audit, health,
     and production-readiness endpoints
   - enforces API auth and identity scope before search or ingestion

2. **Index/store layer**
   - `src/store.js` provides the JSON dev/test store
   - `src/stores/postgresStore.js` provides the production Postgres/pgvector
     store
   - normalized documents and chunks are indexed once, then searched through one
     retrieval path

3. **Connector and job layer**
   - connectors live under `src/connectors/`
   - sync work is queued through Azure Service Bus in production
   - `src/worker.js` runs background indexing jobs

4. **Frontend**
   - React workspace under `frontend/`
   - served by the same API container after `npm run build`

The production deployment currently reports:

- Postgres/pgvector index
- JWT identity mode
- auth required
- Azure Service Bus queue
- Azure Blob artifact storage

## Search Flow

Typical search flow:

1. Client calls `POST /v1/search`.
2. API resolves tenant/user identity from JWT/API key or trusted dev headers.
3. Requested sources are intersected with the caller's allowed sources.
4. Search engine embeds the query.
5. Store returns scoped candidate chunks.
6. Results are ranked and returned with provenance metadata.
7. Audit event is written.

The important rule is that desktop and other clients do not talk directly to
Slack, Drive, Blob, or data-fabric connectors for RAG. They call this service.

## Meeting And Recording Flow

Atlas Desktop owns the meeting runtime and meeting orchestration. This backend
owns durable search, archive ingestion, recording upload receipts, and retrieval.

Desktop sends completed meeting data to:

- `POST /v1/meeting/archive`
- `POST /v1/meeting/ingest`
- `POST /v1/meeting/recording/upload`
- `PUT /v1/meeting/recording/blob/:recordingId`
- `POST /v1/meeting/recording/complete`

The backend converts a meeting archive into a searchable `conference_bridge`
document. The searchable document includes:

- transcript text
- minutes and summary text
- participants and participant context
- action items
- decisions
- pending questions
- related artifacts and cited knowledge references
- security labels and meeting metadata

Recording storage is intentionally simple:

- desktop asks the backend for a recording upload session
- desktop uploads bytes to the returned upload URL
- desktop completes the upload
- backend stores a recording artifact/receipt and returns a durable recording URI
- the meeting archive references that recording metadata

The recording itself is stored/referenced. The transcript, minutes, action
items, and metadata are what become searchable immediately. Deeper audio/video
segment search belongs to the conference video-search workstream, not this
meeting archive conversion path.

Simple pipeline:

```text
Atlas Desktop meeting
  -> meeting archive / recording upload
  -> atlas-unified-search /v1/meeting/*
  -> conference_bridge document + recording artifact
  -> /v1/search can retrieve the meeting later
```

## Identity And Security

Production should run with identity-bound auth:

- `IDENTITY_MODE=jwt` or `IDENTITY_MODE=api_key`
- `UNIFIED_SEARCH_REQUIRE_AUTH=true`

In identity-bound modes, tenant/user scope comes from the verified identity and
request-provided IDs cannot override it.

Legacy shared-token/dev mode still supports request-provided `tenantId`,
`userId`, or `x-tenant-id` / `x-user-id` headers for local testing.

## Storage

Production storage:

- Postgres/pgvector for normalized documents, chunks, jobs, audit, search runs,
  assistant actions, and artifact metadata
- Azure Blob artifacts for generated artifacts and recording-related storage
- Azure Service Bus for async sync/indexing jobs

Local/dev storage:

- JSON store under `DATA_DIR`
- local recording upload path under `DATA_DIR/meeting-recordings`

## Important Commands

Install and test:

```bash
npm install
npm test
```

Run locally:

```bash
npm run dev:api
```

Build image in ACR:

```bash
az acr build \
  --resource-group atlas-azure-backend-rg \
  --registry atlasbackend2ba6c25e \
  --image atlas-unified-search:<tag> .
```

Promote an already-built image without changing existing Container App env vars:

```bash
IMAGE_TAG='<tag>' npm run azure:promote-image
```

Health check:

```bash
curl -s https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io/v1/health
```

## Validation Status

Local backend validation:

- `npm test`
- current result after meeting backend work: 59 passed, 0 failed

Meeting-specific backend coverage:

- `tests/meeting-production.test.js`
- covers meeting archive/ingest becoming searchable as `conference_bridge`
- covers recording upload session, byte upload, and completion receipt

Desktop-side validation lives in `atlas-desktop`:

- fake-backend meeting smoke matrix has passed
- meeting-focused desktop unit tests have passed
- live Windows validation still needs real desktop token, user email, Google Meet
  URL, and recording configuration

## Specs

- `specs/001-unified-knowledge-search/spec.md`
- `specs/002-search-scale-and-tenant-hardening/spec.md`
- `specs/003-attachments-artifacts-enterprise-sources/spec.md`
- `specs/004-conference-video-search/spec.md`

## Current Production Smoke Status

- Live-proven: hosted UI, API auth, Service Bus worker, Postgres/pgvector,
  Blob artifacts, email readiness, conference Blob transcripts, and knowledge
  base documents.
- Deployed and endpoint-proven: meeting archive, meeting ingest, and meeting
  recording upload routes.
- Fixture-pipeline only: Slack-shaped data through queue/index/search/assistant.
- Not live-proven until credentials are configured: Slack Web API and Google
  Drive API.
- Not live-proven yet: admitted Google Meet run from Windows desktop against the
  deployed meeting endpoints.

## Implementation Target Name

- `atlas-unified-search`

## Related Prior Repo

- `https://github.com/atlasweb232/slack-integration`
