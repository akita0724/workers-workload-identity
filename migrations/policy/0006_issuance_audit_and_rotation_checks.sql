-- Separate short-lived issuance events from durable policy-change history.
CREATE TABLE issuance_audit_events (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  client_id TEXT,
  audience TEXT,
  kid TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','caller-denied','audience-denied','invalid-request','rate-limited','issuance-unavailable')),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  occurred_at INTEGER NOT NULL
);
CREATE INDEX issuance_audit_cursor ON issuance_audit_events(occurred_at DESC,event_id DESC);
CREATE INDEX issuance_audit_request ON issuance_audit_events(request_id);
-- Existing cache confirmations alone do not certify token exchange or mixed JWKS.
ALTER TABLE audiences ADD COLUMN exchange_verified INTEGER NOT NULL DEFAULT 0 CHECK (exchange_verified IN (0,1));
ALTER TABLE audiences ADD COLUMN mixed_jwks_verified INTEGER NOT NULL DEFAULT 0 CHECK (mixed_jwks_verified IN (0,1));
