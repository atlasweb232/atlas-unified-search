# Tasks: GDrive/Slack Embedding + AWS Infrastructure

**Spec**: 011-gdrive-slack-embedding-aws-infra
**Created**: 2026-09-07

## Phase 1: AWS Infrastructure (Terraform)

### T001 - Create SQS Queues
- [ ] Add `sqs.tf` to atlas-unified-search
- [ ] Create `atlas-unified-search-ingestion` queue
- [ ] Create `atlas-unified-search-embeddings` queue
- [ ] Configure dead-letter queues
- [ ] Set retention period (14 days)

### T002 - Create S3 Buckets
- [ ] Add `s3.tf` to atlas-unified-search
- [ ] Create `atlas-unified-search-artifacts` bucket
- [ ] Configure lifecycle rules (90-day archival)
- [ ] Enable versioning
- [ ] Configure bucket policy

### T003 - Create ECR Repositories
- [ ] Add to existing atlas-emailreact `ecr.tf` OR create new file
- [ ] Repository: `atlas-unified-search`
- [ ] Repository: `atlas-unified-search-worker`
- [ ] Repository: `atlas-unified-search-scheduler`
- [ ] Set lifecycle policy (keep last 10 images)

### T004 - Create ECS Task Definitions
- [ ] `aws/services/atlas-unified-search/task-definition.json`
- [ ] `aws/services/atlas-unified-search-worker/task-definition.json`
- [ ] `aws/services/atlas-unified-search-scheduler/task-definition.json`
- [ ] Configure environment variables
- [ ] Reference Secrets Manager for sensitive values

### T005 - Add ECS Services to Cluster
- [ ] Add to `stream-a-services.tf` or create `stream-c-services.tf`
- [ ] Configure service discovery for `atlas-bge-embedding`
- [ ] Set desired count (0 for shadow, 1+ for A1 phase)
- [ ] Attach to existing security group

### T006 - Create RDS Database (if needed)
- [ ] Check if existing `atlas-prod-db` can host new schema
- [ ] Create `atlas_unified_search` database if separate
- [ ] Enable pgvector extension
- [ ] Configure security group for ECS access

### T007 - Create Secrets
- [ ] Slack tokens in Secrets Manager
- [ ] Google OAuth credentials in Secrets Manager
- [ ] Database credentials (if new database)
- [ ] Update task definitions with ARN references

## Phase 2: Database Schema

### T008 - Create Migration: GDrive Embeddings
- [ ] File: `migrations/005_gdrive_embeddings.sql`
- [ ] Table: `gdrive_document_embeddings`
- [ ] Columns: id, document_id, tenant_id, user_id, content_hash, embedding (bytea), embedding_model, status, etc.
- [ ] Index: content_hash unique per tenant/user
- [ ] Index: status for queue polling

### T009 - Create pgvector Index
- [ ] Add `embedding_vec vector(768)` column
- [ ] Create IVFFlat index: `USING ivfflat (embedding_vec vector_cosine_ops) WITH (lists = 100)`
- [ ] Update embedding worker to populate vector column

### T010 - Create Migration: Search Audit
- [ ] Table: `search_audit_log`
- [ ] Columns: id, query, user_id, tenant_id, results_count, latency_ms, created_at
- [ ] Index: tenant_id, created_at

## Phase 3: Embedding Client

### T011 - Create Embedding Client
- [ ] File: `src/embedding-client.js`
- [ ] Function: `generateEmbeddings(texts)`
- [ ] Call `atlas-bge-embedding` service
- [ ] Handle errors, retries, timeout
- [ ] Batch size: 32-64 texts

### T012 - Create Embedding Worker
- [ ] File: `src/workers/embedding-worker.js`
- [ ] Poll `atlas-unified-search-embeddings` queue
- [ ] Process pending embeddings from database
- [ ] Batch calls to embedding service
- [ ] Update status: pending → completed
- [ ] Handle failures (error_count, last_error)

## Phase 4: GDrive Connector Modifications

### T013 - Modify GDrive Connector
- [ ] File: `src/connectors/gdrive.js`
- [ ] After text extraction, queue for embedding
- [ ] Calculate content_hash (sha256)
- [ ] Insert to `gdrive_document_embeddings` with status='pending'
- [ ] Skip if content_hash already exists

### T014 - Create GDrive Ingestion Worker
- [ ] File: `src/workers/gdrive-ingestion-worker.js`
- [ ] Poll SQS `atlas-unified-search-ingestion` queue
- [ ] Fetch document from GDrive API
- [ ] Extract text content
- [ ] Normalize and clean text
- [ ] Queue for embedding

## Phase 5: Slack Connector

### T015 - Create Slack Search Connector
- [ ] File: `src/connectors/slack-search.js`
- [ ] Function: `searchSlack(query, options)`
- [ ] Call `assistant.search.context` API
- [ ] Parameters: query, disable_semantic_search=false, sort=score
- [ ] Parse response and normalize results
- [ ] No vectorization needed!

### T016 - Handle Slack Rate Limits
- [ ] Implement exponential backoff
- [ ] Track rate limit headers
- [ ] Queue failed requests for retry

## Phase 6: Search Endpoints

### T017 - Create GDrive Search Endpoint
- [ ] File: `src/routes/search-gdrive.js`
- [ ] POST `/v1/search/gdrive`
- [ ] Generate query embedding
- [ ] Query pgvector: `ORDER BY embedding_vec <=> query_vector`
- [ ] Threshold: score > 0.3
- [ ] Return ranked results with file metadata

### T018 - Create Slack Search Endpoint
- [ ] File: `src/routes/search-slack.js`
- [ ] POST `/v1/search/slack`
- [ ] Call `slack-search.js` connector
- [ ] Return native Slack results

### T019 - Create Unified Search Endpoint
- [ ] Modify: `src/routes/search.js`
- [ ] Aggregate results from: GDrive, Slack, Email, Conference
- [ ] Merge and rank by relevance
- [ ] Return unified results with source provenance

## Phase 7: Testing

### T020 - Unit Tests
- [ ] Test embedding client
- [ ] Test embedding worker
- [ ] Test GDrive connector queue logic
- [ ] Test Slack connector
- [ ] Test search endpoints

### T021 - Integration Tests
- [ ] Test SQS queue flow
- [ ] Test end-to-end GDrive ingestion → embedding → search
- [ ] Test Slack search API integration
- [ ] Test database migrations

### T022 - Load Tests
- [ ] Test with 1000 documents
- [ ] Test batch embedding (64 texts)
- [ ] Test concurrent search requests
- [ ] Measure latency

## Phase 8: Deployment

### T023 - Build Docker Images
- [ ] Build `atlas-unified-search` image
- [ ] Build `atlas-unified-search-worker` image
- [ ] Build `atlas-unified-search-scheduler` image
- [ ] Push to ECR

### T024 - Register Task Definitions
- [ ] Register with ECS
- [ ] Verify secrets resolution
- [ ] Test health checks

### T025 - Deploy to ECS
- [ ] Set desired count to 1
- [ ] Wait for service stable
- [ ] Run smoke tests
- [ ] Monitor CloudWatch logs

## Post-Deployment

### T026 - Monitor and Tune
- [ ] Set up CloudWatch alarms
- [ ] Monitor embedding queue depth
- [ ] Monitor search latency
- [ ] Tune pgvector index (lists parameter)

### T027 - Documentation
- [ ] Update API documentation
- [ ] Update deployment guide
- [ ] Update architecture docs
- [ ] Document Slack app setup
