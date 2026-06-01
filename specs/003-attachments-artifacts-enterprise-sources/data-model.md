# Data Model (Delta over 001 / 002)

Additive only. Base entities keep their `001` fields; `002` adds scoped storage
and identity. This feature adds attachment-content chunks, a reconstruction
reference, contact/channel fields, the workbench session, and a report artifact.

## Changed: SearchChunk (attachment content)

Attachment children already exist as `kind:'attachment'`. The change is that
their `text` now carries **extracted file content**, so they become real
embedded chunks. Additive chunk metadata:

```text
metadata.attachment = {
  attachmentId, fileName, mimeType, sizeBytes,
  extraction: { ok, skippedReason?, charCount },
  ref            # stable attachmentRef for reconstruction (FR-2)
}
```

## New: AttachmentRef (derived, not a stored table)

```text
attachmentRef = stable(documentId + ':' + attachmentId)
resolves -> { documentId, source, attachmentId, mimeType, fileName, sizeBytes }
```

Used by `GET /v1/attachments/:ref/content`. Resolution is scoped: the parent
document must be in the caller's identity scope.

## Changed: SearchDocument / line item (contact & channel)

Additive normalized fields (populated by connectors, queryable as filters):

```text
authorEmail?     authorHandle?      # contact context
containerType?   ('channel'|'folder'|'mailbox'|'space'|'dataset'|'blob_container')
```

`author` and `container` remain as in `001`; the above refine them.

## New: WorkbenchSession (ephemeral, TTL store — not Postgres core)

```text
WorkbenchSession {
  id
  tenantId, userId          # identity-scoped (002)
  searchRunIds: string[]
  selections: [ { lineItemId, documentId, source } ]
  createdAt
  expiresAt                 # TTL; auto-expires
}
```

Stored in `InMemoryTtlWorkbench` (dev/test) or `RedisWorkbench` (prod). Not the
system of record; respects redaction + TTL.

## New: action type + report artifact

- `AssistantAction.actionType` adds `create_report`.
- `Artifact.type` adds `create_report`; artifacts are now **real binaries**
  (`.pptx`/`.pdf`/`.docx`) with `mimeType`/`sizeBytes` reflecting the real file,
  plus existing `provenanceResultIds` and a backend-controlled `downloadUrl`
  (never a raw public/private third-party URL).

## Mock enterprise sources (fixtures/seeds, not new schema)

- Mock Data Fabric records conform to the `DataFabricConnector` shape
  (`{ id, title, summary, text, record, dataset, timestamp, metadata }`) and are
  indexed as normal `SearchDocument`s under `source = data_fabric`.
- Mock KB pages are indexed under `source = knowledge_base` from a seeded
  markdown root.
