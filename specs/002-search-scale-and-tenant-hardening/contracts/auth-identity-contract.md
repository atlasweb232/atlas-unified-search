# Contract: Auth Identity & Scope Enforcement

## Resolution

Middleware resolves a request `Identity` before any data route runs. Order:
`/v1/health` and `/v1/webhooks/*` are exempt (webhooks keep signature
verification). All other `/v1/*` routes require a resolved identity when
`IDENTITY_MODE != off`.

```text
Identity = { mode, tenantId, userId, allowedSources?, subject }
```

## Modes

### `IDENTITY_MODE=jwt`
- `Authorization: Bearer <jwt>`; verify HS256 (`IDENTITY_JWT_SECRET`) or
  RS256/JWKS (`IDENTITY_JWKS_URL`).
- Claims MUST include `tenantId` and `userId`; MAY include `sources`.
- Effective scope = claims. If a request body/query carries `tenantId`/`userId`
  that differ from the claims → `403`.

### `IDENTITY_MODE=api_key`
- `Authorization: Bearer <key>` (or `X-Api-Key`); look up in
  `IDENTITY_TENANT_KEYS_JSON` / Key Vault → `{ tenantId, users[] }`.
- Effective `tenantId` = mapped tenant. `userId` MUST be in the key's `users`
  (or the key is single-user). Out-of-mapping → `403`.

### `IDENTITY_MODE=shared_token` (legacy / single-tenant)
- Current behaviour: one `UNIFIED_SEARCH_AUTH_TOKEN`; scope taken from request.
- Permitted only for single-tenant / trusted-network deployments.
- `/v1/production-readiness` MUST report
  `infrastructure.identity = { ready:false-for-multitenant, mode:'shared_token' }`.

## Enforcement rules (MUST)

- Data routes derive scope from `Identity`, not from raw body `tenantId`/
  `userId` (except `shared_token`).
- `matchesScope(req, row)` returns true only when `req.identity` is entitled to
  `row.tenantId`/`row.userId` AND the row is in scope.
- `sourcePermissions` still applies and intersects with `identity.allowedSources`.
- Cross-tenant ID substitution → `403` in `jwt` and `api_key` modes.
- Audit events record `actorSubject` from `Identity`.

## Responses

```text
401  missing/invalid token or signature
403  authenticated but not entitled to the requested tenant/user/source
```

## Verification (credential-free)

- Locally minted JWTs (`IDENTITY_JWT_SECRET=dev-only-secret`) and synthetic
  `IDENTITY_TENANT_KEYS_JSON` exercise all modes with no external IdP.
- Tests: matching scope → 200; mismatched tenant → 403; mismatched user → 403;
  source outside `allowedSources` → 403/filtered; webhook routes unaffected.
