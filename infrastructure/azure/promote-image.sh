#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-atlas-azure-backend-rg}"
ACR_NAME="${ACR_NAME:-atlasbackend2ba6c25e}"
API_APP_NAME="${API_APP_NAME:-atlas-unified-search}"
WORKER_APP_NAME="${WORKER_APP_NAME:-atlas-unified-search-worker}"
SCHEDULER_APP_NAME="${SCHEDULER_APP_NAME:-atlas-unified-search-scheduler}"
RETENTION_SCHEDULER_APP_NAME="${RETENTION_SCHEDULER_APP_NAME:-atlas-search-retention-sched}"
PROMOTE_API="${PROMOTE_API:-true}"
PROMOTE_WORKER="${PROMOTE_WORKER:-true}"
PROMOTE_SCHEDULER="${PROMOTE_SCHEDULER:-false}"
PROMOTE_RETENTION_SCHEDULER="${PROMOTE_RETENTION_SCHEDULER:-false}"
DRY_RUN="${DRY_RUN:-false}"
WAIT_ATTEMPTS="${WAIT_ATTEMPTS:-36}"
WAIT_SECONDS="${WAIT_SECONDS:-5}"

if [[ -n "${IMAGE:-}" ]]; then
  TARGET_IMAGE="$IMAGE"
elif [[ -n "${IMAGE_TAG:-}" ]]; then
  TARGET_IMAGE="${ACR_NAME}.azurecr.io/${API_APP_NAME}:${IMAGE_TAG}"
else
  echo "Set IMAGE or IMAGE_TAG before promoting." >&2
  exit 1
fi

show_plan() {
  cat <<EOF
Promote image without changing existing Container App env vars/secrets:
  resource group: $RESOURCE_GROUP
  image:          $TARGET_IMAGE
  api:            $PROMOTE_API ($API_APP_NAME)
  worker:         $PROMOTE_WORKER ($WORKER_APP_NAME)
  scheduler:      $PROMOTE_SCHEDULER ($SCHEDULER_APP_NAME)
  retention sched:$PROMOTE_RETENTION_SCHEDULER ($RETENTION_SCHEDULER_APP_NAME)
  dry run:        $DRY_RUN
EOF
}

env_fingerprint() {
  local app_name="$1"
  az containerapp show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$app_name" \
    --query "join('|', sort(properties.template.containers[0].env[].join(':', [name, secretRef || 'value'])))" \
    -o tsv
}

update_app_image() {
  local app_name="$1"
  shift
  local before after latest ready
  before="$(env_fingerprint "$app_name")"
  echo "Promoting $app_name"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "DRY_RUN: az containerapp update --resource-group $RESOURCE_GROUP --name $app_name --image $TARGET_IMAGE $*"
    return
  fi
  az containerapp update \
    --resource-group "$RESOURCE_GROUP" \
    --name "$app_name" \
    --image "$TARGET_IMAGE" \
    "$@" \
    --output none
  after="$(env_fingerprint "$app_name")"
  if [[ "$before" != "$after" ]]; then
    echo "Env/secret binding fingerprint changed while promoting $app_name; inspect Azure state before proceeding." >&2
    exit 1
  fi
  for attempt in $(seq 1 "$WAIT_ATTEMPTS"); do
    latest="$(az containerapp show --resource-group "$RESOURCE_GROUP" --name "$app_name" --query 'properties.latestRevisionName' -o tsv)"
    ready="$(az containerapp show --resource-group "$RESOURCE_GROUP" --name "$app_name" --query 'properties.latestReadyRevisionName' -o tsv)"
    echo "$app_name readiness attempt=$attempt latest=$latest ready=$ready"
    if [[ "$latest" == "$ready" ]]; then
      return
    fi
    sleep "$WAIT_SECONDS"
  done
  echo "$app_name did not report latest revision ready in time." >&2
  exit 1
}

show_summary() {
  local app_name="$1"
  az containerapp show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$app_name" \
    --query "{name:name,latest:properties.latestRevisionName,ready:properties.latestReadyRevisionName,image:properties.template.containers[0].image,running:properties.runningStatus}" \
    -o json
}

show_plan

if [[ "$PROMOTE_API" == "true" ]]; then
  update_app_image "$API_APP_NAME"
fi

if [[ "$PROMOTE_WORKER" == "true" ]]; then
  update_app_image "$WORKER_APP_NAME" --command node --args src/worker.js
fi

if [[ "$PROMOTE_SCHEDULER" == "true" ]]; then
  update_app_image "$SCHEDULER_APP_NAME" --command node --args src/apiScheduler.js
fi

if [[ "$PROMOTE_RETENTION_SCHEDULER" == "true" ]]; then
  update_app_image "$RETENTION_SCHEDULER_APP_NAME" --command node --args src/apiScheduler.js
fi

if [[ "$DRY_RUN" != "true" ]]; then
  if [[ "$PROMOTE_API" == "true" ]]; then
    show_summary "$API_APP_NAME"
  fi
  if [[ "$PROMOTE_WORKER" == "true" ]]; then
    show_summary "$WORKER_APP_NAME"
  fi
  if [[ "$PROMOTE_SCHEDULER" == "true" ]]; then
    show_summary "$SCHEDULER_APP_NAME"
  fi
  if [[ "$PROMOTE_RETENTION_SCHEDULER" == "true" ]]; then
    show_summary "$RETENTION_SCHEDULER_APP_NAME"
  fi
fi
