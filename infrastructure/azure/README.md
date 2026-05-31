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
```

Repeatable production smoke tests:

```bash
export UNIFIED_SEARCH_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
export UNIFIED_SEARCH_AUTH_TOKEN='<same token wired into Container App>'

UNIFIED_SEARCH_SMOKE_MODE=inline npm run smoke:production
UNIFIED_SEARCH_SMOKE_MODE=async npm run smoke:production
npm run smoke:production:ui
```

If `conference_bridge` readiness is `ready:true`, `smoke:production` also runs
a live Blob transcript reindex/search using
`UNIFIED_SEARCH_SMOKE_CONFERENCE_PREFIX`, defaulting to `smoke/`.

Expected production health:

- `index.backend` is `postgres-pgvector`
- `queue.backend` is `azure-service-bus`
- `artifacts.backend` is `azure-blob-artifact`
- `auth.required` is `true`
