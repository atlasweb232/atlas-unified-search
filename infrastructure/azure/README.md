# Azure Deployment

Default target:

- resource group: `atlas-azure-backend-rg`
- ACR: `atlasbackend2ba6c25e`
- Container Apps environment: `atlas-desktop-aca-env`
- app: `atlas-unified-search`

Deploy:

```bash
chmod +x infrastructure/azure/deploy-containerapp.sh
./infrastructure/azure/deploy-containerapp.sh
```

Production mode requires Postgres + pgvector, Service Bus, Blob artifacts, source
credentials, and an API bearer token. Run the database migration before sending
production traffic:

```bash
export POSTGRES_CONNECTION_STRING='<postgres-ssl-connection-string>'
npm run db:migrate
```

Deploy the API with production secret refs by exporting the values locally before
running the script. The script stores these values as Container App secrets and
only wires secret references into the app:

```bash
export UNIFIED_SEARCH_AUTH_TOKEN='<random-shared-api-token>'
export UNIFIED_SEARCH_REQUIRE_AUTH=true
export POSTGRES_CONNECTION_STRING='<postgres-ssl-connection-string>'
export SERVICE_BUS_CONNECTION_STRING='<service-bus-connection-string>'
export SERVICE_BUS_SYNC_QUEUE_NAME='unified-search-sync'
export ARTIFACT_STORAGE_CONNECTION_STRING='<storage-connection-string>'
export ARTIFACT_BLOB_CONTAINER='unified-search-artifacts'
export UNIFIED_SEARCH_SOURCE_TIMEOUT_MS='30000'
export AZURE_STORAGE_CONNECTION_STRING='<storage-connection-string>'
export CONFERENCE_BLOB_CONTAINERS='conference-transcripts'
export KNOWLEDGE_BASE_ROOT='/app/docs'
export DATA_FABRIC_BASE_URL='<data-fabric-service-base-url>'
export DATA_FABRIC_API_TOKEN='<optional-data-fabric-token>'
export DATA_FABRIC_READINESS_PATH='/health'
export DATA_FABRIC_RECORDS_PATH='/records'
export EMBEDDING_PROVIDER='openai'
export OPENAI_API_KEY='<openai-or-azure-openai-compatible-key>'
export CHAT_PROVIDER='openai-compatible' # or azure-openai, anthropic, cerebras
export CHAT_MODEL='gpt-4.1-mini'
export SLACK_BOT_TOKEN='<xoxb-token>'
export GOOGLE_CLIENT_ID='<id>'
export GOOGLE_CLIENT_SECRET='<secret>'
export GOOGLE_REFRESH_TOKEN='<refresh-token>'
export EMAIL_VECTOR_SEARCH_URL='<existing-email-vector-search-url>'
export EMAIL_CONNECTOR_API_TOKEN='<email-backend-token>'
export EMAIL_READINESS_USER_EMAIL='<indexed-test-email-address>'

./infrastructure/azure/deploy-containerapp.sh
```

Deploy the background sync worker from the same image:

```bash
./infrastructure/azure/deploy-worker-containerapp.sh
```

Optional scheduled sync process:

```bash
export UNIFIED_SEARCH_SYNC_SCHEDULES='[
  {
    "name": "atlasweb-email-hourly",
    "source": "email",
    "tenantId": "atlasweb",
    "userId": "rakib.mahmood@tridentinter.io",
    "everySeconds": 3600,
    "runOnStart": false,
    "options": { "limit": 50 }
  },
  {
    "name": "atlasweb-knowledge-nightly",
    "source": "knowledge_base",
    "tenantId": "atlasweb",
    "userId": "shared",
    "everySeconds": 86400,
    "reindex": true
  }
]'
node src/scheduler.js
```

For Azure, prefer the API-backed scheduler unless the scheduler must connect to
Postgres/Service Bus directly. It runs as a separate single-replica Container
App from the same image with command `node src/apiScheduler.js`, checks
connector readiness, then calls the protected API to enqueue `/v1/sync/{source}`
or `/v1/reindex/{source}` work. Keep `minReplicas=1` and `maxReplicas=1` for a
continuously running scheduler so duplicate schedulers do not enqueue the same
sync. The worker can still scale out because actual indexing work is
queue-backed.

Set `UNIFIED_SEARCH_SCHEDULER_REQUIRED=true` only when scheduled sync is a
production gate. Leave it unset for manual-only connector testing.

Deploy the scheduler Container App when schedules are ready:

```bash
export UNIFIED_SEARCH_API_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
export UNIFIED_SEARCH_AUTH_TOKEN='<same token wired into Container App>'
export UNIFIED_SEARCH_SYNC_SCHEDULES='<json schedule array>'
chmod +x infrastructure/azure/deploy-api-scheduler-containerapp.sh
./infrastructure/azure/deploy-api-scheduler-containerapp.sh
```

Use `deploy-scheduler-containerapp.sh` only for the direct-store scheduler path
where the scheduler app is intentionally given Postgres and Service Bus secrets.

```bash
chmod +x infrastructure/azure/deploy-scheduler-containerapp.sh
./infrastructure/azure/deploy-scheduler-containerapp.sh
```

Production verification:

```bash
BASE='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
curl -s "$BASE/v1/health" | jq
curl -i "$BASE/v1/connectors"
curl -s "$BASE/v1/connectors" -H "Authorization: Bearer $UNIFIED_SEARCH_AUTH_TOKEN" | jq
curl -s "$BASE/v1/connectors/readiness" -H "Authorization: Bearer $UNIFIED_SEARCH_AUTH_TOKEN" | jq
curl -s "$BASE/v1/production-readiness" -H "Authorization: Bearer $UNIFIED_SEARCH_AUTH_TOKEN" | jq
```

Config audit without printing secret values:

```bash
export UNIFIED_SEARCH_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
export UNIFIED_SEARCH_AUTH_TOKEN='<same token wired into Container App>'
npm run audit:production-config
```

Wire Slack, Google Drive, or Data Fabric credentials after the apps are already
deployed:

```bash
export RESOURCE_GROUP='atlas-azure-backend-rg'
export APP_NAME='atlas-unified-search'
export WORKER_APP_NAME='atlas-unified-search-worker'

# Slack live connector
export SLACK_BOT_TOKEN='<xoxb-token>'
export SLACK_CHANNEL_IDS='C0123456789,C0987654321'

# Google Drive live connector, choose OAuth refresh token or service account
export GOOGLE_CLIENT_ID='<oauth-client-id>'
export GOOGLE_CLIENT_SECRET='<oauth-client-secret>'
export GOOGLE_REFRESH_TOKEN='<oauth-refresh-token>'
# or:
export GOOGLE_SERVICE_ACCOUNT_JSON='<service-account-json>'
export GDRIVE_FOLDER_IDS='<folder-id-1>,<folder-id-2>'

# Data Fabric live connector
export DATA_FABRIC_BASE_URL='https://<data-fabric-service>'
export DATA_FABRIC_API_TOKEN='<optional-token>'
export DATA_FABRIC_READINESS_PATH='/health'
export DATA_FABRIC_RECORDS_PATH='/records'

# Optional immediate runtime check
export UNIFIED_SEARCH_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
export UNIFIED_SEARCH_AUTH_TOKEN='<same token wired into Container App>'

npm run wire:production-connectors
npm run audit:production-config
```

The wiring command sets Container App secrets and env vars on both the API and
worker without printing secret values. It does not fabricate live coverage:
Slack and Google Drive remain credential-blocked until their readiness entries
return `ready:true` and real `/v1/reindex/{source}` calls succeed.

The audit reports:

- API and worker image/revision/env names
- infrastructure gates
- live connector gates for email, conference bridge, and knowledge base
- credential-blocked gates for Slack and Google Drive
- future connector gates for Data Fabric
- runtime `/v1/production-readiness` summary when token/base URL are provided

Repeatable production smoke tests:

```bash
export UNIFIED_SEARCH_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
export UNIFIED_SEARCH_AUTH_TOKEN='<same token wired into Container App>'
export UNIFIED_SEARCH_SMOKE_JOB_POLL_ATTEMPTS=60

UNIFIED_SEARCH_SMOKE_MODE=inline npm run smoke:production
UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production
npm run smoke:production:ui
```

Important: the Slack section of `smoke:production` is intentionally named a
fixture pipeline check unless Slack readiness is `ready:true`. It verifies the
shared Service Bus/Postgres/search/assistant path with Slack-shaped data; it
does not verify real Slack Web API access without `SLACK_BOT_TOKEN` and
`SLACK_CHANNEL_IDS`. Google Drive is only live-tested after readiness is
`ready:true` and a real `/v1/reindex/google_drive` run succeeds.

When Slack, Google Drive, or Data Fabric readiness is `ready:true`,
`smoke:production` now performs a real reindex and search for that connector.
Use small, known-readable smoke scopes so failures are actionable:

```bash
export UNIFIED_SEARCH_SMOKE_LIVE_LIMIT=5
export UNIFIED_SEARCH_SMOKE_SLACK_CHANNEL_IDS='C0123456789'
export UNIFIED_SEARCH_SMOKE_SLACK_QUERY='known phrase in smoke Slack channel'
export UNIFIED_SEARCH_SMOKE_GDRIVE_FOLDER_IDS='folder-id-with-smoke-doc'
export UNIFIED_SEARCH_SMOKE_GDRIVE_QUERY='known phrase in smoke Drive doc'
export UNIFIED_SEARCH_SMOKE_DATA_FABRIC_DATASET='smoke'
export UNIFIED_SEARCH_SMOKE_DATA_FABRIC_QUERY='known smoke record phrase'
export UNIFIED_SEARCH_SMOKE_EMAIL_USER_ID='indexed-user@example.com'
export UNIFIED_SEARCH_SMOKE_EMAIL_QUERY='known phrase in indexed smoke email'
export UNIFIED_SEARCH_SMOKE_REQUIRE_EMAIL_RESULTS=true
UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production
```

If a live connector is configured but indexes zero documents, the smoke test
fails. That usually means the bot/service account can authenticate but cannot
read the configured channel, folder, or dataset.

Email live smoke always verifies that the federated email source-agent
completes. Set `UNIFIED_SEARCH_SMOKE_REQUIRE_EMAIL_RESULTS=true` when a known
indexed smoke email exists and zero results should fail the run.

If `conference_bridge` readiness is `ready:true`, `smoke:production` also runs
a live Blob transcript reindex/search using
`UNIFIED_SEARCH_SMOKE_CONFERENCE_PREFIX`, defaulting to `smoke/`.

Data Fabric live connector contract:

- `GET $DATA_FABRIC_BASE_URL$DATA_FABRIC_READINESS_PATH` returns JSON with
  optional `{ "ready": true, "service": "...", "version": "..." }`.
- `GET $DATA_FABRIC_BASE_URL$DATA_FABRIC_RECORDS_PATH?tenantId=&userId=&dataset=&since=&limit=`
  returns `{ "records": [...] }`, `{ "items": [...] }`, or
  `{ "data": { "records": [...] } }`.
- Records are normalized from fields like `id`, `title`, `text`, `record`,
  `owner`, `timestamp`, and `dataset`.

Expected production health:

- `index.backend` is `postgres-pgvector`
- `queue.backend` is `azure-service-bus`
- `artifacts.backend` is `azure-blob-artifact`
- `auth.required` is `true`
