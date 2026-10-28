import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { build } from "esbuild";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { makeConfigs } from "./deployment-config.mjs";
import { e2eSeedSql } from "./staging-sql.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const configs = makeConfigs(
  { accountId: "0".repeat(32), workersSubdomain: "example-account", prefix: "e2e-oidc" },
  root,
  { sample: true },
);
const databases = { POLICY_DB: "e2e-policy", KEY_DB: "e2e-keys" };
const pairs = [
  { pair: generateKeyPairSync("rsa", { modulusLength: 3072 }), alg: "RS256", kid: "rsa" },
  { pair: generateKeyPairSync("ec", { namedCurve: "P-256" }), alg: "ES256", kid: "ec" },
];
const jwks = pairs.map(({ pair, alg, kid }) => ({
  ...pair.publicKey.export({ format: "jwk" }),
  kid,
  alg,
  use: "sig",
}));
async function worker(kind: "issuer" | "smoke" | "receiver") {
  const config = configs[kind];
  const compiled = await build({
    entryPoints: [config.main],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
  });
  return {
    name: config.name,
    modules: true,
    script: compiled.outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
    bindings: { ...config.vars },
    serviceBindings: Object.fromEntries(
      (config.services ?? [])
        .filter((service) => !["ADMIN", "ROTATION"].includes(service.binding))
        .map((service) => [
          service.binding,
          { name: service.service, entrypoint: service.entrypoint, props: service.props },
        ]),
    ),
  };
}
const issuer = await worker("issuer");
const caller = await worker("smoke");
const receiver = await worker("receiver");
const probeToken = "local-e2e-probe-secret-at-least-32-characters";
const callerWorker = { ...caller, bindings: { ...caller.bindings, SMOKE_TOKEN: probeToken } };
const missingPropsCaller = {
  ...callerWorker,
  name: "e2e-missing-props",
  serviceBindings: {
    ...caller.serviceBindings,
    OIDC_ISSUER: { name: issuer.name, entrypoint: "IssuerRpc", props: {} },
  },
};

export default defineConfig({
  root: fileURLToPath(new URL("../apps/smoke-worker", import.meta.url)),
  test: { include: ["test/e2e.test.ts"], fileParallelism: false, testTimeout: 15000 },
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL("../apps/smoke-worker/test/harness.ts", import.meta.url)),
      miniflare: {
        compatibilityDate: "2026-10-26",
        d1Databases: databases,
        serviceBindings: {
          CALLER: caller.name,
          MISSING_PROPS_CALLER: missingPropsCaller.name,
          ISSUER_HTTP: issuer.name,
          RECEIVER: receiver.name,
        },
        workers: [
          {
            ...issuer,
            d1Databases: databases,
            bindings: {
              ...issuer.bindings,
              ...Object.fromEntries(
                pairs.map(({ pair, kid }) => [
                  `SIGNING_KEY_${kid.toUpperCase()}`,
                  pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
                ]),
              ),
            },
          },
          receiver,
          callerWorker,
          missingPropsCaller,
        ],
        bindings: {
          SMOKE_TOKEN: probeToken,
          SMOKE_CLIENT: "e2e-oidc-smoke",
          SMOKE_AUDIENCE: configs.smoke.vars.SMOKE_AUDIENCE,
          PUBLIC_JWKS: JSON.stringify(jwks),
          POLICY_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL("../migrations/policy", import.meta.url)),
          ),
          KEY_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL("../migrations/keys", import.meta.url)),
          ),
          SEED_SQL: e2eSeedSql({
            clientId: "e2e-oidc-smoke",
            subject: configs.smoke.vars.SMOKE_SUBJECT,
            audience: configs.smoke.vars.SMOKE_AUDIENCE,
            now: 0,
            eventId: "e2e-seed",
          }),
        },
      },
    }),
  ],
});
