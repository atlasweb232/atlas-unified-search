# Data Model (007 — Control Plane + Silo)

## Control plane (`control` schema — new)

```sql
-- migrations/007_control_plane.sql
CREATE SCHEMA IF NOT EXISTS control;

CREATE TABLE control.tenants (
  tenant_id        text PRIMARY KEY,
  status           text NOT NULL,        -- pending|provisioning|active|suspended|deprovisioning|deleted
  plan             text NOT NULL DEFAULT 'free',
  qdrant_collection text NOT NULL,       -- physical silo handle (vectors)
  postgres_schema  text NOT NULL,        -- physical silo handle (records)
  region           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  provisioned_at   timestamptz,
  deprovisioned_at timestamptz
);

CREATE TABLE control.tenant_quotas (
  tenant_id        text PRIMARY KEY REFERENCES control.tenants(tenant_id),
  max_documents    bigint,
  max_storage_bytes bigint,
  max_embed_per_min integer,
  max_requests_per_min integer,
  used_documents   bigint NOT NULL DEFAULT 0,
  used_storage_bytes bigint NOT NULL DEFAULT 0
);

CREATE TABLE control.migration_state (
  schema_name      text NOT NULL,
  migration_id     text NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schema_name, migration_id)
);

CREATE TABLE control.provision_jobs (   -- for idempotent resume
  tenant_id        text NOT NULL,
  step             text NOT NULL,        -- collection|schema|migrations|identity|quotas
  status           text NOT NULL,        -- pending|done|failed
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, step)
);
```

## Per-tenant data plane (silo)

Each tenant gets:
- **Qdrant collection** `t_<tenantId>` — points carry named vectors
  `{ text: vector(TEXT_DIM), vision: vector(VISION_DIM) }` (005) and payload
  `{ user_id, source, container, sourceRef, ... }` with a **payload index on
  `user_id`** (user-level isolation) and `source`.
- **Postgres schema** `t_<tenantId>` — the existing `unified_*` tables
  (documents, jobs, search_runs, assistant_actions, artifacts, audit,
  checkpoints), no longer carrying cross-tenant rows because the schema *is* the
  tenant boundary. (`tenant_id` column retained for defence-in-depth.)

## Runtime: TenantContext (resolved per request, not persisted)

```text
TenantContext {
  tenantId
  qdrantCollection      # from registry
  postgresSchema        # from registry
  status                # must be 'active' for data ops
  quotas
}
```

- Resolved by tenancy middleware from `Identity` (002) → registry lookup.
- **Never** constructed from request body. A forged `tenantId` either matches
  the identity (allowed) or fails identity check (403) — and the silo handle
  comes from the registry row, so it cannot point at another tenant.

## Isolation summary (two levels)

```
ENTITY level   →  physical: separate Qdrant collection + Postgres schema
                  (cross-tenant access impossible by construction)
USER level     →  logical: user_id payload filter (Qdrant) + row predicate
                  (Postgres), enforced from Identity (002)
```

## Lifecycle states

```
pending → provisioning → active ⇄ suspended
active|suspended → deprovisioning → deleted
```

Each transition is audited (`tenant_provisioned`, `tenant_suspended`,
`tenant_resumed`, `tenant_deprovisioned`) with the acting principal.
