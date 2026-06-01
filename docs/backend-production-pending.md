# Backend Production Status

The unified search backend is deployed and production-testable for sources that
already have backend credentials/storage configured.

## Deployed

- API Container App: `atlas-unified-search`
- Worker Container App: `atlas-unified-search-worker`
- API-backed scheduler Container App: `atlas-unified-search-scheduler`
- Postgres + pgvector store
- Azure Service Bus queue: `unified-search-sync`
- Azure Blob assistant artifacts
- API bearer-token auth boundary
- Tenant/user-scoped documents, chunks, jobs, search runs, assistant actions,
  artifacts, checkpoints, and audit events
- Federated email search through the existing Atlas email vector search service
- Conference bridge Blob indexing
- Knowledge base indexing from packaged `/app/docs`
- Fixture-tested Slack-shaped ingestion through API, queue, worker, vector
  search, and assistant artifact generation

## Current External Blockers

These are not code blockers, but they prevent claiming full live connector
coverage:

- Slack live access requires `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_IDS`.
- Google Drive live access requires either OAuth refresh-token credentials or
  `GOOGLE_SERVICE_ACCOUNT_JSON`.
- Data Fabric live access requires `DATA_FABRIC_BASE_URL` and a service that
  implements the documented readiness/records contract.

Run this before wiring live Slack or Drive credentials:

```bash
npm run validate:connector-credentials
```

Then wire credentials:

```bash
npm run wire:production-connectors
npm run audit:production-config
UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production
```

## Remaining Enhancements

- Add Slack Events API webhook ingestion.
- Add Google Drive Changes/watch ingestion.
- Add Azure Blob Event Grid ingestion for conference bridge transcripts.
- Add SSE or WebSocket streaming for partial search-run results.
- Add source-agent retry policy for transient source failures.
- Add WorkOS/Nango token provider for multi-user connector onboarding.
