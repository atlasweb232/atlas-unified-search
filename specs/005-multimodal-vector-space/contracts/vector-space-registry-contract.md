# Contract: Vector Space Registry

## Interface

```text
VectorSpaceRegistry {
  register(name, { embedder, dim, column }) → void
  embed(space, input: string | Buffer, mimeType?) → float32[]
  embedQuery(query: string, queryImage?: Buffer)
    → Map<space, float32[]>   # only spaces with available input
  spaces() → string[]
}
```

## Named spaces (005)

| Name | Input type | Embedder | Dim | Column |
|---|---|---|---|---|
| `text` | string | TextEmbedder | `TEXT_EMBEDDING_DIM` | `embedding_text` |
| `vision` | Buffer/path | VisionEmbedder | `VISION_EMBEDDING_DIM` | `embedding_vision` |

## Rules (MUST)

- Registering a space whose embedder output dimension ≠ `dim` MUST throw at
  startup (FR-2).
- `embed(space, input)` for a space whose input type doesn't match MUST throw
  (not silently embed empty text).
- `embedQuery` with no `queryImage` returns only `text` space vectors.
- `embedQuery` with a `queryImage` returns `vision` vectors; MAY also return
  `text` vectors if a text query is provided.

## searchChunks integration (extends 002 M3)

```text
searchChunks({ tenantId, userId, sources, query, queryImage?, spaces, candidateLimit, filters })
  for each space in spaces:
    queryVec = registry.embed(space, query | queryImage)
    candidates = ANN query on space.column ORDER BY <=> queryVec LIMIT candidateLimit
    normalise distances to [0,1]
  merge candidates by documentId (best normalised score per space wins)
  hybrid re-rank (fused distance * vectorWeight + lexical * lexicalWeight + recency * recencyWeight)
  return top candidateLimit
```

## Verification

- Unit: register space with wrong dim → throws.
- Unit: `embedQuery('quarterly revenue')` → only `text` vector returned.
- Integration: image fixture indexed in `vision` space; text fixture in `text`
  space; neither leaks into the other's column.
