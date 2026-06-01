# Quickstart: Credential-Free Verification

This feature is fully testable **without any Slack/Google/Azure/embedding/LLM
account**. You need only Docker (for Postgres+pgvector) and Node.

## 1. Local Postgres + pgvector

```bash
docker run --rm -d --name uss-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=unified_search \
  -p 5432:5432 pgvector/pgvector:pg16

export POSTGRES_CONNECTION_STRING="postgres://postgres:postgres@localhost:5432/unified_search"
export POSTGRES_SSL=false
npm run db:migrate          # applies migrations/001 + 002
```

## 2. Credential-free configuration

```bash
# Deterministic local embedder at the configured dimension (no embedding API).
export EMBEDDING_PROVIDER=hash
export EMBEDDING_DIM=768             # canonical = BGE-base-en-v1.5 (768); must equal the vector column; startup asserts this

# Mock assistant; no LLM key.
export CHAT_PROVIDER=mock

# Identity in verifiable multi-tenant mode (locally minted tokens for tests).
export IDENTITY_MODE=jwt
export IDENTITY_JWT_SECRET=dev-only-secret
# or: IDENTITY_MODE=api_key ; IDENTITY_TENANT_KEYS_JSON='{"tenantA":{"key":"kA","users":["u1"]}}'
```

No `SLACK_*`, `GOOGLE_*`, `AZURE_*`, `OPENAI_*`, or `ANTHROPIC_*` variables are
required for any of the M1–M6 acceptance tests.

## 3. Index fixtures (real path, fake data)

Connectors accept `options.fixtures`, so the full
queue → index → pgvector → search → assistant path runs on synthetic data:

```bash
npm run seed:fixtures        # or POST /v1/sync/slack with { options: { fixtures: [...] } }
```

## 4. Verify the gaps are closed

```bash
# Scoped pgvector retrieval (bounded, indexed — not a full scan)
curl -s localhost:4420/v1/search \
  -H "Authorization: Bearer <locally-minted-jwt-for-tenantA/u1>" \
  -d '{"tenantId":"tenantA","userId":"u1","query":"quarterly report"}'

# Cross-tenant substitution is rejected (identity = tenantA, body = tenantB)
curl -s -o /dev/null -w '%{http_code}\n' localhost:4420/v1/search \
  -H "Authorization: Bearer <jwt-for-tenantA>" \
  -d '{"tenantId":"tenantB","userId":"u1","query":"x"}'   # expect 403

npm test                     # runs spec check + the M1-M6 suite against local PG
```

## 5. What still needs real accounts (out of scope here)

`checkReadiness` for Slack/Google/Azure validates live tokens/channels/files.
That remains gated and is **not** part of this feature's acceptance — the
hardening work is complete and provable without it.
