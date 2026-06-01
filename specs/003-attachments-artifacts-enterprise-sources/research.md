# Research & Decisions

## 1. Attachment extraction (credential-free)

Today attachment *content* is not vectorized: Slack/email keep only metadata;
Drive's `extractText` returns `binary_or_unsupported` for PDF/Office. Decision:
in-process extraction libraries (favoring offline CI):

- text/markdown/csv/json: native.
- PDF: a pure-JS/no-binary PDF text extractor.
- docx/xlsx/pptx: parser libs (e.g. mammoth / xlsx / officeparser-style).
- images/unknown: skip with reason; OCR is future.

Rationale: an extraction *worker service* is more scalable but adds infra and
breaks credential-free CI. Start in-process, bounded by `ATTACHMENT_MAX_BYTES`,
with per-attachment failure isolation. Fixtures may supply pre-extracted `text`
so tests never need real files or network.

## 2. Reconstruction: re-fetch vs. cache

Connectors hold source references (`url_private`, Drive id, blob path). Decision:
re-fetch from source on demand by default (always fresh, no extra storage, honors
source-side revocation), with an **optional short-TTL byte cache** for hot/large
files. Never return raw third-party URLs; for blob-backed sources we may issue a
**short-lived backend-signed URL** instead of proxying bytes. All opens audited.

## 3. Contact / channel as first-class

Sender/channel already exist as `author`/`container` but are inconsistent across
connectors. Decision: normalize additive `authorEmail`/`authorHandle`/
`containerType` and extend the `002` `searchChunks` filter predicates rather than
build a separate contacts connector now. A directory view is a cheap SQL
`DISTINCT` aggregation if needed.

## 4. Ephemeral workbench store (decision: TTL, pluggable)

User chose **ephemeral + TTL**. Decision: define `WorkbenchStore` with:

- `InMemoryTtlWorkbench` — Map + per-entry expiry sweep; zero external deps for
  dev/CI.
- `RedisWorkbench` — native TTL for multi-instance production.

Open: if adding Redis infra is undesirable, a Postgres-backed workbench table
with an `expires_at` sweep is an alternative; it loses "truly ephemeral" purity
but reuses existing infra. Recommend in-memory for MVP, Redis for production.

## 5. Artifact engine (decision: pluggable, organic default + LLM option)

User chose **both, pluggable**. Decision: one `ArtifactProvider` contract, two
implementations:

- `OrganicArtifactProvider` (default): renders real `.pptx`/`.pdf`/report with
  in-process libraries. Deterministic, no API key — required for credential-free
  CI and the baseline demo.
- `LlmArtifactProvider` (optional): the configured chat provider returns a
  **structured outline** (slides/sections as JSON), which the organic renderer
  turns into the real file. Keeps rendering deterministic while letting the LLM
  shape content. Selected via `ARTIFACT_PROVIDER`.

This replaces the current markdown-stub `create` (`*.pptx.md`).

## 6. Report sourcing (decision: manual)

User chose **manual**. The report fuses only user-selected results. To include
enterprise data, Data Fabric and KB are first-class selectable search sources;
the user searches them and selects hits. No hidden augmentation — simpler trust
model, fully explainable provenance. (Auto-augment remains a future option behind
an explicit toggle if desired.)

## 7. Mock enterprise sources

The `DataFabricConnector` already speaks a clean HTTP contract (`/health`,
`/records`) but nothing implements it. Decision: ship a tiny local Express mock
under `mocks/data-fabric/` with synthetic metrics/facts/lineage/operational
records, plus a seeded markdown KB under `mocks/knowledge-base/`. Both start with
one command, contain only obviously-synthetic data, and make the analytical
report demonstrable end to end with no enterprise account.

## 8. Output formats

Open: `create_report` default to `.pdf` (universally viewable) with optional
`.docx`. Presentations default to `.pptx`. Confirm with stakeholders; renderer
supports adding formats behind the same contract.

## 9. Backwards compatibility

All changes are additive: new endpoints, one new action type, new optional fields.
`001` result/run/document response shapes are unchanged, so the existing frontend
and `atlas-emailreact` embedding keep working; expanded detail simply shows more.
