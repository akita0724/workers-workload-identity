import { Hono } from "hono";
import { z } from "zod";
import management, { ManagementError } from "./management.js";
import { maintainAdmin } from "./operations.js";
import {
  accessStepUpStatus,
  completeAccessStepUp,
  consumeAccessStepUp,
  startAccessStepUp,
  stepUpAction,
} from "./access-step-up.js";
import {
  audienceCreateSchema,
  audienceUpdateSchema,
  clientCreateSchema,
  clientUpdateSchema,
  clientIdSchema,
  audienceSchema,
  versionSchema,
  operatorCreateSchema,
  rotationPlanSchema,
} from "@workers-workload-identity/contracts";
import { canPerform, type AdminAction } from "@workers-workload-identity/domain-operators";
import {
  adminConfig,
  authenticate,
  authenticateAccess,
  randomToken,
  requireRecentAuthentication,
  requireMutationProtection,
  sha256,
  type AdminEnv,
  type AuthenticatedOperator,
} from "./auth.js";
import {
  enforceAuthRateLimit,
  finishLogin,
  finishRegistration,
  startLogin,
  startRegistration,
} from "./passkey.js";

type App = { Bindings: AdminEnv; Variables: { operator: AuthenticatedOperator } };
const app = new Hono<App>();

function actor(c: { get(key: "operator"): AuthenticatedOperator }, action: AdminAction) {
  const operator = c.get("operator");
  if (!canPerform({ id: operator.id, role: operator.role, enabled: true }, action)) {
    throw new Error("forbidden");
  }
  return operator;
}

function assertOrigin(request: Request, origin: string) {
  if (request.headers.get("Origin") !== origin) throw new Error("invalid-origin");
}

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const config = adminConfig(c.env);
  const stepUpRequest =
    config.ADMIN_AUTH_MODE === "cloudflare-access" &&
    c.req.method === "GET" &&
    c.req.path === "/api/access-step-up/complete";
  const expectedOrigin = stepUpRequest ? config.ACCESS_STEP_UP_ORIGIN : config.ADMIN_ORIGIN;
  if (new URL(c.req.url).origin !== new URL(expectedOrigin!).origin)
    return c.json({ error: "not-found" }, 404);
  const publicPasskey =
    config.ADMIN_AUTH_MODE === "passkey" && c.req.path.startsWith("/api/auth/passkey/");
  const publicAsset = config.ADMIN_AUTH_MODE === "passkey" && !c.req.path.startsWith("/api/");
  if (publicPasskey || publicAsset) return next();
  let operator: AuthenticatedOperator | null;
  try {
    operator = stepUpRequest
      ? await authenticateAccess(c.req.raw, c.env, config.ACCESS_STEP_UP_AUD)
      : await authenticate(c.req.raw, c.env);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (!operator) return c.json({ error: "unauthorized" }, 401);
  c.set("operator", operator);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    requireMutationProtection(c.req.raw, operator, config.ADMIN_ORIGIN);
  }
  await next();
});

app.get("/api/auth/passkey/options", async (c) => {
  await enforceAuthRateLimit(c.env, c.req.raw);
  return c.json(await startLogin(c.env));
});
async function authenticationAttempt(
  env: AdminEnv,
  request: Request,
  action: string,
  operation: () => Promise<string>,
) {
  try {
    return await operation();
  } catch (error) {
    const source = await sha256(request.headers.get("CF-Connecting-IP") ?? "unknown");
    await env.ADMIN_DB.prepare(
      "INSERT INTO admin_audit_events (event_id,actor_id,action,target,after_json,occurred_at) VALUES (?,?,?,'passkey',?,?)",
    )
      .bind(
        crypto.randomUUID(),
        `source:${source}`,
        action,
        JSON.stringify({ result: "verification-failed" }),
        Date.now(),
      )
      .run();
    throw error;
  }
}
app.post("/api/auth/passkey/verify", async (c) => {
  assertOrigin(c.req.raw, adminConfig(c.env).ADMIN_ORIGIN);
  await enforceAuthRateLimit(c.env, c.req.raw);
  const body = await c.req.json();
  const cookie = await authenticationAttempt(c.env, c.req.raw, "auth.login-failed", () =>
    finishLogin(c.env, body),
  );
  return c.json({ ok: true }, 200, { "Set-Cookie": cookie });
});
app.post("/api/auth/passkey/register/options", async (c) => {
  assertOrigin(c.req.raw, adminConfig(c.env).ADMIN_ORIGIN);
  await enforceAuthRateLimit(c.env, c.req.raw);
  const { invitationToken } = z
    .strictObject({ invitationToken: z.string().min(32) })
    .parse(await c.req.json());
  return c.json(await startRegistration(c.env, invitationToken));
});
app.post("/api/auth/passkey/register/verify", async (c) => {
  assertOrigin(c.req.raw, adminConfig(c.env).ADMIN_ORIGIN);
  await enforceAuthRateLimit(c.env, c.req.raw);
  const body = await c.req.json();
  const cookie = await authenticationAttempt(c.env, c.req.raw, "auth.registration-failed", () =>
    finishRegistration(c.env, body),
  );
  return c.json({ ok: true }, 200, { "Set-Cookie": cookie });
});

app.get("/api/me", (c) => {
  const operator = actor(c, "read");
  return c.json({
    id: operator.id,
    role: operator.role,
    provider: operator.provider,
    authenticatedAt: operator.authenticatedAt,
    csrfToken: operator.csrfToken,
  });
});
app.post("/api/access-step-up/challenges", async (c) => {
  const { action } = z.strictObject({ action: stepUpAction }).parse(await c.req.json());
  const id = await startAccessStepUp(c.env, c.get("operator"), action);
  const config = adminConfig(c.env);
  if (config.ADMIN_AUTH_MODE !== "cloudflare-access") throw new Error("forbidden");
  return c.json(
    {
      challengeId: id,
      url: `${config.ACCESS_STEP_UP_ORIGIN}/api/access-step-up/complete?id=${encodeURIComponent(id)}`,
    },
    200,
    { "Cache-Control": "no-store" },
  );
});
app.get("/api/access-step-up/challenges/:id", async (c) => {
  const id = z.uuid().parse(c.req.param("id"));
  const completed = await accessStepUpStatus(c.env, c.get("operator"), id);
  return c.json({ completed }, 200, { "Cache-Control": "no-store" });
});
app.get("/api/access-step-up/complete", async (c) => {
  const id = z.uuid().parse(c.req.query("id"));
  await completeAccessStepUp(c.env, c.get("operator"), id);
  const ja = /^\s*ja\b/i.test(c.req.header("Accept-Language") ?? "");
  return c.html(
    ja
      ? '<!doctype html><html lang="ja"><meta charset="utf-8"><title>確認完了</title><body><p>操作を確認しました。この画面は閉じても構いません。</p></body></html>'
      : '<!doctype html><html lang="en"><meta charset="utf-8"><title>Verification complete</title><body><p>The action has been verified. You can close this window.</p></body></html>',
    200,
    {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  );
});
app.post("/api/logout", async (c) => {
  const operator = actor(c, "read");
  if (operator.provider === "passkey") {
    const cookie = c.req.header("Cookie") ?? "";
    const token = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("oidc_admin_session="))
      ?.slice("oidc_admin_session=".length);
    if (token) {
      await c.env.ADMIN_DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
        .bind(await sha256(token))
        .run();
    }
  }
  return c.json({ ok: true }, 200, {
    "Set-Cookie": "oidc_admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
  });
});

app.route("/", management);

app.get("/api/clients", async (c) => {
  actor(c, "read");
  const clients = await c.env.POLICY_DB.prepare(
    "SELECT client_id, subject, enabled, version, created_at, updated_at FROM clients ORDER BY client_id",
  ).all();
  const grants = await c.env.POLICY_DB.prepare(
    "SELECT client_id, audience FROM client_audience_grants ORDER BY audience",
  ).all();
  return c.json({ clients: clients.results, grants: grants.results });
});

app.post("/api/clients", async (c) => {
  const operator = actor(c, "edit-policy");
  const input = clientCreateSchema.parse(await c.req.json());
  if (new Set(input.audiences).size !== input.audiences.length)
    throw new Error("duplicate-audience");
  const now = Date.now();
  const eventId = crypto.randomUUID();
  const statements = [
    c.env.POLICY_DB.prepare(
      "INSERT INTO clients (client_id, subject, enabled, version, last_mutation_id, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
    ).bind(input.clientId, input.subject, Number(input.enabled), eventId, now, now),
    ...input.audiences.map((audience) =>
      c.env.POLICY_DB.prepare(
        "INSERT INTO client_audience_grants (client_id, audience) VALUES (?, ?)",
      ).bind(input.clientId, audience),
    ),
    c.env.POLICY_DB.prepare(
      "INSERT INTO policy_audit_events (event_id, actor_id, action, target, after_json, occurred_at) VALUES (?, ?, 'client.create', ?, ?, ?)",
    ).bind(eventId, operator.id, input.clientId, JSON.stringify(input), now),
  ];
  await c.env.POLICY_DB.batch(statements);
  return c.json({ clientId: input.clientId, version: 0 }, 201);
});

app.patch("/api/clients/:clientId", async (c) => {
  const operator = actor(c, "edit-policy");
  const input = clientUpdateSchema.parse(await c.req.json());
  if (new Set(input.audiences).size !== input.audiences.length)
    throw new Error("duplicate-audience");
  const clientId = c.req.param("clientId");
  const eventId = crypto.randomUUID();
  const now = Date.now();
  const db = c.env.POLICY_DB;
  const statements = [
    db
      .prepare(
        "UPDATE clients SET enabled = ?, version = version + 1, last_mutation_id = ?, updated_at = ? WHERE client_id = ? AND version = ?",
      )
      .bind(Number(input.enabled), eventId, now, clientId, input.version),
    db
      .prepare(
        "DELETE FROM client_audience_grants WHERE client_id = ? AND EXISTS (SELECT 1 FROM clients WHERE client_id = ? AND last_mutation_id = ?)",
      )
      .bind(clientId, clientId, eventId),
    ...input.audiences.map((audience) =>
      db
        .prepare(
          "INSERT INTO client_audience_grants (client_id, audience) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM clients WHERE client_id = ? AND last_mutation_id = ?)",
        )
        .bind(clientId, audience, clientId, eventId),
    ),
    db
      .prepare(
        "INSERT INTO policy_audit_events (event_id, actor_id, action, target, after_json, occurred_at) SELECT ?, ?, 'client.update', ?, ?, ? WHERE EXISTS (SELECT 1 FROM clients WHERE client_id = ? AND last_mutation_id = ?)",
      )
      .bind(eventId, operator.id, clientId, JSON.stringify(input), now, clientId, eventId),
  ];
  const results = await db.batch(statements);
  if (results[0]?.meta.changes !== 1) return c.json({ error: "version-conflict" }, 409);
  return c.json({ clientId, version: input.version + 1 });
});

app.delete("/api/clients/:clientId", async (c) => {
  const operator = actor(c, "edit-policy");
  const clientId = clientIdSchema.parse(c.req.param("clientId"));
  const { version } = versionSchema.parse(await c.req.json());
  const db = c.env.POLICY_DB;
  const eventId = crypto.randomUUID();
  // The snapshot, eligibility check, audit, and deletion share one D1 transaction.
  const results = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT version, enabled FROM clients WHERE client_id = ?").bind(clientId),
    db
      .prepare(`INSERT INTO policy_audit_events
      (event_id, actor_id, action, target, before_json, after_json, occurred_at)
      SELECT ?, ?, 'client.delete', client_id,
        json_object('clientId', client_id, 'subject', subject, 'enabled', enabled,
          'version', version, 'createdAt', created_at, 'updatedAt', updated_at,
          'audiences', json((SELECT json_group_array(audience) FROM
            (SELECT audience FROM client_audience_grants WHERE client_id = ? ORDER BY audience)))),
        'null', ? FROM clients WHERE client_id = ? AND version = ? AND enabled = 0`)
      .bind(eventId, operator.id, clientId, Date.now(), clientId, version),
    db
      .prepare(`DELETE FROM issuance_rate_limits WHERE client_id = ?
      AND EXISTS (SELECT 1 FROM policy_audit_events WHERE event_id = ?)`)
      .bind(clientId, eventId),
    // Grants cascade; durable audit and issuance history have no parent foreign key.
    db
      .prepare(`DELETE FROM clients WHERE client_id = ?
      AND EXISTS (SELECT 1 FROM policy_audit_events WHERE event_id = ?)`)
      .bind(clientId, eventId),
  ]);
  const previous = results[0].results[0];
  if (!previous) return c.json({ error: "not-found" }, 404);
  if (previous.version !== version) return c.json({ error: "version-conflict" }, 409);
  if (previous.enabled !== 0) return c.json({ error: "client-must-be-disabled" }, 409);
  return c.json({ clientId, deleted: true });
});

app.get("/api/audiences", async (c) => {
  actor(c, "read");
  const result = await c.env.POLICY_DB.prepare(
    "SELECT audience, algorithm, token_lifetime_seconds, description, verified_for_es256, exchange_verified, mixed_jwks_verified, jwks_cache_seconds, version, created_at, updated_at FROM audiences ORDER BY audience",
  ).all();
  return c.json({ audiences: result.results });
});

type AudienceInput = z.infer<typeof audienceCreateSchema>;
async function validateAudienceEvidence(
  env: AdminEnv,
  input: AudienceInput,
  role: AuthenticatedOperator["role"],
  updating = false,
) {
  if (input.algorithm === "ES256" && !input.verifiedForEs256)
    throw new ManagementError("es256-not-verified", 400);
  if (role === "security-admin") return;
  const previous = updating
    ? await env.POLICY_DB.prepare(
        "SELECT algorithm,verified_for_es256,exchange_verified,mixed_jwks_verified,jwks_cache_seconds FROM audiences WHERE audience=?",
      )
        .bind(input.audience)
        .first<{
          algorithm: string;
          verified_for_es256: number;
          exchange_verified: number;
          mixed_jwks_verified: number;
          jwks_cache_seconds: number | null;
        }>()
    : null;
  if (
    input.verifiedForEs256 !== Boolean(previous?.verified_for_es256) ||
    input.exchangeVerified !== Boolean(previous?.exchange_verified) ||
    input.mixedJwksVerified !== Boolean(previous?.mixed_jwks_verified) ||
    (previous &&
      input.algorithm !== previous.algorithm &&
      (input.exchangeVerified || input.mixedJwksVerified)) ||
    input.jwksCacheSeconds !== (previous?.jwks_cache_seconds ?? null) ||
    (input.algorithm === "ES256" && previous?.algorithm !== "ES256")
  )
    throw new ManagementError("forbidden", 403);
}

app.post("/api/audiences", async (c) => {
  const operator = actor(c, "edit-policy");
  const input = audienceCreateSchema.parse(await c.req.json());
  await validateAudienceEvidence(c.env, input, operator.role);
  const now = Date.now();
  const eventId = crypto.randomUUID();
  await c.env.POLICY_DB.batch([
    c.env.POLICY_DB.prepare(
      "INSERT INTO audiences (audience, algorithm, token_lifetime_seconds, description, verified_for_es256, exchange_verified, mixed_jwks_verified, jwks_cache_seconds, version, last_mutation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    ).bind(
      input.audience,
      input.algorithm,
      input.tokenLifetimeSeconds,
      input.description,
      Number(input.verifiedForEs256),
      Number(input.exchangeVerified),
      Number(input.mixedJwksVerified),
      input.jwksCacheSeconds,
      eventId,
      now,
      now,
    ),
    c.env.POLICY_DB.prepare(
      "INSERT INTO policy_audit_events (event_id, actor_id, action, target, after_json, occurred_at) VALUES (?, ?, 'audience.create', ?, ?, ?)",
    ).bind(eventId, operator.id, input.audience, JSON.stringify(input), now),
  ]);
  return c.json({ audience: input.audience, version: 0 }, 201);
});

app.patch("/api/audiences", async (c) => {
  const operator = actor(c, "edit-policy");
  const input = audienceUpdateSchema
    .extend({ audience: audienceCreateSchema.shape.audience })
    .parse(await c.req.json());
  await validateAudienceEvidence(c.env, input, operator.role, true);
  const eventId = crypto.randomUUID();
  const now = Date.now();
  const results = await c.env.POLICY_DB.batch([
    c.env.POLICY_DB.prepare(
      "UPDATE audiences SET algorithm = ?, token_lifetime_seconds = ?, description = ?, verified_for_es256 = ?, exchange_verified = ?, mixed_jwks_verified = ?, jwks_cache_seconds = ?, version = version + 1, last_mutation_id = ?, updated_at = ? WHERE audience = ? AND version = ?",
    ).bind(
      input.algorithm,
      input.tokenLifetimeSeconds,
      input.description,
      Number(input.verifiedForEs256),
      Number(input.exchangeVerified),
      Number(input.mixedJwksVerified),
      input.jwksCacheSeconds,
      eventId,
      now,
      input.audience,
      input.version,
    ),
    c.env.POLICY_DB.prepare(
      "INSERT INTO policy_audit_events (event_id, actor_id, action, target, after_json, occurred_at) SELECT ?, ?, 'audience.update', ?, ?, ? WHERE EXISTS (SELECT 1 FROM audiences WHERE audience = ? AND last_mutation_id = ?)",
    ).bind(
      eventId,
      operator.id,
      input.audience,
      JSON.stringify(input),
      now,
      input.audience,
      eventId,
    ),
  ]);
  if (results[0]?.meta.changes !== 1) return c.json({ error: "version-conflict" }, 409);
  return c.json({ audience: input.audience, version: input.version + 1 });
});

app.delete("/api/audiences", async (c) => {
  const operator = actor(c, "edit-policy");
  // Audience values may contain '/', '?', '#', or percent escapes: keep them in JSON.
  const { audience, version } = versionSchema
    .extend({ audience: audienceSchema })
    .parse(await c.req.json());
  const db = c.env.POLICY_DB;
  const eventId = crypto.randomUUID();
  const results = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT version FROM audiences WHERE audience = ?").bind(audience),
    db
      .prepare("SELECT client_id FROM client_audience_grants WHERE audience = ? ORDER BY client_id")
      .bind(audience),
    db
      .prepare(`INSERT INTO policy_audit_events
      (event_id, actor_id, action, target, before_json, after_json, occurred_at)
      SELECT ?, ?, 'audience.delete', audience,
        json_object('audience', audience, 'algorithm', algorithm,
          'tokenLifetimeSeconds', token_lifetime_seconds, 'description', description,
          'verifiedForEs256', verified_for_es256, 'exchangeVerified', exchange_verified,
          'mixedJwksVerified', mixed_jwks_verified, 'jwksCacheSeconds', jwks_cache_seconds,
          'version', version, 'createdAt', created_at, 'updatedAt', updated_at),
        'null', ? FROM audiences WHERE audience = ? AND version = ?
        AND NOT EXISTS (SELECT 1 FROM client_audience_grants WHERE audience = ?)`)
      .bind(eventId, operator.id, Date.now(), audience, version, audience),
    db
      .prepare(`DELETE FROM audiences WHERE audience = ?
      AND EXISTS (SELECT 1 FROM policy_audit_events WHERE event_id = ?)`)
      .bind(audience, eventId),
  ]);
  const previous = results[0].results[0];
  if (!previous) return c.json({ error: "not-found" }, 404);
  if (previous.version !== version) return c.json({ error: "version-conflict" }, 409);
  if (results[1].results.length)
    return c.json(
      { error: "audience-in-use", clientIds: results[1].results.map((row) => row.client_id) },
      409,
    );
  return c.json({ audience, deleted: true });
});

app.get("/api/operators", async (c) => {
  actor(c, "manage-operators");
  const rows = await c.env.ADMIN_DB.prepare(
    "SELECT id, role, enabled, version, created_at, updated_at, (SELECT provider_subject FROM operator_identities i WHERE i.operator_id=operators.id AND provider='cloudflare-access' LIMIT 1) AS provider_subject FROM operators ORDER BY created_at",
  ).all();
  return c.json({ operators: rows.results });
});

app.post("/api/operators", async (c) => {
  const operator = actor(c, "manage-operators");
  if (operator.provider === "passkey") requireRecentAuthentication(operator);
  const input = operatorCreateSchema.parse(await c.req.json());
  if (operator.provider === "cloudflare-access")
    await consumeAccessStepUp(
      c.env,
      operator,
      "operator.create",
      c.req.header("X-Step-Up-Challenge"),
    );
  const provider = adminConfig(c.env).ADMIN_AUTH_MODE;
  if (provider === "cloudflare-access" && !input.providerSubject) {
    throw new Error("missing-provider-subject");
  }
  if (provider === "passkey" && input.providerSubject) {
    throw new Error("unexpected-provider-subject");
  }
  const now = Date.now();
  const eventId = crypto.randomUUID();
  const invitationToken = provider === "passkey" ? randomToken() : undefined;
  const statements = [
    c.env.ADMIN_DB.prepare(
      "INSERT INTO operators (id, role, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
    ).bind(input.id, input.role, now, now),
    c.env.ADMIN_DB.prepare(
      "INSERT INTO admin_audit_events (event_id, actor_id, action, target, after_json, occurred_at) VALUES (?, ?, 'operator.create', ?, ?, ?)",
    ).bind(eventId, operator.id, input.id, JSON.stringify({ role: input.role, provider }), now),
  ];
  if (provider === "cloudflare-access") {
    statements.push(
      c.env.ADMIN_DB.prepare(
        "INSERT INTO operator_identities (provider, provider_subject, operator_id) VALUES ('cloudflare-access', ?, ?)",
      ).bind(input.providerSubject, input.id),
    );
  } else {
    statements.push(
      c.env.ADMIN_DB.prepare(
        "INSERT INTO bootstrap_invites (token_hash, operator_id, expires_at) VALUES (?, ?, ?)",
      ).bind(await sha256(invitationToken!), input.id, now + 15 * 60_000),
    );
  }
  await c.env.ADMIN_DB.batch(statements);
  return c.json({ id: input.id, invitationToken }, 201);
});

app.get("/api/keys", async (c) => {
  actor(c, "read");
  if (!c.env.ROTATION) throw new Error("rotation-unavailable");
  return c.json({ keys: await c.env.ROTATION.listKeys() });
});

app.post("/api/rotations", async (c) => {
  const operator = actor(c, "rotate-keys");
  if (operator.provider === "passkey") requireRecentAuthentication(operator);
  if (!c.env.ROTATION) throw new Error("rotation-unavailable");
  const input = rotationPlanSchema.parse(await c.req.json());
  if (operator.provider === "cloudflare-access")
    await consumeAccessStepUp(
      c.env,
      operator,
      "rotation.plan",
      c.req.header("X-Step-Up-Challenge"),
    );
  return c.json(await c.env.ROTATION.plan(input), 202);
});

app.all("/api/*", (c) => c.json({ error: "not-found" }, 404));
app.get("*", async (c) => {
  if (!c.env.ASSETS) return c.text("Admin UI unavailable", 503);
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (c.env.ADMIN_BASE_PATH && response.headers.get("Content-Type")?.includes("text/html")) {
    return new HTMLRewriter()
      .on("head", {
        element(element) {
          element.prepend(`<base href="${c.env.ADMIN_BASE_PATH}">`, { html: true });
        },
      })
      .transform(response);
  }
  return response;
});
const knownErrors: Record<string, [string, 400 | 403 | 409 | 503]> = {
  "passkey-disabled": ["passkey-disabled", 400],
  "invalid-passkey": ["invalid-passkey", 400],
  "invalid-invitation": ["invalid-invitation", 400],
  "invitation-mismatch": ["invalid-invitation", 400],
  "operator-disabled": ["operator-disabled", 403],
  "challenge-used": ["challenge-used", 409],
  "counter-conflict": ["challenge-used", 409],
  "passkey-limit": ["passkey-limit", 409],
  "version-conflict": ["version-conflict", 409],
  "rotation activation conflict": ["version-conflict", 409],
  "schedule-date-invalid": ["schedule-date-invalid", 400],
  "automatic-rotation-not-verified": ["automatic-rotation-not-verified", 409],
  "audience cache behavior is not verified": ["automatic-rotation-not-verified", 409],
  "proposal-approval-denied": ["proposal-approval-denied", 409],
  "rotation-control-denied": ["rotation-control-denied", 409],
  "rotation is not published": ["rotation-control-denied", 409],
  "issuer version is not deployed at 100 percent": ["rotation-not-ready", 409],
  "new secret is not bound in the serving version": ["rotation-not-ready", 409],
  "new key absent from public JWKS": ["rotation-not-ready", 409],
  "rotation-unavailable": ["rotation-unavailable", 503],
};
app.onError((error, c) => {
  if (error instanceof ManagementError) return c.json({ error: error.code }, error.status);
  if (["last-security-admin", "last-passkey"].some((code) => error.message.includes(code)))
    return c.json(
      {
        error: error.message.includes("last-security-admin")
          ? "last-security-admin"
          : "last-passkey",
      },
      409,
    );
  if (error instanceof z.ZodError) return c.json({ error: "invalid-input" }, 400);
  if (error instanceof SyntaxError) return c.json({ error: "invalid-input" }, 400);
  if (error.message === "forbidden") return c.json({ error: "forbidden" }, 403);
  if (error.message === "invalid-origin" || error.message === "invalid-csrf") {
    return c.json({ error: "invalid-request" }, 403);
  }
  if (error.message === "reauth-required") return c.json({ error: "reauth-required" }, 403);
  if (error.message === "auth-rate-limited") return c.json({ error: "rate-limited" }, 429);
  // Rotation Controller RPC errors keep their message across the Service Binding.
  const known = knownErrors[error.message];
  if (known) return c.json({ error: known[0] }, known[1]);
  return c.json({ error: "unavailable" }, 503);
});

export default Object.assign(app, {
  async scheduled(_event: ScheduledController, env: AdminEnv) {
    await maintainAdmin(env);
  },
});
