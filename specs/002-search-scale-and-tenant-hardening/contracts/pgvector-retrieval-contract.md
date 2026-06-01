# Contract: Scoped pgvector Retrieval

## Store method

```text
searchChunks({ tenantId, userId, sources, queryVector, limit, filters }) -> Candidate[]
```

### Inputs

- `tenantId`, `userId` (string, required) — authoritative scope from identity.
- `sources` (string[] | null) — restrict to these sources; null = all permitted.
- `queryVector` (number[EMBEDDING_DIM]) — embedded query.
- `limit` (int) — final result count requested by the caller.
- `filters` (object) — `{ containers?, authors?, from?, to? }` applied at the
  document level.

### Behaviour (MUST)

- Executes one bounded SQL query scoped by `tenant_id`/`user_id` (+ `source`,
  + document filters). MUST NOT load unscoped rows.
- When vectors exist and dimension matches, orders by
  `embedding <=> queryVector::vector` and limits to `candidateLimit`
  (`>= limit`, default `max(50, 5*limit)`).
- Returns at most `candidateLimit` `Candidate` rows (document + matched chunk +
  vector distance), which `SearchEngine` re-ranks (vector + lexical + recency,
  configurable weights) down to `limit`.
- Final `SearchResultLineItem` shape is byte-for-byte compatible with the
  current `/v1/search` and `/v1/search-runs` responses.

### Candidate

```text
{ document: SearchDocument, matchedChunkSummary: string, distance: number }
```

## Fallback (no pgvector / no vectors)

- MUST perform a scoped, bounded lexical query (e.g. token/`ILIKE`/full-text over
  title+summary+body within scope, `LIMIT candidateLimit`).
- MUST NOT silently scan the entire corpus in memory.
- Same `Candidate[]` output; re-rank step unchanged.

## Dimension integrity

- `EMBEDDING_DIM` is shared by embedder, chunk writer, and the
  `vector(EMBEDDING_DIM)` column.
- Startup MUST fail if `embedder.dimension !== EMBEDDING_DIM`.
- A chunk whose `embedding` length ≠ `EMBEDDING_DIM` MUST NOT be written to the
  `vector` column as NULL-by-omission; it is a configuration error.

## Verification

- `EXPLAIN (ANALYZE)` shows an index scan over the scoped predicate + the ANN
  index, bounded by `LIMIT`, with no sequential scan of `unified_chunks`.
- Result parity test: same fixture corpus, same query → same top-N documents as
  the pre-change in-memory implementation (within rank tolerance).
- Runs against local Postgres+pgvector with the deterministic local embedder; no
  external credentials.
