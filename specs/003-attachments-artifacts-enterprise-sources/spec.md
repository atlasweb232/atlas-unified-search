# Feature Spec: Attachments, Artifacts & Enterprise Sources

## Summary

Build the "experience" half of the unified search vision on top of the
foundation from `002-search-scale-and-tenant-hardening`. Where `001` delivered
the sync → search → list → summarize spine and `002` makes vector search and
login real and scalable, this feature delivers the pieces that make the product
demonstrably useful:

1. **Attachment content vectorization** — index the *contents* of attached
   files (PDF/Office/text/transcripts), not just their names.
2. **Attachment reconstruction** — fetch the real attachment bytes from the
   source on demand through a backend-controlled endpoint (no public URLs).
3. **Contact & channel context** — make sender/contact and channel/space
   information first-class and searchable, not buried in opaque metadata.
4. **Ephemeral session workbench** — hold the working result set in a
   short-lived, auto-expiring store during a session.
5. **Real artifact generation** — produce actual `.pptx`/`.pdf` (and report)
   files through a pluggable `ArtifactProvider` (organic builder by default,
   optional LLM-backed builder behind the same interface), exposed as a
   presentation/report endpoint.
6. **Analytical report** — a report action that fuses the user's *selected*
   results, including results the user explicitly searched and selected from the
   **Data Fabric** and **Enterprise Knowledge Base** sources.
7. **Mock enterprise sources** — a runnable mock Data Fabric service and a
   seeded Enterprise Knowledge Base corpus so the whole experience works with
   **no live Slack/Google/Azure account and no external enterprise systems**.

This feature adds new endpoints and one new action type but does not change the
`SearchDocument`/`SearchChunk` shapes from `001` beyond additive fields.

## Dependencies

- Requires `002` retrieval/identity foundation (scoped pgvector search,
  identity-bound tenancy). Report/summarize/artifact actions operate within the
  authenticated identity scope from `002`.

## Decisions (locked)

- **Artifact engine:** pluggable `ArtifactProvider`. Default = **organic**
  in-process builder (deterministic, no API key); optional = **LLM-backed**
  builder (Claude/Codex/OpenAI-compatible) behind the same contract.
- **Report sourcing:** **manual**. The analytical report uses only the results
  the user explicitly selected. Data Fabric and Enterprise KB are first-class
  *selectable search sources*, so to include them the user searches and selects
  their hits like any other source. No hidden auto-augmentation.
- **Session model:** **ephemeral with TTL**. The working result set lives in a
  short-lived store that auto-expires; it is not the long-term system of record.
- **Sequencing:** the **Enterprise Knowledge Base build-out is deferred**. The
  existing `KnowledgeBaseConnector` (local-markdown stub) is kept as-is for now;
  the seeded enterprise KB corpus (part of FR-7) is a later phase. The mock Data
  Fabric source and all other `003` items proceed as specified.

## Problem Statement (Observed Gaps vs. the vision)

- Attachments: Slack/email connectors capture attachment *metadata* only; the
  Drive connector extracts Google-native docs and plaintext but **skips
  PDF/Office/binary** (`extractText` returns `skipped: binary_or_unsupported`).
  So "any attachment also vectored" is not met.
- Reconstruction: connectors store `sourceUri`/`url_private`/`webLink` but there
  is **no endpoint** that pulls the bytes back from the source under backend
  control; the `001` spec promises "short-lived access URLs" that don't exist.
- Artifacts: `LocalArtifactProvider.create` writes a **markdown stub**
  (`*.pptx.md` / `*.pdf.md`), not a real presentation/document.
- Reports: there is a `compare_sources` action but no report that fuses Data
  Fabric + KB evidence; the Data Fabric connector targets an **external HTTP
  service that does not exist**, and the KB connector reads only local markdown.
- Mocks: there is no seeded enterprise database or rich KB to demonstrate the
  analytical report end to end.

## Functional Requirements

### FR-1: Attachment content extraction & vectorization

- Each connector that exposes attachments/files MUST be able to retrieve the
  attachment bytes (or accept them via fixtures) and extract text for:
  - PDF, plain text, Markdown, CSV/JSON, and common Office formats
    (docx/xlsx/pptx) at minimum.
  - Images / unknown binaries MAY be skipped with a recorded reason; OCR is a
    documented future extension.
- Extracted attachment text MUST be chunked and embedded as **child chunks**
  linked to the parent document (preserving the existing parent/child model),
  so attachment content participates in search and is attributable to its file.
- Extraction MUST be size-bounded and failure-isolated: a failed or oversized
  attachment records an error on that child and does not fail the parent sync.
- Each attachment chunk MUST carry enough reference metadata
  (`source`, `sourceId`, attachment id, mime type, byte size, container) to
  later reconstruct the original (FR-2).

### FR-2: Attachment reconstruction endpoint

- Provide `GET /v1/attachments/:attachmentRef/content` (and a metadata
  companion) that, for an attachment the caller's identity may access:
  - resolves the owning connector and re-fetches the bytes **from the source**
    on demand (Slack `url_private`, Drive `files.get?alt=media`, Azure Blob,
    mock enterprise sources), or streams from a short-lived cache;
  - returns the bytes (or a short-lived, backend-issued signed URL) with the
    correct content type;
  - NEVER exposes a raw third-party private URL or a public blob URL.
- Access MUST be scoped by identity (`002`): an attachment is reconstructable
  only if its parent document is in the caller's scope.
- All reconstruction requests MUST be audited (`attachment_open`).

### FR-3: Contact & channel context

- Sender/contact (name, handle, email where available) and channel/space/folder
  context MUST be normalized onto documents as queryable fields/metadata and
  surfaced on result line items (already partly present as `author`/`container`).
- These fields MUST be usable as search filters (extend existing
  `authors`/`containers` filters) and displayed in the expandable detail view.
- A lightweight directory view (contacts seen, channels seen) per scope MAY be
  derived from indexed documents; a dedicated contacts connector is a future
  extension, not required here.

### FR-4: Ephemeral session workbench + hot-memory cache

- A session workbench holds a user's working result set (selected line items +
  the originating search run reference) in a **short-lived store with a TTL**;
  entries auto-expire and are not the long-term record.
- Endpoints to create/read/update a workbench session and its selections, scoped
  by identity. Assistant actions (summarize/report/artifact) may target a
  workbench session in addition to a `searchRunId`.
- The store MUST be pluggable: an in-process TTL map for dev/test (no external
  dependency) and a **Redis** adapter for multi-instance production.
- **Session hot-memory cache (Redis):** beyond the selected-items workbench, the
  Redis layer is the session's *hot memory* and MUST cache, TTL-bound and
  keyed by `{tenantId}:{userId}:{sessionId}`:
  - the most recent search **result set(s)** for a session (so pagination,
    expand, and re-rank tweaks don't re-hit the vector engine),
  - computed **query embeddings** (cache key = normalized query + space), to
    skip re-embedding repeated/near-identical queries within a session,
  - the assistant's **working context** (summaries, selected provenance) so
    summarize/report/presentation actions reuse warm state instead of refetching.
- Cache keys MUST be tenant- and user-scoped; no cross-tenant or cross-user
  cache hits are possible. Cache is read-through/write-through over the vector
  engine, never a system of record.
- Expiry and contents MUST respect retention/redaction rules; nothing sensitive
  persists past TTL. A session-end (logout/expiry) MUST be able to flush its keys.

### FR-5: Real, pluggable artifact generation

- Define/extend the `ArtifactProvider` contract to produce real files:
  - `create_powerpoint` → a valid `.pptx`.
  - `create_pdf` → a valid `.pdf`.
  - `create_report` (FR-6) → `.pdf` or `.docx`.
- Default provider = **organic** in-process builder (e.g. pptx/pdf libraries),
  producing deterministic files with **no external API**.
- Optional provider = **LLM-backed** builder (Claude/Codex/OpenAI-compatible):
  the LLM proposes structured slide/section content, the builder renders it to a
  real file. Selected via config; same contract.
- Artifacts MUST carry provenance (the included result IDs) and be stored via
  the existing artifact storage (local dir or Azure Blob), returning a
  backend-controlled download reference (no public raw URL).
- A presentation/report generation request is exposed through the existing
  `/v1/assistant/actions` surface (action types) plus, if needed, a dedicated
  `POST /v1/artifacts` endpoint for direct generation from a workbench/selection.

### FR-6: Analytical report (manual sourcing)

- Add a `create_report` assistant action that produces a comprehensive analytical
  document from the **user-selected** results.
- Because sourcing is manual, Data Fabric and Enterprise KB MUST be selectable
  search sources (FR-7) so their hits can be selected and fused into the report
  alongside Slack/Drive/email/conference results.
- The report MUST cite every included result (provenance) and clearly attribute
  each section to its source(s). It MUST NOT silently pull in unselected data.

### FR-7: Mock enterprise sources (credential-free)

- **Mock Data Fabric service**: a runnable local HTTP service implementing the
  contract the existing `DataFabricConnector` expects (`/health`, `/records`
  with `tenantId`/`userId`/`dataset`/`since`/`limit`), seeded with realistic
  structured records (metrics, facts, lineage, operational summaries).
- **Mock Enterprise Knowledge Base**: a seeded KB corpus (runbooks, policies,
  architecture notes, FAQs) consumable by the existing `KnowledgeBaseConnector`
  (local root) — richer than a couple of markdown files, structured by space.
- Both MUST be startable locally with one command and require **no external
  account**. They make FR-6 demonstrable end to end.
- Seeds MUST be obviously synthetic (no real PII) and live under the repo.

## Security & Tenancy

- All new endpoints are identity-scoped per `002`; attachment reconstruction and
  workbench access are denied across tenants/users.
- No raw third-party or public URLs are ever returned (FR-2).
- Attachment bytes and ephemeral workbench contents are subject to redaction and
  TTL; artifacts carry provenance and audit trails.
- LLM-backed artifact/report generation sends only the selected, in-scope result
  content to the provider; provider keys remain backend-only.

## Non-Goals

- No OCR of images or audio/video transcription in this feature (future).
- No automatic/hidden augmentation of reports from unselected sources (decision:
  manual sourcing).
- No new third-party live connectors; mocks stand in for enterprise systems.
- No change to `001` result/run response shapes beyond additive fields.

## Acceptance Criteria

1. Indexing a fixture document with a PDF and a docx attachment results in
   attachment **content** appearing as searchable child chunks attributable to
   that file; a search for text that exists only inside the attachment returns
   the parent document.
2. `GET /v1/attachments/:ref/content` returns the original bytes for an in-scope
   attachment with the correct content type, never a raw private/public URL, and
   is rejected (`403`) for an out-of-scope caller; the open is audited.
3. Result line items and the expandable detail view show contact/sender and
   channel/space context, and those fields work as search filters.
4. A workbench session holds selected results, is readable within its TTL,
   auto-expires after it, and is identity-scoped; the dev store needs no external
   dependency.
5. `create_powerpoint` and `create_pdf` produce **valid, openable** files (not
   markdown stubs) via the organic provider with no external API key; switching
   config to the LLM-backed provider produces files through the same contract.
6. `create_report` produces a cited analytical document from selected results
   that includes Data Fabric and Enterprise KB results the user searched and
   selected, with per-section source attribution.
7. The mock Data Fabric service and mock Enterprise KB start locally with one
   command, seed synthetic data, and let criteria 6 run end to end with **no
   Slack/Google/Azure/enterprise credentials**.
8. The full test suite for the above runs in CI credential-free (local
   Postgres+pgvector + mocks + organic artifact provider + deterministic
   embedder).

## Open Questions

- Office extraction: bundle parsers (mammoth/xlsx/officeparser) vs. a small
  extraction worker service? (favor in-process libraries for credential-free CI).
- Workbench store: in-process TTL for MVP, Redis for production — confirm Redis
  is acceptable infra, or reuse Postgres with a TTL/expiry sweep.
- Should `create_report` output `.pdf`, `.docx`, or both by default?
- Attachment cache: cache reconstructed bytes (with TTL) or always re-fetch from
  source? (affects latency vs. freshness/storage).
