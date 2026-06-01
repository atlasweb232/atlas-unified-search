# Requirements Checklist

## Retrieval & scale
- [ ] Search executes as scoped, bounded SQL (tenant/user/source + filters).
- [ ] pgvector ANN (`embedding <=> $vec`) used when dim matches; index, not scan.
- [ ] Hybrid scoring preserved via re-rank over the bounded candidate set.
- [ ] Ranking weights configurable (no hard-coded 0.72/0.22/0.06).
- [ ] Documented bounded fallback when pgvector/vectors absent.
- [ ] No endpoint loads the full corpus into memory.

## Embedding integrity
- [ ] `EMBEDDING_DIM` shared by embedder, writer, migration.
- [ ] Startup fails fast on embedder/column dimension mismatch.
- [ ] Local deterministic embedder emits configured dimension.
- [ ] Model/version change drives reindex.

## Writes & concurrency
- [ ] Writes persist only changed rows (no whole-state rewrite).
- [ ] Deletes are authoritative and non-resurrecting across instances.
- [ ] Cross-process concurrency mechanism chosen and applied.
- [ ] Two-instance delete-vs-stale-write test passes.

## Tenancy & security
- [ ] Scope derived from / verified against caller identity.
- [ ] `jwt` and `api_key` modes reject cross-tenant ID substitution (403).
- [ ] `shared_token` flagged not multi-tenant-safe in production-readiness.
- [ ] `matchesScope` enforces identity entitlement.
- [ ] Audit records authenticated actor; redaction preserved.

## Operational
- [ ] Audit/jobs/runs/actions trimmed in DB by retention; audit reads via SQL LIMIT.
- [ ] SSE reads single run row per tick (or LISTEN/NOTIFY) — no full refresh.

## Compatibility & CI
- [ ] `/v1/*` response shapes unchanged; existing frontend works.
- [ ] Full M1–M6 suite runs against local Postgres+pgvector.
- [ ] CI passes with NO Slack/Google/Azure/embedding/LLM credentials set.
- [ ] `quickstart.md` and `docs/production-readiness-checklist.md` updated.
