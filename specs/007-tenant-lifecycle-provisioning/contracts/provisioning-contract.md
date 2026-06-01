# Contract: Tenant Provisioning (Saga)

## Entry points

```text
onboardTenant({ tenantId, plan?, region? }) → Tenant      # idempotent
suspendTenant(tenantId) → Tenant
resumeTenant(tenantId) → Tenant
deprovisionTenant(tenantId, { export? }) → void           # idempotent
```

## Provisioning saga (idempotent, resumable)

Steps recorded in `control.provision_jobs`; each is individually idempotent and
the orchestrator resumes from the first non-`done` step:

```
1. collection   → Qdrant: create collection t_<id> if not exists
                  named vectors { text(TEXT_DIM), vision(VISION_DIM) }
                  payload index on user_id, source
2. schema       → Postgres: CREATE SCHEMA IF NOT EXISTS t_<id>
3. migrations   → apply all unified_* migrations into t_<id>
                  (record control.migration_state)
4. identity     → mint per-tenant JWT issuer entry / API key (002)
5. quotas       → insert default quota row by plan
→ registry.status = active   (only when ALL steps done)
```

## Rules (MUST)

- Every step is idempotent (`IF NOT EXISTS` / upsert) — safe to retry.
- A partial failure leaves `status = provisioning`; never `active` until all
  steps complete. Never half-active.
- Provisioning is bounded; on timeout it fails retryably with a clear error.
- Emits `tenant_provisioned` audit with acting principal on success.

## Deprovisioning (reverse, idempotent)

```
1. revoke identity material
2. unroute in registry (status = deprovisioning)
3. (optional) export collection + schema
4. Qdrant: drop collection t_<id>
5. Postgres: DROP SCHEMA t_<id> CASCADE
→ registry.status = deleted
```

- MUST NOT touch any other tenant's collection/schema.
- Idempotent: re-running after partial completion finishes the rest.
- Audited (`tenant_deprovisioned`).

## Verification (credential-free)

- Against local Qdrant + Postgres: onboard → assert collection + schema +
  migrations + quota row exist; re-run onboard → no duplicates (idempotent).
- Kill provisioning mid-saga → status `provisioning`; retry → `active`.
- Deprovision one tenant → its silo gone, others intact.
