import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
  plugins: [
    cloudflareTest({ main: "./src/index.ts", miniflare: { compatibilityDate: "2026-10-24" } }),
  ],
});
