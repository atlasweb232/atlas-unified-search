# Tasks

Depends on `002` foundation. All milestones verifiable with **no live
Slack/Google/Azure/enterprise/LLM credentials** — fixtures (with attachment
bytes), local Postgres+pgvector, deterministic embedder, mock Data Fabric + KB,
organic artifact provider.

## Speckit
- [ ] Define attachments/artifacts/enterprise-sources feature (this spec).
- [ ] Define attachment reconstruction contract.
- [ ] Define artifact provider contract (organic + LLM).
- [ ] Define enterprise mock (Data Fabric + KB) contract.

## M1: Attachment content extraction
- [ ] Shared `extractAttachmentText({ bytes, mimeType, name })` util.
- [ ] Handlers: text/md/csv/json (native), PDF, docx/xlsx/pptx.
- [ ] Size bound (`ATTACHMENT_MAX_BYTES`) + per-attachment failure isolation.
- [ ] Slack: download `url_private` for permitted files → extract → child chunk.
- [ ] Drive: route PDF/Office through the util (replace `binary_or_unsupported`).
- [ ] Email/Conference: feed attachment bytes/fixtures through the util.
- [ ] Tests: text inside a PDF/docx fixture is searchable via its parent doc.

## M2: Attachment reconstruction
- [ ] Stable `attachmentRef` derivation from document + attachment id.
- [ ] `fetchAttachment(ref, scope)` connector method per source.
- [ ] `GET /v1/attachments/:ref/content` streams bytes / short-lived signed URL.
- [ ] `GET /v1/attachments/:ref` metadata-only companion.
- [ ] No raw private/public URL ever returned.
- [ ] Identity-scoped; out-of-scope → 403; `attachment_open` audited.
- [ ] Tests: in-scope fetch returns bytes+type; cross-tenant → 403.

## M3: Contact & channel context
- [ ] Normalize author/handle/email + container/containerType across connectors.
- [ ] Extend search filters with author/handle/email + container/space.
- [ ] Surface contact/channel on line items + detail view.
- [ ] Tests: filter-by-author and filter-by-channel return expected scope.

## M4: Ephemeral session workbench
- [ ] `WorkbenchStore` interface; `InMemoryTtlWorkbench` (dev) + Redis adapter.
- [ ] `WorkbenchSession` entity with TTL/auto-expiry.
- [ ] `POST /v1/workbench`, `GET/PATCH /v1/workbench/:id`,
      `POST /v1/workbench/:id/selections` (identity-scoped).
- [ ] Assistant actions accept `workbenchSessionId`.
- [ ] Tests: readable within TTL, gone after TTL, cross-tenant denied.

## M5: Real, pluggable artifact generation
- [ ] Extend `ArtifactProvider` contract for real .pptx/.pdf/report files.
- [ ] `OrganicArtifactProvider` (default, no API key) — valid pptx + pdf.
- [ ] `LlmArtifactProvider` — LLM outline → organic renderer, same contract.
- [ ] `ARTIFACT_PROVIDER=organic|llm` selection; provenance + backend download ref.
- [ ] Optional `POST /v1/artifacts` direct generation from workbench/selection.
- [ ] Tests: organic provider yields openable pptx/pdf with no external API.

## M6: Analytical report (manual sourcing)
- [ ] `create_report` action type + templates/prompts.
- [ ] Group selected results by source; cited, sectioned, per-source attribution.
- [ ] Include user-selected Data Fabric + KB results; no implicit augmentation.
- [ ] Tests: report cites every included result; excludes unselected sources.

## M7: Mock enterprise sources
- [ ] `mocks/data-fabric/` Express service: `/health` + `/records` per contract.
- [ ] Seed synthetic metrics/facts/lineage/operational records.
- [ ] `npm run mock:data-fabric` wiring docs.
- [ ] Tests: Data Fabric connector indexes mock data; report demo runs end to end.
- [~] DEFERRED (keep existing KnowledgeBaseConnector stub): `mocks/knowledge-base/`
      seeded enterprise corpus + `KNOWLEDGE_BASE_ROOT` enterprise wiring. The
      local-markdown stub stays usable; enterprise KB build-out is a later phase.

## M8: Integration & CI
- [ ] `migrations/003_*.sql` additive (attachment/contact filter indexes).
- [ ] Quickstart: full credential-free demo (login → sync fixtures+mocks →
      search → workbench → report/pptx).
- [ ] CI runs M1–M7 with NO Slack/Google/Azure/enterprise/LLM credentials.
- [ ] Confirm `001` response shapes unchanged (additive only).

## Out of scope (future)
- OCR of images; audio/video transcription.
- Automatic report augmentation from unselected sources.
- Live third-party enterprise connectors (mocks stand in).
