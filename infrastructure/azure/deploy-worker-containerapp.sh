#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-atlas-azure-backend-rg}"
CONTAINER_ENV="${CONTAINER_ENV:-atlas-desktop-aca-env}"
ACR_NAME="${ACR_NAME:-atlasbackend2ba6c25e}"
APP_NAME="${WORKER_APP_NAME:-atlas-unified-search-worker}"
API_APP_NAME="${API_APP_NAME:-atlas-unified-search}"
ACR_SERVER="${ACR_NAME}.azurecr.io"
if [[ -n "${IMAGE_TAG:-}" ]]; then
  IMAGE="${ACR_NAME}.azurecr.io/${API_APP_NAME}:${IMAGE_TAG}"
else
  IMAGE="$(az containerapp show --resource-group "$RESOURCE_GROUP" --name "$API_APP_NAME" --query 'properties.template.containers[0].image' -o tsv)"
fi

if [[ -z "${POSTGRES_CONNECTION_STRING:-}" || -z "${SERVICE_BUS_CONNECTION_STRING:-}" ]]; then
  echo "POSTGRES_CONNECTION_STRING and SERVICE_BUS_CONNECTION_STRING are required for the worker" >&2
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
    --max-replicas 5 \
    --registry-server "$ACR_SERVER" \
    --registry-username "$ACR_USER" \
    --registry-password "$ACR_PASS" \
    --command node \
    --args src/worker.js \
    --env-vars \
      EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-hash}" \
      SERVICE_BUS_SYNC_QUEUE_NAME="${SERVICE_BUS_SYNC_QUEUE_NAME:-unified-search-sync}"
fi

az containerapp secret set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --secrets \
    unified-search-postgres="$POSTGRES_CONNECTION_STRING" \
    unified-search-servicebus="$SERVICE_BUS_CONNECTION_STRING" \
    openai-api-key="${OPENAI_API_KEY:-unused}" \
    slack-bot-token="${SLACK_BOT_TOKEN:-unused}" \
    google-client-id="${GOOGLE_CLIENT_ID:-unused}" \
    google-client-secret="${GOOGLE_CLIENT_SECRET:-unused}" \
    google-refresh-token="${GOOGLE_REFRESH_TOKEN:-unused}" \
    artifact-storage="${ARTIFACT_STORAGE_CONNECTION_STRING:-unused}" \
  --output none

az containerapp update \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --image "$IMAGE" \
  --command node \
  --args src/worker.js \
  --set-env-vars \
    POSTGRES_CONNECTION_STRING=secretref:unified-search-postgres \
    SERVICE_BUS_CONNECTION_STRING=secretref:unified-search-servicebus \
    OPENAI_API_KEY=secretref:openai-api-key \
    SLACK_BOT_TOKEN=secretref:slack-bot-token \
    GOOGLE_CLIENT_ID=secretref:google-client-id \
    GOOGLE_CLIENT_SECRET=secretref:google-client-secret \
    GOOGLE_REFRESH_TOKEN=secretref:google-refresh-token \
    ARTIFACT_STORAGE_CONNECTION_STRING=secretref:artifact-storage \
    SERVICE_BUS_SYNC_QUEUE_NAME="${SERVICE_BUS_SYNC_QUEUE_NAME:-unified-search-sync}" \
    EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-hash}" \
  --output none

az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --query "{name:name,latestRevision:properties.latestRevisionName,image:properties.template.containers[0].image}" \
  -o json
