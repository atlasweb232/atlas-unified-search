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

7. Start a sync:

```bash
curl -X POST http://localhost:4420/v1/sync/slack \
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

6. Start a sync:

```bash
curl -X POST http://localhost:4420/v1/sync/google_drive \
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

Current implementation supports background jobs through `/v1/sync/:source`.
Production should replace the in-process runner with:

- Azure Service Bus topics for source events, normalized documents, chunks ready,
  and artifact jobs
- Postgres + pgvector for document/chunk/embedding storage
- Connector checkpoints for Slack channel timestamps and Drive page tokens
- Event webhooks for Slack Events API and Google Drive Changes/watch
