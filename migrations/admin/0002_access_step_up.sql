CREATE TABLE IF NOT EXISTS access_step_up_challenges (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  provider_subject TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('operator.create', 'rotation.plan')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS access_step_up_expires ON access_step_up_challenges(expires_at);
