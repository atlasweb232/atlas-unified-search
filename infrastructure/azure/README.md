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
