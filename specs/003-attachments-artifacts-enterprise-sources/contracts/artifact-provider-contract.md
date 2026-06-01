# Contract: Artifact Provider (Organic + LLM)

Replaces the current markdown-stub provider with real binary output behind a
single pluggable interface.

## Interface

```text
ArtifactProvider {
  name
  configured() -> boolean
  create({ type, title, selections, prompt?, provenanceResultIds }) -> Artifact
}

type ∈ { 'create_powerpoint', 'create_pdf', 'create_report' }

Artifact {
  artifactId
  storageUri        # local path or blob URI (backend-controlled)
  downloadUrl       # backend-controlled; NEVER a raw public/third-party URL
  mimeType          # real file type, e.g. application/vnd.openxmlformats-...pptx
  sizeBytes         # real size
  provenanceResultIds: string[]
}
```

## Implementations

### OrganicArtifactProvider (default)
- Renders real files in-process: `.pptx` (presentation lib), `.pdf` (pdf lib),
  report as `.pdf`/`.docx`.
- Deterministic; **requires no external API key**. Used in CI and the baseline
  demo. Selected by `ARTIFACT_PROVIDER=organic` (default).

### LlmArtifactProvider (optional)
- Calls the configured chat provider to produce a **structured outline**
  (slides/sections as JSON: `{ slides:[{title,bullets[]}] }` or
  `{ sections:[{heading,body,sourceRefs[]}] }`).
- Passes that outline to the organic renderer to produce the real file —
  rendering stays deterministic; the LLM only shapes content.
- Selected by `ARTIFACT_PROVIDER=llm`; falls back to organic on provider error.

## Content & provenance rules

- Input is the user-selected results (via `searchRunId`+ids or
  `workbenchSessionId`). For `create_report`, sections are grouped and attributed
  by source; every included result is cited.
- LLM-backed generation sends only in-scope selected content to the provider;
  provider keys remain backend-only.
- Artifacts are stored via the existing artifact storage; the returned
  `downloadUrl` is always backend-controlled.

## Verification (credential-free)

- Organic provider yields a valid, openable `.pptx` and `.pdf` with no API key
  (assert magic bytes / openability + provenance list).
- Switching to `llm` with the mock chat provider produces files through the same
  contract (outline JSON → rendered file).
