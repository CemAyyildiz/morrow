import type { U64 } from "@morrow/core-ts";

/** The watcher's manual Auto-Clawback trigger (`POST /clawbacks`, Story 3.5). */
export interface WatcherClient {
  /** Queues a Clawback of `vaultId`; the watcher returns its unfinished job if one exists. */
  requestClawback(vaultId: U64): Promise<{ job_id: string; status: string }>;
}

export interface WatcherClientOptions {
  /** `MORROW_WATCHER_URL`, e.g. `https://watcher.example`. */
  url: string;
  /** `MORROW_WATCHER_ADMIN_TOKEN`. Never logged. */
  adminToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class WatcherRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "WatcherRequestError";
  }
}

export function watcherClient(options: WatcherClientOptions): WatcherClient {
  const base = options.url.replace(/\/+$/, "");
  const fetchFn = options.fetch ?? fetch;
  return {
    async requestClawback(vaultId) {
      let response: Response;
      try {
        response = await fetchFn(`${base}/clawbacks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.adminToken}`,
          },
          body: JSON.stringify({ vault_id: vaultId }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
      } catch (error) {
        throw new WatcherRequestError(
          `watcher unreachable: ${error instanceof Error ? error.message : String(error)}`,
          null,
        );
      }
      const body = (await response.json().catch(() => null)) as {
        job_id?: unknown;
        status?: unknown;
        error?: unknown;
      } | null;
      if (
        response.status !== 202 ||
        typeof body?.job_id !== "string" ||
        typeof body.status !== "string"
      ) {
        const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
        throw new WatcherRequestError(
          `watcher POST /clawbacks: HTTP ${response.status}${detail}`,
          response.status,
        );
      }
      return { job_id: body.job_id, status: body.status };
    },
  };
}
