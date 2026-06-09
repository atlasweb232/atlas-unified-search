#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-atlas-azure-backend-rg}"
LOCATION="${LOCATION:-eastus}"
ACR_NAME="${ACR_NAME:-atlasbackend2ba6c25e}"
CONTAINER_ENV="${CONTAINER_ENV:-atlas-desktop-aca-env}"
APP_NAME="${APP_NAME:-atlas-unified-search}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d%H%M%S)}"
IMAGE="${ACR_NAME}.azurecr.io/${APP_NAME}:${IMAGE_TAG}"
ACR_SERVER="${ACR_NAME}.azurecr.io"
ENV_VARS=(
  PORT=8080
  DATA_DIR=/data
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
      --output none || true
    ENV_VARS+=("$env_name=secretref:$secret_name")
  fi
}

collect_production_env() {
  append_secret_env "UNIFIED_SEARCH_AUTH_TOKEN" "unified-search-auth-token"
  append_secret_env "POSTGRES_CONNECTION_STRING" "unified-search-postgres"
  append_secret_env "SERVICE_BUS_CONNECTION_STRING" "unified-search-servicebus"
  append_secret_env "OPENAI_API_KEY" "openai-api-key"
  append_secret_env "SLACK_BOT_TOKEN" "slack-bot-token"
  append_secret_env "CONNECTOR_CREDENTIAL_ENCRYPTION_KEY" "connector-credential-encryption-key"
  append_secret_env "GOOGLE_CLIENT_ID" "google-client-id"
  append_secret_env "GOOGLE_CLIENT_SECRET" "google-client-secret"
  append_secret_env "GOOGLE_REFRESH_TOKEN" "google-refresh-token"
  append_secret_env "GOOGLE_SERVICE_ACCOUNT_JSON" "google-service-account-json"
  append_secret_env "EMAIL_CONNECTOR_API_TOKEN" "email-connector-api-token"
  append_secret_env "ARTIFACT_STORAGE_CONNECTION_STRING" "unified-search-artifact-storage"
  append_secret_env "AZURE_STORAGE_CONNECTION_STRING" "unified-search-azure-storage"
  append_secret_env "DATA_FABRIC_API_TOKEN" "data-fabric-api-token"
  [[ -n "${SERVICE_BUS_SYNC_QUEUE_NAME:-}" ]] && ENV_VARS+=("SERVICE_BUS_SYNC_QUEUE_NAME=$SERVICE_BUS_SYNC_QUEUE_NAME")
  [[ -n "${SLACK_CHANNEL_IDS:-}" ]] && ENV_VARS+=("SLACK_CHANNEL_IDS=$SLACK_CHANNEL_IDS")
  [[ -n "${GDRIVE_FOLDER_IDS:-}" ]] && ENV_VARS+=("GDRIVE_FOLDER_IDS=$GDRIVE_FOLDER_IDS")
  [[ -n "${EMAIL_VECTOR_SEARCH_URL:-}" ]] && ENV_VARS+=("EMAIL_VECTOR_SEARCH_URL=$EMAIL_VECTOR_SEARCH_URL")
  [[ -n "${EMAIL_READINESS_USER_EMAIL:-}" ]] && ENV_VARS+=("EMAIL_READINESS_USER_EMAIL=$EMAIL_READINESS_USER_EMAIL")
  [[ -n "${ARTIFACT_BLOB_CONTAINER:-}" ]] && ENV_VARS+=("ARTIFACT_BLOB_CONTAINER=$ARTIFACT_BLOB_CONTAINER")
  [[ -n "${CONFERENCE_BLOB_CONTAINERS:-}" ]] && ENV_VARS+=("CONFERENCE_BLOB_CONTAINERS=$CONFERENCE_BLOB_CONTAINERS")
  [[ -n "${KNOWLEDGE_BASE_ROOT:-}" ]] && ENV_VARS+=("KNOWLEDGE_BASE_ROOT=$KNOWLEDGE_BASE_ROOT")
  [[ -n "${DATA_FABRIC_BASE_URL:-}" ]] && ENV_VARS+=("DATA_FABRIC_BASE_URL=$DATA_FABRIC_BASE_URL")
  [[ -n "${DATA_FABRIC_READINESS_PATH:-}" ]] && ENV_VARS+=("DATA_FABRIC_READINESS_PATH=$DATA_FABRIC_READINESS_PATH")
  [[ -n "${DATA_FABRIC_RECORDS_PATH:-}" ]] && ENV_VARS+=("DATA_FABRIC_RECORDS_PATH=$DATA_FABRIC_RECORDS_PATH")
  [[ -n "${UNIFIED_SEARCH_REQUIRE_AUTH:-}" ]] && ENV_VARS+=("UNIFIED_SEARCH_REQUIRE_AUTH=$UNIFIED_SEARCH_REQUIRE_AUTH")
  [[ -n "${UNIFIED_SEARCH_SOURCE_PERMISSIONS:-}" ]] && ENV_VARS+=("UNIFIED_SEARCH_SOURCE_PERMISSIONS=$UNIFIED_SEARCH_SOURCE_PERMISSIONS")
}

az acr build \
  --resource-group "$RESOURCE_GROUP" \
  --registry "$ACR_NAME" \
  --image "${APP_NAME}:${IMAGE_TAG}" \
  .

az acr update --name "$ACR_NAME" --admin-enabled true --output none
ACR_USER="$(az acr credential show --name "$ACR_NAME" --query username -o tsv)"
ACR_PASS="$(az acr credential show --name "$ACR_NAME" --query passwords[0].value -o tsv)"

if az containerapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" >/dev/null 2>&1; then
  collect_production_env
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
    --set-env-vars "${ENV_VARS[@]}"
else
  az containerapp create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$APP_NAME" \
    --environment "$CONTAINER_ENV" \
    --image "$IMAGE" \
    --target-port 8080 \
    --ingress external \
    --min-replicas 1 \
    --max-replicas 3 \
    --registry-server "$ACR_SERVER" \
    --registry-username "$ACR_USER" \
    --registry-password "$ACR_PASS" \
    --env-vars "${ENV_VARS[@]}"
  collect_production_env
  az containerapp update \
    --resource-group "$RESOURCE_GROUP" \
    --name "$APP_NAME" \
    --set-env-vars "${ENV_VARS[@]}" \
    --output none
fi

az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --query "{name:name,latestRevision:properties.latestRevisionName,fqdn:properties.configuration.ingress.fqdn}" \
  -o json
