CREATE TABLE rotation_schedules (
  algorithm TEXT PRIMARY KEY CHECK (algorithm IN ('RS256','ES256')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  interval_days INTEGER NOT NULL CHECK (interval_days BETWEEN 7 AND 365),
  next_run_at INTEGER NOT NULL,
  prepublish_seconds INTEGER NOT NULL,
  retirement_grace_seconds INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  last_mutation_id TEXT NOT NULL,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE rotation_proposals (
  id TEXT PRIMARY KEY,
  proposed_by TEXT NOT NULL,
  approved_by TEXT,
  plan_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed','approved')),
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);
CREATE TABLE rotation_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
