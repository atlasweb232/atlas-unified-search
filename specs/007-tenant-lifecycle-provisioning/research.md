# Research & Decisions

## 1. Why silo per tenant (decision)

Row-level multitenancy (one shared table, `tenant_id` column) is the current
state and fails the "segregated from an entity point of view" requirement: a
single bad filter leaks across tenants. Silo (collection-per-tenant +
schema-per-tenant) makes cross-tenant access **physically impossible**, and
makes offboarding a clean `DROP` rather than a risky scoped delete.

Trade-off (honest): Qdrant recommends against very large numbers of collections,
and Postgres schemas have practical ceilings in the low thousands. Silo therefore
suits an **enterprise tenant profile** (fewer, larger tenants). If tenant count
later explodes toward many small tenants, the pool+partition model (single
collection with a `tenant_id` payload partition index; Postgres RLS) is the
documented fallback. The `VectorStore`/`DocumentStore` interfaces (`006`) make
that switch an adapter change, not a rewrite.

## 2. Stateful stores can't truly scale to zero — be honest

"Serverless / don't scale before onboarded" is fully achievable for **stateless
compute** (api, fetch workers, embed workers) via KEDA — including scale-to-zero.
It is **not** achievable for **stateful stores** (Qdrant, Postgres): a tenant's
data must live somewhere. The realistic model:

- No tenant exists → no collection/schema → **zero data-store cost** for them.
- Tenant onboards → its silo is provisioned (managed/auto-pausing tier keeps idle
  cost low).
- Tenant active → compute autoscales with its load; idle → compute scales to
  zero, store stays at rest.

So "tied to onboarding" = provision-on-onboard + elastic compute, not literally
zero infrastructure. This is the correct, honest interpretation.

## 3. Managed vs self-hosted Qdrant

- **Qdrant Cloud (managed):** better per-tenant economics, snapshots, scaling
  handled; idle tenants cheaper. Needs an account/cost.
- **Self-hosted Qdrant on the cluster:** no per-tenant auto-pause; idle tenants
  still consume RAM (Qdrant is memory-resident). Cheaper at steady scale, worse
  for many idle tenants.

Decision: target **managed Qdrant** for production economics; **local Qdrant
(Docker)** for dev/CI (credential-free). The `VectorStore` adapter is identical.

## 4. Autoscale signal = broker lag (ties to 008)

The cleanest hands-off autoscale signal for vectorization is **consumer lag** on
the embed topic (`008`). KEDA has a native Kafka-lag scaler. Lag > threshold →
add embed workers; lag drains → scale to zero. The API scales on HTTP
concurrency. This is why `007` (scaling) and `008` (pipeline) interlock: `008`
produces the signal `007` consumes.

## 5. Provisioning idempotency

Self-serve provisioning touches multiple systems (Qdrant, Postgres, identity,
quotas) — there is no distributed transaction. Decision: a **saga with recorded
steps** (`control.provision_jobs`). Each step is individually idempotent
(`CREATE ... IF NOT EXISTS`, upserts); a retry resumes from the first
non-`done` step. The tenant is only `active` once all steps are `done`. A
partial failure leaves it `provisioning` (retryable), never half-active.

## 6. Automated migrations across many schemas

Per-tenant schemas mean a new migration must reach every tenant. Decision: a
**migration-rollout job** iterates active tenants, applies pending migrations to
each schema, records `control.migration_state(schema, migration_id)`. Idempotent
and resumable. Global (`control`) migrations run on deploy. No manual
`db:migrate` in production.

## 7. Control-plane location

Options: dedicated `control` schema in the main Postgres (simple, transactional
with tenant schemas) vs. a separate control DB (blast-radius isolation). Decision
(proposed): `control` schema in the primary Postgres for now; revisit a separate
control DB if the control plane needs independent scaling/HA. (Open question.)

## 8. Credential-free verification

- Local Qdrant (Docker) + local Postgres cover collection/schema create, migrate,
  route, quota, suspend, deprovision.
- Autoscale is validated as **declarative config + a simulated lag metric** at
  the unit/integration layer; real KEDA scaling is a deploy-time concern, not a
  unit-test concern.
- No cloud account required for any acceptance criterion.
