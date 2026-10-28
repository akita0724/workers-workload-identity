CREATE TABLE access_step_up_challenges_v3 (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  provider_subject TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'operator.create','operator.update','operator.delete','operator.recover',
    'rotation.plan','rotation.approve','rotation.control','rotation.schedule','rotation.immediate','provider.update'
  )),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  used_at INTEGER
);
INSERT INTO access_step_up_challenges_v3
  SELECT id, operator_id, provider_subject,
    CASE action WHEN 'rotation.emergency' THEN 'rotation.immediate' ELSE action END,
    created_at, expires_at, verified_at, used_at
  FROM access_step_up_challenges;
DROP TABLE access_step_up_challenges;
ALTER TABLE access_step_up_challenges_v3 RENAME TO access_step_up_challenges;
CREATE INDEX access_step_up_expires ON access_step_up_challenges(expires_at);
