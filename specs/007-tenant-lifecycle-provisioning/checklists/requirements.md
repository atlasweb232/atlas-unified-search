# Requirements Checklist

## Registry & lifecycle
- [ ] `control` schema: tenants, quotas, migration_state, provision_jobs.
- [ ] Lifecycle state machine with audited transitions.

## Provisioning (automated, idempotent)
- [ ] Self-serve `POST /v1/tenants` provisions silo with no human step.
- [ ] Saga: Qdrant collection + Postgres schema + migrations + identity + quotas.
- [ ] Idempotent; partial failure resumes; never half-active.
- [ ] Signup guardrails (rate limit, per-account cap, suspendable).

## Two-level isolation
- [ ] Entity: per-tenant Qdrant collection + Postgres schema (physical).
- [ ] Silo handle resolved from registry+identity, never from request.
- [ ] User: user_id payload/row filter within the silo (002).
- [ ] Cross-tenant impossible by construction; forged tenantId → 403.
- [ ] Cross-user within tenant blocked.

## Elastic scaling (hands-off)
- [ ] embed/fetch/media workers scale on broker lag, min 0.
- [ ] api scales on HTTP concurrency.
- [ ] Declarative infra config; no hand-tuning.
- [ ] No pre-scaling for non-existent tenants.
- [ ] Provider rate-limit cap prevents throttling; backlog waits in broker.

## Automated migrations & self-healing
- [ ] Global on deploy; per-tenant on provision.
- [ ] Rollout job applies new migrations to all tenant schemas idempotently.
- [ ] Health probes + restart; job retry w/ backoff; dead-letter for poison work.
- [ ] No manual db:migrate in production path.

## Quotas & fairness
- [ ] Per-tenant soft/hard quota enforcement.
- [ ] Hard quota on one tenant doesn't affect others.

## Suspend / deprovision
- [ ] Suspend/resume; deprovision drops collection + schema, audited, idempotent.
- [ ] Deprovision of one tenant leaves others intact.

## CI
- [ ] All milestones verified against local Qdrant + Postgres, no cloud account.
- [ ] Autoscale logic unit-tested via simulated lag.
