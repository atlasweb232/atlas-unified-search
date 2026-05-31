# Production Readiness Checklist

The unified search service is production-testable when these gates are true:

- API Container App is deployed from this repo and `/v1/health` is public.
- `UNIFIED_SEARCH_AUTH_TOKEN` is configured and protected API routes reject unauthenticated requests.
- Postgres flexible server has `pgvector` installed and `npm run db:migrate` has completed.
- `/v1/health` reports `index.backend=postgres-pgvector`.
- Service Bus queue `unified-search-sync` exists and the worker Container App is running.
- `/v1/health` reports `queue.backend=azure-service-bus`.
- Artifact Blob container exists and assistant artifacts are stored there.
- `/v1/health` reports `artifacts.backend=azure-blob-artifact`.
- Slack app is installed in the workspace with bot scopes listed in `docs/slack-gdrive-onboarding.md`.
- Google OAuth consent and refresh token are configured for Drive read access.
- Email results use `EMAIL_VECTOR_SEARCH_URL` to federate against the existing Atlas email vector service.
- Tenant/user IDs are supplied on every sync, search, search-run, document, and assistant action request.
- Cross-tenant reads are rejected by API tests and manual smoke tests.
- Scoped deletion and `/v1/reindex/{source}` are available for tenant/user/source resets without deleting other users' data.
- Slack and Google Drive syncs persist tenant/user-scoped checkpoints; use `forceFullSync` or `/v1/reindex/{source}` to intentionally rescan.
- Optional `UNIFIED_SEARCH_SOURCE_PERMISSIONS` can restrict usable sources per `tenantId:userId`.
- `npm run smoke:production` passes with `UNIFIED_SEARCH_SMOKE_MODE=inline`.
- `npm run smoke:production` passes with `UNIFIED_SEARCH_SMOKE_MODE=async`, proving Service Bus worker ownership.
- `GET /v1/connectors/readiness` returns explicit `ready/status/requirements` for each connector without exposing secret values.

Known non-blocking follow-up after the first production test:

- Replace polling with SSE/WebSocket partial-result streaming.
- Add connector-specific deletion/reindex endpoints.
- Add Azure OpenAI provider alias if OpenAI-compatible embedding/chat endpoints are not sufficient.
