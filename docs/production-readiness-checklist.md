# Production Readiness Checklist

The unified search service is production-testable when these gates are true:

- API Container App is deployed from this repo and `/v1/health` is public.
- `UNIFIED_SEARCH_AUTH_TOKEN` is configured and protected API routes reject unauthenticated requests.
- `UNIFIED_SEARCH_CORS_ORIGINS` is configured in authenticated production deployments so browsers only receive CORS approval from known frontend origins.
- Postgres flexible server has `pgvector` installed and `npm run db:migrate` has completed.
- `/v1/health` reports `index.backend=postgres-pgvector`.
- Public `/v1/health` does not expose connector configuration, global document/chunk/job counts, or per-source corpus counts; use protected `/v1/index/status?tenantId=&userId=` for scoped index counts.
- Service Bus queue `unified-search-sync` exists and the worker Container App is running.
- Scheduled sync is configured either through a single-replica scheduler Container App/job using `UNIFIED_SEARCH_SYNC_SCHEDULES`, or consciously disabled for manual-only testing with `UNIFIED_SEARCH_SCHEDULER_REQUIRED` unset/false. Prefer the API-backed scheduler (`node src/apiScheduler.js`) so scheduling only needs the protected API URL plus auth token; use the direct scheduler (`node src/scheduler.js`) only when intentionally giving the scheduler Postgres and Service Bus secrets.
- `UNIFIED_SEARCH_SYNC_SCHEDULES` can include `{"action":"retention_cleanup",...}` entries so tenant/user cleanup can run on a controlled cadence through the same single-replica scheduler.
- `/v1/health` reports `queue.backend=azure-service-bus`.
- Artifact Blob container exists and assistant artifacts are stored there.
- `/v1/health` reports `artifacts.backend=azure-blob-artifact`.
- `/v1/health` reports retention defaults, and `/v1/retention/cleanup` supports tenant/user-scoped dry-run and deletion using `UNIFIED_SEARCH_DOCUMENT_RETENTION_DAYS`, `UNIFIED_SEARCH_OPERATIONAL_RETENTION_DAYS`, and `UNIFIED_SEARCH_AUDIT_RETENTION_DAYS`.
- Hosted frontend root `/` returns the React shell, built JS/CSS assets load, and protected `/v1/*` routes still reject unauthenticated callers.
- Slack app is installed in the workspace with bot scopes listed in `docs/slack-gdrive-onboarding.md`.
- `npm run slack:list-channels` can list bot-visible Slack channel IDs without printing the bot token; configured private channels must show `member:true`.
- Google OAuth consent and refresh token are configured for Drive read access.
- `npm run gdrive:create-watch` has created a Google Drive changes watch channel, and the returned channel ID is wired as `GDRIVE_WEBHOOK_CHANNEL_IDS` before strict webhook readiness is required.
- Google Drive watch metadata from `npm run gdrive:create-watch` is wired as `GDRIVE_WATCH_RESOURCE_ID`, `GDRIVE_WATCH_START_PAGE_TOKEN`, and `GDRIVE_WATCH_EXPIRATION`; `npm run audit:production-config` reports `gdriveWatchRenewalStatus=ok` or flags renewal before the watch silently expires.
- Google Drive watch renewal is operationalized with `npm run gdrive:renew-watch`; run it before `GDRIVE_WATCH_EXPIRATION`, wire the new `GDRIVE_WEBHOOK_CHANNEL_IDS`, `GDRIVE_WATCH_RESOURCE_ID`, `GDRIVE_WATCH_START_PAGE_TOKEN`, and `GDRIVE_WATCH_EXPIRATION`, then rerun `npm run audit:production-config` and `npm run status:webhooks`.
- Email results use `EMAIL_VECTOR_SEARCH_URL` to federate against the existing Atlas email vector service.
- Email production smoke verifies the federated email source-agent path; set `UNIFIED_SEARCH_SMOKE_REQUIRE_EMAIL_RESULTS=true` with a known indexed test email before claiming email corpus content coverage.
- Conference bridge transcripts use `AZURE_STORAGE_CONNECTION_STRING` and `CONFERENCE_BLOB_CONTAINERS`; when configured, production smoke reindexes and searches a scoped Blob prefix.
- Knowledge base uses `KNOWLEDGE_BASE_ROOT`; the deployed image can use `/app/docs` for production smoke coverage.
- Tenant/user IDs are supplied on every sync, search, search-run, document, and assistant action request.
- Cross-tenant reads are rejected by API tests and manual smoke tests.
- Scoped deletion and `/v1/reindex/{source}` are available for tenant/user/source resets without deleting other users' data.
- `/v1/sync/{source}` and `/v1/reindex/{source}` reject live connector jobs with `409` unless readiness passes; `/v1/reindex/{source}` must not delete existing indexed data when Slack/Drive auth is missing or invalid.
- `/v1/events/{source}` accepts authenticated provider events, strips fixture bypasses, audits a redacted event summary, and queues only readiness-gated tenant/user-scoped sync jobs.
- `/v1/webhooks/slack/events` accepts Slack Events API payloads only with a valid `X-Slack-Signature`, fresh `X-Slack-Request-Timestamp`, and configured `SLACK_SIGNING_SECRET`, `SLACK_EVENT_TENANT_ID`, and `SLACK_EVENT_USER_ID`; signed events still return `409` until Slack live readiness passes.
- `/v1/webhooks/google-drive/changes` accepts Google Drive push notifications only with a valid `X-Goog-Channel-Token`, configured `X-Goog-Channel-ID`, and configured `GDRIVE_WEBHOOK_TOKEN`, `GDRIVE_WEBHOOK_CHANNEL_IDS`, `GDRIVE_EVENT_TENANT_ID`, and `GDRIVE_EVENT_USER_ID`; verified notifications still return `409` until Google Drive live readiness passes.
- `/v1/webhooks/azure-blob/events` handles Event Grid subscription validation and accepts BlobCreated events only with configured `CONFERENCE_EVENT_GRID_TOKEN`, `CONFERENCE_EVENT_TENANT_ID`, and `CONFERENCE_EVENT_USER_ID`; verified events still return `409` until conference Blob storage readiness passes.
- `UNIFIED_SEARCH_SOURCE_TIMEOUT_MS` is configured or defaults to 30000ms so a hung federated source-agent produces a partial search run instead of blocking the whole query.
- `UNIFIED_SEARCH_SYNC_RETRY_ATTEMPTS` and `UNIFIED_SEARCH_SYNC_RETRY_BASE_DELAY_MS` provide bounded retries for transient source sync failures while configuration/auth failures fail fast.
- Slack and Google Drive syncs persist tenant/user-scoped checkpoints; use `forceFullSync` or `/v1/reindex/{source}` to intentionally rescan.
- Optional `UNIFIED_SEARCH_SOURCE_PERMISSIONS` can restrict usable sources per `tenantId:userId`.
- `npm run smoke:production` passes with `UNIFIED_SEARCH_SMOKE_MODE=inline`.
- `npm run smoke:production` passes with `UNIFIED_SEARCH_SMOKE_MODE=async`, proving Service Bus worker ownership.
- After Slack and Google Drive credentials are wired, `UNIFIED_SEARCH_SMOKE_REQUIRE_LIVE_SOURCES=slack,google_drive npm run smoke:production` passes; this fails closed if either source is not live-ready and proves real reindex/search with configured connector coverage before cleaning the smoke corpus.
- The Slack portion of `smoke:production` is a fixture pipeline check unless `/v1/connectors/readiness?source=slack` returns `ready:true`; it does not prove real Slack Web API access without `SLACK_BOT_TOKEN` and channel IDs.
- Google Drive live ingestion is not proven until `/v1/connectors/readiness?source=google_drive` returns `ready:true` and `/v1/reindex/google_drive` succeeds with real credentials.
- `npm run smoke:production:ui` passes against the hosted frontend and protected API boundary.
- `npm run smoke:browser-ui` passes against the hosted frontend with `UNIFIED_SEARCH_LOCAL_FRONTEND_URL` set, proving the rendered React shell disables unauthenticated Slack/GDrive source selection and can run a scoped federated email search.
- `GET /v1/connectors/readiness` returns explicit `ready/status/requirements` for each connector without exposing secret values.
- `GET /v1/production-readiness` returns `readyForProductionTesting:true`, lists Slack/GDrive under `credentialBlockedSources` until real credentials are configured, reports webhook ingress readiness under `webhookIngress`, and only sets `productionComplete:true` after every live source, future source, and provider webhook ingress is proven.
- `STATUS_REQUIRE_READY_SOURCES=slack,google_drive npm run status:production` or `npm run status:live-connectors` fails until both Slack and Google Drive readiness are true; use this as the explicit live-connector acceptance gate after credentials are wired.
- `STATUS_REQUIRE_WEBHOOK_INGRESS=slack_events,google_drive_changes,azure_blob_event_grid npm run status:production` or `npm run status:webhooks` fails until every provider webhook ingress secret and tenant/user mapping is wired.
- `npm run audit:production-config` reports API/worker env wiring and credential blockers without printing secret values.
- `WIRE_CONNECTORS_DRY_RUN=true WIRE_CONNECTORS_VALIDATE_FIRST=true npm run wire:production-connectors` prints redacted planned Azure changes and does not update Container Apps.
- `WIRE_CONNECTORS_VALIDATE_FIRST=true npm run wire:production-connectors` validates supplied Slack, Google Drive, and Data Fabric credentials before updating either Container App; Slack must pass channel history reads, Google Drive must pass file listing, Slack/Google webhook tenant/user/channel mappings must be complete, and failed preflight must leave Azure env wiring unchanged.
- `UNWIRE_CONNECTOR_SOURCES=slack,google_drive UNWIRE_CONNECTORS_DRY_RUN=true npm run unwire:production-connectors` previews connector rollback, and without dry-run removes only Container App env bindings while leaving stored secrets intact.
- `npm run wire:production-connectors` can wire Slack, Google Drive, and Data Fabric credentials into both Container Apps once real credentials exist; it does not turn fixture coverage into live coverage by itself.
- Data Fabric live readiness requires `DATA_FABRIC_BASE_URL` and a service that implements `GET /health` and `GET /records?tenantId=&userId=&dataset=&since=&limit=`; the backend-owned mode uses `/v1/data-fabric/health` and `/v1/data-fabric/records` on the unified search API with `DATA_FABRIC_API_TOKEN`.

Current test boundary:

- Without `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_IDS`, Slack testing only proves the shared async ingestion, Postgres vector search, and assistant artifact pipeline using Slack-shaped fixtures.
- Without Google OAuth refresh-token or service-account credentials, Google Drive testing only proves the connector contract and fixture path, not real Drive API access or attachment retrieval.
- Email, conference bridge, and knowledge base are the current live connector tests because they have deployed backing services/storage configured.

Known non-blocking follow-up after the first production test:

- Replace polling with SSE/WebSocket partial-result streaming.
- Add connector-specific deletion/reindex endpoints.
- Add Azure OpenAI provider alias if OpenAI-compatible embedding/chat endpoints are not sufficient.
