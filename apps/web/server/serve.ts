// Production server for the built app: `node server/serve.ts` (Node 24 type stripping, no
// dependencies). Serves `dist/` with the NFR-10 headers on every response, `/config.json` from
// the whitelisted env vars, and `index.html` for any path without a file extension so deep
// links such as `/g/<vault_id>` load the app. Text responses go out brotli or gzip encoded
// when the client accepts it (story 9.5). The wallet pages (`/vault/new`, `/vault/<id>`) get
// their own CSP with a fresh nonce per response, also written into the page as
// `<meta name="csp-nonce">`; every other response keeps the strict CSP. Refuses to start on a
// bad config.
import { randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import {
  ConfigError,
  isWalletPath,
  loadConfig,
  securityHeaders,
  walletContentSecurityPolicy,
  type PublicConfig,
} from "./config.ts";

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

/**
 * Text types worth encoding. Images, fonts and video are compressed formats already, and are
 * always sent as they are (byte ranges included).
 */
const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".map",
  ".txt",
  ".svg",
  ".webmanifest",
]);

export type Encoding = "br" | "gzip";

/**
 * The encoding to send for an `Accept-Encoding` header: brotli or gzip, whichever the client
 * weights higher (brotli on a tie, `*` standing for any not named), or null for the raw bytes.
 */
export function negotiateEncoding(header: string | undefined): Encoding | null {
  if (header === undefined) return null;
  const weights = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name = "", ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
    if (name === "") continue;
    const q = params.find((param) => /^q\s*=/.test(param));
    const weight = q === undefined ? 1 : Number(q.slice(q.indexOf("=") + 1).trim());
    weights.set(name, Number.isFinite(weight) && weight > 0 ? Math.min(weight, 1) : 0);
  }
  const weight = (name: Encoding) => weights.get(name) ?? weights.get("*") ?? 0;
  const br = weight("br");
  const gz = weight("gzip");
  if (br === 0 && gz === 0) return null;
  return br >= gz ? "br" : "gzip";
}

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Maximum compression: each body is encoded once per process and then served from memory. */
function encode(body: Buffer, encoding: Encoding): Promise<Buffer> {
  return encoding === "br"
    ? brotli(body, {
        params: {
          [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY,
          [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
          [zlib.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      })
    : gzipAsync(body, { level: zlib.Z_BEST_COMPRESSION });
}

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

  // Encoded bodies, keyed by encoding and source (a dist file path, or a fixed body's name).
  // dist/ does not change while the server runs: a deploy restarts it.
  const encoded = new Map<string, Promise<Buffer>>();
  const encodedBody = (key: string, encoding: Encoding, load: () => Promise<Buffer>) => {
    const cacheKey = `${encoding}:${key}`;
    let body = encoded.get(cacheKey);
    if (body === undefined) {
      body = load().then((raw) => encode(raw, encoding));
      // A failure is not cached: the raw bytes go out and the next request tries again.
      body.catch(() => encoded.delete(cacheKey));
      encoded.set(cacheKey, body);
    }
    return body;
  };

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

  /** A fixed text body (index.html, /config.json), encoded when the client accepts it. */
  const sendText = async (
    request: IncomingMessage,
    response: ServerResponse,
    key: string,
    body: Buffer,
    extra: Record<string, string>,
  ) => {
    const encoding = negotiateEncoding(request.headers["accept-encoding"]);
    const vary = { vary: "accept-encoding" };
    if (encoding !== null) {
      const out = await encodedBody(key, encoding, async () => body).catch(() => null);
      // A body too small to gain from encoding goes out as it is.
      if (out !== null && out.length < body.length) {
        return send(request, response, 200, out, {
          ...extra,
          ...vary,
          "content-encoding": encoding,
        });
      }
    }
    return send(request, response, 200, body, { ...extra, ...vary });
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
      return sendText(request, response, "/config.json", configBody, {
        "content-type": JSON_TYPE,
        "cache-control": NO_STORE,
      });
    }

    if (isWalletPath(path)) {
      // A fresh nonce per response, so this body is never cached or pre-encoded.
      const nonce = randomBytes(16).toString("base64");
      const meta = `<meta name="csp-nonce" content="${nonce}" />`;
      const text = index.toString("utf8");
      const html = text.includes("</head>")
        ? text.replace("</head>", `  ${meta}\n  </head>`)
        : `${meta}${text}`;
      return send(request, response, 200, Buffer.from(html), {
        "content-type": HTML,
        "cache-control": NO_STORE,
        "content-security-policy": walletContentSecurityPolicy(config, nonce),
      });
    }

    const extension = extname(path);
    if (extension === "" || path === "/index.html") {
      return sendText(request, response, "/index.html", index, {
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
      const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
      const cacheControl = path.startsWith("/assets/") ? IMMUTABLE : "no-cache";
      // Text is encoded whole when the client accepts it; a byte range always gets raw bytes.
      if (COMPRESSIBLE.has(extension)) {
        const encoding =
          request.headers.range === undefined
            ? negotiateEncoding(request.headers["accept-encoding"])
            : null;
        const out =
          encoding === null
            ? null
            : await encodedBody(file, encoding, () => readFile(file)).catch(() => null);
        if (encoding !== null && out !== null && out.length < size) {
          return send(request, response, 200, out, {
            "content-type": contentType,
            "cache-control": cacheControl,
            "content-encoding": encoding,
            vary: "accept-encoding",
          });
        }
      }
      const fileHeaders: Record<string, string> = {
        "content-type": contentType,
        "cache-control": cacheControl,
        "accept-ranges": "bytes",
        ...(COMPRESSIBLE.has(extension) ? { vary: "accept-encoding" } : {}),
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

  // Encode index.html, /config.json and every text file in dist/ in the background now, one at
  // a time so requests never queue behind a pile of encodes, and the main bundle is usually
  // ready before the first visitor asks for it. index.html is served from memory under its
  // own key, so its file in dist/ is skipped.
  void (async () => {
    const jobs: [string, () => Promise<Buffer>][] = [
      ["/index.html", async () => index],
      ["/config.json", async () => configBody],
    ];
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      const file = join(entry.parentPath, entry.name);
      const ext = extname(entry.name);
      if (!entry.isFile() || !COMPRESSIBLE.has(ext) || ext === ".map") continue;
      if (file === join(root, "index.html")) continue;
      jobs.push([file, () => readFile(file)]);
    }
    for (const [key, load] of jobs) {
      for (const encoding of ["br", "gzip"] as const) {
        await encodedBody(key, encoding, load).catch(() => undefined);
      }
    }
  })().catch(() => undefined);

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
