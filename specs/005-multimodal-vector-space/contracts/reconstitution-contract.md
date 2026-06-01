# Contract: Vector Hit → Source Reconstitution

Every chunk returned by a search MUST carry a `sourceRef` that resolves to the
original bytes or media segment via an existing backend endpoint — no additional
discovery round-trip required.

## sourceRef shape

```text
sourceRef {
  type:         'document_body'
              | 'attachment'
              | 'transcript_segment'
              | 'page_image'
              | 'keyframe'
  documentId:   string    # always present

  # type-specific (exactly one of):
  attachmentId? string    # → GET /v1/attachments/:attachmentId/content       (003)
  segmentStart? number    # → GET /v1/conference/:ref/segment?start=N&end=M   (004)
  segmentEnd?   number
  pageNumber?   number    # → GET /v1/attachments/:ref/content?page=N         (003)
  frameTime?    number    # → GET /v1/conference/:ref/segment?start=N&end=N+1 (004)
}
```

## Rules (MUST)

- Every chunk written by any indexer (text, image, audio future) MUST have a
  populated `sourceRef` set at index time, not computed later.
- The resolver MUST check identity scope (`002`) before streaming bytes.
- A `sourceRef` for a `document_body` chunk resolves inline (body is in the
  search result already); no network hop needed.
- `sourceRef` is included in `/v1/search` and `/v1/search-runs` results so the
  UI can reconstruct without a follow-up discovery call.

## Endpoint mapping

| sourceRef.type | Endpoint | Feature |
|---|---|---|
| `document_body` | inline — body in result | `001` |
| `attachment` | `GET /v1/attachments/:attachmentId/content` | `003 M2` |
| `page_image` | `GET /v1/attachments/:ref/content?page=N` | `003 M2` |
| `transcript_segment` | `GET /v1/conference/:ref/segment?start=&end=` | `004 M4` |
| `keyframe` | `GET /v1/conference/:ref/segment?start=T&end=T+1` | `004 M4` |

## Verification

- Every search result in the test suite has a non-null `sourceRef` with the
  correct `type` for its chunk kind.
- An `attachment` sourceRef resolves to the fixture bytes via the `003`
  endpoint.
- A `transcript_segment` sourceRef resolves to the fixture clip via the `004`
  endpoint.
- A cross-tenant `sourceRef` resolution attempt is rejected `403`.
