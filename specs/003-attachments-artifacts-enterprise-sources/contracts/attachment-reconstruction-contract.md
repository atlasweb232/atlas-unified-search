# Contract: Attachment Reconstruction

## Connector method

```text
fetchAttachment(ref, scope) -> { stream | bytes, mimeType, fileName, sizeBytes }
```

- Each connector exposing attachments implements it (Slack `url_private`, Drive
  `files.get?alt=media`, Azure Blob download, mock enterprise sources).
- MUST authenticate to the source using backend-only credentials.
- MUST validate `ref` belongs to a document in `scope` before fetching.

## Endpoints

### `GET /v1/attachments/:attachmentRef/content`
- Resolves `ref` → parent document; requires the document be in the caller's
  identity scope (`002`), else `403`.
- Returns the attachment bytes with the correct `Content-Type` and a
  `Content-Disposition` filename, **or** `302` to a short-lived backend-issued
  signed URL (blob-backed sources).
- MUST NOT return a raw third-party private URL or a public blob URL.
- Records an `attachment_open` audit event (with `actorSubject`).

### `GET /v1/attachments/:attachmentRef`
- Metadata only: `{ fileName, mimeType, sizeBytes, source, documentId,
  extraction: { ok, skippedReason? } }`. Same scope rules.

## attachmentRef

- Stable, opaque id derived from `documentId` + attachment id; not guessable
  across tenants (resolution still enforces scope regardless).

## Responses

```text
200  bytes (or metadata)
302  short-lived signed URL (blob-backed)
401  unauthenticated
403  authenticated but document/attachment out of scope
404  ref not found in scope
413  attachment exceeds ATTACHMENT_MAX_BYTES (reconstruction policy)
502  source fetch failed
```

## Verification (credential-free)

- Fixtures register attachments with bytes (or a local file path); the mock
  sources serve bytes locally.
- Tests: in-scope fetch returns correct bytes + type; cross-tenant → 403;
  response never contains a raw `url_private`/public URL; open is audited.
