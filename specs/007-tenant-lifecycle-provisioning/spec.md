# Feature Spec: Tenant Lifecycle & Elastic Provisioning

## Summary

Make the platform **scale without human intervention** and **tie infrastructure
to onboarding**: a tenant signing up triggers fully automated provisioning of
its isolated stores and identity; compute scales elastically with that tenant's
actual load (including to zero when idle); and offboarding deprovisions cleanly.
Tenancy is segregated at **two levels** — the **entity (tenant)** level by
physical isolation, and the **user** level by scoped access within the tenant.

This is the "serverless" operating model: nothing is pre-scaled for tenants that
don't exist yet; resources come into being at onboarding and follow demand.

## Decisions (locked)

- **Entity isolation = silo per tenant.** Each tenant gets a dedicated **Qdrant
  collection** for vectors and a dedicated **Postgres schema** for operational
  records. Offboarding = drop the collection + schema. (Trade-off: caps tenant
  count to the low thousands — acceptable for an enterprise tenant profile;
  revisit pool+partition if tenant count explodes.)
- **User isolation** is enforced within a tenant's silo by identity-scoped
  `user_id` filters (Qdrant payload filter + Postgres row predicate), building
  on `002` identity binding.
- **Provisioning = fully automated self-serve.** Signup → provisioning with no
  human step. Guardrails (quotas, rate caps, abuse limits) are mandatory.
- **Elasticity = scale-to-zero stateless compute + provisioned-on-onboard
  stateful stores.** API/worker/embed compute autoscale on load (incl. to zero);
  stateful stores (Qdrant, Postgres) are provisioned per tenant at onboarding
  and run on managed/auto-pausing tiers — they do not literally scale to zero
  but incur no cost for non-existent tenants.

## Dependencies

- `002` — identity-bound scoping (the user-level layer).
- `005`/`006` — Qdrant `VectorStore` and the `DocumentStore` split.
- `008` — the streaming pipeline whose consumer lag is this spec's primary
  autoscale signal.

## Problem Statement

- All tenants currently share `unified_*` tables and one vector space, separated
  only by a `tenant_id` column → **no entity-level segregation**.
- Deployment is three always-on Container Apps with no autoscaling policy, no
  scale-to-zero, and no per-tenant provisioning → **pre-scaled for nobody**.
- There is no tenant onboarding, deprovisioning, quota, or lifecycle concept
  anywhere in the codebase.
- Migrations are run manually (`npm run db:migrate`) → not hands-off.

## Functional Requirements

### FR-1: Tenant entity model & registry

- A `Tenant` record is the unit of provisioning: `{ tenantId, status, plan,
  qdrantCollection, postgresSchema, createdAt, quotas, region }`.
- A tenant registry (control-plane) tracks lifecycle state:
  `pending → provisioning → active → suspended → deprovisioning → deleted`.
- The registry is the source of truth for routing a request to the correct
  per-tenant silo.

### FR-2: Automated self-serve provisioning

- A signup/onboarding call provisions, with **no human step**:
  1. a dedicated **Qdrant collection** (named vectors `text`+`vision` per `005`,
     payload index on `user_id`),
  2. a dedicated **Postgres schema** with the `unified_*` tables (migrations
     applied automatically),
  3. tenant identity material (JWT issuer config or per-tenant API key per
     `002`),
  4. default **quotas** (storage, documents, embed throughput, rate limits).
- Provisioning MUST be **idempotent** (safe to retry) and **transactional in
  effect** (a partial failure leaves the tenant `pending`/`provisioning`, never
  half-active).
- Provisioning MUST emit lifecycle audit events and complete within a bounded
  time or fail with a clear, retryable error.

### FR-3: Two-level tenancy enforcement

- **Entity level:** every data operation resolves the tenant's silo
  (collection + schema) from the registry via the authenticated identity. A
  request can never address another tenant's collection/schema — the silo
  handle is derived from identity, never from request input.
- **User level:** within the silo, results are filtered by `user_id` per `002`.
- Cross-tenant access MUST be impossible by construction (different physical
  collection/schema), not merely by a filter predicate.

### FR-4: Elastic, hands-off compute scaling

- Stateless services (api, sync-fetch workers, embed workers) MUST autoscale
  with **no human intervention**:
  - **embed/fetch workers** scale on **broker consumer lag** (`008`) — including
    **to zero** when no backlog.
  - **api** scales on HTTP concurrency, with a configurable min (0 for pure
    serverless, or 1 for warm latency).
- Scaling policy is declarative (KEDA scalers on Azure Container Apps or
  equivalent) and committed as infra config, not adjusted by hand.
- The platform MUST NOT pre-scale capacity for tenants/load that don't exist.

### FR-5: Automated migrations & self-healing

- Schema migrations (global and per-tenant) MUST apply automatically on deploy /
  on tenant provision — no manual `db:migrate` step in production.
- Per-tenant migration state is tracked; a new migration rolls out to all tenant
  schemas idempotently.
- Health probes + automatic restart for unhealthy instances; failed provisioning
  jobs auto-retry with backoff; poison work goes to a dead-letter path (`008`)
  without human triage to keep flowing.

### FR-6: Quotas, fairness & abuse guardrails

- Per-tenant quotas (storage, doc count, embed throughput, request rate) are
  enforced; exceeding a soft quota throttles, a hard quota rejects with a clear
  error — never silently degrades another tenant.
- Self-serve provisioning MUST have abuse guardrails: signup rate limiting,
  per-account tenant caps, and suspendability.

### FR-7: Suspend / deprovision / offboard

- A tenant can be **suspended** (compute denied, data retained) and **resumed**.
- **Deprovisioning** drops the tenant's Qdrant collection and Postgres schema,
  revokes identity material, and removes registry routing — bounded, audited,
  and idempotent. Optional export-before-delete.
- Deprovisioning one tenant MUST NOT affect any other tenant (silo guarantees
  this physically).

## Security & Tenancy

- Silo isolation is the primary control; identity scoping (`002`) is the
  secondary. Both must hold.
- Per-tenant credentials/keys are stored in the secret store, never co-mingled.
- Lifecycle operations (provision/suspend/deprovision) are audited with the
  acting principal.
- A tenant's data is never reachable from another tenant's silo handle.

## No-Live-Credentials Verification

- Provisioning is tested against **local Qdrant** (Docker) + **local Postgres**:
  create collection + schema, apply migrations, route, then deprovision.
- Self-serve flow, quotas, suspend/resume, and deprovision are all exercised
  with synthetic tenants and local stores. Autoscale policy is validated as
  declarative config + a simulated lag signal (no cloud account needed for the
  unit/integration layer).

## Acceptance Criteria

1. A signup call provisions a new tenant end to end (Qdrant collection +
   Postgres schema + migrations + identity + quotas) with no human step, and is
   idempotent on retry.
2. Two tenants' data live in physically separate collections/schemas; a request
   authenticated for tenant A cannot read tenant B's data even if A forges
   B's id (the silo handle comes from the registry+identity, not the request).
3. Within a tenant, user A cannot read user B's data (`002` user-level filter).
4. Embed/fetch workers scale up on broker lag and **down to zero** when the
   backlog drains — verified with a simulated lag signal.
5. A new migration applies to all tenant schemas automatically and idempotently;
   no manual `db:migrate` in the production path.
6. Exceeding a hard quota for tenant A throttles/rejects A only; tenant B is
   unaffected.
7. Deprovisioning tenant A drops its collection + schema, is audited, and leaves
   tenant B fully intact.
8. The provisioning + lifecycle test suite runs against local Qdrant + Postgres
   with no cloud account.

## Open Questions

- Control-plane store: where does the tenant registry live — its own Postgres
  schema (`control`), a separate small DB, or a managed config store?
- Scale-to-zero for `api`: min-0 (cold starts, pure serverless) vs min-1 (warm,
  small always-on cost)? Likely per-plan.
- Managed Qdrant (Qdrant Cloud) vs self-hosted on the cluster — self-hosted
  doesn't auto-pause, so idle tenants still cost; managed may offer better
  per-tenant economics.
- Collection-count ceiling: at what tenant count do we switch silo → pool, and
  is that switch automated?
- Region/data-residency per tenant — in scope now or later?
