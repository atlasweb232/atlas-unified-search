# Tasks

## Speckit

- [x] Create separate repo.
- [x] Define unified search feature.
- [x] Define connector boundaries.
- [x] Define API contract.
- [x] Define data model.
- [x] Define rollout plan.

## M1: Skeleton

- [ ] Create TypeScript workspace.
- [ ] Add backend API service.
- [ ] Add connector interface.
- [ ] Add normalized document types.
- [ ] Add chunking module.
- [ ] Add embedding provider interface.
- [ ] Add in-memory and pgvector store interfaces.
- [ ] Add hybrid search service.
- [ ] Add React `UnifiedSearchWidget`.
- [ ] Add fixture-based tests.

## M2: Slack

- [ ] Reuse logic from `slack-integration`.
- [ ] Add Slack bot token connector.
- [ ] Sync channel history.
- [ ] Sync thread replies.
- [ ] Normalize links and files.
- [ ] Persist channel timestamp checkpoints.

## M3: Google Drive

- [ ] Add Google auth config.
- [ ] Implement files listing.
- [ ] Implement blob downloads.
- [ ] Implement Google Workspace export.
- [ ] Extract text from supported formats.
- [ ] Persist modified-time/page-token checkpoints.

## M4: Conference Blob

- [ ] Add Azure Blob connector.
- [ ] List configured containers/prefixes.
- [ ] Parse TXT, JSON, VTT, SRT transcripts.
- [ ] Normalize speaker/time ranges.
- [ ] Store blob references without public URLs.

## M5: Email

- [ ] Define adapter over current Atlas email vectorization.
- [ ] Normalize email metadata.
- [ ] Preserve thread/conversation IDs.
- [ ] Enforce mailbox/user scope.

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
