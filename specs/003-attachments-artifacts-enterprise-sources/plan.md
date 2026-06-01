# Implementation Plan

## Where this sits

```text
002 foundation:  real pgvector retrieval + identity/login + scale
       │
003 experience (this feature):
       ├─ attachment content pipeline   (extract → chunk → embed as children)
       ├─ attachment reconstruction     GET /v1/attachments/:ref/content
       ├─ contact/channel context       additive fields + filters
       ├─ ephemeral workbench           TTL session store + endpoints
       ├─ real artifact providers       organic (default) | LLM-backed
       ├─ create_report action          manual-sourced, cited
       └─ mock enterprise sources       mock Data Fabric svc + seeded KB
```

## 1. Attachment content pipeline

- Add a shared `extractAttachmentText({ bytes|stream, mimeType, name })` util
  with format handlers: text/markdown/csv/json (native), PDF (pdf parser), Office
  docx/xlsx/pptx (parser libs). Unknown/binary → `{ text:'', skipped:reason }`.
- Connector changes (additive):
  - **Slack**: download `url_private` via bot token for permitted files, extract,
    attach as `kind:'attachment'` children with `text` = extracted content.
  - **Drive**: extend `extractText` so PDF/Office go through the new util instead
    of `binary_or_unsupported`.
  - **Email/Conference**: feed attachment bytes/fixtures through the same util.
- `createChunks` already chunks `children[].text`; the only change is that
  children now carry real extracted text, so they become real embedded chunks.
- Bound by `ATTACHMENT_MAX_BYTES`; per-attachment failures recorded, parent sync
  continues. Fixtures may supply pre-extracted `text` to keep CI offline.

## 2. Attachment reconstruction endpoint

- `attachmentRef` = stable id derived from `{documentId, attachmentId}` (or an
  index into the document's `children`/`metadata.files`).
- New `src/attachments.js` resolver: given a ref + identity scope, load the
  parent document (scoped, via `002` store), confirm access, find the connector,
  and call a new connector method `fetchAttachment(ref, scope) -> { stream,
  mimeType, fileName, sizeBytes }`.
- Route `GET /v1/attachments/:ref/content` streams bytes (or 302 to a
  backend-issued short-lived signed URL for blob-backed sources). Companion
  `GET /v1/attachments/:ref` returns metadata only.
- Optional short-TTL byte cache (decision in research). Audit `attachment_open`.

## 3. Contact / channel context

- Normalize `author`/`authorEmail`/`authorHandle` and
  `container`/`containerType` consistently across connectors (additive metadata).
- Extend search filters (`002` `searchChunks` filters) with author/handle/email
  and container/space; surface on line items + detail view.
- Derive a per-scope directory (distinct contacts/channels) via SQL aggregation
  if a directory view is wanted; otherwise skip.

## 4. Ephemeral workbench

- `src/workbench/store.js` with a `WorkbenchStore` interface:
  - `InMemoryTtlWorkbench` (dev/test, no deps) and `RedisWorkbench` (prod).
- Entity: `WorkbenchSession { id, tenantId, userId, searchRunIds[],
  selections[], createdAt, expiresAt }` with TTL sweep / native expiry.
- Endpoints: `POST /v1/workbench`, `GET/PATCH /v1/workbench/:id`,
  `POST /v1/workbench/:id/selections`. Identity-scoped.
- Assistant actions accept `workbenchSessionId` as an alternative to
  `searchRunId` + `selectedResultIds`.

## 5. Real, pluggable artifact providers

- Extend the existing `ArtifactProvider` contract (currently
  `LocalArtifactProvider.create` writing markdown) to real files:
  - `OrganicArtifactProvider` (default): pptx via a pptx library, pdf via a pdf
    library, report via pdf/docx. Deterministic, no API key.
  - `LlmArtifactProvider` (optional): calls the configured chat provider to
    produce a structured outline (slides/sections JSON), then renders it with the
    organic renderer. Same `create(...)` signature.
- Selection via `ARTIFACT_PROVIDER=organic|llm`. Storage unchanged (local dir or
  Azure Blob), returning backend-controlled download refs.
- `AssistantActionService` keeps orchestration; only the provider output becomes
  real binary artifacts. Optional `POST /v1/artifacts` for direct generation from
  a workbench/selection.

## 6. create_report action (manual sourcing)

- New action type `create_report` in `AssistantActionService` + providers'
  prompt/templates.
- Input = selected results (which may include Data Fabric / KB results the user
  selected). The service groups selections by source, builds a cited, sectioned
  report (organic renderer or LLM-backed), and attaches provenance result IDs.
- No implicit search against unselected sources (manual decision). UI guidance:
  to include enterprise data, search Data Fabric/KB and select hits first.

## 7. Mock enterprise sources

- `mocks/data-fabric/` — a tiny Express service implementing `/health` +
  `/records` per the existing `DataFabricConnector` contract, seeded with
  synthetic metrics/facts/lineage/operational records; `npm run mock:data-fabric`.
  Point `DATA_FABRIC_BASE_URL` at it.
- `mocks/knowledge-base/` — a seeded markdown tree (runbooks/policies/arch/FAQ by
  space) consumed by `KnowledgeBaseConnector` via `KNOWLEDGE_BASE_ROOT`.
- Both checked into the repo, synthetic data only, started with one command, no
  account required.

## Migration / schema

- `migrations/003_*.sql` (additive): any new attachment-chunk metadata columns or
  indexes for author/handle/container filters; workbench is external (TTL store),
  not a core table (unless Postgres-backed workbench is chosen).

## Verification order (all credential-free)

1. Attachment extraction util + connector wiring (fixtures with bytes).
2. Reconstruction endpoint + scope/audit.
3. Contact/channel fields + filters.
4. Ephemeral workbench (in-memory TTL) + endpoints.
5. Organic artifact provider (real pptx/pdf) → then LLM-backed behind same API.
6. create_report with manual Data Fabric + KB selections via mocks.
7. Mock services + seeds; end-to-end report demo.
