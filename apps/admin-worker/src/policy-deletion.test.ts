import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "./auth.js";

const origin = "https://admin.example.com";
const id = "11111111-1111-4111-8111-111111111111";
const audience = "https://api.example.com/path%2Fpart?scope=read#target";
let headers: Record<string, string>;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.ADMIN_DB, env.ADMIN_MIGRATIONS);
  await applyD1Migrations(env.POLICY_DB, env.POLICY_MIGRATIONS);
  await env.ADMIN_DB.prepare(
    "INSERT INTO operators (id,role,enabled,created_at,updated_at) VALUES (?,'security-admin',1,0,0)",
  )
    .bind(id)
    .run();
  const cookie = (await createSession(env.ADMIN_DB, env.CSRF_SECRET, id)).split(";")[0];
  const me = await (
    await exports.default.fetch(origin + "/api/me", { headers: { Cookie: cookie } })
  ).json<{ csrfToken: string }>();
  headers = {
    Cookie: cookie,
    Origin: origin,
    "X-CSRF-Token": me.csrfToken,
    "Content-Type": "application/json",
  };
  await env.POLICY_DB.prepare(
    "INSERT INTO audiences (audience,algorithm,token_lifetime_seconds,description,exchange_verified,mixed_jwks_verified,jwks_cache_seconds,created_at,updated_at) VALUES (?,'RS256',120,'API',1,1,60,10,20)",
  )
    .bind(audience)
    .run();
  await env.POLICY_DB.prepare(
    "INSERT INTO clients (client_id,subject,enabled,created_at,updated_at) VALUES ('retired-worker','service:retired',0,10,20),('other-worker','service:other',1,10,20)",
  ).run();
  await env.POLICY_DB.prepare(
    "INSERT INTO policy_audit_events (event_id,actor_id,action,target,occurred_at) VALUES ('old-event',?,'audience.create',?,0)",
  )
    .bind(id, audience)
    .run();
  await env.POLICY_DB.prepare(
    "INSERT INTO issuance_audit_events VALUES ('issued','request','retired-worker',?,'key','success',1,0)",
  )
    .bind(audience)
    .run();
});
function call(path: string, body: unknown, customHeaders = headers, method = "DELETE") {
  return exports.default.fetch(origin + "/api" + path, {
    method,
    headers: customHeaders,
    body: JSON.stringify(body),
  });
}
const endpoints = [
  {
    path: "/clients/retired-worker",
    body: { version: 0 },
    table: "clients",
    action: "client.delete",
  },
  {
    path: "/audiences",
    body: { audience, version: 0 },
    table: "audiences",
    action: "audience.delete",
  },
];
async function snapshot() {
  return Promise.all(
    [
      "clients",
      "audiences",
      "client_audience_grants",
      "issuance_rate_limits",
      "policy_audit_events",
      "issuance_audit_events",
    ].map(
      async (table) =>
        (await env.POLICY_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
    ),
  );
}
async function grant(client = "retired-worker") {
  await env.POLICY_DB.prepare("INSERT INTO client_audience_grants VALUES (?,?)")
    .bind(client, audience)
    .run();
}
async function deletionEvents(action: string) {
  return (
    await env.POLICY_DB.prepare("SELECT * FROM policy_audit_events WHERE action = ?")
      .bind(action)
      .all()
  ).results;
}

for (const endpoint of endpoints) {
  describe(endpoint.action, () => {
    it("requires authentication, a valid Origin and CSRF, and rejects viewers without side effects", async () => {
      const before = await snapshot();
      for (const [customHeaders, status] of [
        [{}, 401],
        [{ ...headers, Origin: "https://evil.example" }, 403],
        [{ ...headers, "X-CSRF-Token": "" }, 403],
      ] as const) {
        expect((await call(endpoint.path, endpoint.body, customHeaders)).status).toBe(status);
      }
      // Keep a security administrator so the last-admin trigger allows the role change.
      await env.ADMIN_DB.prepare(
        "INSERT INTO operators VALUES ('backup','security-admin',1,0,0,0,NULL)",
      ).run();
      await env.ADMIN_DB.prepare("UPDATE operators SET role='viewer' WHERE id=?").bind(id).run();
      expect((await call(endpoint.path, endpoint.body)).status).toBe(403);
      expect(await snapshot()).toEqual(before);
    });
    for (const role of ["operator", "security-admin"]) {
      it(`allows ${role} to delete an eligible resource`, async () => {
        if (role === "operator") {
          await env.ADMIN_DB.prepare(
            "INSERT INTO operators VALUES ('backup','security-admin',1,0,0,0,NULL)",
          ).run();
          await env.ADMIN_DB.prepare("UPDATE operators SET role='operator' WHERE id=?")
            .bind(id)
            .run();
        }
        expect((await call(endpoint.path, endpoint.body)).status).toBe(200);
        const events = await deletionEvents(endpoint.action);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ actor_id: id, after_json: "null" });
      });
    }
    it.each([undefined, -1, 0.5, "0", null])(
      "rejects invalid version %s without changes",
      async (version) => {
        const before = await snapshot();
        expect((await call(endpoint.path, { ...endpoint.body, version })).status).toBe(400);
        expect(await snapshot()).toEqual(before);
      },
    );
    it("rejects unexpected fields and malformed JSON", async () => {
      const before = await snapshot();
      expect((await call(endpoint.path, { ...endpoint.body, force: true })).status).toBe(400);
      const malformed = await exports.default.fetch(origin + "/api" + endpoint.path, {
        method: "DELETE",
        headers,
        body: "{",
      });
      expect(malformed.status).toBe(400);
      expect(await snapshot()).toEqual(before);
    });
    it("rejects stale versions without deleting or writing audit events", async () => {
      const before = await snapshot();
      const response = await call(endpoint.path, { ...endpoint.body, version: 1 });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "version-conflict" });
      expect(await snapshot()).toEqual(before);
    });
    it("returns 404 on a repeated deletion and writes exactly one audit event", async () => {
      expect((await call(endpoint.path, endpoint.body)).status).toBe(200);
      const before = await snapshot();
      const response = await call(endpoint.path, endpoint.body);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not-found" });
      expect(await snapshot()).toEqual(before);
    });
    it("serializes concurrent deletions and records only the successful deletion", async () => {
      const responses = await Promise.all([
        call(endpoint.path, endpoint.body),
        call(endpoint.path, endpoint.body),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
      expect(await deletionEvents(endpoint.action)).toHaveLength(1);
    });
    for (const failure of ["audit", "delete"]) {
      it(`rolls back all changes when ${failure} fails`, async () => {
        await grant();
        // Audience deletion must be eligible before injecting an infrastructure failure.
        if (endpoint.table === "audiences")
          await env.POLICY_DB.prepare("DELETE FROM client_audience_grants").run();
        await env.POLICY_DB.prepare(
          "INSERT INTO issuance_rate_limits VALUES ('retired-worker',1,5)",
        ).run();
        const before = await snapshot();
        const trigger =
          failure === "audit"
            ? "CREATE TRIGGER fail_deletion BEFORE INSERT ON policy_audit_events BEGIN SELECT RAISE(ABORT, 'test failure'); END"
            : `CREATE TRIGGER fail_deletion BEFORE DELETE ON ${endpoint.table} BEGIN SELECT RAISE(ABORT, 'test failure'); END`;
        await env.POLICY_DB.prepare(trigger).run();
        try {
          expect((await call(endpoint.path, endpoint.body)).status).toBe(503);
          expect(await snapshot()).toEqual(before);
        } finally {
          await env.POLICY_DB.prepare("DROP TRIGGER fail_deletion").run();
        }
      });
    }
  });
}

describe("workload deletion", () => {
  it("requires disablement and preserves all state when the workload is enabled", async () => {
    await grant("other-worker");
    const before = await snapshot();
    const response = await call("/clients/other-worker", { version: 0 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "client-must-be-disabled" });
    expect(await snapshot()).toEqual(before);
  });
  it("removes only the target and its grants and rate limits while retaining historical events", async () => {
    await grant();
    await grant("other-worker");
    await env.POLICY_DB.prepare(
      "INSERT INTO issuance_rate_limits VALUES ('retired-worker',1,5),('other-worker',1,7)",
    ).run();
    const response = await call("/clients/retired-worker", { version: 0 });
    expect(await response.json()).toEqual({ clientId: "retired-worker", deleted: true });
    const [clients, audiences, grants, limits, audits, issuance] = await snapshot();
    expect(clients.map((row) => row.client_id)).toEqual(["other-worker"]);
    expect(audiences).toHaveLength(1);
    expect(grants).toEqual([{ client_id: "other-worker", audience }]);
    expect(limits).toEqual([{ client_id: "other-worker", minute_bucket: 1, count: 7 }]);
    expect(audits).toHaveLength(2);
    expect(issuance).toHaveLength(1);
    const [event] = await deletionEvents("client.delete");
    expect(JSON.parse(event.before_json as string)).toEqual({
      clientId: "retired-worker",
      subject: "service:retired",
      enabled: 0,
      version: 0,
      createdAt: 10,
      updatedAt: 20,
      audiences: [audience],
    });
  });
  it("does not delete a workload that is concurrently re-enabled", async () => {
    const responses = await Promise.all([
      call("/clients/retired-worker", { version: 0 }),
      call(
        "/clients/retired-worker",
        { version: 0, enabled: true, audiences: [] },
        headers,
        "PATCH",
      ),
    ]);
    const row = await env.POLICY_DB.prepare(
      "SELECT enabled,version FROM clients WHERE client_id='retired-worker'",
    ).first();
    if (responses[0].status === 200) {
      expect(responses[1].status).toBe(409);
      expect(row).toBeNull();
    } else {
      expect(responses[0].status).toBe(409);
      expect(responses[1].status).toBe(200);
      expect(row).toEqual({ enabled: 1, version: 1 });
      expect(await deletionEvents("client.delete")).toHaveLength(0);
    }
  });
  it("validates client IDs and returns 404 for an unknown ID", async () => {
    expect((await call("/clients/INVALID", { version: 0 })).status).toBe(400);
    expect((await call("/clients/missing-worker", { version: 0 })).status).toBe(404);
  });
});

describe("audience deletion", () => {
  it("lists all referencing workloads, including disabled ones, and changes nothing", async () => {
    await grant();
    await grant("other-worker");
    const before = await snapshot();
    const response = await call("/audiences", { audience, version: 0 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "audience-in-use",
      clientIds: ["other-worker", "retired-worker"],
    });
    expect(await snapshot()).toEqual(before);
  });
  it("succeeds after the final grant is removed and preserves confirmations in audit history", async () => {
    await grant();
    expect(
      (
        await call(
          "/clients/retired-worker",
          { version: 0, enabled: false, audiences: [] },
          headers,
          "PATCH",
        )
      ).status,
    ).toBe(200);
    const response = await call("/audiences", { audience, version: 0 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ audience, deleted: true });
    const [clients, audiences, , , audits, issuance] = await snapshot();
    expect(clients).toHaveLength(2);
    expect(audiences).toEqual([]);
    expect(audits).toHaveLength(3);
    expect(issuance).toHaveLength(1);
    const [event] = await deletionEvents("audience.delete");
    expect(event.target).toBe(audience);
    expect(JSON.parse(event.before_json as string)).toEqual({
      audience,
      algorithm: "RS256",
      tokenLifetimeSeconds: 120,
      description: "API",
      verifiedForEs256: 0,
      exchangeVerified: 1,
      mixedJwksVerified: 1,
      jwksCacheSeconds: 60,
      version: 0,
      createdAt: 10,
      updatedAt: 20,
    });
  });
  it("cannot leave a dangling grant when grant creation races deletion", async () => {
    const responses = await Promise.all([
      call("/audiences", { audience, version: 0 }),
      call(
        "/clients",
        { clientId: "new-worker", subject: "service:new", audiences: [audience] },
        headers,
        "POST",
      ),
    ]);
    if (responses[0].status === 200) {
      expect(responses[1].status).toBe(503);
      expect(
        await env.POLICY_DB.prepare("SELECT * FROM clients WHERE client_id='new-worker'").first(),
      ).toBeNull();
    } else {
      expect(responses[0].status).toBe(409);
      expect(responses[1].status).toBe(201);
      expect(await deletionEvents("audience.delete")).toHaveLength(0);
    }
    expect((await env.POLICY_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it.each(["", "https://bad host", 123, null])("rejects invalid audience %s", async (invalid) => {
    expect((await call("/audiences", { audience: invalid, version: 0 })).status).toBe(400);
  });
  it("returns 404 for an unknown audience", async () => {
    expect((await call("/audiences", { audience: "urn:missing", version: 0 })).status).toBe(404);
  });
});
