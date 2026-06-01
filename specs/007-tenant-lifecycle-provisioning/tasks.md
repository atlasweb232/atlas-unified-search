# Tasks

Depends on `002` (identity), `005`/`006` (Qdrant VectorStore + DocumentStore
split), `008` (lag-based autoscale signal). Verifiable credential-free against
local Qdrant + Postgres.

## Speckit
- [ ] Define tenant lifecycle & elastic provisioning (this spec).
- [ ] Define provisioning contract.
- [ ] Define tenant-isolation (silo) contract.
- [ ] Define autoscale-policy contract.

## M1: @atlas/tenancy registry + state machine
- [ ] `Tenant` model + `control` schema (`migrations/007_control_plane.sql`).
- [ ] Registry CRUD + lifecycle state machine
      (pending→provisioning→active→suspended→deprovisioning→deleted).
- [ ] Tests: valid/invalid state transitions.

## M2: Provisioner (automated, idempotent)
- [ ] Qdrant: create per-tenant collection (named vectors text+vision, payload
      index on user_id).
- [ ] Postgres: CREATE SCHEMA + run unified_* migrations in it.
- [ ] Identity: mint per-tenant JWT issuer entry / API key (002).
- [ ] Quotas: default quota row.
- [ ] Idempotent orchestration; partial failure resumes, never half-active.
- [ ] Tests: provision against local Qdrant+Postgres; retry is idempotent.

## M3: Silo-aware store resolution
- [ ] `tenantContext` resolved from registry by identity (never from request).
- [ ] `QdrantVectorStore` targets tenant collection; `PostgresDocumentStore`
      uses tenant schema.
- [ ] Tests: forged tenantId resolves nothing; cross-tenant read impossible;
      cross-user within tenant blocked (002).

## M4: Self-serve onboarding endpoint + guardrails
- [ ] `POST /v1/tenants` signup → provision (no human step).
- [ ] Signup rate-limit, per-account tenant cap, suspendability.
- [ ] Tests: signup provisions; guardrails reject abuse.

## M5: Elastic scaling (declarative)
- [ ] KEDA ScaledObject configs: embed/fetch workers on Kafka lag (minReplicas
      0); api on HTTP concurrency.
- [ ] Committed as infra-as-code; no hand-tuning.
- [ ] Tests: simulated lag → scale 0→N→0 (config + scaler unit validation).

## M6: Automated migrations & self-healing
- [ ] Global migrations on deploy; per-tenant on provision.
- [ ] Migration-rollout job applies new migrations to all tenant schemas
      idempotently; `control.migration_state` tracks.
- [ ] Health probes + restart; provision/deprovision retry w/ backoff;
      dead-letter (008) for poison work.
- [ ] Tests: new migration rolls to all tenants; rollout is idempotent.

## M7: Quotas & fairness
- [ ] Per-tenant quota enforcement at write/embed/enqueue (soft throttle, hard
      reject).
- [ ] Tests: hard quota on tenant A doesn't affect tenant B.

## M8: Suspend / deprovision
- [ ] `POST /v1/tenants/:id/suspend|resume`, `DELETE /v1/tenants/:id`.
- [ ] Deprovision drops collection + schema, revokes identity, unroutes;
      idempotent + audited; optional export-before-delete.
- [ ] Tests: deprovision A leaves B intact.

## M9: CI + docs
- [ ] CI runs M1–M8 against local Qdrant + Postgres, no cloud account.
- [ ] `docs/production-readiness-checklist.md` + onboarding runbook updated.

## Out of scope
- Pool+partition fallback at very high tenant counts (documented threshold only).
- Region/data-residency routing (open question).
- Billing/metering beyond quota counters.
