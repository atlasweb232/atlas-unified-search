# Contract: Elastic Autoscale Policy

Declarative, hands-off scaling. No capacity for tenants/load that don't exist.

## Workloads & scalers

| Workload | Scaler | min | max | Signal |
|---|---|---|---|---|
| embed-workers | Kafka lag (008) | **0** | N | consumer-group lag on embed topic |
| fetch-workers | Kafka lag (008) | **0** | N | lag on fetch/discover topic |
| media-workers (004/005) | Kafka lag | **0** | N | lag on heavy-media topic (GPU pool) |
| api | HTTP concurrency | 0 or 1 (per plan) | N | concurrent requests |
| provisioner | queue/HTTP | 0 | small | provision job backlog |

## Rules (MUST)

- Scaling is **declarative infra config** (KEDA `ScaledObject` on Azure
  Container Apps or equivalent), committed to the repo — never hand-adjusted in
  production.
- Embed/fetch/media workers MUST scale **to zero** when their topic lag is zero.
- No workload is pre-scaled for tenants that have not onboarded.
- Scale-up reacts to lag/concurrency above threshold; scale-down after a
  cooldown to avoid flapping.
- Per-provider rate limits (embedding RPM/TPM) cap worker concurrency so scaling
  up does not cause throttling — excess work waits in the broker (008), not in
  failed requests.

## Self-healing

- Health/liveness probes restart unhealthy instances automatically.
- Failed provision/deprovision jobs retry with backoff.
- Poison messages dead-letter (008) without blocking the stream or requiring
  human triage.

## Verification (credential-free)

- ScaledObject configs validate against schema in CI.
- A simulated lag metric drives the scaling decision function: lag>threshold →
  desiredReplicas>0; lag==0 → desiredReplicas==0 (unit-tested logic, no live
  KEDA needed).
- Rate-limit cap: with provider RPM=X, worker concurrency never exceeds the
  configured cap regardless of backlog size.
