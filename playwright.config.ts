import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  webServer: { command: "npm run dev", port: 3000, reuseExistingServer: true },
  use: { baseURL: "http://localhost:3000" },
});
