import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { createSession } from "./auth.js";
import { maintainAdmin, checkHealth, overview } from "./operations.js";
const id = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  origin = "https://admin.example.com";
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.ADMIN_DB, env.ADMIN_MIGRATIONS);
  await applyD1Migrations(env.POLICY_DB, env.POLICY_MIGRATIONS);
  await env.ADMIN_DB.prepare(
    "INSERT INTO operators (id,role,enabled,created_at,updated_at) VALUES (?,'security-admin',1,0,0),(?,'viewer',1,0,0)",
  )
    .bind(id, other)
    .run();
});
async function headers(who = id) {
  const cookie = (await createSession(env.ADMIN_DB, env.CSRF_SECRET, who)).split(";")[0];
  const me = await (
    await exports.default.fetch(origin + "/api/me", { headers: { Cookie: cookie } })
  ).json<{ csrfToken: string }>();
  return {
    Cookie: cookie,
    Origin: origin,
    "X-CSRF-Token": me.csrfToken,
    "Content-Type": "application/json",
  };
}
async function call(path: string, method = "GET", body?: unknown, h?: Record<string, string>) {
  return exports.default.fetch(origin + "/api" + path, {
    method,
    headers: h ?? (await headers()),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
describe("management lifecycle", () => {
  it("revokes sessions on role changes and prevents stale edits and self changes", async () => {
    const viewer = await headers(other),
      admin = await headers();
    expect(
      (
        await call(
          `/operators/${other}`,
          "PATCH",
          { version: 0, role: "operator", enabled: true },
          viewer,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          `/operators/${id}`,
          "PATCH",
          { version: 0, role: "viewer", enabled: true },
          admin,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          `/operators/${other}`,
          "PATCH",
          { version: 0, role: "operator", enabled: true },
          admin,
        )
      ).status,
    ).toBe(200);
    expect((await call("/me", "GET", undefined, viewer)).status).toBe(401);
    expect(
      (
        await call(
          `/operators/${other}`,
          "PATCH",
          { version: 0, role: "viewer", enabled: true },
          admin,
        )
      ).status,
    ).toBe(409);
    expect(
      await env.ADMIN_DB.prepare("SELECT role,version FROM operators WHERE id=?")
        .bind(other)
        .first(),
    ).toEqual({ role: "operator", version: 1 });
    await expect(
      env.ADMIN_DB.prepare("UPDATE operators SET enabled=0 WHERE id=?").bind(id).run(),
    ).rejects.toThrow("last-security-admin");
  });
  it("issues a bounded recovery invitation, revokes credentials and sessions, and does not log the token", async () => {
    await env.ADMIN_DB.prepare(
      "INSERT INTO passkey_credentials (credential_id,operator_id,public_key,counter,transports_json,created_at) VALUES ('lost',?,?,0,'[]',0)",
    )
      .bind(other, [1, 2])
      .run();
    const viewer = await headers(other),
      admin = await headers();
    expect(
      (
        await call(
          `/operators/${other}/recovery`,
          "POST",
          { version: 1, reason: "Device was lost" },
          admin,
        )
      ).status,
    ).toBe(409);
    expect(
      await env.ADMIN_DB.prepare("SELECT COUNT(*) n FROM passkey_credentials").first("n"),
    ).toBe(1);
    const res = await call(
      `/operators/${other}/recovery`,
      "POST",
      { version: 0, reason: "Identity checked, device lost" },
      admin,
    );
    expect(res.status).toBe(201);
    const payload = await res.json<{ invitationToken: string; expiresAt: number }>();
    expect(payload.invitationToken.length).toBeGreaterThan(32);
    expect(payload.expiresAt - Date.now()).toBeLessThanOrEqual(900_000);
    expect((await call("/me", "GET", undefined, viewer)).status).toBe(401);
    expect(
      await env.ADMIN_DB.prepare("SELECT COUNT(*) n FROM passkey_credentials").first("n"),
    ).toBe(0);
    const audit = await env.ADMIN_DB.prepare(
      "SELECT after_json FROM admin_audit_events WHERE action='operator.recover'",
    ).first<string>("after_json");
    expect(audit).not.toContain(payload.invitationToken);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("deletes an operator and all foreign-key children while preserving audit", async () => {
    await env.ADMIN_DB.prepare(
      "INSERT INTO operator_identities VALUES ('cloudflare-access','issuer|person',?)",
    )
      .bind(other)
      .run();
    const viewer = await headers(other),
      admin = await headers();
    expect((await call(`/operators/${other}`, "DELETE", { version: 0 }, admin)).status).toBe(200);
    expect((await call("/me", "GET", undefined, viewer)).status).toBe(401);
    expect(
      await env.ADMIN_DB.prepare("SELECT * FROM operators WHERE id=?").bind(other).first(),
    ).toBeNull();
    expect(
      await env.ADMIN_DB.prepare(
        "SELECT COUNT(*) n FROM admin_audit_events WHERE action='operator.delete'",
      ).first("n"),
    ).toBe(1);
  });
  it("guards the last credential, enforces ownership and revokes sessions on deletion", async () => {
    for (const [credential, owner] of [
      ["one", id],
      ["two", id],
      ["theirs", other],
    ])
      await env.ADMIN_DB.prepare(
        "INSERT INTO passkey_credentials (credential_id,operator_id,public_key,counter,transports_json,created_at) VALUES (?,?,?,0,'[]',0)",
      )
        .bind(credential, owner, [1, 2])
        .run();
    const admin = await headers();
    expect((await call("/passkeys/theirs", "DELETE", undefined, admin)).status).toBe(404);
    expect((await call("/passkeys/two", "DELETE", undefined, admin)).status).toBe(200);
    expect((await call("/me", "GET", undefined, admin)).status).toBe(401);
    const fresh = await headers();
    expect((await call("/passkeys/one", "DELETE", undefined, fresh)).status).toBe(409);
    expect(
      await env.ADMIN_DB.prepare(
        "SELECT COUNT(*) n FROM admin_audit_events WHERE action='passkey.delete'",
      ).first("n"),
    ).toBe(1);
  });
  it("searches both audit sources and pages equal timestamps without duplicates", async () => {
    for (let i = 0; i < 6; i++) {
      const db = i % 2 ? env.ADMIN_DB : env.POLICY_DB,
        table = i % 2 ? "admin_audit_events" : "policy_audit_events";
      await db
        .prepare(
          `INSERT INTO ${table} (event_id,actor_id,action,target,occurred_at) VALUES (?,?,'test.edit','needle',12345)`,
        )
        .bind(`00000000-0000-4000-8000-00000000000${i}`, id)
        .run();
    }
    const admin = await headers();
    let cursor = "",
      all: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await call(
        `/audit?q=needle&from=10000&to=20000&limit=2${cursor}`,
        "GET",
        undefined,
        admin,
      );
      const data = await res.json<{
        events: { event_id: string }[];
        nextCursor: { time: number; id: string } | null;
      }>();
      all.push(...data.events.map((e) => e.event_id));
      cursor = data.nextCursor
        ? `&cursorTime=${data.nextCursor.time}&cursorId=${data.nextCursor.id}`
        : "";
    }
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
    expect((await call("/audit?from=20&to=10", "GET", undefined, admin)).status).toBe(400);
  });
  it("finds issuance audits by correlation ID and merges equal timestamps with policy events", async () => {
    const requestId = crypto.randomUUID();
    for (let i = 0; i < 3; i++) {
      const eventId = `00000000-0000-4000-8000-00000000000${i}`;
      if (i === 1)
        await env.POLICY_DB.prepare(
          "INSERT INTO policy_audit_events (event_id,actor_id,action,target,occurred_at) VALUES (?,?,'test.edit','urn:test',12345)",
        )
          .bind(eventId, id)
          .run();
      else
        await env.POLICY_DB.prepare(
          "INSERT INTO issuance_audit_events VALUES (?,?, 'test-caller','urn:test','public-key','success',12,12345)",
        )
          .bind(eventId, requestId)
          .run();
    }
    const admin = await headers();
    const result = await (
      await call(`/audit?q=${requestId}&from=10000&to=20000`, "GET", undefined, admin)
    ).json<{ events: { source: string; after_json: string }[] }>();
    expect(result.events).toHaveLength(2);
    expect(result.events.every((row) => row.source === "issuance")).toBe(true);
    expect(JSON.parse(result.events[0].after_json)).toMatchObject({
      requestId,
      clientId: "test-caller",
      kid: "public-key",
      latencyMs: 12,
    });
    const first = await (
      await call("/audit?q=urn:test&from=10000&to=20000&limit=2", "GET", undefined, admin)
    ).json<{ events: { event_id: string }[]; nextCursor: { time: number; id: string } }>();
    const last = await (
      await call(
        `/audit?q=urn:test&from=10000&to=20000&limit=2&cursorTime=${first.nextCursor.time}&cursorId=${first.nextCursor.id}`,
        "GET",
        undefined,
        admin,
      )
    ).json<{ events: { event_id: string }[]; nextCursor: unknown }>();
    expect(new Set([...first.events, ...last.events].map((row) => row.event_id)).size).toBe(3);
    expect(last.nextCursor).toBeNull();
  });

  it("restricts recipient confirmations to security administrators while preserving ordinary operator edits", async () => {
    const admin = await headers();
    const payload = {
      audience: "urn:confirmed",
      algorithm: "RS256",
      tokenLifetimeSeconds: 300,
      exchangeVerified: true,
      mixedJwksVerified: true,
      jwksCacheSeconds: 60,
    };
    await env.ADMIN_DB.prepare("UPDATE operators SET role='operator' WHERE id=?").bind(other).run();
    const operator = await headers(other);
    expect((await call("/audiences", "POST", payload, operator)).status).toBe(403);
    expect((await call("/audiences", "POST", payload, admin)).status).toBe(201);
    expect(
      (
        await call(
          "/audiences",
          "PATCH",
          { ...payload, version: 0, exchangeVerified: false },
          operator,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "/audiences",
          "PATCH",
          { ...payload, version: 0, tokenLifetimeSeconds: 120 },
          operator,
        )
      ).status,
    ).toBe(200);
    const data = await (
      await call("/audiences", "GET", undefined, operator)
    ).json<{ audiences: Record<string, unknown>[] }>();
    expect(data.audiences[0]).toMatchObject({ exchange_verified: 1, mixed_jwks_verified: 1 });
    expect(
      (
        await call(
          "/audiences",
          "PATCH",
          { ...payload, version: 1, exchangeVerified: false },
          admin,
        )
      ).status,
    ).toBe(200);
    expect(
      await env.POLICY_DB.prepare(
        "SELECT exchange_verified FROM audiences WHERE audience='urn:confirmed'",
      ).first("exchange_verified"),
    ).toBe(0);
  });

  it("validates metadata and JWKS, records failures without raw response content", async () => {
    const issuer = "https://issuer.example.com";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("jwks.json")
          ? Response.json({
              keys: [{ kid: "key", alg: "RS256", kty: "RSA", d: "never-store-this" }],
            })
          : Response.json({ issuer, jwks_uri: issuer + "/jwks.json" }),
      ),
    );
    try {
      await checkHealth({ ...env, ISSUER_URL: issuer });
      const checks = await env.ADMIN_DB.prepare(
        "SELECT name,healthy,detail FROM health_checks ORDER BY name",
      ).all();
      expect(checks.results).toEqual([
        { name: "discovery", healthy: 1, detail: "ok" },
        { name: "jwks", healthy: 0, detail: "unavailable-or-invalid" },
      ]);
      expect(JSON.stringify(checks)).not.toContain("never-store-this");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("accepts an issuer URL with a trailing slash as the issuer publishes it", async () => {
    const issuer = "https://issuer.example.com/oidc/";
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        return String(input).endsWith("jwks.json")
          ? Response.json({ keys: [{ kid: "key", alg: "RS256", kty: "RSA" }] })
          : Response.json({ issuer, jwks_uri: "https://issuer.example.com/oidc/jwks.json" });
      }),
    );
    try {
      await checkHealth({ ...env, ISSUER_URL: issuer });
      expect(fetched).toEqual([
        "https://issuer.example.com/oidc/.well-known/openid-configuration",
        "https://issuer.example.com/oidc/jwks.json",
      ]);
      expect(
        (await env.ADMIN_DB.prepare("SELECT healthy FROM health_checks ORDER BY name").all())
          .results,
      ).toEqual([{ healthy: 1 }, { healthy: 1 }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("lets operators edit policy without changing security-admin verification evidence", async () => {
    const admin = await headers();
    const payload = {
      audience: "urn:verified",
      algorithm: "RS256",
      tokenLifetimeSeconds: 300,
      description: "Verified audience",
      jwksCacheSeconds: 60,
    };
    expect((await call("/audiences", "POST", payload, admin)).status).toBe(201);
    await env.ADMIN_DB.prepare("UPDATE operators SET role='operator' WHERE id=?").bind(other).run();
    const operator = await headers(other);
    expect(
      (
        await call(
          "/audiences",
          "PATCH",
          { ...payload, version: 0, tokenLifetimeSeconds: 180 },
          operator,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          "/audiences",
          "PATCH",
          { ...payload, version: 1, jwksCacheSeconds: null },
          operator,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "/audiences",
          "POST",
          { ...payload, audience: "urn:invalid-cache", jwksCacheSeconds: -1 },
          admin,
        )
      ).status,
    ).toBe(400);
  });
  it("cleans expired data without deleting current rate limits or active sessions", async () => {
    const admin = await headers();
    const minute = Math.floor(Date.now() / 60_000);
    await env.ADMIN_DB.prepare("INSERT INTO auth_rate_limits VALUES ('old',?,1),('current',?,1)")
      .bind(minute - 61, minute)
      .run();
    await maintainAdmin(env);
    expect(await env.ADMIN_DB.prepare("SELECT COUNT(*) n FROM auth_rate_limits").first("n")).toBe(
      1,
    );
    expect((await call("/me", "GET", undefined, admin)).status).toBe(200);
    await env.POLICY_DB.prepare(
      "INSERT INTO issuance_metrics VALUES (?,'success',90),(?,'issuance-unavailable',10),(?,'audience-denied',50)",
    )
      .bind(minute, minute, minute)
      .run();
    const data = await overview(env);
    expect(data.availability).toBe(90);
    expect(data.outcomes["audience-denied"]).toBe(50);
  });
});
