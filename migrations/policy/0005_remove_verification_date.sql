-- Do not turn previously expired or invalid confirmations into valid settings.
UPDATE audiences
SET jwks_cache_seconds = NULL
WHERE rotation_verified_at IS NULL
   OR rotation_verified_at > unixepoch() * 1000
   OR unixepoch() * 1000 - rotation_verified_at > 180 * 86400000;
ALTER TABLE audiences DROP COLUMN rotation_verified_at;

-- Remove confirmation dates from saved audience audit payloads, retaining the events.
UPDATE policy_audit_events
SET before_json = CASE WHEN json_valid(before_json) THEN json_remove(before_json, '$.rotationVerifiedAt') ELSE NULL END,
    after_json = CASE WHEN json_valid(after_json) THEN json_remove(after_json, '$.rotationVerifiedAt') ELSE NULL END
WHERE action IN ('audience.create', 'audience.update');
