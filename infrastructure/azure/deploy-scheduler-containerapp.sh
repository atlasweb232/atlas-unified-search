#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-atlas-azure-backend-rg}"
CONTAINER_ENV="${CONTAINER_ENV:-atlas-desktop-aca-env}"
ACR_NAME="${ACR_NAME:-atlasbackend2ba6c25e}"
APP_NAME="${SCHEDULER_APP_NAME:-atlas-unified-search-scheduler}"
API_APP_NAME="${API_APP_NAME:-atlas-unified-search}"
ACR_SERVER="${ACR_NAME}.azurecr.io"

if [[ -n "${IMAGE_TAG:-}" ]]; then
  IMAGE="${ACR_NAME}.azurecr.io/${API_APP_NAME}:${IMAGE_TAG}"
else
  IMAGE="$(az containerapp show --resource-group "$RESOURCE_GROUP" --name "$API_APP_NAME" --query 'properties.template.containers[0].image' -o tsv)"
fi

if [[ -z "${POSTGRES_CONNECTION_STRING:-}" || -z "${SERVICE_BUS_CONNECTION_STRING:-}" || -z "${UNIFIED_SEARCH_SYNC_SCHEDULES:-}" ]]; then
  echo "POSTGRES_CONNECTION_STRING, SERVICE_BUS_CONNECTION_STRING, and UNIFIED_SEARCH_SYNC_SCHEDULES are required for the scheduler" >&2
  exit 1
fi

az acr update --name "$ACR_NAME" --admin-enabled true --output none
ACR_USER="$(az acr credential show --name "$ACR_NAME" --query username -o tsv)"
ACR_PASS="$(az acr credential show --name "$ACR_NAME" --query passwords[0].value -o tsv)"

if ! az containerapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" >/dev/null 2>&1; then
  az containerapp create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$APP_NAME" \
    --environment "$CONTAINER_ENV" \
    --image "$IMAGE" \
    --min-replicas 1 \
    --max-replicas 1 \
    --registry-server "$ACR_SERVER" \
    --registry-username "$ACR_USER" \
    --registry-password "$ACR_PASS" \
    --command node \
    --args src/scheduler.js \
    --env-vars EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-hash}" \
    --output none
fi

az containerapp secret set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --secrets \
    unified-search-postgres="$POSTGRES_CONNECTION_STRING" \
    unified-search-servicebus="$SERVICE_BUS_CONNECTION_STRING" \
    sync-schedules="$UNIFIED_SEARCH_SYNC_SCHEDULES" \
    openai-api-key="${OPENAI_API_KEY:-unused}" \
    artifact-storage="${ARTIFACT_STORAGE_CONNECTION_STRING:-unused}" \
  --output none

ENV_VARS=(
  POSTGRES_CONNECTION_STRING=secretref:unified-search-postgres
  SERVICE_BUS_CONNECTION_STRING=secretref:unified-search-servicebus
  UNIFIED_SEARCH_SYNC_SCHEDULES=secretref:sync-schedules
  OPENAI_API_KEY=secretref:openai-api-key
  ARTIFACT_STORAGE_CONNECTION_STRING=secretref:artifact-storage
  SERVICE_BUS_SYNC_QUEUE_NAME="${SERVICE_BUS_SYNC_QUEUE_NAME:-unified-search-sync}"
  EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-hash}"
)

append_secret_env() {
  local env_name="$1"
  local secret_name="$2"
  if [[ -n "${!env_name:-}" ]]; then
    az containerapp secret set \
      --resource-group "$RESOURCE_GROUP" \
      --name "$APP_NAME" \
      --secrets "$secret_name=${!env_name}" \
      --output none
    ENV_VARS+=("$env_name=secretref:$secret_name")
  fi
}

append_value_env() {
  local env_name="$1"
  if [[ -n "${!env_name:-}" ]]; then
    ENV_VARS+=("$env_name=${!env_name}")
  fi
}

append_secret_env "SLACK_BOT_TOKEN" "slack-bot-token"
append_secret_env "GOOGLE_CLIENT_ID" "google-client-id"
append_secret_env "GOOGLE_CLIENT_SECRET" "google-client-secret"
append_secret_env "GOOGLE_REFRESH_TOKEN" "google-refresh-token"
append_secret_env "GOOGLE_SERVICE_ACCOUNT_JSON" "google-service-account-json"
append_secret_env "EMAIL_CONNECTOR_API_TOKEN" "email-connector-api-token"
append_secret_env "AZURE_STORAGE_CONNECTION_STRING" "azure-storage"
append_secret_env "DATA_FABRIC_API_TOKEN" "data-fabric-api-token"
append_value_env "SLACK_CHANNEL_IDS"
append_value_env "GDRIVE_FOLDER_IDS"
append_value_env "EMAIL_VECTOR_SEARCH_URL"
append_value_env "EMAIL_READINESS_USER_EMAIL"
append_value_env "CONFERENCE_BLOB_CONTAINERS"
append_value_env "KNOWLEDGE_BASE_ROOT"
append_value_env "DATA_FABRIC_BASE_URL"
append_value_env "DATA_FABRIC_READINESS_PATH"
append_value_env "DATA_FABRIC_RECORDS_PATH"

az containerapp registry set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --server "$ACR_SERVER" \
  --username "$ACR_USER" \
  --password "$ACR_PASS" \
  --output none

az containerapp update \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --image "$IMAGE" \
  --command node \
  --args src/scheduler.js \
  --set-env-vars "${ENV_VARS[@]}" \
  --min-replicas 1 \
  --max-replicas 1 \
  --output none

az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --query "{name:name,latestRevision:properties.latestRevisionName,image:properties.template.containers[0].image,replicas:properties.template.scale}" \
  -o json
