# Quickstart: GDrive/Slack Embedding

This guide shows how to test the embedding scheme locally before deploying to AWS.

## Prerequisites

- Node.js 18+
- PostgreSQL 15+ with pgvector extension
- Access to `atlas-bge-embedding` service (or run locally)
- Slack app with search scopes
- Google Cloud project with Drive API enabled

## Local Setup

### 1. Start PostgreSQL with pgvector

```bash
docker run -d \
  --name atlas-pgvector \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=atlas_unified_search \
  -p 5432:5432 \
  pgvector/pgvector:pg15
```

### 2. Enable pgvector extension

```bash
docker exec atlas-pgvector psql -U postgres -d atlas_unified_search -c "CREATE EXTENSION vector;"
```

### 3. Run migrations

```bash
cd atlas-unified-search
npm run migrate
```

### 4. Set environment variables

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/atlas_unified_search"
export BGE_SERVICE_URL="http://localhost:8080"  # or remote service URL
export SLACK_BOT_TOKEN="xoxb-..."  # from Slack app
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

### 5. Install dependencies

```bash
npm install
```

## Test GDrive Embedding Flow

### 1. Ingest a document

```bash
curl -X POST http://localhost:3000/v1/ingest/gdrive \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "fileId": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
    "userEmail": "user@example.com"
  }'
```

### 2. Check embedding queue

```bash
psql $DATABASE_URL -c "SELECT * FROM gdrive_document_embeddings WHERE status='pending';"
```

### 3. Run embedding worker

```bash
node src/workers/embedding-worker.js
```

### 4. Search

```bash
curl -X POST http://localhost:3000/v1/search/gdrive \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "query": "quarterly financial report",
    "limit": 10
  }'
```

## Test Slack Native Search

```bash
curl -X POST http://localhost:3000/v1/search/slack \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "query": "project alpha discussion",
    "limit": 10
  }'
```

## Verify pgvector Index

```bash
psql $DATABASE_URL -c "SELECT * FROM gdrive_document_embeddings WHERE embedding_vec IS NOT NULL LIMIT 1;"
```

## Troubleshooting

### Embedding service unreachable
- Check `BGE_SERVICE_URL` is correct
- Verify service is running: `curl http://localhost:8080/health`

### pgvector not installed
- Use pgvector/pgvector Docker image
- Run: `CREATE EXTENSION vector;`

### Slack API errors
- Verify `SLACK_BOT_TOKEN` is valid
- Check app has `search:read.*` scopes

### GDrive API errors
- Verify service account has Drive access
- Check `GOOGLE_APPLICATION_CREDENTIALS` path
