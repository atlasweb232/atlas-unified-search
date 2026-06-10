#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-atlas-azure-backend-rg}"
ACR_NAME="${ACR_NAME:-atlasbackend2ba6c25e}"
CONTAINER_ENV="${CONTAINER_ENV:-atlas-desktop-aca-env}"
APP_NAME="${APP_NAME:-atlas-bge-embedding}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"
IMAGE="${ACR_NAME}.azurecr.io/${APP_NAME}:${IMAGE_TAG}"
EMBEDDING_API_KEY="${EMBEDDING_API_KEY:-}"

if az containerapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" >/dev/null 2>&1; then
  APP_EXISTS=true
  if [[ -z "$EMBEDDING_API_KEY" ]]; then
    EMBEDDING_API_KEY="$(az containerapp secret list \
      --resource-group "$RESOURCE_GROUP" \
      --name "$APP_NAME" \
      --show-values \
      --query "[?name=='embedding-api-key'].value | [0]" \
      -o tsv)"
  fi
else
  APP_EXISTS=false
fi
EMBEDDING_API_KEY="${EMBEDDING_API_KEY:-$(openssl rand -hex 32)}"

az acr build \
  --resource-group "$RESOURCE_GROUP" \
  --registry "$ACR_NAME" \
  --file services/bge-embedding/Dockerfile \
  --image "${APP_NAME}:${IMAGE_TAG}" \
  .

az acr update --name "$ACR_NAME" --admin-enabled true --output none
ACR_USER="$(az acr credential show --name "$ACR_NAME" --query username -o tsv)"
ACR_PASS="$(az acr credential show --name "$ACR_NAME" --query passwords[0].value -o tsv)"

if [[ "$APP_EXISTS" == true ]]; then
  az containerapp secret set \
    --resource-group "$RESOURCE_GROUP" \
    --name "$APP_NAME" \
    --secrets "embedding-api-key=$EMBEDDING_API_KEY" \
    --output none
  az containerapp update \
    --resource-group "$RESOURCE_GROUP" \
    --name "$APP_NAME" \
    --image "$IMAGE" \
    --cpu 2 \
    --memory 4Gi \
    --min-replicas 1 \
    --max-replicas 2 \
    --set-env-vars \
      BGE_MODEL_NAME=BAAI/bge-base-en-v1.5 \
      EMBEDDING_API_KEY=secretref:embedding-api-key \
    --output none
else
  az containerapp create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$APP_NAME" \
    --environment "$CONTAINER_ENV" \
    --image "$IMAGE" \
    --target-port 8080 \
    --ingress internal \
    --transport http \
    --cpu 2 \
    --memory 4Gi \
    --min-replicas 1 \
    --max-replicas 2 \
    --registry-server "${ACR_NAME}.azurecr.io" \
    --registry-username "$ACR_USER" \
    --registry-password "$ACR_PASS" \
    --secrets "embedding-api-key=$EMBEDDING_API_KEY" \
    --env-vars \
      BGE_MODEL_NAME=BAAI/bge-base-en-v1.5 \
      EMBEDDING_API_KEY=secretref:embedding-api-key \
    --output none
fi

az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --query "{name:name,revision:properties.latestRevisionName,fqdn:properties.configuration.ingress.fqdn,external:properties.configuration.ingress.external}" \
  -o json
