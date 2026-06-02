CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS unified_documents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  source text NOT NULL,
  source_id text NOT NULL,
  title text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  author text NOT NULL DEFAULT '',
  container text NOT NULL DEFAULT '',
  timestamp timestamptz,
  source_uri text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  children jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, source, source_id)
);

CREATE TABLE IF NOT EXISTS unified_chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES unified_documents(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  source text NOT NULL,
  text text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  embedding_model text NOT NULL DEFAULT '',
  embedding_version text NOT NULL DEFAULT '',
  -- Canonical width = EMBEDDING_DIM (BAAI/bge-base-en-v1.5 = 768). 002 M3 will
  -- template this to the configured dimension; the writer/embedder assert it.
  embedding vector(768),
  embedding_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unified_checkpoints (
  key text PRIMARY KEY,
  checkpoint jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unified_jobs (
  id text PRIMARY KEY,
  source text NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  status text NOT NULL,
  indexed integer NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS unified_search_runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  query text NOT NULL,
  selected_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  source_statuses jsonb NOT NULL DEFAULT '[]'::jsonb,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS unified_assistant_actions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  search_run_id text NOT NULL,
  action_type text NOT NULL,
  selected_result_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompt text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  status text NOT NULL,
  response_text text NOT NULL DEFAULT '',
  artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS unified_artifacts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  storage_uri text NOT NULL,
  download_url text NOT NULL DEFAULT '',
  mime_type text NOT NULL DEFAULT '',
  size_bytes integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unified_audit (
  id text PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT '',
  user_id text NOT NULL DEFAULT '',
  event_type text NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unified_documents_scope_source ON unified_documents (tenant_id, user_id, source, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_unified_chunks_scope_source ON unified_chunks (tenant_id, user_id, source);
CREATE INDEX IF NOT EXISTS idx_unified_jobs_scope_created ON unified_jobs (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_unified_search_runs_scope_created ON unified_search_runs (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_unified_chunks_embedding ON unified_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
