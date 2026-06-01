# Data Model (Delta over 001)

This feature does not introduce new core entities. It changes how existing
entities are stored, queried, and authorized. Base entities (`SearchDocument`,
`SearchChunk`, `SyncCheckpoint`, `SearchRun`, `SearchResultLineItem`,
`AssistantAction`, `Artifact`, `AuditEvent`) keep the fields defined in
`001-unified-knowledge-search/data-model.md`.

## Changed: SearchChunk.embedding

- `embedding` is stored in the `vector(EMBEDDING_DIM)` column **only when the
  configured embedder's dimension equals `EMBEDDING_DIM`**. Mismatch is a
  startup error, not a silent NULL (replaces the current
  `length === 1536` guard).
- `EMBEDDING_DIM` is a single configured value shared by embedder, writer, and
  migration. `embedding_json` remains as a portable copy / dev-store fallback.

## Changed: write semantics (all entities)

- Persistence is **row-scoped**: an operation writes only the rows it created or
  mutated. There is no whole-state rewrite.
- Deletes are authoritative `DELETE ... WHERE`; no code path re-inserts a row it
  did not just create.

## New (optional): concurrency control column

Decision pending in `research.md`. One of:

- `version integer NOT NULL DEFAULT 0` on `unified_documents` /
  `unified_chunks`, incremented on update, with optimistic concurrency; **or**
- rely on `updated_at` last-writer-wins (no schema change); **or**
- `SELECT ... FOR UPDATE` row locks within a transaction (no schema change).

## New: Identity (request-scoped, not persisted as a core entity)

```text
Identity
  mode: 'jwt' | 'api_key' | 'shared_token'
  tenantId: string            # authoritative scope, NOT taken from request body
  userId: string              # authoritative or identity-permitted
  allowedSources: string[]    # optional; intersects with sourcePermissions
  subject: string             # token subject / api key id, for audit
```

- For `jwt`: derived from verified claims.
- For `api_key`: derived from the tenant-key mapping
  (`IDENTITY_TENANT_KEYS_JSON` / Key Vault).
- For `shared_token`: single-tenant; scope may come from request but the
  deployment is flagged not multi-tenant-safe.

## Changed: AuditEvent

- Add `actorSubject` (the authenticated identity subject) alongside the existing
  `tenantId`/`userId`, so audit reflects *who acted*, not only the claimed scope.
- Audit reads are bounded by SQL `ORDER BY created_at DESC LIMIT n` per scope
  (no 1000-row in-memory slice as the source of truth).

## Query Shapes (new, scoped)

```text
searchChunks(scope, queryVector, k, filters):
  SELECT d.*, c.id AS chunk_id, c.summary,
         (c.embedding <=> $queryVector) AS distance
  FROM unified_chunks c
  JOIN unified_documents d ON d.id = c.document_id
  WHERE c.tenant_id = $tenantId AND c.user_id = $userId
    AND ($sources IS NULL OR c.source = ANY($sources))
    AND <document filter predicates: container/author/date range>
  ORDER BY c.embedding <=> $queryVector
  LIMIT $k;

scopedIndexStatus(scope):
  SELECT source, count(*) FROM unified_documents
  WHERE tenant_id=$1 AND user_id=$2 GROUP BY source;

listAudit(scope, eventType, limit):
  SELECT * FROM unified_audit
  WHERE tenant_id=$1 AND user_id=$2 AND ($3='' OR event_type=$3)
  ORDER BY created_at DESC LIMIT $4;
```
