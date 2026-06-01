# Contract: Two-Level Tenant Isolation

## Resolution (silo handle never from request)

```text
resolveTenantContext(identity) → TenantContext
  registry.lookup(identity.tenantId)
  assert status === 'active'
  → { tenantId, qdrantCollection, postgresSchema, quotas }
```

- Input is the **authenticated `Identity`** (002), not request body fields.
- The `qdrantCollection` / `postgresSchema` come from the registry row — there
  is no code path that builds a silo handle from request input.

## Entity level (physical)

- `VectorStore` operations target `tenantContext.qdrantCollection` only.
- `DocumentStore` operations run within `tenantContext.postgresSchema` only
  (`SET search_path` or schema-qualified).
- A request authenticated for tenant A can never reference tenant B's
  collection/schema — the handle for B is not reachable from A's context.

## User level (logical, within the silo)

- Every Qdrant query includes a payload filter `user_id == identity.userId`
  (unless an explicit broader org/admin scope per 002).
- Every Postgres query includes the `user_id` predicate.
- Enforced from `Identity`, consistent with `002` FR-4.

## Invariants (MUST)

1. Cross-tenant read/write is impossible **by construction** (separate physical
   collection + schema), not merely by filter.
2. Cross-user read within a tenant is blocked by the user-level filter.
3. A forged `tenantId` in the request either equals the identity (allowed) or
   fails identity (403); it can never resolve another tenant's silo.
4. Suspended/deprovisioning tenants reject data operations.

## Verification

- Tenant A token + body `tenantId=B` → 403; no B data returned.
- Within tenant A: user u1 cannot read user u2's documents.
- Deprovisioned tenant's collection/schema absent; queries 404/410, never leak.
