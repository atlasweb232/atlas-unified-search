# Slack And Google Drive Onboarding

This is the current production-facing setup path before WorkOS/Nango is added.
All credentials stay backend-side.

## Slack Personal Bot Setup

1. Create a Slack app at `https://api.slack.com/apps`.
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

7. Validate credentials before wiring them into Azure:

```bash
export VALIDATE_CONNECTOR_SOURCES='slack'
export VALIDATE_CONNECTOR_REQUIRE_CONFIG=true
npm run validate:connector-credentials
```

The validator calls Slack `auth.test`, `conversations.info`, and a one-message
`conversations.history` probe for configured channels. It does not print token
values.

8. Wire credentials into the Azure API and worker apps:

```bash
export RESOURCE_GROUP='atlas-azure-backend-rg'
export APP_NAME='atlas-unified-search'
export WORKER_APP_NAME='atlas-unified-search-worker'
export UNIFIED_SEARCH_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
export UNIFIED_SEARCH_AUTH_TOKEN='<same token wired into the API app>'
npm run wire:production-connectors
```

9. Start a live sync:

```bash
curl -X POST "$UNIFIED_SEARCH_BASE_URL/v1/reindex/slack" \
  -H "Authorization: Bearer $UNIFIED_SEARCH_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"atlasweb","userId":"rakib","wait":true}'
```

Subsequent Slack syncs resume from the last stored channel timestamp for the
same tenant/user/channel. To intentionally rebuild a source, call
`/v1/reindex/slack` or pass `options.forceFullSync=true`.

Production note: later user onboarding should replace this with WorkOS Pipes or
Nango. The connector should receive tokens from a `TokenProvider` and should not
care whether the token came from `.env`, WorkOS, Nango, or direct OAuth.

## Google Drive Setup

For personal testing, use OAuth refresh token auth.

1. Create a Google Cloud project.
2. Enable Google Drive API.
3. Create OAuth credentials.
4. Authorize scopes:
   - `https://www.googleapis.com/auth/drive.readonly`
5. Store these backend-side:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GDRIVE_FOLDER_IDS=<optional comma-separated folder ids>
```

6. Validate credentials before wiring them into Azure:

```bash
export VALIDATE_CONNECTOR_SOURCES='google_drive'
export VALIDATE_CONNECTOR_REQUIRE_CONFIG=true
npm run validate:connector-credentials
```

The validator performs Drive auth and a one-file `files.list` probe. It reports
whether the configured folder scope can see at least one file, without printing
OAuth or service-account secret values.

7. Wire credentials into the Azure API and worker apps:

```bash
export RESOURCE_GROUP='atlas-azure-backend-rg'
export APP_NAME='atlas-unified-search'
export WORKER_APP_NAME='atlas-unified-search-worker'
export UNIFIED_SEARCH_BASE_URL='https://atlas-unified-search.proudfield-a201b3fd.eastus.azurecontainerapps.io'
export UNIFIED_SEARCH_AUTH_TOKEN='<same token wired into the API app>'
npm run wire:production-connectors
```

8. Start a live sync:

```bash
curl -X POST "$UNIFIED_SEARCH_BASE_URL/v1/reindex/google_drive" \
  -H "Authorization: Bearer $UNIFIED_SEARCH_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"atlasweb","userId":"rakib","wait":true}'
```

Subsequent Google Drive syncs resume from the last stored modified time for the
same tenant/user/folder scope. To intentionally rebuild a source, call
`/v1/reindex/google_drive` or pass `options.forceFullSync=true`.

For service-account mode, set:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

and share target Drive folders/files with the service account email.

## Background Vectorization Path

Current production deployment supports background jobs through `/v1/sync/:source`
and `/v1/reindex/:source`:

- Azure Service Bus queue `unified-search-sync`
- single-replica API-backed scheduler app
- Postgres + pgvector document/chunk/embedding storage
- tenant/user/source-scoped checkpoints
- worker-side vectorization and assistant artifact generation

Later multi-user onboarding should add Slack Events API and Google Drive
Changes/watch ingestion so changes flow into Service Bus near real time instead
of relying only on scheduled scans.
