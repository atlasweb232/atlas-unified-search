# Data Model

## SearchDocument

- `id`: internal document ID
- `tenantId`
- `userId`
- `source`: `slack | google_drive | conference_blob | email`
- `sourceId`: stable source ID
- `sourceUri`: source-specific URI/reference
- `title`
- `summary`
- `body`
- `author`
- `timestamp`
- `container`: channel/folder/mailbox/blob container
- `access`: ACL object
- `metadata`: source-specific JSON
- `children`: thread replies, transcript segments, email replies, file sections
- `createdAt`
- `updatedAt`
- `deletedAt`

## SearchChunk

- `id`
- `documentId`
- `tenantId`
- `userId`
- `source`
- `chunkIndex`
- `text`
- `summary`
- `embedding`
- `embeddingModel`
- `embeddingVersion`
- `metadata`
- `createdAt`

## SyncCheckpoint

- `id`
- `tenantId`
- `userId`
- `source`
- `connectorName`
- `scopeKey`: channel ID, drive ID, container prefix, mailbox ID
- `cursor`
- `lastSyncedAt`
- `status`
- `error`

## SearchAuditEvent

- `id`
- `tenantId`
- `userId`
- `eventType`: `sync_start | sync_complete | search | open_result | delete`
- `source`
- `documentId`
- `queryHash`
- `metadata`
- `createdAt`

## Source Notes

### Slack Metadata

- `channelId`
- `channelName`
- `messageTs`
- `threadTs`
- `permalink`
- `links`
- `files`

### Drive Metadata

- `fileId`
- `mimeType`
- `webViewLink`
- `folderPath`
- `modifiedTime`
- `owners`
- `exportMimeType`

### Conference Blob Metadata

- `container`
- `blobName`
- `etag`
- `meetingId`
- `bridgeId`
- `participants`
- `speaker`
- `startTime`
- `endTime`

### Email Metadata

- `mailboxId`
- `messageId`
- `threadId`
- `subject`
- `sender`
- `recipients`
- `receivedAt`
- `attachments`
