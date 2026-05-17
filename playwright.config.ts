import { defineConfig } from "@playwright/test";
export default defineConfig({
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "test-screenshots",
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
});
