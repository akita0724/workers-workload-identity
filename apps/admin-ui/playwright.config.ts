import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5195",
    viewport: { width: 1440, height: 1040 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 5195 --strictPort",
    url: "http://127.0.0.1:5195",
    reuseExistingServer: false,
  },
});
