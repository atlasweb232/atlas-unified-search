# Data Model (006 — Interface Contracts)

No new data entities. This spec defines the **interface shapes** each package
must satisfy. These are the swap boundaries.

## @atlas/embedding interfaces

```js
// TextEmbedder
{
  model:   string,
  version: string,
  dim:     number,                          // must equal TEXT_EMBEDDING_DIM
  embed(text: string): Promise<float32[]>   // length === dim
}

// VisionEmbedder
{
  model:   string,
  dim:     number,                          // must equal VISION_EMBEDDING_DIM
  embed({ imageBuffer: Buffer, mimeType: string }): Promise<float32[]>
}
```

## @atlas/store interfaces

```js
// VectorStore — knows about vectors only
{
  upsertChunks(chunks: Chunk[]): Promise<void>
  deleteChunks({ tenantId, userId, documentIds? }): Promise<void>
  searchChunks({
    tenantId, userId, sources?, spaces?, queryVectors: Map<space, float32[]>,
    candidateLimit, filters
  }): Promise<Candidate[]>
}

// DocumentStore — knows about operational records only
{
  upsertDocument(doc, chunks): void    // chunks kept for JSON fallback
  getDocument(id): Document | null
  deleteDocuments({ tenantId, userId, source?, documentIds? }): DeleteResult
  setCheckpoint(key, cp): void
  getCheckpoint(key): Checkpoint | null
  deleteCheckpoints({ tenantId, userId, source? }): DeleteResult
  createJob / updateJob / listJobs
  createSearchRun / updateSearchRun / updateSourceStatus / getSearchRun
  createAssistantAction / updateAssistantAction / getAssistantAction
  createArtifact
  appendAudit(event): void
  listAudit({ tenantId, userId, eventType?, limit }): AuditEvent[]
  scopedIndexStatus(scope): IndexStatus
  cleanupRetention(scope, cutoffs, { dryRun }): RetentionReport
  save(): Promise<void>
  load(): Promise<void>
  refresh?(): Promise<void>
  withStoreLock?(fn): Promise<any>      // optional cross-call locking
}
```

## @atlas/ingestion interfaces

```js
// Queue
{ enqueue(message: SyncMessage): Promise<void>, name: string }

// Receiver
{
  subscribe({ processMessage, processError }): void
  close(): Promise<void>
}

// SyncMessage
{ jobId, source, tenantId, userId, options }
```

## @atlas/assistant interfaces

```js
// ChatProvider
{
  name: string,
  configured(): boolean,
  generate({ actionType, prompt, contextResults }): Promise<ChatResponse>
}

// ArtifactProvider
{
  name: string,
  configured(): boolean,
  create({ type, title, selections, prompt?, provenanceResultIds }):
    Promise<Artifact>
}
```

## @atlas/identity interface

```js
// IdentityResolver
{
  mode: 'jwt' | 'api_key' | 'shared_token',
  resolve(req): Promise<Identity>
}

// Identity (request-scoped)
{ tenantId, userId, allowedSources?, subject, mode }
```

## @atlas/connectors interface

```js
// Connector
{
  source: string,
  practical: boolean,
  description: string,
  vectorizationMode: 'local_index' | 'external_federated',
  isConfigured(scope?): boolean,
  requirements(scope?): Requirement[],
  sync({ tenantId, userId, store, options }): Promise<Document[]>,
  checkReadiness?(scope?): Promise<ReadinessResult>,
  search?({ tenantId, userId, query, filters, limit }): Promise<Result[]>,
  fetchAttachment?(ref, scope): Promise<AttachmentStream>  // 003 M2
}
```

## Swap contract (the guarantee)

Any concrete implementation that satisfies its interface can be registered
with the relevant factory. Nothing outside the package knows which concrete
class is in use. Config selects the adapter; dependency injection wires it.

```
EMBEDDING_PROVIDER=bge_gpu → BgeGpuServiceEmbedder (PRIMARY; BGE-base-en-v1.5 768,
                             thin client of the shared Cloud Run GPU embedding
                             service reused from the Atlas email system; batch 32-64)
EMBEDDING_PROVIDER=hash    → HashTextEmbedder (dev/offline; MUST emit 768 to match)
EMBEDDING_PROVIDER=openai  → OpenAITextEmbedder (legacy/alt; 1536 — NOT the common scheme)
VISION_EMBEDDING_PROVIDER=local → LocalClipProvider
VISION_EMBEDDING_PROVIDER=api   → ApiVisionEmbedder

POSTGRES_CONNECTION_STRING set → PostgresDocumentStore + PgVectorStore
(none)                         → JsonDocumentStore + JsonVectorStore

SERVICE_BUS_CONNECTION_STRING set → ServiceBusQueue
BULLMQ_REDIS_URL set              → BullMQQueue (future)
(none)                            → InlineQueue

CHAT_PROVIDER=openai     → OpenAICompatibleChatProvider
CHAT_PROVIDER=anthropic  → AnthropicChatProvider
CHAT_PROVIDER=mock       → MockChatProvider

ARTIFACT_PROVIDER=organic → OrganicArtifactProvider
ARTIFACT_PROVIDER=llm     → LlmArtifactProvider
```
