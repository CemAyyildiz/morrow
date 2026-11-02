import { defineConfig } from "@playwright/test";

const PORT = 4173;
const CI = Boolean(process.env.CI);

// The shell is checked against the production build served by `vite preview`, at the
// mockup's desktop size and at a phone size.
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
    baseURL: `http://127.0.0.1:${PORT}`,
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
  webServer: {
    command: `pnpm build && pnpm preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/challenge`,
    // Always build and serve afresh, so the run never checks a stale bundle.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
