# Tasks

## Speckit

- [x] Create separate repo.
- [x] Define unified search feature.
- [x] Define connector boundaries.
- [x] Define API contract.
- [x] Define data model.
- [x] Define rollout plan.

## M1: Skeleton

- [x] Create Node workspace.
- [x] Add backend API service.
- [x] Add connector interface.
- [x] Add normalized document types.
- [x] Add chunking module.
- [x] Add embedding provider interface.
- [x] Add JSON store and pgvector-ready store boundary.
- [x] Add hybrid search service.
- [ ] Add React `UnifiedSearchWidget`.
- [x] Add fixture-based tests.

## M2: Slack

- [x] Reuse logic from `slack-integration`.
- [x] Add Slack bot token connector.
- [x] Sync channel history.
- [x] Sync thread replies.
- [x] Normalize links and files.
- [ ] Persist channel timestamp checkpoints.

## M3: Google Drive

- [ ] Add Google auth config.
- [x] Implement files listing.
- [x] Implement blob downloads.
- [x] Implement Google Workspace export.
- [x] Extract text from supported formats.
- [ ] Persist modified-time/page-token checkpoints.

## M4: Conference Blob

- [x] Add Azure Blob connector.
- [x] List configured containers/prefixes.
- [x] Parse TXT, JSON, VTT, SRT transcripts as text fixtures/live blobs.
- [x] Normalize speaker/time ranges from fixture segments.
- [x] Store blob references without public URLs.

## M5: Email

- [x] Define adapter over current Atlas email vectorization/fetch backend.
- [x] Normalize email metadata.
- [x] Preserve thread/conversation IDs.
- [x] Enforce mailbox/user scope through tenant/user indexing.

## M6: Security

- [ ] Add tenant/user access filter.
- [ ] Add audit logs.
- [ ] Add secret redaction.
- [ ] Add deletion/reindex workflow.
- [ ] Add per-source sync permissions.

## M7: Deployment

- [ ] Add Dockerfile.
- [ ] Add Azure Container App deployment notes.
- [ ] Add Postgres/pgvector migration.
- [ ] Add scheduler/worker process.
