# Implementation Plan

## Two planes

```
CONTROL PLANE  (new — @atlas/tenancy package)
  tenant registry + lifecycle state machine
  provisioner: Qdrant collection + Postgres schema + identity + quotas
  migration orchestrator (per-tenant + global)
  quota/guardrail enforcement

DATA PLANE  (existing services, made tenant-silo-aware)
  every request → resolve silo handle from registry (by identity)
                → @atlas/store uses that tenant's collection + schema
```

## 1. @atlas/tenancy package (control plane)

```
packages/tenancy/src/
  registry.js          Tenant CRUD + state machine (pending→active→…→deleted)
  provisioner.js       orchestrates: createCollection, createSchema,
                       runMigrations, mintIdentity, setQuotas (idempotent)
  deprovisioner.js     dropCollection, dropSchema, revokeIdentity, unroute
  migrations.js        per-tenant + global migration runner (tracks state)
  quotas.js            soft/hard quota checks
  index.js             onboardTenant(), suspendTenant(), deprovisionTenant()
```

- Registry lives in a `control` Postgres schema (decision: open question).
- Provisioner steps are individually idempotent; the orchestrator records
  progress so a retry resumes rather than duplicates.

## 2. Silo-aware store resolution

- `@atlas/store` factories take a `tenantContext` (resolved from registry by
  identity) → `{ qdrantCollection, postgresSchema }`.
- `QdrantVectorStore` targets the tenant's collection; `PostgresDocumentStore`
  sets `search_path` to the tenant's schema (or qualifies table names).
- The silo handle is derived in the identity/tenancy middleware, never from
  request body — a forged `tenantId` resolves nothing.

## 3. Provisioning flow (self-serve, automated)

```
POST /v1/tenants  (signup)            [guardrails: signup rate-limit, account cap]
  → registry.create(status=pending)
  → enqueue provision job (008 control topic) OR inline for small scale
  → provisioner:
       Qdrant: create collection (named vectors text+vision, payload index user_id)
       Postgres: CREATE SCHEMA t_<id>; run unified_* migrations in it
       identity: mint JWT issuer entry / per-tenant API key (002)
       quotas: insert default quota row
  → registry.update(status=active)
  → emit tenant_provisioned audit
  (any failure → status stays provisioning; retry resumes)
```

## 4. Elastic scaling (declarative, hands-off)

- **infra/azure**: KEDA `ScaledObject` config per workload:
  - embed-workers / fetch-workers → Kafka lag scaler (`008`), `minReplicas: 0`.
  - api → HTTP concurrency scaler, `minReplicas` per plan (0 or 1).
- Committed as infra-as-code (Bicep/Terraform or Container Apps YAML), not
  hand-tuned.
- No capacity is provisioned for tenants that don't exist; stateful stores are
  created per-tenant at onboarding.

## 5. Automated migrations & self-healing

- Deploy pipeline runs global migrations; tenant provision runs per-tenant
  migrations; a migration-rollout job applies new migrations to all existing
  tenant schemas idempotently (tracked in `control.migration_state`).
- Container Apps health probes + restart; provision/deprovision jobs retry with
  backoff; `008` dead-letter handles poison work without human triage.

## 6. Quotas & guardrails

- `quotas.js` checked at write/embed/enqueue time; soft → throttle (delay /
  shed to backlog), hard → reject. Per-tenant counters in the tenant's schema or
  control plane.
- Signup guardrails in the `POST /v1/tenants` route.

## 7. Lifecycle endpoints (admin + self-serve)

```
POST   /v1/tenants                 signup → provision
GET    /v1/tenants/:id             status
POST   /v1/tenants/:id/suspend     suspend (retain data)
POST   /v1/tenants/:id/resume
DELETE /v1/tenants/:id             deprovision (drop silo, audited)
```

## Migration / infra

- `migrations/007_control_plane.sql` — `control` schema: tenants, quotas,
  migration_state.
- Per-tenant schema migrations reuse the existing `unified_*` DDL, parameterised
  by schema name.
- `infra/azure/` — KEDA scaler configs; provisioner deploy.

## Verification order (credential-free, local Qdrant + Postgres)

1. Registry + state machine unit tests.
2. Provisioner against local Qdrant + Postgres (create/idempotent-retry).
3. Silo resolution: forged tenantId resolves nothing; cross-tenant blocked.
4. Per-tenant + global migration rollout idempotency.
5. Quota enforce (soft/hard) isolated per tenant.
6. Suspend/resume/deprovision; deprovision A leaves B intact.
7. Autoscale config validated + simulated lag → scale 0→N→0.
