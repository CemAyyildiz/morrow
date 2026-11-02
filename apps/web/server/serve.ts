// Production server for the built app: `node server/serve.ts` (Node 24 type stripping, no
// dependencies). Serves `dist/` with the NFR-10 headers on every response, `/config.json` from
// the whitelisted env vars, and `index.html` for any path without a file extension so deep
// links such as `/g/<vault_id>` load the app. Refuses to start on a bad config.
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError, loadConfig, securityHeaders, type PublicConfig } from "./config.ts";

const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";

const CONTENT_TYPES: Record<string, string> = {
  ".html": HTML,
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": JSON_TYPE,
  ".map": "application/json; charset=utf-8",
  ".txt": TEXT,
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

/** Vite writes content-hashed files under `assets/`; they never change. */
const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_STORE = "no-store";

export interface WebServerOptions {
  config: PublicConfig;
  /** The built app: `index.html` plus `assets/`. */
  distDir: string;
}

/** `pathname` decoded, or null when it is malformed or could reach outside the dist dir. */
function decodePath(rawUrl: string): string | null {
  const pathname = rawUrl.replace(/[?#].*$/s, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return null;
  // No `.` or `..` segments and no dotfiles, checked after decoding so `%2e%2e` counts.
  if (decoded.split("/").some((segment) => segment.startsWith("."))) return null;
  return decoded;
}

/**
 * A single `bytes=` range from a `Range` header: null when absent or not a single byte range
 * (the full file is sent), "unsatisfiable" when it starts past the end or the file is empty.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return null;
  if (size === 0) return "unsatisfiable";
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return "unsatisfiable";
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (end < start) return null;
  return { start, end };
}

export function createWebServer({ config, distDir }: WebServerOptions): Server {
  const root = resolve(distDir);
  const index = readFileSync(join(root, "index.html"));
  const configBody = Buffer.from(JSON.stringify(config));
  const headers = securityHeaders(config);

  const send = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: Buffer,
    extra: Record<string, string>,
  ) => {
    response.writeHead(status, { ...headers, "content-length": body.length, ...extra });
    response.end(request.method === "HEAD" ? undefined : body);
  };

  const notFound = (request: IncomingMessage, response: ServerResponse) =>
    send(request, response, 404, Buffer.from("Not found\n"), {
      "content-type": TEXT,
      "cache-control": NO_STORE,
    });

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return send(request, response, 405, Buffer.from("Method not allowed\n"), {
        "content-type": TEXT,
        "cache-control": NO_STORE,
        allow: "GET, HEAD",
      });
    }
    const path = decodePath(request.url ?? "/");
    if (path === null) return notFound(request, response);

    if (path === "/config.json") {
      return send(request, response, 200, configBody, {
        "content-type": JSON_TYPE,
        "cache-control": NO_STORE,
      });
    }

    const extension = extname(path);
    if (extension === "" || path === "/index.html") {
      return send(request, response, 200, index, {
        "content-type": HTML,
        "cache-control": NO_STORE,
      });
    }

    const file = resolve(root, `.${path}`);
    if (!file.startsWith(root + sep)) return notFound(request, response);
    try {
      const info = await stat(file);
      if (!info.isFile()) return notFound(request, response);
      const size = info.size;
      const fileHeaders = {
        "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
        "cache-control": path.startsWith("/assets/") ? IMMUTABLE : "no-cache",
        "accept-ranges": "bytes",
      };
      // Safari plays <video> only from a server that answers byte-range requests.
      const range = byteRange(request.headers.range, size);
      if (range === "unsatisfiable") {
        return send(request, response, 416, Buffer.alloc(0), {
          ...fileHeaders,
          "content-range": `bytes */${size}`,
        });
      }
      // Stream the file (or the requested slice) instead of reading it whole.
      const start = range === null ? 0 : range.start;
      const end = range === null ? size - 1 : range.end;
      response.writeHead(range === null ? 200 : 206, {
        ...headers,
        ...fileHeaders,
        "content-length": end - start + 1,
        ...(range === null ? {} : { "content-range": `bytes ${start}-${end}/${size}` }),
      });
      if (request.method === "HEAD" || size === 0) return void response.end();
      const stream = createReadStream(file, { start, end });
      stream.on("error", () => response.destroy());
      stream.pipe(response);
      return;
    } catch {
      return notFound(request, response);
    }
  };

  return createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        send(request, response, 500, Buffer.from("Internal error\n"), {
          "content-type": TEXT,
          "cache-control": NO_STORE,
        });
      } else {
        response.destroy();
      }
    });
  });
}

/** `PORT` as a port number: unset or blank means 8080; anything but 1 to 65535 is null. */
export function parsePort(value: string | undefined): number | null {
  const text = value?.trim() ?? "";
  if (text === "") return 8080;
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

function log(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

function main() {
  let config: PublicConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      log("error", "invalid config", { variable: error.variable, reason: error.message });
      process.exit(1);
    }
    throw error;
  }

  const port = parsePort(process.env.PORT);
  if (port === null) {
    log("error", "invalid config", {
      variable: "PORT",
      reason: "PORT must be an integer from 1 to 65535",
    });
    process.exit(1);
  }
  const host = process.env.HOST ?? "0.0.0.0";
  const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

  let server: Server;
  try {
    server = createWebServer({ config, distDir });
  } catch {
    log("error", "dist/index.html is missing; run `pnpm build` first");
    process.exit(1);
  }
  server.listen(port, host, () => {
    log("info", "listening", { host, port, near_network: config.near_network });
  });
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
