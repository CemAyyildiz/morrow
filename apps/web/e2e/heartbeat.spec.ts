import { expect, test, type Page } from "@playwright/test";
import { RPC_URL, WATCHER_URL } from "./services.ts";

// The system card against a watcher whose heartbeat the test controls, on a fake clock:
// a new heartbeat shows within one 30 s poll, a stale or missing one turns the line to alarm.

const ALARM = "rgb(255, 107, 91)";
const OK = "rgb(126, 226, 168)";
const START = new Date("2026-11-05T09:00:00Z");

/**
 * Serves `/heartbeat` with `updated_at: current()`; `null` is a watcher without progress,
 * `undefined` an unreachable one.
 */
async function routeHeartbeat(page: Page, current: () => string | null | undefined) {
  await page.route(`${WATCHER_URL}/heartbeat`, (route) => {
    const updatedAt = current();
    if (updatedAt === undefined) return route.abort("connectionrefused");
    return route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
      contentType: "application/json",
      body: JSON.stringify({ last_seq: "41", last_block_timestamp: null, updated_at: updatedAt }),
    });
  });
}

const minutesBefore = (now: number, minutes: number) =>
  new Date(now - minutes * 60_000).toISOString();

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the system card lives in the sidebar");
  await page.clock.install({ time: START });
});

test("a new heartbeat shows within 30 s, a stale one is alarm", async ({ page }) => {
  let updatedAt: string | null | undefined = minutesBefore(START.getTime(), 6);
  await routeHeartbeat(page, () => updatedAt);
  await page.goto("/challenge");

  const alerts = page.getByTestId("system-alerts");
  await expect(alerts).toHaveText("Alerts: watcher last seen 6 min ago");
  await expect(alerts).toHaveAttribute("data-alarm", "true");
  await expect(alerts).toHaveCSS("color", ALARM);
  await expect(page.getByTestId("system-dot")).toHaveCSS("background-color", ALARM);

  // The watcher reports again; the next poll, at most 30 s later, picks it up.
  updatedAt = new Date(START.getTime() + 1_000).toISOString();
  await page.clock.runFor(30_000);
  await expect(alerts).toHaveText("Alerts: watcher last seen 0 min ago");
  await expect(alerts).toHaveAttribute("data-alarm", "false");
  await expect(page.getByTestId("system-dot")).toHaveCSS("background-color", OK);

  // The watcher stops answering: alarm on the next poll, and back once it answers again.
  updatedAt = undefined;
  await page.clock.runFor(30_000);
  await expect(alerts).toHaveText("Alerts: watcher unreachable");
  await expect(alerts).toHaveAttribute("data-alarm", "true");

  updatedAt = new Date(START.getTime() + 60_000).toISOString();
  await page.clock.runFor(30_000);
  await expect(alerts).toHaveText("Alerts: watcher last seen 0 min ago");
});

test("a watcher with no progress yet is alarm", async ({ page }) => {
  await routeHeartbeat(page, () => null);
  await page.goto("/challenge");
  await expect(page.getByTestId("system-alerts")).toHaveText("Alerts: watcher has not reported");
  await expect(page.getByTestId("system-alerts")).toHaveAttribute("data-alarm", "true");
});

test("an RPC error shows the contract as unknown with the alarm dot", async ({ page }) => {
  await routeHeartbeat(page, () => minutesBefore(START.getTime(), 1));
  await page.route(`${RPC_URL}/**`, (route) => route.abort("connectionrefused"));
  await page.goto("/challenge");
  await expect(page.getByTestId("system-contract")).toHaveText("contract unknown");
  await expect(page.getByTestId("system-dot")).toHaveCSS("background-color", ALARM);
  await expect(page.getByTestId("system-alerts")).toHaveText("Alerts: watcher last seen 1 min ago");
});

test("without a watcher URL the card says so, muted: absent is not failing", async ({ page }) => {
  // The same deployment with MORROW_WATCHER_URL unset.
  await page.route("/config.json", async (route) => {
    const config = (await (await route.fetch()).json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...config, watcher_url: null } });
  });
  let polled = false;
  await page.route(`${WATCHER_URL}/**`, (route) => {
    polled = true;
    return route.abort();
  });
  await page.goto("/challenge");
  await expect(page.getByTestId("system-alerts")).toHaveText(
    "Alerts: no watcher for this deployment",
  );
  await expect(page.getByTestId("system-alerts")).toHaveAttribute("data-alarm", "false");
  await expect(page.getByTestId("system-dot")).toHaveAttribute("data-state", "checking");
  await page.clock.runFor(60_000);
  expect(polled).toBe(false);
});

test("the contract reads checking, not alarm, until the RPC answers", async ({ page }) => {
  await routeHeartbeat(page, () => minutesBefore(START.getTime(), 1));
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => (release = done));
  await page.route(`${RPC_URL}/**`, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/challenge");
  await expect(page.getByTestId("system-contract")).toHaveText("contract checking");
  await expect(page.getByTestId("system-dot")).toHaveAttribute("data-state", "checking");
  release();
  await expect(page.getByTestId("system-contract")).toHaveText("contract locked");
  await expect(page.getByTestId("system-dot")).toHaveCSS("background-color", OK);
});

test("a failed lock check is retried on the next 30 s tick", async ({ page }) => {
  await routeHeartbeat(page, () => minutesBefore(START.getTime(), 1));
  let fail = true;
  await page.route(`${RPC_URL}/**`, (route) =>
    fail ? route.abort("connectionrefused") : route.continue(),
  );
  await page.goto("/challenge");
  await expect(page.getByTestId("system-contract")).toHaveText("contract unknown");
  fail = false;
  await page.clock.runFor(30_000);
  await expect(page.getByTestId("system-contract")).toHaveText("contract locked");
});

test.describe("a bad /config.json shows the configuration error", () => {
  const bodies: [string, { status: number; json: unknown }][] = [
    ["a 500", { status: 500, json: { error: "unavailable" } }],
    ["an empty object", { status: 200, json: {} }],
  ];
  for (const [name, reply] of bodies) {
    test(name, async ({ page }) => {
      await page.route("/config.json", (route) => route.fulfill(reply));
      await page.goto("/challenge");
      await expect(page.getByTestId("config-failed")).toBeVisible();
      await expect(page.getByTestId("config-failed")).toContainText("Configuration unavailable");
      await expect(page.getByTestId("sidebar")).toHaveCount(0);
    });
  }
});
