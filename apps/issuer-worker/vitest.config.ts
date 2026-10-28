import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { build } from "esbuild";
import { generateKeyPairSync } from "node:crypto";

const compiled = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers"],
});
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "aux-key",
  alg: "RS256",
  use: "sig",
};
const databases = { POLICY_DB: "standalone-policy", KEY_DB: "standalone-keys" };

export default defineConfig({
  test: { fileParallelism: false },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        d1Databases: databases,
        serviceBindings: { AUXILIARY_CALLER: "standalone-caller" },
        workers: [
          {
            name: "standalone-issuer",
            modules: true,
            script: compiled.outputFiles[0].text,
            compatibilityDate: "2026-10-24",
            d1Databases: databases,
            bindings: {
              ISSUER_URL: "https://oidc.example.com",
              RATE_LIMIT_PER_MINUTE: "120",
              SIGNING_KEY_AUX: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
            },
          },
          {
            name: "standalone-caller",
            modules: true,
            compatibilityDate: "2026-10-24",
            serviceBindings: {
              OIDC_ISSUER: {
                name: "standalone-issuer",
                entrypoint: "IssuerRpc",
                props: { clientId: "fixed-caller" },
              },
            },
            script: `export default { async fetch(request, env) { try { return new Response(await env.OIDC_ISSUER.issue(await request.json())); } catch (error) { return Response.json({ error: error.message }, { status: 403 }); } } };`,
          },
        ],
        bindings: {
          AUX_PUBLIC_JWK: JSON.stringify(jwk),
          POLICY_MIGRATIONS: await readD1Migrations("../../migrations/policy"),
          KEY_MIGRATIONS: await readD1Migrations("../../migrations/keys"),
        },
      },
    }),
  ],
});
