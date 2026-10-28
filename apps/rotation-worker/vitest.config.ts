import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        bindings: {
          CF_API_TOKEN: "test-only-token-never-deployed",
          ISSUER_URL: "https://oidc.example.com",
          POLICY_MIGRATIONS: await readD1Migrations("../../migrations/policy"),
          KEY_MIGRATIONS: await readD1Migrations("../../migrations/keys"),
        },
      },
    }),
  ],
});
