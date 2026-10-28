import { Hono } from "hono";
import { z } from "zod";
import {
  operatorUpdateSchema,
  versionSchema,
  reasonSchema,
  rotationControlSchema,
  rotationScheduleSchema,
  rotationPlanSchema,
  immediateRotationSchema,
} from "@workers-workload-identity/contracts";
import { canPerform, type AdminAction } from "@workers-workload-identity/domain-operators";
import {
  adminConfig,
  randomToken,
  requireRecentAuthentication,
  sha256,
  type AdminEnv,
  type AuthenticatedOperator,
} from "./auth.js";
import { consumeAccessStepUp, type StepUpAction } from "./access-step-up.js";
import { startAdditionalRegistration, finishAdditionalRegistration } from "./passkey.js";
import { overview, checkHealth } from "./operations.js";

type App = { Bindings: AdminEnv; Variables: { operator: AuthenticatedOperator } };
const app = new Hono<App>();
export class ManagementError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 = 409,
  ) {
    super(code);
  }
}
function actor(operator: AuthenticatedOperator, action: AdminAction) {
  if (!canPerform({ ...operator, enabled: true }, action))
    throw new ManagementError("forbidden", 403);
  return operator;
}
async function highImpact(
  env: AdminEnv,
  operator: AuthenticatedOperator,
  action: StepUpAction,
  challenge?: string,
) {
  if (operator.provider === "passkey") requireRecentAuthentication(operator);
  else await consumeAccessStepUp(env, operator, action, challenge);
}
const operatorExists = "EXISTS (SELECT 1 FROM operators WHERE id = ? AND last_mutation_id = ?)";

app.patch("/api/operators/:id", async (c) => {
  const who = actor(c.get("operator"), "manage-operators");
  const id = z.uuid().parse(c.req.param("id"));
  const input = operatorUpdateSchema.parse(await c.req.json());
  if (id === who.id) throw new ManagementError("self-change-forbidden", 403);
  await highImpact(c.env, who, "operator.update", c.req.header("X-Step-Up-Challenge"));
  const db = c.env.ADMIN_DB,
    event = crypto.randomUUID(),
    now = Date.now();
  const results = await db.batch([
    db
      .prepare(
        "UPDATE operators SET role = ?, enabled = ?, version = version + 1, last_mutation_id = ?, updated_at = ? WHERE id = ? AND version = ?",
      )
      .bind(input.role, Number(input.enabled), event, now, id, input.version),
    db
      .prepare(`DELETE FROM admin_sessions WHERE operator_id = ? AND ${operatorExists}`)
      .bind(id, id, event),
    db
      .prepare(`DELETE FROM bootstrap_invites WHERE operator_id = ? AND ${operatorExists}`)
      .bind(id, id, event),
    db
      .prepare(`DELETE FROM webauthn_challenges WHERE operator_id = ? AND ${operatorExists}`)
      .bind(id, id, event),
    db
      .prepare(`DELETE FROM access_step_up_challenges WHERE operator_id = ? AND ${operatorExists}`)
      .bind(id, id, event),
    db
      .prepare(
        `INSERT INTO admin_audit_events (event_id,actor_id,action,target,after_json,occurred_at) SELECT ?,?,'operator.update',?,?,? WHERE ${operatorExists}`,
      )
      .bind(event, who.id, id, JSON.stringify(input), now, id, event),
  ]);
  if (results[0].meta.changes !== 1) throw new ManagementError("version-conflict");
  return c.json({ id, version: input.version + 1 });
});

app.delete("/api/operators/:id", async (c) => {
  const who = actor(c.get("operator"), "manage-operators");
  const id = z.uuid().parse(c.req.param("id"));
  const { version } = versionSchema.parse(await c.req.json());
  if (id === who.id) throw new ManagementError("self-change-forbidden", 403);
  await highImpact(c.env, who, "operator.delete", c.req.header("X-Step-Up-Challenge"));
  const db = c.env.ADMIN_DB,
    event = crypto.randomUUID();
  const statements = [
    db
      .prepare(
        "UPDATE operators SET enabled = 0, last_mutation_id = ? WHERE id = ? AND version = ?",
      )
      .bind(event, id, version),
  ];
  for (const table of [
    "admin_sessions",
    "bootstrap_invites",
    "webauthn_challenges",
    "access_step_up_challenges",
    "passkey_credentials",
    "operator_identities",
  ]) {
    statements.push(
      db
        .prepare(`DELETE FROM ${table} WHERE operator_id = ? AND ${operatorExists}`)
        .bind(id, id, event),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO admin_audit_events (event_id,actor_id,action,target,occurred_at) SELECT ?,?,'operator.delete',?,? WHERE ${operatorExists}`,
      )
      .bind(event, who.id, id, Date.now(), id, event),
    db.prepare("DELETE FROM operators WHERE id = ? AND last_mutation_id = ?").bind(id, event),
  );
  const result = await db.batch(statements);
  if (result[0].meta.changes !== 1) throw new ManagementError("version-conflict");
  return c.json({ ok: true });
});

app.post("/api/operators/:id/recovery", async (c) => {
  const who = actor(c.get("operator"), "manage-operators");
  if (adminConfig(c.env).ADMIN_AUTH_MODE !== "passkey")
    throw new ManagementError("passkey-disabled", 400);
  const id = z.uuid().parse(c.req.param("id"));
  const input = versionSchema.extend({ reason: reasonSchema }).parse(await c.req.json());
  if (id === who.id) throw new ManagementError("self-change-forbidden", 403);
  await highImpact(c.env, who, "operator.recover", c.req.header("X-Step-Up-Challenge"));
  const db = c.env.ADMIN_DB,
    event = crypto.randomUUID(),
    token = randomToken(),
    now = Date.now();
  const statements = [
    db
      .prepare(
        "UPDATE operators SET version = version + 1,last_mutation_id = ?,updated_at = ? WHERE id = ? AND enabled = 1 AND version = ?",
      )
      .bind(event, now, id, input.version),
    db
      .prepare(`DELETE FROM bootstrap_invites WHERE operator_id = ? AND ${operatorExists}`)
      .bind(id, id, event),
    db
      .prepare(
        `INSERT INTO bootstrap_invites (token_hash,operator_id,expires_at) SELECT ?,?,? WHERE ${operatorExists}`,
      )
      .bind(await sha256(token), id, now + 900_000, id, event),
  ];
  for (const table of ["admin_sessions", "webauthn_challenges", "passkey_credentials"])
    statements.push(
      db
        .prepare(`DELETE FROM ${table} WHERE operator_id = ? AND ${operatorExists}`)
        .bind(id, id, event),
    );
  statements.push(
    db
      .prepare(
        `INSERT INTO admin_audit_events (event_id,actor_id,action,target,after_json,occurred_at) SELECT ?,?,'operator.recover',?,?,? WHERE ${operatorExists}`,
      )
      .bind(event, who.id, id, JSON.stringify({ reason: input.reason }), now, id, event),
  );
  const result = await db.batch(statements);
  if (result[0].meta.changes !== 1) throw new ManagementError("version-conflict");
  return c.json({ invitationToken: token, expiresAt: now + 900_000 }, 201);
});

app.delete("/api/operators/:id/access-identity", async (c) => {
  const who = actor(c.get("operator"), "manage-operators");
  const id = z.uuid().parse(c.req.param("id"));
  const { version } = versionSchema.parse(await c.req.json());
  if (id === who.id) throw new ManagementError("self-change-forbidden", 403);
  await highImpact(c.env, who, "operator.update", c.req.header("X-Step-Up-Challenge"));
  const db = c.env.ADMIN_DB,
    event = crypto.randomUUID(),
    now = Date.now();
  const result = await db.batch([
    db
      .prepare(
        "UPDATE operators SET enabled = 0,version = version + 1,last_mutation_id = ?,updated_at = ? WHERE id = ? AND version = ?",
      )
      .bind(event, now, id, version),
    db
      .prepare(
        `DELETE FROM operator_identities WHERE operator_id = ? AND provider = 'cloudflare-access' AND ${operatorExists}`,
      )
      .bind(id, id, event),
    db
      .prepare(`DELETE FROM access_step_up_challenges WHERE operator_id = ? AND ${operatorExists}`)
      .bind(id, id, event),
    db
      .prepare(
        `INSERT INTO admin_audit_events (event_id,actor_id,action,target,occurred_at) SELECT ?,?,'operator.unlink',?,? WHERE ${operatorExists}`,
      )
      .bind(event, who.id, id, now, id, event),
  ]);
  if (result[0].meta.changes !== 1) throw new ManagementError("version-conflict");
  return c.json({ ok: true });
});

app.put("/api/operators/:id/access-identity", async (c) => {
  const who = actor(c.get("operator"), "manage-operators");
  const config = adminConfig(c.env);
  if (config.ADMIN_AUTH_MODE !== "cloudflare-access") throw new ManagementError("forbidden", 403);
  const id = z.uuid().parse(c.req.param("id"));
  const input = versionSchema
    .extend({ providerSubject: z.string().min(1).max(512) })
    .parse(await c.req.json());
  const prefix = `https://${config.ACCESS_TEAM_DOMAIN}|`;
  if (!input.providerSubject.startsWith(prefix) || input.providerSubject.length <= prefix.length)
    throw new ManagementError("invalid-input", 400);
  if (id === who.id) throw new ManagementError("self-change-forbidden", 403);
  await highImpact(c.env, who, "operator.update", c.req.header("X-Step-Up-Challenge"));
  const db = c.env.ADMIN_DB,
    event = crypto.randomUUID(),
    now = Date.now();
  const result = await db.batch([
    db
      .prepare(
        "UPDATE operators SET enabled=1,version=version+1,last_mutation_id=?,updated_at=? WHERE id=? AND version=?",
      )
      .bind(event, now, id, input.version),
    db
      .prepare(
        `DELETE FROM operator_identities WHERE operator_id=? AND provider='cloudflare-access' AND ${operatorExists}`,
      )
      .bind(id, id, event),
    db
      .prepare(
        `INSERT INTO operator_identities (provider,provider_subject,operator_id) SELECT 'cloudflare-access',?,? WHERE ${operatorExists}`,
      )
      .bind(input.providerSubject, id, id, event),
    db
      .prepare(`DELETE FROM access_step_up_challenges WHERE operator_id=? AND ${operatorExists}`)
      .bind(id, id, event),
    db
      .prepare(
        `INSERT INTO admin_audit_events (event_id,actor_id,action,target,after_json,occurred_at) SELECT ?,?,'operator.link',?,?,? WHERE ${operatorExists}`,
      )
      .bind(
        event,
        who.id,
        id,
        JSON.stringify({ providerSubject: input.providerSubject }),
        now,
        id,
        event,
      ),
  ]);
  if (result[0].meta.changes !== 1) throw new ManagementError("version-conflict");
  return c.json({ version: input.version + 1 });
});

app.get("/api/passkeys", async (c) => {
  const who = c.get("operator");
  if (who.provider !== "passkey") throw new ManagementError("passkey-disabled", 400);
  const rows = await c.env.ADMIN_DB.prepare(
    "SELECT credential_id,name,created_at,last_used_at FROM passkey_credentials WHERE operator_id = ? ORDER BY created_at",
  )
    .bind(who.id)
    .all();
  return c.json({ passkeys: rows.results });
});
app.post("/api/passkeys/options", async (c) => {
  const who = c.get("operator");
  requireRecentAuthentication(who);
  return c.json(await startAdditionalRegistration(c.env, who.id));
});
app.post("/api/passkeys/verify", async (c) => {
  const who = c.get("operator");
  requireRecentAuthentication(who);
  await finishAdditionalRegistration(c.env, who.id, await c.req.json());
  return c.json({ ok: true });
});
app.delete("/api/passkeys/:id", async (c) => {
  const who = c.get("operator");
  if (who.provider !== "passkey") throw new ManagementError("passkey-disabled", 400);
  requireRecentAuthentication(who);
  const id = z.string().min(1).max(1024).parse(c.req.param("id"));
  const db = c.env.ADMIN_DB;
  const event = crypto.randomUUID();
  const result = await db.batch([
    db
      .prepare(
        "INSERT INTO admin_audit_events (event_id,actor_id,action,target,occurred_at) SELECT ?,?,'passkey.delete',?,? FROM passkey_credentials WHERE credential_id = ? AND operator_id = ?",
      )
      .bind(event, who.id, who.id, Date.now(), id, who.id),
    db
      .prepare("DELETE FROM passkey_credentials WHERE credential_id = ? AND operator_id = ?")
      .bind(id, who.id),
    db
      .prepare(
        "DELETE FROM admin_sessions WHERE operator_id=? AND EXISTS (SELECT 1 FROM admin_audit_events WHERE event_id=?)",
      )
      .bind(who.id, event),
  ]);
  if (result[1].meta.changes !== 1) throw new ManagementError("not-found", 404);
  return c.json({ ok: true, signInAgain: true });
});

app.get("/api/audit", async (c) => {
  actor(c.get("operator"), "read");
  const input = z
    .object({
      q: z.string().max(256).default(""),
      from: z.coerce.number().int().nonnegative().default(0),
      to: z.coerce.number().int().nonnegative().default(Date.now()),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursorTime: z.coerce.number().int().nonnegative().optional(),
      cursorId: z.uuid().optional(),
    })
    .parse(c.req.query());
  if (input.from > input.to || (input.cursorTime === undefined) !== (input.cursorId === undefined))
    throw new ManagementError("invalid-input", 400);
  const values = [input.from, input.to, input.q];
  let condition =
    "occurred_at >= ? AND occurred_at <= ? AND instr(lower(actor_id || ' ' || action || ' ' || target),lower(?)) > 0";
  if (input.cursorTime !== undefined) {
    condition += " AND (occurred_at < ? OR (occurred_at = ? AND event_id < ?))";
    values.push(input.cursorTime, input.cursorTime, input.cursorId!);
  }
  const [policy, admin, issuance] = await Promise.all([
    c.env.POLICY_DB.prepare(
      `SELECT *, 'policy' AS source FROM policy_audit_events WHERE ${condition} ORDER BY occurred_at DESC,event_id DESC LIMIT ?`,
    )
      .bind(...values, input.limit + 1)
      .all(),
    c.env.ADMIN_DB.prepare(
      `SELECT *, 'admin' AS source FROM admin_audit_events WHERE ${condition} ORDER BY occurred_at DESC,event_id DESC LIMIT ?`,
    )
      .bind(...values, input.limit + 1)
      .all(),
    c.env.POLICY_DB.prepare(
      `SELECT *, 'issuance' AS source FROM (
        SELECT event_id,coalesce(client_id,'unidentified') AS actor_id,
          'issuance.' || outcome AS action,coalesce(audience,'unavailable') AS target,
          NULL AS before_json,
          json_object('requestId',request_id,'clientId',client_id,'audience',audience,
            'kid',kid,'outcome',outcome,'latencyMs',latency_ms) AS after_json,occurred_at
        FROM issuance_audit_events
      ) WHERE ${condition.replace("actor_id || ' ' || action || ' ' || target", "actor_id || ' ' || action || ' ' || target || ' ' || after_json")}
      ORDER BY occurred_at DESC,event_id DESC LIMIT ?`,
    )
      .bind(...values, input.limit + 1)
      .all(),
  ]);
  const rows = [...policy.results, ...admin.results, ...issuance.results].sort(
    (a, b) =>
      Number(b.occurred_at) - Number(a.occurred_at) ||
      (String(a.event_id) < String(b.event_id)
        ? 1
        : String(a.event_id) > String(b.event_id)
          ? -1
          : 0),
  );
  const events = rows.slice(0, input.limit),
    last = events.at(-1);
  return c.json({
    events,
    nextCursor:
      rows.length > input.limit && last ? { time: last.occurred_at, id: last.event_id } : null,
  });
});

app.get("/api/overview", async (c) => {
  actor(c.get("operator"), "read");
  return c.json(await overview(c.env));
});
app.post("/api/health/check", async (c) => {
  actor(c.get("operator"), "edit-policy");
  await checkHealth(c.env);
  return c.json({ ok: true });
});

app.post("/api/rotation-proposals", async (c) => {
  const who = actor(c.get("operator"), "edit-policy");
  const input = rotationPlanSchema.parse(await c.req.json());
  if (!c.env.ROTATION?.propose) throw new Error("rotation-unavailable");
  return c.json(await c.env.ROTATION.propose(input, who.id), 201);
});
app.post("/api/rotation-proposals/:id/approve", async (c) => {
  const who = actor(c.get("operator"), "rotate-keys"),
    id = z.uuid().parse(c.req.param("id"));
  await highImpact(c.env, who, "rotation.approve", c.req.header("X-Step-Up-Challenge"));
  if (!c.env.ROTATION?.approve) throw new Error("rotation-unavailable");
  return c.json(await c.env.ROTATION.approve(id, who.id), 202);
});
app.post("/api/rotations/:id/control", async (c) => {
  const who = actor(c.get("operator"), "rotate-keys"),
    id = z.uuid().parse(c.req.param("id"));
  const input = rotationControlSchema.parse(await c.req.json());
  await highImpact(c.env, who, "rotation.control", c.req.header("X-Step-Up-Challenge"));
  if (!c.env.ROTATION?.control) throw new Error("rotation-unavailable");
  return c.json(await c.env.ROTATION.control(id, input, who.id));
});
app.post("/api/rotations/:id/immediate", async (c) => {
  const who = actor(c.get("operator"), "rotate-keys"),
    id = z.uuid().parse(c.req.param("id"));
  const input = immediateRotationSchema.parse(await c.req.json());
  await highImpact(c.env, who, "rotation.immediate", c.req.header("X-Step-Up-Challenge"));
  if (!c.env.ROTATION?.immediateActivate) throw new Error("rotation-unavailable");
  return c.json(await c.env.ROTATION.immediateActivate(id, input, who.id));
});
app.put("/api/rotation-schedules", async (c) => {
  const who = actor(c.get("operator"), "rotate-keys"),
    input = rotationScheduleSchema.parse(await c.req.json());
  await highImpact(c.env, who, "rotation.schedule", c.req.header("X-Step-Up-Challenge"));
  if (!c.env.ROTATION?.configureSchedule) throw new Error("rotation-unavailable");
  return c.json(await c.env.ROTATION.configureSchedule(input, who.id));
});

export default app;
