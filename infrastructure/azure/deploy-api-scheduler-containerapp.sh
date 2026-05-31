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

if [[ -z "${UNIFIED_SEARCH_API_BASE_URL:-}" || -z "${UNIFIED_SEARCH_AUTH_TOKEN:-}" || -z "${UNIFIED_SEARCH_SYNC_SCHEDULES:-}" ]]; then
  echo "UNIFIED_SEARCH_API_BASE_URL, UNIFIED_SEARCH_AUTH_TOKEN, and UNIFIED_SEARCH_SYNC_SCHEDULES are required" >&2
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
    --args src/apiScheduler.js \
    --output none
fi

az containerapp secret set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --secrets \
    unified-search-auth-token="$UNIFIED_SEARCH_AUTH_TOKEN" \
    sync-schedules="$UNIFIED_SEARCH_SYNC_SCHEDULES" \
  --output none

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
  --args src/apiScheduler.js \
  --set-env-vars \
    UNIFIED_SEARCH_API_BASE_URL="$UNIFIED_SEARCH_API_BASE_URL" \
    UNIFIED_SEARCH_AUTH_TOKEN=secretref:unified-search-auth-token \
    UNIFIED_SEARCH_SYNC_SCHEDULES=secretref:sync-schedules \
  --min-replicas 1 \
  --max-replicas 1 \
  --output none

az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --query "{name:name,latestRevision:properties.latestRevisionName,readyRevision:properties.latestReadyRevisionName,image:properties.template.containers[0].image,replicas:properties.template.scale}" \
  -o json
