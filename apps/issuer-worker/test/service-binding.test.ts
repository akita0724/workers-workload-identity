import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { importJWK, jwtVerify } from "jose";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.POLICY_DB, env.POLICY_MIGRATIONS);
  await applyD1Migrations(env.KEY_DB, env.KEY_MIGRATIONS);
  await env.POLICY_DB.batch([
    env.POLICY_DB.prepare(
      "INSERT INTO clients (client_id, subject, enabled, created_at, updated_at) VALUES ('fixed-caller', 'service:fixed', 1, 0, 0)",
    ),
    env.POLICY_DB.prepare(
      "INSERT INTO audiences (audience, algorithm, token_lifetime_seconds, created_at, updated_at) VALUES ('urn:fixed', 'RS256', 300, 0, 0)",
    ),
    env.POLICY_DB.prepare(
      "INSERT INTO client_audience_grants VALUES ('fixed-caller', 'urn:fixed')",
    ),
  ]);
  await env.KEY_DB.prepare(
    "INSERT INTO signing_keys (kid, algorithm, state, public_jwk_json, secret_binding, created_at) VALUES ('aux-key', 'RS256', 'active', ?, 'SIGNING_KEY_AUX', 0)",
  )
    .bind(env.AUX_PUBLIC_JWK)
    .run();
});
function call(body: unknown) {
  // Only the auxiliary test Worker returns the assertion to the local test harness.
  return env.AUXILIARY_CALLER.fetch("https://caller.example.com", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
it("delivers configured props across independent Workers using the production bundle", async () => {
  const response = await call({ aud: "urn:fixed" });
  expect(response.status).toBe(200);
  const verified = await jwtVerify(
    await response.text(),
    await importJWK(JSON.parse(env.AUX_PUBLIC_JWK), "RS256"),
    {
      issuer: "https://oidc.example.com",
      audience: "urn:fixed",
      subject: "service:fixed",
      algorithms: ["RS256"],
    },
  );
  expect(verified.protectedHeader.kid).toBe("aux-key");
  const spoof = await call({ aud: "urn:fixed", clientId: "different-caller" });
  expect(await spoof.json()).toEqual({ error: "invalid-request" });
  await env.POLICY_DB.prepare(
    "UPDATE clients SET enabled = 0 WHERE client_id = 'fixed-caller'",
  ).run();
  expect(await (await call({ aud: "urn:fixed" })).json()).toEqual({ error: "caller-denied" });
});
