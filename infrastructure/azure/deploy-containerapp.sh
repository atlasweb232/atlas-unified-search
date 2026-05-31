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

az acr build \
  --resource-group "$RESOURCE_GROUP" \
  --registry "$ACR_NAME" \
  --image "${APP_NAME}:${IMAGE_TAG}" \
  .

az acr update --name "$ACR_NAME" --admin-enabled true --output none
ACR_USER="$(az acr credential show --name "$ACR_NAME" --query username -o tsv)"
ACR_PASS="$(az acr credential show --name "$ACR_NAME" --query passwords[0].value -o tsv)"

if az containerapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" >/dev/null 2>&1; then
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
    --set-env-vars \
      PORT=8080 \
      DATA_DIR=/data \
      EMBEDDING_PROVIDER=hash
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
    --env-vars \
      PORT=8080 \
      DATA_DIR=/data \
      EMBEDDING_PROVIDER=hash
fi

az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --query "{name:name,latestRevision:properties.latestRevisionName,fqdn:properties.configuration.ingress.fqdn}" \
  -o json
