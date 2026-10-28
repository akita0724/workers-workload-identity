CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'security-admin')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  last_mutation_id TEXT
);
CREATE TABLE IF NOT EXISTS operator_identities (
  provider TEXT NOT NULL CHECK (provider IN ('passkey', 'cloudflare-access')),
  provider_subject TEXT NOT NULL,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  PRIMARY KEY (provider, provider_subject)
);
CREATE TABLE IF NOT EXISTS passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  operator_id TEXT REFERENCES operators(id),
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,
  invitation_hash TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  ip_hash TEXT NOT NULL,
  minute_bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, minute_bucket)
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  csrf_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  authenticated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bootstrap_invites (
  token_hash TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS admin_audit_events (
  event_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_by_time ON admin_audit_events(occurred_at DESC);
