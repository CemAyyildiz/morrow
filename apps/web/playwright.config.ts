import { defineConfig } from "@playwright/test";
import { WATCHER_URL, WEB_ENV, WEB_PORT } from "./e2e/services.ts";

const CI = Boolean(process.env.CI);

// The shell is checked against the production build served by `server/serve.ts`, the
// production server, at the mockup's desktop size and at a phone size. Local stubs stand in
// for the NEAR RPC, the Bitcoin backend and the watcher (e2e/stub-services.ts).
export default defineConfig({
  testDir: "e2e",
  // Results live under node_modules so the root `eslint .` and `prettier --check .` never
  // see them (Playwright writes an unformatted .last-run.json).
  outputDir: "node_modules/.playwright/test-results",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 930 } } },
    {
      name: "phone",
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: [
    {
      command: "node e2e/stub-services.ts",
      url: `${WATCHER_URL}/heartbeat`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "pnpm build && node server/serve.ts",
      url: `http://127.0.0.1:${WEB_PORT}/challenge`,
      env: WEB_ENV,
      // Always build and serve afresh, so the run never checks a stale bundle.
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
