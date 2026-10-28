-- Remove optional notes and the retired provider verification records.
DROP TABLE IF EXISTS provider_checks;
ALTER TABLE audiences DROP COLUMN verification_notes;
ALTER TABLE audiences DROP COLUMN evidence_url;
-- Preserve audit events while removing retired note/link contents from their payloads.
UPDATE policy_audit_events
SET before_json = CASE WHEN json_valid(before_json) THEN json_remove(before_json, '$.verificationNotes', '$.evidenceUrl') ELSE NULL END,
    after_json = CASE WHEN json_valid(after_json) THEN json_remove(after_json, '$.verificationNotes', '$.evidenceUrl') ELSE NULL END
WHERE action IN ('audience.create', 'audience.update');
UPDATE policy_audit_events
SET before_json = NULL, after_json = NULL
WHERE action = 'provider.update';
