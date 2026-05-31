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

## ConnectorStatus

- `tenantId`
- `userId`
- `source`
- `configured`
- `selectedByDefault`
- `syncStatus`
- `lastSyncedAt`
- `lastError`
- `availableFilters`

## SearchRun

- `id`
- `tenantId`
- `userId`
- `query`
- `selectedSources`
- `filters`
- `status`: `queued | running | partial | completed | failed`
- `sourceStatuses`
- `resultIds`
- `createdAt`
- `updatedAt`
- `completedAt`

## SourceSearchAgentRun

- `id`
- `searchRunId`
- `tenantId`
- `userId`
- `source`
- `status`: `queued | running | completed | failed`
- `startedAt`
- `completedAt`
- `error`
- `resultCount`
- `latencyMs`

## SearchResultLineItem

- `id`
- `searchRunId`
- `documentId`
- `source`
- `sourceIcon`
- `sourceLabel`
- `title`
- `oneLine`
- `author`
- `timestamp`
- `container`
- `score`
- `matchedChunk`
- `attachments`
- `links`
- `children`
- `expandable`
- `selected`
- `metadata`

## AttachmentRef

- `id`
- `documentId`
- `source`
- `name`
- `mimeType`
- `size`
- `sourceUri`
- `secureOpenUrl`
- `textIndexed`
- `metadata`

## AssistantConversation

- `id`
- `tenantId`
- `userId`
- `searchRunId`
- `provider`
- `status`
- `createdAt`
- `updatedAt`

## AssistantActionJob

- `id`
- `tenantId`
- `userId`
- `searchRunId`
- `conversationId`
- `actionType`: `summarize | answer_question | draft_email | create_powerpoint | create_pdf | extract_action_items | compare_sources`
- `provider`
- `selectedResultIds`
- `prompt`
- `status`: `queued | running | completed | failed`
- `responseText`
- `artifactIds`
- `error`
- `createdAt`
- `completedAt`

## Artifact

- `id`
- `tenantId`
- `userId`
- `actionJobId`
- `type`: `pptx | pdf | markdown | text`
- `title`
- `storageUri`
- `downloadUrl`
- `provenanceResultIds`
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

## UI State Notes

Connector selection is user/session state and should not change the underlying
indexed corpus. Search runs must persist selected sources and filters so later
assistant actions know exactly which corpus slice produced the answer.
