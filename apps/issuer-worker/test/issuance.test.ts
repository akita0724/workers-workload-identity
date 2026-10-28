import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair, importJWK, jwtVerify } from "jose";
import { createOidcClient } from "@workers-workload-identity/client";
import issuer, { type Env } from "../src/index.js";
import { policyRepository } from "../src/adapters/d1.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof import("../src/index.js");
    }
  }
}
interface TestEnv extends Env {
  AUXILIARY_CALLER: Fetcher;
  AUX_PUBLIC_JWK: string;
  POLICY_MIGRATIONS: D1Migration[];
  KEY_MIGRATIONS: D1Migration[];
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.POLICY_DB, env.POLICY_MIGRATIONS);
  await applyD1Migrations(env.KEY_DB, env.KEY_MIGRATIONS);
  await env.POLICY_DB.batch([
    env.POLICY_DB.prepare(
      "INSERT INTO clients (client_id, subject, enabled, created_at, updated_at) VALUES ('example-caller', 'service:example', 1, 0, 0)",
    ),
    env.POLICY_DB.prepare(
      "INSERT INTO audiences (audience, algorithm, token_lifetime_seconds, created_at, updated_at) VALUES ('urn:allowed', 'RS256', 300, 0, 0)",
    ),
    env.POLICY_DB.prepare(
      "INSERT INTO client_audience_grants (client_id, audience) VALUES ('example-caller', 'urn:allowed')",
    ),
  ]);
});

const rpc = () => exports.IssuerRpc({ props: { clientId: "example-caller" } });

it.each(["https://oidc.example.com/", "https://oidc.example.com/tenant/"])(
  "preserves issuer %s and publishes a reachable JWKS URL",
  async (issuerUrl) => {
    const testEnv = { ...env, ISSUER_URL: issuerUrl };
    const base = issuerUrl.replace(/\/$/, "");
    const response = await issuer.fetch(
      new Request(`${base}/.well-known/openid-configuration`),
      testEnv,
    );
    expect(response.status).toBe(200);
    const metadata = await response.json<{ issuer: string; jwks_uri: string }>();
    expect(metadata.issuer).toBe(issuerUrl);
    expect(metadata.jwks_uri).toBe(`${base}/jwks.json`);
    expect((await issuer.fetch(new Request(metadata.jwks_uri), testEnv)).status).toBe(200);
  },
);

it("fails closed when a stored subject is not a StringOrURI", async () => {
  await env.POLICY_DB.prepare(
    "UPDATE clients SET subject = 'invalid: value' WHERE client_id = 'example-caller'",
  ).run();
  await expect(policyRepository(env.POLICY_DB).getClient("example-caller")).rejects.toThrow();
});

describe("issuer RPC in workerd", () => {
  it("issues through the typed client, verifies with the public JWKS, and reflects the next policy read", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", {
      modulusLength: 2048,
      extractable: true,
    });
    const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
    // Ephemeral test key only; never persisted outside this local runtime.
    env.SIGNING_KEY_TEST = await exportPKCS8(privateKey);
    await env.KEY_DB.prepare(
      "INSERT INTO signing_keys (kid, algorithm, state, public_jwk_json, secret_binding, created_at) VALUES (?, 'RS256', 'active', ?, 'SIGNING_KEY_TEST', 0)",
    )
      .bind("test-key", JSON.stringify(jwk))
      .run();
    const client = createOidcClient(rpc());
    const requestId = crypto.randomUUID();
    const token = await client.issue({ aud: "urn:allowed", requestId });
    const audit = await env.POLICY_DB.prepare(
      "SELECT * FROM issuance_audit_events WHERE request_id=?",
    )
      .bind(requestId)
      .first();
    expect(audit).toMatchObject({
      client_id: "example-caller",
      audience: "urn:allowed",
      kid: "test-key",
      outcome: "success",
    });
    expect(audit?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(audit?.occurred_at).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain("PRIVATE KEY");
    const response = await exports.default.fetch("https://oidc.example.com/jwks.json");
    expect(response.status).toBe(200);
    const body = await response.json<{ keys: (typeof jwk)[] }>();
    expect(body.keys).toEqual([jwk]);
    expect(body.keys[0]).not.toHaveProperty("d");
    const { payload, protectedHeader } = await jwtVerify(
      token,
      await importJWK(body.keys[0], "RS256"),
      {
        issuer: "https://oidc.example.com",
        audience: "urn:allowed",
        algorithms: ["RS256"],
      },
    );
    expect(protectedHeader.kid).toBe("test-key");
    expect(payload.sub).toBe("service:example");
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(payload.nbf).toBe(payload.iat);
    expect(payload.jti).toBeTruthy();
    expect(payload).not.toHaveProperty("azp");
    expect(payload).not.toHaveProperty("requestId");
    const discovery = await exports.default.fetch(
      "https://oidc.example.com/.well-known/openid-configuration",
    );
    const metadata = await discovery.json<{
      issuer: string;
      jwks_uri: string;
      claims_supported: string[];
      id_token_signing_alg_values_supported: string[];
    }>();
    expect(metadata.issuer).toBe(payload.iss);
    expect(metadata.jwks_uri).toBe("https://oidc.example.com/jwks.json");
    expect(metadata.id_token_signing_alg_values_supported).toContain(protectedHeader.alg);
    expect(metadata.claims_supported).toEqual(expect.arrayContaining(Object.keys(payload)));
    await env.POLICY_DB.prepare(
      "UPDATE clients SET enabled = 0 WHERE client_id = 'example-caller'",
    ).run();
    await expect(client.issue({ aud: "urn:allowed" })).rejects.toMatchObject({
      code: "caller-denied",
    });
    await expect
      .poll(
        async () =>
          (
            await env.POLICY_DB.prepare(
              "SELECT outcome,count FROM issuance_metrics ORDER BY outcome",
            ).all()
          ).results,
      )
      .toEqual([
        { outcome: "caller-denied", count: 1 },
        { outcome: "success", count: 1 },
      ]);
  });

  it("rejects missing props and identity overrides at the server boundary", async () => {
    // @ts-expect-error deliberately bypass required props at the runtime boundary
    const missingProps = exports.IssuerRpc({ props: {} });
    await expect((async () => await missingProps.issue({ aud: "urn:allowed" }))()).rejects.toThrow(
      "caller-denied",
    );
    await expect(
      (async () => await rpc().issue({ aud: "urn:allowed", clientId: "spoofed" }))(),
    ).rejects.toThrow("invalid-request");
    await expect(
      (async () => await rpc().issue({ aud: "urn:allowed", sub: "spoofed", ttl: 900 }))(),
    ).rejects.toThrow("invalid-request");
  });

  it("does not expose whether a caller is unknown or disabled", async () => {
    await expect(
      (async () =>
        await exports
          .IssuerRpc({ props: { clientId: "unknown-caller" } })
          .issue({ aud: "urn:allowed" }))(),
    ).rejects.toThrow("caller-denied");
    await env.POLICY_DB.prepare("UPDATE clients SET enabled = 0").run();
    await expect((async () => await rpc().issue({ aud: "urn:allowed" }))()).rejects.toThrow(
      "caller-denied",
    );
  });

  it("reflects grant removal and fails closed without an active key", async () => {
    await expect((async () => await rpc().issue({ aud: "urn:allowed" }))()).rejects.toThrow(
      "issuance-unavailable",
    );
    await env.POLICY_DB.prepare("DELETE FROM client_audience_grants").run();
    await expect((async () => await rpc().issue({ aud: "urn:allowed" }))()).rejects.toThrow(
      "audience-denied",
    );
  });

  it("enforces a shared atomic limit for parallel RPC requests", async () => {
    const bucket = Math.floor(Date.now() / 60_000);
    await env.POLICY_DB.prepare(
      "INSERT INTO issuance_rate_limits VALUES ('example-caller', ?, 119)",
    )
      .bind(bucket)
      .run();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => rpc().issue({ aud: "urn:allowed" })),
    );
    expect(
      results.filter(
        (result) => result.status === "rejected" && result.reason.message === "rate-limited",
      ),
    ).toHaveLength(7);
    expect(
      await env.POLICY_DB.prepare(
        "SELECT count FROM issuance_rate_limits WHERE client_id = 'example-caller' AND minute_bucket = ?",
      )
        .bind(bucket)
        .first("count"),
    ).toBe(120);
  });

  it("sanitizes configuration and storage failures", async () => {
    const previousIssuer = env.ISSUER_URL;
    try {
      env.ISSUER_URL = "sensitive-invalid-configuration";
      await expect(createOidcClient(rpc()).issue({ aud: "urn:allowed" })).rejects.toMatchObject({
        code: "issuance-unavailable",
        message: "issuance-unavailable",
      });
    } finally {
      env.ISSUER_URL = previousIssuer;
    }
    await env.POLICY_DB.prepare("DROP TABLE clients").run();
    await expect(createOidcClient(rpc()).issue({ aud: "urn:allowed" })).rejects.toMatchObject({
      code: "issuance-unavailable",
      message: "issuance-unavailable",
    });
  });

  it("records sanitized denials and distinct events even when callers reuse a request ID", async () => {
    const requestId = crypto.randomUUID();
    await env.POLICY_DB.prepare("UPDATE clients SET enabled=0").run();
    await Promise.allSettled(
      Array.from({ length: 3 }, () => rpc().issue({ aud: "urn:allowed", requestId })),
    );
    const events = await env.POLICY_DB.prepare(
      "SELECT * FROM issuance_audit_events WHERE request_id=?",
    )
      .bind(requestId)
      .all();
    expect(events.results).toHaveLength(3);
    expect(new Set(events.results.map((row) => row.event_id)).size).toBe(3);
    expect(events.results.every((row) => row.outcome === "caller-denied" && row.kid === null)).toBe(
      true,
    );
    await expect(
      (async () =>
        await rpc().issue({
          aud: "sensitive-raw-input",
          requestId: "not-a-uuid",
          token: "sensitive-token",
        }))(),
    ).rejects.toThrow("invalid-request");
    // @ts-expect-error missing trusted identity is a runtime rejection
    const missing = exports.IssuerRpc({ props: {} });
    await expect((async () => await missing.issue({ aud: "urn:allowed" }))()).rejects.toThrow(
      "caller-denied",
    );
    const all = await env.POLICY_DB.prepare("SELECT * FROM issuance_audit_events").all();
    expect(JSON.stringify(all.results)).not.toContain("sensitive-");
    expect(
      all.results.some((row) => row.outcome === "invalid-request" && row.audience === null),
    ).toBe(true);
    expect(
      all.results.some((row) => row.client_id === null && row.outcome === "caller-denied"),
    ).toBe(true);
  });

  it("withholds signed tokens when audit persistence fails and hides storage error details", async () => {
    const response = await env.AUXILIARY_CALLER.fetch("https://caller.example.com", {
      method: "POST",
      body: JSON.stringify({ aud: "urn:fixed" }),
    });
    // This caller has no policy in this test; use a real key and policy for the next call.
    expect(response.status).toBe(403);
    await env.POLICY_DB.prepare(
      "INSERT INTO clients (client_id,subject,enabled,created_at,updated_at) VALUES ('fixed-caller','service:fixed',1,0,0)",
    ).run();
    await env.POLICY_DB.prepare(
      "INSERT INTO client_audience_grants VALUES ('fixed-caller','urn:allowed')",
    ).run();
    await env.KEY_DB.prepare(
      "INSERT INTO signing_keys (kid,algorithm,state,public_jwk_json,secret_binding,created_at) VALUES ('aux-key','RS256','active',?,'SIGNING_KEY_AUX',0)",
    )
      .bind(env.AUX_PUBLIC_JWK)
      .run();
    await env.POLICY_DB.prepare("DROP TABLE issuance_audit_events").run();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const denied = await env.AUXILIARY_CALLER.fetch("https://caller.example.com", {
        method: "POST",
        body: JSON.stringify({ aud: "urn:allowed" }),
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "issuance-unavailable" });
      expect(
        await env.KEY_DB.prepare(
          "SELECT COUNT(*) n FROM issuance_reservations WHERE completed_at IS NOT NULL",
        ).first("n"),
      ).toBe(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("cleans expired issuance audits without removing policy-change history", async () => {
    const now = Date.now();
    await env.POLICY_DB.prepare(
      "INSERT INTO issuance_audit_events VALUES ('old','old',NULL,NULL,NULL,'invalid-request',0,?),('recent','recent',NULL,NULL,NULL,'invalid-request',0,?)",
    )
      .bind(now - 31 * 86400000, now)
      .run();
    await env.POLICY_DB.prepare(
      "INSERT INTO policy_audit_events (event_id,actor_id,action,target,occurred_at) VALUES ('retained','admin','test','policy',0)",
    ).run();
    await issuer.scheduled({ scheduledTime: now, cron: "17 * * * *", noRetry() {} }, env);
    expect(
      (await env.POLICY_DB.prepare("SELECT event_id FROM issuance_audit_events").all()).results,
    ).toEqual([{ event_id: "recent" }]);
    expect(
      await env.POLICY_DB.prepare("SELECT COUNT(*) n FROM policy_audit_events").first("n"),
    ).toBe(1);
  });

  it("keeps issuance inaccessible from HTTP", async () => {
    for (const path of ["/issue", "/IssuerRpc/issue", "/api/issue"]) {
      const response = await exports.default.fetch("https://oidc.example.com" + path, {
        method: "POST",
        body: JSON.stringify({ aud: "urn:allowed", clientId: "example-caller" }),
      });
      expect(response.status).toBe(404);
    }
    const response = await exports.default.fetch(
      "https://oidc.example.com/.well-known/openid-configuration",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issuer: "https://oidc.example.com",
      jwks_uri: "https://oidc.example.com/jwks.json",
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256", "ES256"],
      claims_supported: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
    });
  });
});
