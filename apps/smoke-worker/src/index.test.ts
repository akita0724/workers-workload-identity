import { expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import worker, { type Env } from "./index.js";

const token = "test-only-probe-token-32-characters-long";
function environment(): Env {
  return {
    SMOKE_TOKEN: token,
    OIDC_OTHER_ISSUER: { issue: vi.fn() },
    E2E_RECEIVER: { fetch: vi.fn() },
    ISSUER_URL: "https://oidc.example.com",
    SMOKE_AUDIENCE: "urn:test",
    SMOKE_SUBJECT: "service:test",
    OIDC_ISSUER: {
      issue: vi.fn(async () => {
        throw new Error("must not issue");
      }),
    },
    ROTATION: {
      plan: vi.fn(async () => ({})),
      listKeys: vi.fn(async () => ({ keys: [], runs: [] })),
    },
  };
}
function request(path: string, authorized = true, body = {}) {
  return new Request("https://smoke.example.com" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
it("requires the probe secret before invoking either privileged binding", async () => {
  const env = environment();
  for (const path of ["/keys", "/rotation", "/check", "/e2e"])
    expect((await worker.fetch(request(path, false), env)).status).toBe(401);
  expect(env.OIDC_ISSUER.issue).not.toHaveBeenCalled();
  expect(env.ROTATION.plan).not.toHaveBeenCalled();
  expect(env.OIDC_OTHER_ISSUER.issue).not.toHaveBeenCalled();
  expect(env.E2E_RECEIVER.fetch).not.toHaveBeenCalled();
});
it("returns only verification results, never the assertion", async () => {
  const env = environment();
  const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(env.ISSUER_URL)
    .setSubject(env.SMOKE_SUBJECT)
    .setAudience(env.SMOKE_AUDIENCE)
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("300s")
    .setJti(crypto.randomUUID())
    .sign(pair.privateKey);
  env.OIDC_ISSUER.issue = async ({ aud }) => {
    if (aud !== env.SMOKE_AUDIENCE) throw new Error("audience-denied");
    return assertion;
  };
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", kid: "test-key" }],
    }),
  );
  try {
    const response = await worker.fetch(request("/check"), env);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: true, signatureVerified: true, audienceDenied: true });
    expect(body).not.toContain(assertion);
  } finally {
    fetcher.mockRestore();
  }
});
it("does not expose binding failures or token material in its errors", async () => {
  const env = environment();
  const response = await worker.fetch(request("/check"), env);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "smoke-failed",
    stage: "issue",
    code: "transport-error",
  });
});

it("rejects a public JWKS redirect without following it", async () => {
  const env = environment();
  env.OIDC_ISSUER.issue = async () => "header.payload.signature";
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    // The Workers runtime rejects redirect: "error" before performing a request.
    if (init?.redirect === "error") throw new TypeError("unsupported Workers redirect mode");
    if (init?.redirect !== "manual") throw new Error("must not follow JWKS redirects");
    return new Response(null, { status: 302, headers: { Location: "https://other.example/jwks" } });
  });
  try {
    const response = await worker.fetch(request("/check"), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "smoke-failed", stage: "jwks" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      `${env.ISSUER_URL}/jwks.json`,
      expect.objectContaining({ redirect: "manual" }),
    );
  } finally {
    fetcher.mockRestore();
  }
});
