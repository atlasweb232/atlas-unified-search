# Data Model (Delta over 001–004)

## Changed: unified_chunks schema

```sql
-- 005 migration renames + adds:
ALTER TABLE unified_chunks
  RENAME COLUMN embedding      TO embedding_text;
ALTER TABLE unified_chunks
  RENAME COLUMN embedding_json TO embedding_text_json;

ALTER TABLE unified_chunks
  ADD COLUMN embedding_vision      vector(VISION_EMBEDDING_DIM),
  ADD COLUMN embedding_vision_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN embedding_space       text  NOT NULL DEFAULT 'text';
  -- values: 'text' | 'vision' | 'text+vision'
```

Separate ANN indexes:
```sql
CREATE INDEX idx_unified_chunks_emb_text   ON unified_chunks
  USING ivfflat (embedding_text   vector_cosine_ops) WITH (lists=100);
CREATE INDEX idx_unified_chunks_emb_vision ON unified_chunks
  USING ivfflat (embedding_vision vector_cosine_ops) WITH (lists=100);
```

## Changed: SearchChunk (runtime shape)

Additive fields:

```text
embeddingSpace:   'text' | 'vision' | 'text+vision'
modality:         'text' | 'image' | 'audio'   (set by chunker)
sourceRef: {
  type:           'document_body' | 'attachment' | 'transcript_segment'
                | 'page_image'   | 'keyframe'
  documentId
  attachmentId?   (→ 003 /v1/attachments/:ref/content)
  segmentStart?   (→ 004 /v1/conference/:ref/segment?start=&end=)
  segmentEnd?
  pageNumber?
  frameTime?
}
```

## New: VectorSpaceRegistry (runtime, not persisted)

```text
VectorSpace {
  name:        'text' | 'vision'
  dim:         number            (TEXT_EMBEDDING_DIM | VISION_EMBEDDING_DIM)
  column:      'embedding_text' | 'embedding_vision'
  embedder:    TextEmbedder | VisionEmbedder
  indexType:   'ivfflat' | 'hnsw'
}

VectorSpaceRegistry {
  spaces: Map<name, VectorSpace>
  embed(space, input) → float32[]
  embedQuery(query: string, image?: Buffer) → Map<space, float32[]>
}
```

## New: config additions

```text
config.vectorSpaces = {
  text: {
    dim:      TEXT_EMBEDDING_DIM  (env, default 1536)
    provider: 'hash' | 'openai'   (EMBEDDING_PROVIDER, existing)
    model:    EMBEDDING_MODEL
  },
  vision: {
    dim:      VISION_EMBEDDING_DIM (env, default 512)
    provider: 'local' | 'api'      (VISION_EMBEDDING_PROVIDER)
    model:    VISION_EMBEDDING_MODEL (e.g. 'clip-vit-base-patch32')
  }
}
```

## Search result (additive)

Result line items gain `sourceRef` and `modality`. No existing fields change.
`score` continues to be the fused hybrid score across all queried spaces.

## Cross-space fusion model

```text
rawScore(space, chunk) = cosine_distance normalised to [0, 1] within space
fusedDistance = Σ (spaceWeight[space] * rawScore(space)) / Σ spaceWeight[space]
hybridScore = fusedDistance * vectorWeight
           + lexicalScore   * lexicalWeight
           + recencyBoost   * recencyWeight
```

`spaceWeight` defaults: `{ text: 1.0, vision: 1.0 }`, configurable.
