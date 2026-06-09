CREATE TABLE IF NOT EXISTS connector_installations (
  id text PRIMARY KEY,
  source text NOT NULL,
  provider_team_id text NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  encrypted_credentials text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'connected',
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, provider_team_id)
);

CREATE TABLE IF NOT EXISTS connector_events (
  event_id text PRIMARY KEY,
  source text NOT NULL,
  provider_team_id text NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  status text NOT NULL DEFAULT 'received',
  job_id text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connector_installations_scope
  ON connector_installations (tenant_id, user_id, source);
CREATE INDEX IF NOT EXISTS idx_connector_events_scope_received
  ON connector_events (tenant_id, user_id, received_at DESC);
