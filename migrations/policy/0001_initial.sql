CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 0,
  last_mutation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audiences (
  audience TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('RS256', 'ES256')),
  token_lifetime_seconds INTEGER NOT NULL CHECK (token_lifetime_seconds BETWEEN 1 AND 300),
  description TEXT NOT NULL DEFAULT '',
  verified_for_es256 INTEGER NOT NULL DEFAULT 0 CHECK (verified_for_es256 IN (0, 1)),
  rotation_verified_at INTEGER,
  jwks_cache_seconds INTEGER CHECK (jwks_cache_seconds IS NULL OR jwks_cache_seconds >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  last_mutation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS client_audience_grants (
  client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  audience TEXT NOT NULL REFERENCES audiences(audience) ON DELETE RESTRICT,
  PRIMARY KEY (client_id, audience)
);
CREATE TABLE IF NOT EXISTS policy_audit_events (
  event_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS issuance_rate_limits (
  client_id TEXT NOT NULL,
  minute_bucket INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (client_id, minute_bucket)
);
CREATE INDEX IF NOT EXISTS policy_audit_by_time ON policy_audit_events(occurred_at DESC);
