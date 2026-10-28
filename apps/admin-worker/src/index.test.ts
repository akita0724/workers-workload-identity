import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { adminConfig, authenticateAccess, createSession, sha256, type AdminEnv } from "./auth.js";
import { completeAccessStepUp, consumeAccessStepUp, startAccessStepUp } from "./access-step-up.js";
import { updatePasskeyCounter } from "./passkey.js";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import app from "./index.js";

declare global {
  namespace Cloudflare {
    interface Env extends AdminEnv {
      ADMIN_MIGRATIONS: D1Migration[];
      POLICY_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("./index.js");
    }
  }
}
const operatorId = "11111111-1111-4111-8111-111111111111";
const origin = "https://admin.example.com";
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.ADMIN_DB, env.ADMIN_MIGRATIONS);
  await applyD1Migrations(env.POLICY_DB, env.POLICY_MIGRATIONS);
  await env.ADMIN_DB.prepare(
    "INSERT INTO operators (id, role, enabled, created_at, updated_at) VALUES (?, 'security-admin', 1, 0, 0)",
  )
    .bind(operatorId)
    .run();
});
async function call(path: string, init?: RequestInit) {
  return exports.default.fetch(origin + path, init);
}
async function authenticated() {
  const cookie = (await createSession(env.ADMIN_DB, env.CSRF_SECRET, operatorId)).split(";")[0];
  const response = await call("/api/me", { headers: { Cookie: cookie } });
  const me = await response.json<{ csrfToken: string }>();
  return {
    Cookie: cookie,
    Origin: origin,
    "X-CSRF-Token": me.csrfToken,
    "Content-Type": "application/json",
  };
}

// Minimal test authenticator: creates a real P-256 credential and a none attestation.
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function decode(value: string) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  );
}
function concat(...arrays: Uint8Array[]) {
  const result = new Uint8Array(arrays.reduce((sum, bytes) => sum + bytes.length, 0));
  let offset = 0;
  for (const bytes of arrays) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}
function derSignature(raw: Uint8Array) {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let value = bytes.slice(start);
    if (value[0] & 0x80) value = concat(new Uint8Array([0]), value);
    return concat(new Uint8Array([2, value.length]), value);
  };
  const content = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(new Uint8Array([0x30, content.length]), content);
}

describe("deployed admin API boundary", () => {
  it("requires a session for management routes and rejects CSRF and viewer writes", async () => {
    for (const path of [
      "/api/me",
      "/api/clients",
      "/api/audiences",
      "/api/operators",
      "/api/keys",
      "/api/audit",
    ])
      expect((await call(path)).status).toBe(401);
    const headers = await authenticated();
    expect(
      (
        await call("/api/clients", {
          method: "POST",
          headers: { Cookie: headers.Cookie },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("/api/clients", {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    await env.ADMIN_DB.prepare(
      "INSERT INTO operators (id,role,enabled,created_at,updated_at) VALUES (?, 'security-admin',1,0,0)",
    )
      .bind(crypto.randomUUID())
      .run();
    await env.ADMIN_DB.prepare("UPDATE operators SET role = 'viewer' WHERE id = ?")
      .bind(operatorId)
      .run();
    expect(
      (
        await call("/api/clients", {
          method: "POST",
          headers,
          body: JSON.stringify({ clientId: "example-caller", subject: "service:example" }),
        })
      ).status,
    ).toBe(403);
  });
  it("writes grants and audit atomically, detects stale edits, and keeps the subject immutable", async () => {
    const headers = await authenticated();
    expect(
      (
        await call("/api/audiences", {
          method: "POST",
          headers,
          body: JSON.stringify({
            audience: "urn:test",
            algorithm: "RS256",
            tokenLifetimeSeconds: 300,
          }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call("/api/clients", {
          method: "POST",
          headers,
          body: JSON.stringify({
            clientId: "example-caller",
            subject: "service:example",
            audiences: ["urn:test"],
          }),
        })
      ).status,
    ).toBe(201);
    const edit = {
      method: "PATCH",
      headers,
      body: JSON.stringify({ version: 0, enabled: false, audiences: [] }),
    };
    expect((await call("/api/clients/example-caller", edit)).status).toBe(200);
    expect((await call("/api/clients/example-caller", edit)).status).toBe(409);
    expect(
      (
        await call("/api/clients/example-caller", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ version: 1, enabled: true, audiences: [], subject: "spoofed" }),
        })
      ).status,
    ).toBe(400);
    expect(
      await env.POLICY_DB.prepare("SELECT COUNT(*) FROM policy_audit_events").first("COUNT(*)"),
    ).toBe(3);
    expect(
      await env.POLICY_DB.prepare("SELECT COUNT(*) FROM client_audience_grants").first("COUNT(*)"),
    ).toBe(0);
    expect(
      (
        await call("/api/clients", {
          method: "POST",
          headers,
          body: JSON.stringify({
            clientId: "broken-caller",
            subject: "service:broken",
            audiences: ["urn:missing"],
          }),
        })
      ).status,
    ).toBe(503);
    expect(
      await env.POLICY_DB.prepare(
        "SELECT client_id FROM clients WHERE client_id = 'broken-caller'",
      ).first(),
    ).toBeNull();
  });
  it("returns specific codes for Rotation Controller and passkey errors", async () => {
    const headers = await authenticated();
    for (const [message, status, code] of [
      ["version-conflict", 409, "version-conflict"],
      ["automatic-rotation-not-verified", 409, "automatic-rotation-not-verified"],
      ["audience cache behavior is not verified", 409, "automatic-rotation-not-verified"],
      ["rotation-control-denied", 409, "rotation-control-denied"],
      ["issuer version is not deployed at 100 percent", 409, "rotation-not-ready"],
      ["challenge-used", 409, "challenge-used"],
      ["rotation-unavailable", 503, "rotation-unavailable"],
      ["something unexpected", 503, "unavailable"],
    ] as const) {
      const failing: AdminEnv = {
        ...env,
        ROTATION: {
          listKeys: async () => {
            throw new Error(message);
          },
          plan: async () => ({}),
        },
      };
      const response = await app.request(origin + "/api/keys", { headers }, failing);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    }
  });
  it("requires a recent passkey login for operator creation and rotation planning", async () => {
    const stale = await authenticated();
    const sessionToken = stale.Cookie.slice("oidc_admin_session=".length);
    const staleAt = Date.now() - 6 * 60_000;
    await env.ADMIN_DB.prepare(
      "UPDATE admin_sessions SET authenticated_at = ? WHERE token_hash = ?",
    )
      .bind(staleAt, await sha256(sessionToken))
      .run();
    const me = await (
      await call("/api/me", { headers: { Cookie: stale.Cookie } })
    ).json<{
      authenticatedAt: number;
    }>();
    expect(me.authenticatedAt).toBe(staleAt);
    expect((await call("/api/operators", { headers: { Cookie: stale.Cookie } })).status).toBe(200);
    const createOperator = {
      method: "POST",
      body: JSON.stringify({ id: crypto.randomUUID(), role: "viewer" }),
    };
    for (const path of ["/api/operators", "/api/rotations"]) {
      const response = await call(path, {
        ...createOperator,
        headers: stale,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "reauth-required" });
    }
    expect(await env.ADMIN_DB.prepare("SELECT COUNT(*) FROM operators").first("COUNT(*)")).toBe(1);
    const fresh = await authenticated();
    expect((await call("/api/operators", { ...createOperator, headers: fresh })).status).toBe(201);
  });
  it("registers and logs in with a real cryptographic test passkey, then rejects replay", async () => {
    const invitationToken = "test-invitation-token-32-characters-long";
    await env.ADMIN_DB.prepare("INSERT INTO bootstrap_invites VALUES (?, ?, ?, NULL)")
      .bind(await sha256(invitationToken), operatorId, Date.now() + 60000)
      .run();
    const start = await call("/api/auth/passkey/register/options", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ invitationToken }),
    });
    expect(start.status).toBe(200);
    const registration = await start.json<{
      challengeId: string;
      options: { challenge: string };
    }>();
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const credentialId = crypto.getRandomValues(new Uint8Array(32));
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, decode(jwk.x!)],
        [-3, decode(jwk.y!)],
      ]),
    );
    const rpHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("admin.example.com")),
    );
    const authData = concat(
      rpHash,
      new Uint8Array([0x45, 0, 0, 0, 0]),
      new Uint8Array(16),
      new Uint8Array([0, 32]),
      credentialId,
      cose,
    );
    const attestation = isoCBOR.encode(
      new Map<string, Parameters<typeof isoCBOR.encode>[0]>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const clientData = (challenge: string, type: string) =>
      new TextEncoder().encode(JSON.stringify({ challenge, type, origin }));
    const response = {
      id: encode(credentialId),
      rawId: encode(credentialId),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: encode(clientData(registration.options.challenge, "webauthn.create")),
        attestationObject: encode(attestation),
        transports: ["internal"],
      },
    };
    const finish = await call("/api/auth/passkey/register/verify", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId: registration.challengeId, invitationToken, response }),
    });
    expect(finish.status).toBe(200);
    const cookie = finish.headers.get("Set-Cookie")!;
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict");
    expect((await call("/api/me", { headers: { Cookie: cookie.split(";")[0] } })).status).toBe(200);
    const login = await (
      await call("/api/auth/passkey/options")
    ).json<{ challengeId: string; options: { challenge: string } }>();
    const loginData = clientData(login.options.challenge, "webauthn.get");
    const loginAuth = concat(rpHash, new Uint8Array([5, 0, 0, 0, 1]));
    const signed = concat(
      loginAuth,
      new Uint8Array(await crypto.subtle.digest("SHA-256", loginData)),
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed),
    );
    const loginBody = JSON.stringify({
      challengeId: login.challengeId,
      response: {
        id: encode(credentialId),
        rawId: encode(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: encode(loginData),
          authenticatorData: encode(loginAuth),
          signature: encode(derSignature(signature)),
          userHandle: null,
        },
      },
    });
    const init = {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: loginBody,
    };
    expect((await call("/api/auth/passkey/verify", init)).status).toBe(200);
    expect((await call("/api/auth/passkey/verify", init)).status).toBe(400);
    await updatePasskeyCounter(env.ADMIN_DB, response.id, 1, 2);
    await expect(updatePasskeyCounter(env.ADMIN_DB, response.id, 1, 1)).rejects.toThrow(
      "counter-conflict",
    );
    expect(
      (
        await env.ADMIN_DB.prepare(
          "SELECT counter FROM passkey_credentials WHERE credential_id = ?",
        )
          .bind(response.id)
          .first<{ counter: number }>()
      )?.counter,
    ).toBe(2);
    await env.ADMIN_DB.prepare("UPDATE passkey_credentials SET counter = 0 WHERE credential_id = ?")
      .bind(response.id)
      .run();
    await updatePasskeyCounter(env.ADMIN_DB, response.id, 0, 0);
    const authenticatedHeaders = await authenticated();
    const additional = await (
      await call("/api/passkeys/options", { method: "POST", headers: authenticatedHeaders })
    ).json<{
      challengeId: string;
      options: { challenge: string; excludeCredentials: { id: string }[] };
    }>();
    expect(additional.options.excludeCredentials.map((c) => c.id)).toContain(response.id);
    const spareId = crypto.getRandomValues(new Uint8Array(32));
    const spareAuth = concat(
      rpHash,
      new Uint8Array([0x45, 0, 0, 0, 0]),
      new Uint8Array(16),
      new Uint8Array([0, 32]),
      spareId,
      cose,
    );
    const spareAttestation = isoCBOR.encode(
      new Map<string, Parameters<typeof isoCBOR.encode>[0]>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", spareAuth],
      ]),
    );
    const additionalBody = {
      challengeId: additional.challengeId,
      name: "Spare security key",
      response: {
        ...response,
        id: encode(spareId),
        rawId: encode(spareId),
        response: {
          ...response.response,
          clientDataJSON: encode(clientData(additional.options.challenge, "webauthn.create")),
          attestationObject: encode(spareAttestation),
        },
      },
    };
    expect(
      (
        await call("/api/passkeys/verify", {
          method: "POST",
          headers: authenticatedHeaders,
          body: JSON.stringify(additionalBody),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("/api/passkeys/verify", {
          method: "POST",
          headers: authenticatedHeaders,
          body: JSON.stringify(additionalBody),
        })
      ).status,
    ).toBe(400);
    expect(
      await env.ADMIN_DB.prepare("SELECT COUNT(*) n FROM passkey_credentials").first("n"),
    ).toBe(2);
    expect(
      await env.ADMIN_DB.prepare("SELECT name FROM passkey_credentials WHERE credential_id=?")
        .bind(encode(spareId))
        .first("name"),
    ).toBe("Spare security key");
  });
  it("binds Access step-up proof to a recent distinct Access application, subject, action, and one use", async () => {
    const accessEnv: AdminEnv = {
      ...env,
      ADMIN_AUTH_MODE: "cloudflare-access",
      RP_ID: undefined,
      ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      ACCESS_AUD: "base-audience",
      ACCESS_STEP_UP_AUD: "step-up-audience",
      ACCESS_STEP_UP_ORIGIN: "https://step-up.example.com",
    };
    expect(adminConfig(accessEnv).ADMIN_AUTH_MODE).toBe("cloudflare-access");
    expect(() => adminConfig({ ...accessEnv, ACCESS_STEP_UP_AUD: undefined })).toThrow();
    expect(() => adminConfig({ ...accessEnv, ACCESS_STEP_UP_AUD: "base-audience" })).toThrow();
    expect(() => adminConfig({ ...accessEnv, ACCESS_STEP_UP_ORIGIN: undefined })).toThrow();
    expect(() => adminConfig({ ...accessEnv, ACCESS_STEP_UP_ORIGIN: origin })).toThrow();
    const operator = {
      id: operatorId,
      role: "security-admin" as const,
      provider: "cloudflare-access" as const,
      providerSubject: "https://example.cloudflareaccess.com|person-a",
      authenticatedAt: Date.now(),
      csrfToken: "",
    };
    const challenge = await startAccessStepUp(accessEnv, operator, "operator.create");
    await expect(
      consumeAccessStepUp(accessEnv, operator, "operator.create", challenge),
    ).rejects.toThrow("reauth-required");
    await expect(
      completeAccessStepUp(
        accessEnv,
        { ...operator, authenticatedAt: Date.now() - 6 * 60_000 },
        challenge,
      ),
    ).rejects.toThrow("reauth-required");
    await expect(
      completeAccessStepUp(accessEnv, { ...operator, providerSubject: "other" }, challenge),
    ).rejects.toThrow("reauth-required");
    await completeAccessStepUp(accessEnv, operator, challenge);
    await expect(
      consumeAccessStepUp(accessEnv, operator, "rotation.plan", challenge),
    ).rejects.toThrow("reauth-required");
    await expect(
      consumeAccessStepUp(
        accessEnv,
        { ...operator, providerSubject: "other" },
        "operator.create",
        challenge,
      ),
    ).rejects.toThrow("reauth-required");
    await consumeAccessStepUp(accessEnv, operator, "operator.create", challenge);
    await expect(
      consumeAccessStepUp(accessEnv, operator, "operator.create", challenge),
    ).rejects.toThrow("reauth-required");
  });
  it("validates the step-up Access JWT against its separate audience and registered identity", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ keys: [jwk] }, { headers: { "Cache-Control": "max-age=60" } }),
      ),
    );
    try {
      const accessEnv: AdminEnv = {
        ...env,
        ADMIN_AUTH_MODE: "cloudflare-access",
        RP_ID: undefined,
        ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
        ACCESS_AUD: "base-audience",
        ACCESS_STEP_UP_AUD: "step-up-audience",
        ACCESS_STEP_UP_ORIGIN: "https://step-up.example.com",
        ROTATION: { listKeys: async () => ({}), plan: async () => ({ id: "rotation-test" }) },
      };
      await env.ADMIN_DB.prepare(
        "INSERT INTO operator_identities (provider, provider_subject, operator_id) VALUES ('cloudflare-access', ?, ?)",
      )
        .bind("https://example.cloudflareaccess.com|person-a", operatorId)
        .run();
      const token = await new SignJWT({ type: "app" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://example.cloudflareaccess.com")
        .setAudience("step-up-audience")
        .setSubject("person-a")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      const request = new Request(origin + "/api/access-step-up/complete", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      });
      expect((await authenticateAccess(request, accessEnv, "step-up-audience"))?.id).toBe(
        operatorId,
      );
      await expect(authenticateAccess(request, accessEnv, "base-audience")).rejects.toThrow();
      const mixedAudienceToken = await new SignJWT({ type: "app" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://example.cloudflareaccess.com")
        .setAudience(["base-audience", "step-up-audience"])
        .setSubject("person-a")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      expect(
        await authenticateAccess(
          new Request(origin + "/api/me", {
            headers: { "Cf-Access-Jwt-Assertion": mixedAudienceToken },
          }),
          accessEnv,
          "step-up-audience",
        ),
      ).toBeNull();
      const baseToken = await new SignJWT({ type: "app" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://example.cloudflareaccess.com")
        .setAudience("base-audience")
        .setSubject("person-a")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      const baseHeaders = { "Cf-Access-Jwt-Assertion": baseToken };
      const meResponse = await app.request(origin + "/api/me", { headers: baseHeaders }, accessEnv);
      expect(meResponse.status).toBe(200);
      const me = await meResponse.json<{ csrfToken: string }>();
      const mutationHeaders = {
        ...baseHeaders,
        Origin: origin,
        "X-CSRF-Token": me.csrfToken,
        "Content-Type": "application/json",
      };
      const start = await app.request(
        origin + "/api/access-step-up/challenges",
        {
          method: "POST",
          headers: mutationHeaders,
          body: JSON.stringify({ action: "operator.create" }),
        },
        accessEnv,
      );
      expect(start.status).toBe(200);
      const { challengeId, url } = await start.json<{ challengeId: string; url: string }>();
      expect(new URL(url).origin).toBe("https://step-up.example.com");
      const statusUrl = origin + `/api/access-step-up/challenges/${challengeId}`;
      expect(
        await (await app.request(statusUrl, { headers: baseHeaders }, accessEnv)).json(),
      ).toEqual({ completed: false });
      expect(
        (
          await app.request(
            origin + new URL(url).pathname + new URL(url).search,
            { headers: { "Cf-Access-Jwt-Assertion": token } },
            accessEnv,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await app.request(
            "https://step-up.example.com/api/me",
            { headers: { "Cf-Access-Jwt-Assertion": token } },
            accessEnv,
          )
        ).status,
      ).toBe(404);
      expect((await app.request(url, { headers: baseHeaders }, accessEnv)).status).toBe(401);
      expect(
        (await app.request(url, { headers: { "Cf-Access-Jwt-Assertion": token } }, accessEnv))
          .status,
      ).toBe(200);
      expect(
        await (await app.request(statusUrl, { headers: baseHeaders }, accessEnv)).json(),
      ).toEqual({ completed: true });
      const rotationBody = JSON.stringify({
        algorithm: "RS256",
        prepublishSeconds: 7_200,
        retirementGraceSeconds: 600,
      });
      expect(
        (
          await app.request(
            origin + "/api/rotations",
            {
              method: "POST",
              headers: { ...mutationHeaders, "X-Step-Up-Challenge": challengeId },
              body: rotationBody,
            },
            accessEnv,
          )
        ).status,
      ).toBe(403);
      const create = {
        method: "POST",
        headers: { ...mutationHeaders, "X-Step-Up-Challenge": challengeId },
        body: JSON.stringify({
          id: "22222222-2222-4222-8222-222222222222",
          role: "viewer",
          providerSubject: "https://example.cloudflareaccess.com|person-b",
        }),
      };
      expect((await app.request(origin + "/api/operators", create, accessEnv)).status).toBe(201);
      expect((await app.request(origin + "/api/operators", create, accessEnv)).status).toBe(403);
      const rotationStart = await app.request(
        origin + "/api/access-step-up/challenges",
        {
          method: "POST",
          headers: mutationHeaders,
          body: JSON.stringify({ action: "rotation.plan" }),
        },
        accessEnv,
      );
      const rotationChallenge = await rotationStart.json<{ challengeId: string; url: string }>();
      const completed = await app.request(
        rotationChallenge.url,
        { headers: { "Cf-Access-Jwt-Assertion": token, "Accept-Language": "en-US,ja;q=0.8" } },
        accessEnv,
      );
      expect(completed.status).toBe(200);
      expect(await completed.text()).toContain('lang="en"');
      const rotationRequest = {
        method: "POST",
        headers: { ...mutationHeaders, "X-Step-Up-Challenge": rotationChallenge.challengeId },
        body: rotationBody,
      };
      expect(
        (await app.request(origin + "/api/rotations", rotationRequest, accessEnv)).status,
      ).toBe(202);
      expect(
        (await app.request(origin + "/api/rotations", rotationRequest, accessEnv)).status,
      ).toBe(403);
      const target = "22222222-2222-4222-8222-222222222222";
      const updateChallenge = await app.request(
        origin + "/api/access-step-up/challenges",
        {
          method: "POST",
          headers: mutationHeaders,
          body: JSON.stringify({ action: "operator.update" }),
        },
        accessEnv,
      );
      const updateProof = await updateChallenge.json<{ challengeId: string; url: string }>();
      await app.request(
        updateProof.url,
        { headers: { "Cf-Access-Jwt-Assertion": token } },
        accessEnv,
      );
      const editHeaders = { ...mutationHeaders, "X-Step-Up-Challenge": updateProof.challengeId };
      expect(
        (
          await app.request(
            origin + `/api/operators/${target}/access-identity`,
            { method: "DELETE", headers: editHeaders, body: JSON.stringify({ version: 0 }) },
            accessEnv,
          )
        ).status,
      ).toBe(200);
      expect(
        await env.ADMIN_DB.prepare("SELECT enabled FROM operators WHERE id=?")
          .bind(target)
          .first("enabled"),
      ).toBe(0);
      const linkStart = await app.request(
        origin + "/api/access-step-up/challenges",
        {
          method: "POST",
          headers: mutationHeaders,
          body: JSON.stringify({ action: "operator.update" }),
        },
        accessEnv,
      );
      const linkProof = await linkStart.json<{ challengeId: string; url: string }>();
      await app.request(
        linkProof.url,
        { headers: { "Cf-Access-Jwt-Assertion": token } },
        accessEnv,
      );
      const relinkHeaders = { ...mutationHeaders, "X-Step-Up-Challenge": linkProof.challengeId };
      expect(
        (
          await app.request(
            origin + `/api/operators/${target}/access-identity`,
            {
              method: "PUT",
              headers: relinkHeaders,
              body: JSON.stringify({
                version: 1,
                providerSubject: "https://example.cloudflareaccess.com|person-new",
              }),
            },
            accessEnv,
          )
        ).status,
      ).toBe(200);
      expect(
        await env.ADMIN_DB.prepare("SELECT enabled FROM operators WHERE id=?")
          .bind(target)
          .first("enabled"),
      ).toBe(1);
      expect(
        await env.ADMIN_DB.prepare(
          "SELECT provider_subject FROM operator_identities WHERE operator_id=?",
        )
          .bind(target)
          .first("provider_subject"),
      ).toBe("https://example.cloudflareaccess.com|person-new");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
