import { describe, expect, it, vi } from "vitest";
import { WatcherRequestError, watcherClient } from "./watcher-client.js";

describe("watcherClient.requestClawback", () => {
  it("POSTs {vault_id} with the bearer token and returns the job", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ job_id: "j1", vault_id: "7", status: "queued" }, { status: 202 }),
    );
    const client = watcherClient({
      url: "https://watcher.example/",
      adminToken: "admin-token",
      fetch: fetchFn as unknown as typeof fetch,
    });
    expect(await client.requestClawback("7")).toEqual({ job_id: "j1", status: "queued" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://watcher.example/clawbacks");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer admin-token");
    expect(JSON.parse(String(init.body))).toEqual({ vault_id: "7" });
  });

  it("throws on a refusal or an unreachable watcher, never echoing the token", async () => {
    const refused = watcherClient({
      url: "https://watcher.example",
      adminToken: "admin-token",
      fetch: (async () =>
        Response.json({ error: "unauthorized" }, { status: 401 })) as typeof fetch,
    });
    const error = await refused.requestClawback("7").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WatcherRequestError);
    expect((error as WatcherRequestError).status).toBe(401);
    expect(String(error)).not.toContain("admin-token");

    const down = watcherClient({
      url: "https://watcher.example",
      adminToken: "admin-token",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.requestClawback("7")).rejects.toThrow(/watcher unreachable/);

    const noStatus = watcherClient({
      url: "https://watcher.example",
      adminToken: "admin-token",
      fetch: (async () => Response.json({ job_id: "j1" }, { status: 202 })) as typeof fetch,
    });
    await expect(noStatus.requestClawback("7")).rejects.toThrow(/HTTP 202/);
  });
});
