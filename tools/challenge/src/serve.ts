import { createServer, type Server } from "node:http";
import { publicRound, type RoundStore } from "./store.js";

/**
 * Public round metadata for the challenge page (Story 7.2): `GET /round` → the current open
 * round's published keys and addresses once its funding has confirmed, 404 before that. Only `publicRound` fields are served.
 */
export function createRoundServer(store: RoundStore): Server {
  return createServer((request, response) => {
    const json = (status: number, body: unknown) =>
      response
        .writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type",
        })
        .end(body === null ? undefined : JSON.stringify(body));

    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      return json(400, { error: "bad request target" });
    }

    if (request.method === "OPTIONS") return json(204, null);
    if (request.method === "GET" && path === "/round") {
      store.current().then(
        (round) => {
          if (!round) return json(404, { error: "no open round" });
          // The keys are useful (and the deadline known) only once the funding has confirmed.
          if (round.funding_height === null) {
            return json(404, { error: `round ${round.round} funding is not confirmed yet` });
          }
          return json(200, publicRound(round));
        },
        () => json(503, { error: "unavailable" }),
      );
      return;
    }
    json(404, { error: "not found" });
  });
}
