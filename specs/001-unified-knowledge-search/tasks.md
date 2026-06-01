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
- [x] Add React `UnifiedSearchWidget`.
- [x] Add fixture-based tests.

## M2: Slack

- [x] Reuse logic from `slack-integration`.
- [x] Add Slack bot token connector.
- [x] Sync channel history.
- [x] Sync thread replies.
- [x] Normalize links and files.
- [x] Persist channel timestamp checkpoints.

## M3: Google Drive

- [x] Add Google auth config.
- [x] Implement files listing.
- [x] Implement blob downloads.
- [x] Implement Google Workspace export.
- [x] Extract text from supported formats.
- [x] Persist modified-time checkpoints.

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

- [x] Add tenant/user access filter.
- [x] Add audit logs.
- [x] Add secret redaction.
- [x] Add connector token provider boundary for tenant/user scoped Slack and Google Drive credentials.
- [x] Add deletion/reindex workflow.
- [x] Add explicit connector-scoped document deletion endpoint.
- [x] Add per-source sync permissions.

## M7: Deployment

- [x] Add Dockerfile.
- [x] Add Azure Container App deployment notes.
- [x] Add Postgres/pgvector migration.
- [x] Add scheduler/worker process.

## M8: Federated Search Workspace UI

- [x] Add `UnifiedSearchWorkspace` React component.
- [x] Add left connector/source panel.
- [x] Add source icons for email, Slack, Google Drive, conference bridge,
      knowledge base, and data fabric.
- [x] Add connector configured/syncing/error status display.
- [x] Add source include/exclude selection.
- [x] Add center search box.
- [x] Add source-agent status row for active query.
- [x] Add expandable result line items.
- [x] Add attachment/link rendering inside expanded rows.
- [x] Add result multi-select for assistant actions.
- [x] Add right assistant/chat panel.

## M9: Parallel Source Search Agents

- [x] Add `SearchRun` model.
- [x] Add per-source `SourceSearchAgent` abstraction.
- [x] Fan out selected-source searches in parallel.
- [x] Return partial source statuses.
- [x] Merge/rank/dedupe line items.
- [x] Add polling endpoint for run status/results.
- [x] Add authenticated SSE endpoint for partial run snapshots/results.
- [x] Add source-agent failure isolation.

## M10: LLM And Artifact Actions

- [x] Add pluggable `ChatProvider` interface.
- [x] Add deterministic mock provider for tests.
- [x] Add OpenAI-compatible provider adapter.
- [x] Add Azure OpenAI provider placeholder.
- [x] Add Anthropic-compatible provider placeholder.
- [x] Add Cerebras-compatible provider placeholder.
- [x] Add assistant action API.
- [x] Add action types for summarize, Q&A, draft email, action items, compare
      sources, create PowerPoint, and create PDF.
- [x] Add pluggable `ArtifactProvider` interface.
- [x] Add artifact provenance metadata.
- [x] Audit assistant and artifact actions.
