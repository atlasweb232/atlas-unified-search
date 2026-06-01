# Quickstart: Tenant Lifecycle (credential-free)

Prereqs: local Qdrant + local Postgres (Docker).

## 1. Local stores

```bash
docker run --rm -d --name uss-qdrant -p 6333:6333 qdrant/qdrant
docker run --rm -d --name uss-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=unified_search -p 5432:5432 pgvector/pgvector:pg16

export QDRANT_URL=http://localhost:6333
export POSTGRES_CONNECTION_STRING=postgres://postgres:postgres@localhost:5432/unified_search
export POSTGRES_SSL=false
export VECTOR_STORE=qdrant            # 006 adapter selection
npm run db:migrate:control            # control schema (007)
```

## 2. Self-serve onboard a tenant (no human step)

```bash
curl -s localhost:4420/v1/tenants -d '{"tenantId":"acme","plan":"free"}'
# → provisions: Qdrant collection t_acme (named vectors text+vision),
#   Postgres schema t_acme (unified_* migrated), identity, quotas
# → status: active

curl -s localhost:4420/v1/tenants/acme   # status + silo handles
```

## 3. Entity isolation is physical

```bash
# Onboard a second tenant:
curl -s localhost:4420/v1/tenants -d '{"tenantId":"globex"}'

# A token for acme cannot read globex — silo handle comes from the registry,
# not the request body:
curl -s -o /dev/null -w '%{http_code}\n' localhost:4420/v1/search \
  -H "Authorization: Bearer <acme-jwt>" \
  -d '{"tenantId":"globex","userId":"u","query":"x"}'   # → 403
```

## 4. Elastic scaling (simulated)

```bash
# Workers scale on embed-topic lag (008). Locally, push N embed-tasks and watch
# the worker pool grow, then drain to zero:
npm run sim:lag -- --tenant acme --tasks 5000
# KEDA config lives in infra/azure/ as ScaledObject YAML (minReplicas: 0).
```

## 5. Migrations roll out automatically

```bash
# A new per-tenant migration applies to every tenant schema, idempotently:
npm run migrate:rollout
# control.migration_state records (schema, migration_id) per tenant.
```

## 6. Suspend / deprovision

```bash
curl -s localhost:4420/v1/tenants/acme/suspend
curl -s localhost:4420/v1/tenants/acme/resume
curl -s -X DELETE localhost:4420/v1/tenants/globex   # drops t_globex collection + schema
# acme remains fully intact.
```

## What needs accounts (production only)

- Managed Qdrant + managed Postgres tiers for per-tenant economics.
- KEDA on Azure Container Apps for real autoscale. The logic is verified locally;
  the cloud wiring is deploy-time.
