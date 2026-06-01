# Requirements Checklist

## Attachments
- [ ] Attachment content (PDF/Office/text) extracted, chunked, embedded as children.
- [ ] Size-bounded; per-attachment failures isolated from parent sync.
- [ ] Text inside an attachment is findable via its parent document.
- [ ] `GET /v1/attachments/:ref/content` returns real bytes / short-lived signed URL.
- [ ] Never returns a raw private/public third-party URL.
- [ ] Reconstruction is identity-scoped (403 cross-tenant) and audited.

## Contact & channel
- [ ] Contact (name/handle/email) + channel/space normalized and surfaced.
- [ ] Usable as search filters; shown in expandable detail.

## Ephemeral workbench
- [ ] Working result set held in a TTL store; auto-expires.
- [ ] Identity-scoped CRUD endpoints; dev store needs no external dependency.
- [ ] Assistant actions accept `workbenchSessionId`.

## Artifacts (pluggable)
- [ ] `ArtifactProvider` produces real .pptx/.pdf/report (not markdown stubs).
- [ ] Organic provider works with no external API key (default).
- [ ] LLM-backed provider works behind the same contract.
- [ ] Artifacts carry provenance; download refs are backend-controlled.

## Analytical report (manual sourcing)
- [ ] `create_report` fuses only user-selected results.
- [ ] Data Fabric + KB are selectable sources; their selected hits are included.
- [ ] Every included result cited; per-section source attribution; no hidden augmentation.

## Mock enterprise sources
- [ ] Mock Data Fabric service (`/health`, `/records`) seeded + one-command start.
- [ ] Seeded Enterprise KB corpus consumable via `KNOWLEDGE_BASE_ROOT`.
- [ ] Synthetic data only; report demo runs end to end.

## Compatibility & CI
- [ ] All changes additive; `001` response shapes unchanged.
- [ ] CI runs M1–M7 with NO Slack/Google/Azure/enterprise/LLM credentials.
- [ ] Quickstart demonstrates login → sync → search → workbench → report/pptx offline.
