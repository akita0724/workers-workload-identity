import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { e2eScenarios } from "../src/e2e.js";

declare global {
  namespace Cloudflare {
    interface Env {
      POLICY_DB: D1Database;
      KEY_DB: D1Database;
      POLICY_MIGRATIONS: D1Migration[];
      KEY_MIGRATIONS: D1Migration[];
      CALLER: Fetcher;
      MISSING_PROPS_CALLER: Fetcher;
      ISSUER_HTTP: Fetcher;
      RECEIVER: Fetcher;
      SMOKE_TOKEN: string;
      SMOKE_CLIENT: string;
      SMOKE_AUDIENCE: string;
      PUBLIC_JWKS: string;
      SEED_SQL: string;
    }
    interface GlobalProps {
      mainModule: typeof import("./harness.js");
    }
  }
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.POLICY_DB, env.POLICY_MIGRATIONS);
  await applyD1Migrations(env.KEY_DB, env.KEY_MIGRATIONS);
  await env.POLICY_DB.exec(env.SEED_SQL);
  const keys = JSON.parse(env.PUBLIC_JWKS) as { kid: string; alg: string }[];
  await env.KEY_DB.batch(
    keys.map((jwk) =>
      env.KEY_DB.prepare(
        "INSERT INTO signing_keys (kid, algorithm, state, public_jwk_json, secret_binding, created_at) VALUES (?, ?, 'active', ?, ?, 0)",
      ).bind(jwk.kid, jwk.alg, JSON.stringify(jwk), `SIGNING_KEY_${jwk.kid.toUpperCase()}`),
    ),
  );
});

function call(scenario: string, caller = env.CALLER, body: object = { scenario }) {
  return caller.fetch("https://caller.test/e2e", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SMOKE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
async function expectIssuanceDenied(code: string, caller = env.CALLER) {
  const response = await call("valid", caller);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "e2e-failed",
    scenario: "valid",
    stage: "issue",
    code,
  });
}

describe("caller Worker → production IssuerRpc → relying-party Worker", () => {
  it.each(e2eScenarios)("%s", async (scenario) => {
    const response = await call(scenario);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(
      scenario === "unique-tokens"
        ? { ok: true, scenario, uniqueTokens: 4 }
        : scenario === "audience-denied"
          ? { ok: true, scenario, issuanceDenied: true }
          : { ok: true, scenario, receiverStatus: scenario === "valid" ? 200 : 401 },
    );
  });

  it("reflects caller disable and re-enable on the next RPC", async () => {
    await env.POLICY_DB.prepare("UPDATE clients SET enabled = 0 WHERE client_id = ?")
      .bind(env.SMOKE_CLIENT)
      .run();
    await expectIssuanceDenied("caller-denied");
    await env.POLICY_DB.prepare("UPDATE clients SET enabled = 1 WHERE client_id = ?")
      .bind(env.SMOKE_CLIENT)
      .run();
    expect((await call("valid")).status).toBe(200);
  });
  it("reflects grant removal on the next RPC", async () => {
    await env.POLICY_DB.prepare("DELETE FROM client_audience_grants WHERE client_id = ?")
      .bind(env.SMOKE_CLIENT)
      .run();
    await expectIssuanceDenied("audience-denied");
  });
  it("rejects an unknown caller and does not expose its registration state", async () => {
    await env.POLICY_DB.prepare("DELETE FROM clients WHERE client_id = ?")
      .bind(env.SMOKE_CLIENT)
      .run();
    await expectIssuanceDenied("caller-denied");
  });
  it("rejects a caller whose Service Binding has no identity props", async () => {
    await expectIssuanceDenied("caller-denied", env.MISSING_PROPS_CALLER);
  });
  it("fails closed when no signing key is active", async () => {
    await env.KEY_DB.prepare("UPDATE signing_keys SET state = 'verifying'").run();
    await expectIssuanceDenied("issuance-unavailable");
  });
  it("fails closed when the private-key binding is missing", async () => {
    await env.KEY_DB.prepare(
      "UPDATE signing_keys SET secret_binding = 'SIGNING_KEY_MISSING' WHERE kid = 'rsa'",
    ).run();
    await expectIssuanceDenied("issuance-unavailable");
  });
  it("enforces the issuer's shared rate limit across separate Worker calls", async () => {
    const bucket = Math.floor(Date.now() / 60_000);
    await env.POLICY_DB.prepare("INSERT INTO issuance_rate_limits VALUES (?, ?, 120)")
      .bind(env.SMOKE_CLIENT, bucket)
      .run();
    await expectIssuanceDenied("rate-limited");
  });
  it("rejects a correctly signed algorithm outside the receiver's allowlist", async () => {
    await env.POLICY_DB.prepare(
      "UPDATE audiences SET algorithm = 'ES256', verified_for_es256 = 1 WHERE audience = ?",
    )
      .bind(env.SMOKE_AUDIENCE)
      .run();
    const response = await call("valid");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "e2e-failed",
      scenario: "valid",
      stage: "receiver",
    });
    // Issuance succeeded; rejection happened only at the relying party.
    expect(
      await env.KEY_DB.prepare(
        "SELECT COUNT(*) AS count FROM issuance_reservations WHERE kid = 'ec' AND completed_at IS NOT NULL",
      ).first("count"),
    ).toBe(1);
  });
  it("does not let a request override the binding identity, audience, or destination", async () => {
    for (const field of ["clientId", "sub", "aud", "receiverUrl"]) {
      const response = await call("valid", env.CALLER, { scenario: "valid", [field]: "override" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid-request" });
    }
    expect(
      await env.KEY_DB.prepare("SELECT COUNT(*) AS count FROM issuance_reservations").first(
        "count",
      ),
    ).toBe(0);
  });
  it("requires the probe secret before either Worker binding can be used", async () => {
    const response = await env.CALLER.fetch("https://caller.test/e2e", {
      method: "POST",
      body: JSON.stringify({ scenario: "valid" }),
    });
    expect(response.status).toBe(401);
    expect(
      await env.KEY_DB.prepare("SELECT COUNT(*) AS count FROM issuance_reservations").first(
        "count",
      ),
    ).toBe(0);
  });
  it("keeps issuance unavailable through the issuer's public HTTP surface", async () => {
    for (const path of ["/issue", "/IssuerRpc/issue", "/api/issue"]) {
      const response = await env.ISSUER_HTTP.fetch(`https://issuer.test${path}`, {
        method: "POST",
      });
      expect(response.status).toBe(404);
    }
  });
});
