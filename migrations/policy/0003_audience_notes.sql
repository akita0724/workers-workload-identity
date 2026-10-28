-- Keep historical provider_checks intact; new notes belong to the audience.
ALTER TABLE audiences ADD COLUMN verification_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE audiences ADD COLUMN evidence_url TEXT NOT NULL DEFAULT '';
