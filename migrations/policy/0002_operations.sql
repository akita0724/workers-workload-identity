CREATE TABLE issuance_metrics (
  minute_bucket INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (minute_bucket, outcome)
);
CREATE TABLE provider_checks (
  provider TEXT NOT NULL,
  audience TEXT NOT NULL REFERENCES audiences(audience) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('unverified','success','unsupported','blocked')),
  tested_at INTEGER,
  evidence_url TEXT NOT NULL,
  notes TEXT NOT NULL,
  version INTEGER NOT NULL,
  last_mutation_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, audience)
);
CREATE INDEX policy_audit_cursor ON policy_audit_events(occurred_at DESC, event_id DESC);
