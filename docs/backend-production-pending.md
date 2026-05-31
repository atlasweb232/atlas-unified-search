# Backend Production Pending

The current branch has a working backend skeleton and fixture-tested connector
paths. These are the remaining production items.

## Must Do

- Replace JSON store with Postgres + pgvector.
- Add migrations for documents, chunks, search runs, connector checkpoints,
  assistant actions, artifacts, and audit events.
- Add Azure Service Bus job pipeline.
- Add Key Vault secret loading.
- Add `TokenProvider` abstraction:
  - env token provider for personal use
  - WorkOS or Nango provider for user onboarding
- Add Slack checkpoint persistence by channel timestamp.
- Add Google Drive checkpoint persistence by page token/modified time.
- Change email connector from fetch/vectorization fallback to federated query
  against the existing Atlas email vector search API.
- Add per-source sync permissions.
- Add deletion/reindex workflow.
- Add Dockerfile and Azure Container App deployment.

## Should Do

- Add Slack Events API webhook ingestion.
- Add Google Drive Changes/watch ingestion.
- Add Azure Blob Event Grid ingestion for conference bridge transcripts.
- Add SSE or WebSocket streaming for partial search-run results.
- Add source-agent timeout and retry policy.
- Add dependency vulnerability remediation before production deployment.

## Current Implemented Backend

- `/v1/health`
- `/v1/connectors`
- `/v1/sync/:source`
- `/v1/search`
- `/v1/search-runs`
- `/v1/search-runs/:id`
- `/v1/documents/:id`
- `/v1/jobs`
- `/v1/assistant/actions`
- `/v1/assistant/actions/:id`

## Current Practical Connectors

- Slack bot-token sync.
- Google Drive API sync.
- Atlas email backend adapter path.

## Current Future Connectors

- Conference bridge Azure Blob connector.
- Knowledge base local file connector.
- Data fabric placeholder connector.
