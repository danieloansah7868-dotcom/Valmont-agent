import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a real Next.js server with a throwaway SQLite
 * database. Nothing here bypasses authentication in production code: the tests
 * mint a genuine encrypted session cookie using the same `SESSION_SECRET` the
 * server is started with, exactly as a real sign-in would produce.
 */
const PORT = Number(process.env.E2E_PORT ?? 3200);
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * A secret generated per run unless CI supplies one. Never a hardcoded
 * fallback: a weak default in a committed file is a real risk if it ever
 * reaches a deployed environment.
 */
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error(
    "SESSION_SECRET (32+ characters) must be set before running the end-to-end tests. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}

// A temporary database per run. The real .data directory is never opened.
const dataDir = process.env.E2E_DATA_DIR ?? ".e2e-data";

/**
 * Optional override for the Chromium executable and its shared-library path.
 * Normal CI installs the Playwright build and leaves this unset; sandboxed
 * environments that cannot download it can point Playwright at any Chromium
 * binary (for example a package-bundled one) instead. `undefined` keeps the
 * default Playwright browser.
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const chromiumLibs = process.env.PLAYWRIGHT_CHROMIUM_LIBS;
const browserLaunchOptions =
  chromiumExecutable || chromiumLibs
    ? {
        executablePath: chromiumExecutable || undefined,
        env: chromiumLibs
          ? { ...process.env, LD_LIBRARY_PATH: chromiumLibs }
          : undefined,
      }
    : undefined;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // A stray .only must never make CI pass silently.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions: browserLaunchOptions,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "iphone",
      use: {
        ...devices["iPhone 13"],
        // The iPhone 13 descriptor defaults to WebKit, but CI installs only
        // Chromium. Pinning the engine keeps the mobile viewport, touch and
        // user-agent emulation while running on the browser that is actually
        // present — otherwise every test in this project fails to launch.
        // Swap to WebKit only alongside `playwright install webkit` in CI.
        defaultBrowserType: "chromium",
        browserName: "chromium",
      },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: baseURL,
    timeout: 300_000,
    // Never silently reuse a server someone else configured in CI.
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      SESSION_SECRET: sessionSecret,
      NEXT_TELEMETRY_DISABLED: "1",
      // Placeholder OAuth credentials so the session cookie is honoured. These
      // are NOT an auth bypass: the tests still present a real encrypted
      // session cookie, and no production code path is weakened.
      GITHUB_CLIENT_ID: "e2e-client-id",
      GITHUB_CLIENT_SECRET: "e2e-client-secret",
      // Studio and chat share this one throwaway file.
      CHAT_STORE_PATH: `${dataDir}/chat-store.json`,
      CHAT_SQLITE_PATH: `${dataDir}/chat-store.sqlite`,
      // Force the SQLite path: e2e must not touch the CI PostgreSQL database.
      DATABASE_URL: "",
    },
  },
});
