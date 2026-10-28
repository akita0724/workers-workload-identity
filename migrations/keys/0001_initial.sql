CREATE TABLE IF NOT EXISTS signing_keys (
  kid TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('RS256', 'ES256')),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'active', 'verifying', 'removed')),
  public_jwk_json TEXT NOT NULL,
  secret_binding TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  activated_at INTEGER,
  last_old_issued_at INTEGER,
  remove_not_before INTEGER,
  rotation_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_key_per_algorithm
  ON signing_keys(algorithm) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS issuance_reservations (
  reservation_id TEXT PRIMARY KEY,
  kid TEXT NOT NULL REFERENCES signing_keys(kid),
  reserved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS reservations_by_key ON issuance_reservations(kid, expires_at);
CREATE TABLE IF NOT EXISTS rotation_runs (
  id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('RS256', 'ES256')),
  state TEXT NOT NULL,
  new_kid TEXT,
  old_kid TEXT,
  prepublish_seconds INTEGER NOT NULL,
  retirement_grace_seconds INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  error_code TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_rotation_per_algorithm
  ON rotation_runs(algorithm) WHERE state NOT IN ('removed', 'failed');
CREATE TABLE IF NOT EXISTS rotation_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES rotation_runs(id),
  kind TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
