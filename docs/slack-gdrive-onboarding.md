# Slack And Google Drive Onboarding

This is the current production-facing setup path before WorkOS/Nango is added.
All credentials stay backend-side.

## Slack Personal Bot Setup

1. Create a Slack app at `https://api.slack.com/apps`.
   To avoid hand-entering scopes and webhook URLs, generate the app manifest
   from the deployed backend URL:

```bash
export UNIFIED_SEARCH_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
npm run slack:app-manifest
```

   Paste the `manifest` object into Slack's "Create from an app manifest" flow.
2. Add bot token scopes:
   - `channels:read`
   - `channels:history`
   - `groups:read`
   - `groups:history`
   - `im:history`
   - `mpim:history`
   - `users:read`
   - `files:read`
3. Install the app into your workspace.
4. Invite the bot to private channels that must be indexed.
5. Copy the bot token into backend secret storage as `SLACK_BOT_TOKEN`.
6. Configure channel IDs:

```bash
SLACK_CHANNEL_IDS=C0123456789,C9876543210
```

If you do not know the channel IDs yet, list channels visible to the bot:

```bash
export SLACK_BOT_TOKEN='xoxb-...'
npm run slack:list-channels
```

By default the helper lists public and private channels where the bot is a
member. Use `SLACK_CHANNEL_LIST_UNJOINED=true` only for inventory; validation
and sync still require bot membership for private channels.

7. For near-real-time Slack Events API ingestion, copy the app signing secret
   into backend secret storage as `SLACK_SIGNING_SECRET`, set the Slack Events
   request URL to
   `https://<unified-search-host>/v1/webhooks/slack/events`, and configure the
   tenant/user scope that events feed:

```bash
SLACK_EVENT_TENANT_ID=atlasweb
SLACK_EVENT_USER_ID=rakib.mahmood@tridentinter.io
```

8. Validate credentials before wiring them into Azure:

```bash
export VALIDATE_CONNECTOR_SOURCES='slack'
export VALIDATE_CONNECTOR_REQUIRE_CONFIG=true
npm run validate:connector-credentials
```

The validator calls Slack `auth.test`, `conversations.info`, and a one-message
`conversations.history` probe for configured channels. It does not print token
values.

9. Wire credentials into the Azure API and worker apps:

```bash
export RESOURCE_GROUP='atlas-azure-backend-rg'
export APP_NAME='atlas-unified-search'
export WORKER_APP_NAME='atlas-unified-search-worker'
export UNIFIED_SEARCH_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
export UNIFIED_SEARCH_AUTH_TOKEN='<same token wired into the API app>'
npm run wire:production-connectors
```

For production testing, prefer strict preflight wiring:

```bash
export WIRE_CONNECTORS_VALIDATE_FIRST=true
export WIRE_CONNECTORS_DRY_RUN=true
npm run wire:production-connectors

unset WIRE_CONNECTORS_DRY_RUN
npm run wire:production-connectors
```

Strict preflight validates the connector from the local environment before
touching Azure Container Apps. It fails closed if Slack channel access, Google
Drive auth, provider webhook mappings, or Data Fabric readiness cannot be
proven. The failure report includes missing env names and provider error
messages, but does not print secret values. For Slack, preflight also calls
`conversations.history` on the configured channels so an installed app without
channel membership is rejected before Azure is updated. Dry-run mode prints the
redacted Azure changes that would be applied without updating either Container
App.

10. Start a live sync:

```bash
curl -X POST "$UNIFIED_SEARCH_BASE_URL/v1/reindex/slack" \
  -H "Authorization: Bearer $UNIFIED_SEARCH_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"atlasweb","userId":"rakib","wait":true}'
```

Subsequent Slack syncs resume from the last stored channel timestamp for the
same tenant/user/channel. To intentionally rebuild a source, call
`/v1/reindex/slack` or pass `options.forceFullSync=true`.

If Slack credentials fail after wiring, remove only the runtime env bindings and
leave stored secrets intact for later inspection or replacement:

```bash
export UNWIRE_CONNECTOR_SOURCES=slack
export UNWIRE_CONNECTORS_DRY_RUN=true
npm run unwire:production-connectors

unset UNWIRE_CONNECTORS_DRY_RUN
npm run unwire:production-connectors
```

Production note: connectors now read credentials through a backend
`ConnectorTokenProvider`. Direct `.env` values remain the fallback for personal
testing, and `UNIFIED_SEARCH_CONNECTOR_TOKENS_JSON` can provide tenant/user
scoped credentials without changing connector code. WorkOS Pipes, Nango, or
Key Vault-backed onboarding should plug into this provider boundary rather than
adding source-specific token logic to Slack or Google Drive connectors.

Scoped token JSON shape:

```json
{
  "atlasweb:rakib.mahmood@tridentinter.io": {
    "slack": {
      "SLACK_BOT_TOKEN": "xoxb-...",
      "SLACK_CHANNEL_IDS": "C0123456789,C9876543210"
    },
    "google_drive": {
      "GOOGLE_CLIENT_ID": "...",
      "GOOGLE_CLIENT_SECRET": "...",
      "GOOGLE_REFRESH_TOKEN": "...",
      "GDRIVE_FOLDER_IDS": "folder-id-1,folder-id-2"
    }
  }
}
```

Use `tenant:*`, `*:user`, or `*:*` entries only when intentionally sharing a
connector credential across scopes.

## Google Drive Setup

For personal testing, use OAuth refresh token auth.

1. Create a Google Cloud project.
2. Enable Google Drive API.
3. Create OAuth credentials. For personal testing, create an OAuth client that
   allows this loopback redirect URI:

```text
http://127.0.0.1:53682/oauth2callback
```

   Override it with `GOOGLE_REDIRECT_URI` if you choose a different local port
   or callback path.
4. Authorize scopes:
   - `https://www.googleapis.com/auth/drive.readonly`
5. Store these backend-side:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GDRIVE_FOLDER_IDS=<optional comma-separated folder ids>
```

For multi-user onboarding, the same values can be supplied in
`UNIFIED_SEARCH_CONNECTOR_TOKENS_JSON` under the tenant/user scope instead of as
global env vars. Scoped values override global env fallbacks for sync,
readiness, and scheduler checks.

Generate the authorization URL:

```bash
export GOOGLE_CLIENT_ID='...'
export GOOGLE_CLIENT_SECRET='...'
npm run gdrive:create-refresh-token
```

Open the returned `authorizationUrl`, approve Drive read access, then exchange
the `code` query parameter from the redirect URL:

```bash
export GOOGLE_AUTH_CODE='<code returned by Google>'
export GOOGLE_OAUTH_PRINT_SECRET=true
npm run gdrive:create-refresh-token
```

If the browser is on the same machine running the helper, it can capture the
callback automatically:

```bash
export GOOGLE_OAUTH_WAIT_FOR_CALLBACK=true
export GOOGLE_OAUTH_PRINT_SECRET=true
npm run gdrive:create-refresh-token
```

Use `GOOGLE_OAUTH_PRINT_SECRET=true` only on a trusted terminal. Without it, the
helper proves that a refresh token was returned but redacts the token value.

6. For near-real-time Google Drive push notifications, create a watch channel
   with an unguessable token and set the webhook URL to
   `https://<unified-search-host>/v1/webhooks/google-drive/changes`. Store the
   channel token and tenant/user mapping backend-side:

```bash
GDRIVE_WEBHOOK_TOKEN=<unguessable channel token>
GDRIVE_WEBHOOK_CHANNEL_IDS=<comma-separated channel ids returned by npm run gdrive:create-watch>
GDRIVE_EVENT_TENANT_ID=atlasweb
GDRIVE_EVENT_USER_ID=rakib.mahmood@tridentinter.io
```

Google Drive push notifications do not include an HMAC signature. The endpoint
therefore requires `X-Goog-Channel-Token` to match `GDRIVE_WEBHOOK_TOKEN` and
`X-Goog-Channel-ID` to be present in `GDRIVE_WEBHOOK_CHANNEL_IDS`.

After Google credentials and the webhook token are present locally, create the
Drive watch channel:

```bash
export UNIFIED_SEARCH_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
export GDRIVE_WEBHOOK_TOKEN='<unguessable channel token>'
export GDRIVE_EVENT_TENANT_ID=atlasweb
export GDRIVE_EVENT_USER_ID=rakib.mahmood@tridentinter.io
npm run gdrive:create-watch
```

The helper calls `changes.getStartPageToken` and `changes.watch`, does not print
Google OAuth secrets, and returns the channel ID that should be wired as
`wireEnv.GDRIVE_WEBHOOK_CHANNEL_IDS`. Use `GDRIVE_WATCH_DRY_RUN=true` to
validate the local command shape without calling Google. The response also
includes `optionalPersistence.GDRIVE_WATCH_RESOURCE_ID`,
`optionalPersistence.GDRIVE_WATCH_START_PAGE_TOKEN`, and the channel expiration
timestamp for audit/renewal tracking.

Wire the watch metadata as ordinary env values when promoting the connector:

```bash
export GDRIVE_WEBHOOK_CHANNEL_IDS='<wireEnv.GDRIVE_WEBHOOK_CHANNEL_IDS>'
export GDRIVE_WATCH_RESOURCE_ID='<optionalPersistence.GDRIVE_WATCH_RESOURCE_ID>'
export GDRIVE_WATCH_START_PAGE_TOKEN='<optionalPersistence.GDRIVE_WATCH_START_PAGE_TOKEN>'
export GDRIVE_WATCH_EXPIRATION='<optionalPersistence.GDRIVE_WATCH_EXPIRATION>'
```

`npm run audit:production-config` reports whether the watch metadata is present
and whether the channel should be renewed within 24 hours.

7. Validate credentials before wiring them into Azure:

```bash
export VALIDATE_CONNECTOR_SOURCES='google_drive'
export VALIDATE_CONNECTOR_REQUIRE_CONFIG=true
npm run validate:connector-credentials
```

The validator performs Drive auth and a one-file `files.list` probe. It reports
whether the configured folder scope can see at least one file, without printing
OAuth or service-account secret values.

8. Wire credentials into the Azure API and worker apps:

```bash
export RESOURCE_GROUP='atlas-azure-backend-rg'
export APP_NAME='atlas-unified-search'
export WORKER_APP_NAME='atlas-unified-search-worker'
export UNIFIED_SEARCH_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
export UNIFIED_SEARCH_AUTH_TOKEN='<same token wired into the API app>'
npm run wire:production-connectors
```

For production testing, prefer strict preflight wiring:

```bash
export WIRE_CONNECTORS_VALIDATE_FIRST=true
export WIRE_CONNECTORS_DRY_RUN=true
npm run wire:production-connectors

unset WIRE_CONNECTORS_DRY_RUN
npm run wire:production-connectors
```

Strict preflight validates Google Drive auth and a `files.list` read before
Azure Container Apps are updated. It also requires the watch-channel output
`GDRIVE_WEBHOOK_CHANNEL_IDS` plus the webhook token and tenant/user mapping. If
OAuth returns `invalid_client`, `invalid_grant`, the Drive API cannot list
files, or the webhook mapping is incomplete, the script exits before wiring the
bad secret refs into production. Dry-run mode prints the redacted Azure changes
that would be applied without updating either Container App.

9. Start a live sync:

```bash
curl -X POST "$UNIFIED_SEARCH_BASE_URL/v1/reindex/google_drive" \
  -H "Authorization: Bearer $UNIFIED_SEARCH_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"atlasweb","userId":"rakib","wait":true}'
```

Subsequent Google Drive syncs resume from the last stored modified time for the
same tenant/user/folder scope. To intentionally rebuild a source, call
`/v1/reindex/google_drive` or pass `options.forceFullSync=true`.

If Google Drive credentials fail after wiring, remove only the runtime env
bindings and leave stored secrets intact for later inspection or replacement:

```bash
export UNWIRE_CONNECTOR_SOURCES=google_drive
export UNWIRE_CONNECTORS_DRY_RUN=true
npm run unwire:production-connectors

unset UNWIRE_CONNECTORS_DRY_RUN
npm run unwire:production-connectors
```

For service-account mode, set:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

and share target Drive folders/files with the service account email.

## Background Vectorization Path

Current production deployment supports background jobs through `/v1/sync/:source`,
`/v1/reindex/:source`, and authenticated connector events through
`/v1/events/:source`:

- Azure Service Bus queue `unified-search-sync`
- single-replica API-backed scheduler app
- Postgres + pgvector document/chunk/embedding storage
- tenant/user/source-scoped checkpoints
- worker-side vectorization and assistant artifact generation

Slack Events API can call `/v1/webhooks/slack/events` directly. The endpoint
bypasses the unified search bearer token only for Slack, verifies
`X-Slack-Signature` with `SLACK_SIGNING_SECRET`, rejects stale timestamps, maps
the payload to `SLACK_EVENT_TENANT_ID` / `SLACK_EVENT_USER_ID`, and then uses the
same readiness-gated event enqueue path internally. It still returns `409` until
`SLACK_BOT_TOKEN` and `SLACK_CHANNEL_IDS` pass live readiness.

Other provider webhook receivers should verify provider signatures, map the
provider payload to `{ tenantId, userId, event, options }`, and call
`/v1/events/:source` with the unified search API token. The event endpoint does
not accept fixture bypasses and still returns `409` until the live connector
readiness gate passes.

Google Drive Changes/watch can call `/v1/webhooks/google-drive/changes`
directly. The endpoint bypasses the unified search bearer token only for Google
Drive notifications, verifies `X-Goog-Channel-Token` against
`GDRIVE_WEBHOOK_TOKEN`, checks `X-Goog-Channel-ID` against
`GDRIVE_WEBHOOK_CHANNEL_IDS`, maps the notification to `GDRIVE_EVENT_TENANT_ID`
/ `GDRIVE_EVENT_USER_ID`, and then uses the same readiness-gated event enqueue
path internally. It still returns `409` until Google Drive OAuth or
service-account credentials pass live readiness.

Azure Blob Event Grid can call `/v1/webhooks/azure-blob/events` directly for
conference bridge transcript containers. Configure the Event Grid subscription
delivery property/header `X-Atlas-Event-Grid-Token` to match
`CONFERENCE_EVENT_GRID_TOKEN`, and set `CONFERENCE_EVENT_TENANT_ID` /
`CONFERENCE_EVENT_USER_ID` for the tenant/user scope. The endpoint handles
`Microsoft.EventGrid.SubscriptionValidationEvent`, accepts
`Microsoft.Storage.BlobCreated`, verifies the blob container is listed in
`CONFERENCE_BLOB_CONTAINERS`, and enqueues a prefix-scoped conference bridge
sync. It still returns `409` until `AZURE_STORAGE_CONNECTION_STRING` and
`CONFERENCE_BLOB_CONTAINERS` pass live readiness.

Future tenant onboarding services should continue to call `/v1/events/:source`
with the unified search API token unless they get their own provider-specific
verified ingress.
