# LLM And Artifact Provider Contract

The unified search UI includes a right-side assistant panel. The assistant must
remain provider-pluggable so the backend can later choose OpenAI, Azure OpenAI,
Anthropic-compatible APIs, Cerebras-compatible APIs, or a local/mock provider.

## Chat Provider Interface

```ts
interface ChatProvider {
  name: string;
  configured(): boolean;
  generate(input: ChatGenerateInput): Promise<ChatGenerateResult>;
}

interface ChatGenerateInput {
  tenantId: string;
  userId: string;
  actionType:
    | 'summarize'
    | 'answer_question'
    | 'draft_email'
    | 'extract_action_items'
    | 'compare_sources'
    | 'create_powerpoint'
    | 'create_pdf';
  prompt?: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  contextResults: SearchResultLineItem[];
  contextDocuments: SearchDocument[];
}

interface ChatGenerateResult {
  text: string;
  citations: Array<{ resultId: string; documentId: string; quote?: string }>;
  structured?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}
```

## Artifact Provider Interface

```ts
interface ArtifactProvider {
  name: string;
  configured(): boolean;
  create(input: ArtifactCreateInput): Promise<ArtifactCreateResult>;
}

interface ArtifactCreateInput {
  tenantId: string;
  userId: string;
  type: 'pptx' | 'pdf' | 'markdown' | 'text';
  title: string;
  sections: Array<{ heading: string; body: string; citations: string[] }>;
  provenanceResultIds: string[];
  metadata?: Record<string, unknown>;
}

interface ArtifactCreateResult {
  artifactId: string;
  storageUri: string;
  downloadUrl?: string;
  mimeType: string;
  size?: number;
}
```

## Provider Rules

- Provider secrets are backend-only.
- The frontend sends an action request, not provider credentials.
- The backend resolves provider selection by tenant/user config and allowed
  action type.
- Test environments must use a deterministic mock provider.
- Production actions must persist provenance and audit events.
- Artifact generation may be synchronous for MVP but should be queue-backed for
  large PowerPoint/PDF jobs.
