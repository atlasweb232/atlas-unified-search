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
- Tenant/user-scoped `/v1/retention/cleanup` with dry-run support for indexed
  data, operational records, artifact metadata, checkpoints, and audit rows
- Scheduler support for `action: retention_cleanup`, using the API-backed
  scheduler in Azure or the direct-store scheduler for intentionally privileged
  deployments
- Dedicated Azure dry-run retention scheduler app:
  `atlas-search-retention-sched`
- Federated email search through the existing Atlas email vector search service
- Conference bridge Blob indexing
- Knowledge base indexing from packaged `/app/docs`
- Backend-owned authenticated Data Fabric records endpoint for tenant/user
  operational summaries and audit-derived records
- Authenticated `/v1/events/{source}` path plus verified Slack Events API,
  Google Drive Changes, and Azure Blob Event Grid webhook ingress that maps
  provider notifications to readiness-gated, tenant/user-scoped sync jobs
- Bounded sync retry policy for transient provider failures with `sync_retry`
  audit events; missing configuration and auth/permission failures fail fast
- Fixture-tested Slack-shaped ingestion through API, queue, worker, vector
  search, and assistant artifact generation

## Current External Blockers

These are not code blockers, but they prevent claiming full live connector
coverage:

- Slack live access requires `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_IDS`.
- Google Drive live access requires either OAuth refresh-token credentials or
  `GOOGLE_SERVICE_ACCOUNT_JSON`.
- Data Fabric can use the backend-owned `/v1/data-fabric/*` contract, or a
  separate external service if/when one is introduced.

Run this before wiring live Slack or Drive credentials:

```bash
npm run validate:connector-credentials
```

Then wire credentials:

```bash
WIRE_CONNECTORS_VALIDATE_FIRST=true npm run wire:production-connectors
npm run audit:production-config
STATUS_REQUIRE_READY_SOURCES=slack,google_drive npm run status:production
STATUS_REQUIRE_WEBHOOK_INGRESS=slack_events,google_drive_changes,azure_blob_event_grid npm run status:production
UNIFIED_SEARCH_SMOKE_MODE=async UNIFIED_SEARCH_SMOKE_REQUIRE_LIVE_SOURCES=slack,google_drive npm run smoke:production
```

Google Drive watch channels expire. After the first `npm run gdrive:create-watch`,
schedule `npm run gdrive:renew-watch` before `GDRIVE_WATCH_EXPIRATION`, then wire
the new watch values and rerun the audit/status commands above.

## Remaining Enhancements

- Add WorkOS/Nango token provider for multi-user connector onboarding.
