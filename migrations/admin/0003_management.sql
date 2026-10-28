ALTER TABLE passkey_credentials ADD COLUMN name TEXT NOT NULL DEFAULT 'パスキー';
CREATE TRIGGER protect_last_security_admin_update
BEFORE UPDATE OF role, enabled ON operators
WHEN OLD.role = 'security-admin' AND OLD.enabled = 1
  AND (NEW.role != 'security-admin' OR NEW.enabled != 1)
  AND (SELECT COUNT(*) FROM operators WHERE role = 'security-admin' AND enabled = 1) <= 1
BEGIN SELECT RAISE(ABORT, 'last-security-admin'); END;
CREATE TRIGGER protect_last_security_admin_delete
BEFORE DELETE ON operators
WHEN OLD.role = 'security-admin' AND OLD.enabled = 1
  AND (SELECT COUNT(*) FROM operators WHERE role = 'security-admin' AND enabled = 1) <= 1
BEGIN SELECT RAISE(ABORT, 'last-security-admin'); END;
CREATE TRIGGER protect_last_passkey
BEFORE DELETE ON passkey_credentials
WHEN EXISTS (SELECT 1 FROM operators WHERE id = OLD.operator_id AND enabled = 1)
  AND (SELECT COUNT(*) FROM passkey_credentials WHERE operator_id = OLD.operator_id) <= 1
  AND NOT EXISTS (SELECT 1 FROM bootstrap_invites WHERE operator_id = OLD.operator_id
    AND used_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000)
BEGIN SELECT RAISE(ABORT, 'last-passkey'); END;
CREATE TABLE health_checks (
  name TEXT PRIMARY KEY,
  healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
  checked_at INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX admin_audit_cursor ON admin_audit_events(occurred_at DESC, event_id DESC);
