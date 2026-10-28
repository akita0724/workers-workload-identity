import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-10-24",
        d1Databases: ["ADMIN_DB", "POLICY_DB"],
        bindings: {
          ADMIN_ORIGIN: "https://admin.example.com",
          ADMIN_AUTH_MODE: "passkey",
          RP_ID: "admin.example.com",
          CSRF_SECRET: "test-only-secret-32-characters-long",
          POLICY_MIGRATIONS: await readD1Migrations("../../migrations/policy"),
          ADMIN_MIGRATIONS: await readD1Migrations("../../migrations/admin"),
        },
      },
    }),
  ],
});
