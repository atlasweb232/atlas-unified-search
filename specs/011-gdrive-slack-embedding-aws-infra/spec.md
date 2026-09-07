# Spec: GDrive/Slack Embedding Scheme + AWS Infrastructure

**Spec ID**: 011-gdrive-slack-embedding-aws-infra
**Created**: 2026-09-07
**Status**: draft
**Depends on**: None

## Problem Statement

Atlas-unified-search needs:
1. Embedding scheme for Google Drive documents (following atlas-emailreact pattern)
2. Slack semantic search using native API (no custom vectorization)
3. AWS infrastructure deployed (currently has NO AWS infra)

## Research Findings

### Embedding Scheme (from atlas-emailreact)

**Model**: BAAI/bge-base-en-v1.5 (768 dimensions)

**Services**:
- `atlas-bge-embedding`: GPU inference service (Python FastAPI)
- `atlas-email-vectorization`: Orchestrator (Node.js)

**Database Schema** (PostgreSQL):
```sql
CREATE TABLE assistant_turn_embeddings (
  id uuid PRIMARY KEY,
  turn_id uuid NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  content_hash text NOT NULL,
  embedding bytea,
  embedding_model text DEFAULT 'bge-base-en-v1.5',
  embedding_provider text DEFAULT 'atlas-bge-embedding',
  status text DEFAULT 'pending',
  error_count integer DEFAULT 0,
  last_error text,
  created_at timestamptz DEFAULT now(),
  embedded_at timestamptz
);
```

**Search Hybrid Approach**:
1. Exact text search (ILIKE)
2. Semantic vector search (cosine similarity)
3. Recent items (time-based)
4. Memory facts (persistent facts)

### Slack Native Semantic Search

**API**: `POST /api/search.context`

**Parameters**:
```json
{
  "query": "project alpha discussion",
  "disable_semantic_search": false,
  "sort": "score",
  "count": 10
}
```

**Scopes Required**:
- `search:read.files`
- `search:read.public`
- `search:read.im`
- `search:read.private`

**Decision**: Use Slack native semantic search - NO custom vectorization needed.

### Google Drive Native Search

**API**: `fullText contains 'query'`

**Limitation**: Keyword search only. NO semantic search available from Google.

**Decision**: MUST implement custom vectorization for GDrive.

## Architecture

### Service Flow

```
GDrive Connector → Extract Text → Queue for Embedding
                                          ↓
                              Embedding Worker (polls queue)
                                          ↓
                              atlas-bge-embedding service
                                          ↓
                              Store in PostgreSQL (bytea)
                                          ↓
                              Search API queries via pgvector
```

### Slack Flow

```
Slack Connector → Search Request → Slack API (assistant.search.context)
                                              ↓
                                       Return native semantic results
                                              ↓
                                       No vectorization needed
```

## AWS Infrastructure Requirements

### Already Exists (atlas-emailreact)

- VPC: `atlas-prod` (10.0.0.0/16)
- Subnets: 3 private, 3 public
- Security Group: `atlas-stream-a` (ports 3000-3999, 5432, 6379)
- ECS Cluster: `atlas-backend-cluster`
- ECR Repositories: 33 services including `atlas-bge-embedding`
- RDS PostgreSQL: `atlas-prod-db` (has pgvector extension)
- IAM Roles: `atlas-ecs-execution-role`, `atlas-ecs-task-role`

### Needed for atlas-unified-search

#### Option A: Deploy to Existing Cluster (Recommended)

Reuse existing cluster, add new services:

1. **ECR Repositories** (add to ecr.tf):
   - `atlas-unified-search`
   - `atlas-unified-search-worker`
   - `atlas-unified-search-scheduler`

2. **SQS Queues**:
   - `atlas-unified-search-ingestion` (replaces Azure Service Bus)
   - `atlas-unified-search-embeddings`

3. **S3 Buckets**:
   - `atlas-unified-search-artifacts` (conference recordings, exports)

4. **ECS Services**:
   - `atlas-unified-search` (API)
   - `atlas-unified-search-worker` (ingestion worker)
   - `atlas-unified-search-scheduler` (scheduled jobs)

5. **Service Discovery**:
   - Internal DNS for `atlas-bge-embedding` endpoint

#### Option B: New Cluster (Not Recommended)

Create separate cluster - adds cost, complexity, inter-cluster networking.

### Resource Requirements

| Service | CPU | Memory | Port |
|---------|-----|--------|------|
| atlas-unified-search | 512 | 1024 | 3000 |
| atlas-unified-search-worker | 256 | 512 | - |
| atlas-unified-search-scheduler | 256 | 512 | - |

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@atlas-prod-db.xxx.us-east-1.rds.amazonaws.com:5432/atlas_unified_search

# Embedding Service
BGE_SERVICE_URL=http://atlas-bge-embedding:3000

# SQS
SQS_INGESTION_URL=https://sqs.us-east-1.amazonaws.com/ACCOUNT/atlas-unified-search-ingestion
SQS_EMBEDDING_URL=https://sqs.us-east-1.amazonaws.com/ACCOUNT/atlas-unified-search-embeddings

# Slack
SLACK_BOT_TOKEN=<from Secrets Manager>
SLACK_APP_TOKEN=<from Secrets Manager>

# Google
GOOGLE_CLIENT_ID=<from Secrets Manager>
GOOGLE_CLIENT_SECRET=<from Secrets Manager>
GOOGLE_REFRESH_TOKEN=<from Secrets Manager>
```

## Tasks

See `tasks.md` for implementation tasks.

## Success Criteria

- [ ] Google Drive documents vectorized with BGE model (768 dims)
- [ ] Slack search uses native API (no custom vectorization)
- [ ] pgvector index created on RDS
- [ ] SQS queues replace Azure Service Bus
- [ ] S3 buckets replace Azure Blob
- [ ] ECS services deployed to atlas-backend-cluster
- [ ] Service discovery works for atlas-bge-embedding
- [ ] Search endpoint returns hybrid results (exact + semantic)
- [ ] All services healthy in ECS

## Risks

1. **GPU availability**: atlas-bge-embedding may need GPU instance for performance
2. **pgvector performance**: Large datasets (>1M vectors) need index tuning
3. **Slack API rate limits**: Handle pagination and rate limiting
4. **GDrive API limits**: Full-text extraction throttling
5. **Multi-tenant isolation**: Row-level security in PostgreSQL

## Decisions

1. **AWS Account**: Deploy to account **392300785948** (user's account)
2. **Embedding Service**: Deploy new `atlas-bge-embedding` instance in same account (avoid cross-account complexity)
3. **Slack App**: TBD - verify if existing app can be reused

## Open Questions

1. Slack app already exists? Need to create new app or reuse existing?
2. Should we share ECR repositories with atlas-emailreact or create separate repos?
