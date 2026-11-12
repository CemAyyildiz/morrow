import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentSecurityPolicy, loadConfig, walletContentSecurityPolicy } from "./config.ts";
import { byteRange, createWebServer, negotiateEncoding, parsePort } from "./serve.ts";

const ENV = {
  MORROW_NEAR_NETWORK: "testnet",
  MORROW_VAULT_CONTRACT: "vault.morrow.testnet",
  MORROW_BTC_NETWORK: "signet",
  MORROW_BTC_BACKEND_URL: "https://mempool.space/signet/api",
  MORROW_WATCHER_URL: "https://watcher.example.org",
};
const config = loadConfig(ENV);
const INDEX = '<!doctype html><script type="module" src="/assets/index-abc123.js"></script>';
/** A bundle big enough that encoding it pays off. */
const BUNDLE = `${"export const greeting = 'Bitcoin that cannot be rushed';\n".repeat(200)}`;

let dir: string;
let server: Server;
let port: number;

beforeAll(async () => {
  // dist/ inside a parent that holds a file the server must never reach.
  dir = mkdtempSync(join(tmpdir(), "morrow-web-"));
  writeFileSync(join(dir, "package.json"), '{"secret":true}');
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log(1);");
  writeFileSync(join(dist, "assets", "bundle-bbb222.js"), BUNDLE);
  writeFileSync(join(dist, "assets", "font-def456.woff2"), "woff2");
  writeFileSync(join(dist, "assets", "hero-aaa111.mp4"), "0123456789");
  writeFileSync(join(dist, ".env"), "SECRET=1");
  server = createWebServer({ config, distDir: dist });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Sends `path` as-is (no client-side normalization of `..` or `%2e`). */
function get(path: string, method = "GET", headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** Like `get`, keeping the body as bytes (an encoded body is not UTF-8). */
function getRaw(
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", fail);
    req.end();
  });
}

function expectSecurityHeaders(headers: IncomingHttpHeaders) {
  expect(headers["content-security-policy"]).toBe(contentSecurityPolicy(config));
  expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
}

describe("web server", () => {
  it.each(["/vault/new", "/vault/7", "/vault/7/", "/vault/new?x=1"])(
    "%s gets the wallet CSP with a fresh nonce, also in the page",
    async (path) => {
      const [a, b] = [await get(path), await get(path, "GET", { "accept-encoding": "br" })];
      for (const reply of [a, b]) {
        expect(reply.status).toBe(200);
        expect(reply.headers["content-type"]).toMatch(/^text\/html/);
        expect(reply.headers["cache-control"]).toBe("no-store");
        expect(reply.headers["content-encoding"]).toBeUndefined();
        const nonce = /<meta name="csp-nonce" content="([A-Za-z0-9+/]{22}==)" \/>/.exec(
          reply.body,
        )?.[1];
        if (nonce === undefined) throw new Error("no nonce meta");
        expect(reply.body).toContain(INDEX);
        expect(reply.headers["content-security-policy"]).toBe(
          walletContentSecurityPolicy(config, nonce),
        );
        expect(reply.headers["strict-transport-security"]).toBe(
          "max-age=31536000; includeSubDomains",
        );
        expect(reply.headers["x-content-type-options"]).toBe("nosniff");
        expect(reply.headers["referrer-policy"]).toBe("no-referrer");
      }
      expect(a.headers["content-security-policy"]).not.toBe(b.headers["content-security-policy"]);
    },
  );

  it.each(["/vault", "/vault/abc", "/vault/new/x", "/vaults/7", "/challenge"])(
    "%s keeps the strict CSP and no nonce",
    async (path) => {
      const reply = await get(path);
      expectSecurityHeaders(reply.headers);
      expect(reply.body).not.toContain("csp-nonce");
    },
  );

  it("serves /config.json with the whitelist only, no-store", async () => {
    const reply = await get("/config.json");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toMatch(/^application\/json/);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expectSecurityHeaders(reply.headers);
    expect(JSON.parse(reply.body)).toEqual(config);
    expect(Object.keys(JSON.parse(reply.body)).sort()).toEqual([
      "bounty_url",
      "btc_backend_url",
      "btc_network",
      "challenge_url",
      "near_archival_rpc_url",
      "near_network",
      "near_rpc_url",
      "near_tx_indexer_url",
      "vault_contract",
      "watcher_url",
    ]);
    expect(JSON.parse(reply.body)).toMatchObject({ challenge_url: null, bounty_url: null });
  });

  it.each(["/", "/challenge", "/g/42", "/g/42/clawback", "/index.html", "/challenge?x=1"])(
    "%s serves index.html, no-store",
    async (path) => {
      const reply = await get(path);
      expect(reply.status).toBe(200);
      expect(reply.body).toBe(INDEX);
      expect(reply.headers["content-type"]).toMatch(/^text\/html/);
      expect(reply.headers["cache-control"]).toBe("no-store");
      expectSecurityHeaders(reply.headers);
    },
  );

  it("serves hashed assets as immutable with their type", async () => {
    const js = await get("/assets/index-abc123.js");
    expect(js.status).toBe(200);
    expect(js.body).toBe("console.log(1);");
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expectSecurityHeaders(js.headers);

    const font = await get("/assets/font-def456.woff2");
    expect(font.headers["content-type"]).toBe("font/woff2");
  });

  it.each([
    "/assets/nope.js",
    "/nope.css",
    "/../package.json",
    "/%2e%2e/package.json",
    "/%2E%2E/%2E%2E/etc/passwd",
    "/assets/..%2f..%2fpackage.json",
    "/..%5cpackage.json",
    "/.env",
    "/%2eenv",
    "/assets/%00.js",
    "/%E0%A4%A",
  ])("%s is a 404 with the headers", async (path) => {
    const reply = await get(path);
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain("secret");
    expect(reply.body).not.toContain("SECRET");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expectSecurityHeaders(reply.headers);
  });

  it("answers HEAD without a body and refuses other methods", async () => {
    const head = await get("/challenge", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expectSecurityHeaders(head.headers);

    const post = await get("/config.json", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    expectSecurityHeaders(post.headers);
  });
});

describe("startup", () => {
  const serve = fileURLToPath(new URL("./serve.ts", import.meta.url));
  /** Runs `node server/serve.ts` with only `env` and returns how it exited. */
  const start = (env: Record<string, string>) =>
    spawnSync(process.execPath, [serve], { env, encoding: "utf8", timeout: 10_000 });

  it.each([
    ["MORROW_VAULT_CONTRACT", { ...ENV, MORROW_VAULT_CONTRACT: "" }, ""],
    ["MORROW_NEAR_NETWORK", { ...ENV, MORROW_NEAR_NETWORK: "betanet" }, "betanet"],
    [
      "MORROW_BTC_BACKEND_URL",
      { ...ENV, MORROW_BTC_BACKEND_URL: "https://user:hunter2@mempool.space/api" },
      "hunter2",
    ],
    [
      "MORROW_WATCHER_URL",
      { ...ENV, MORROW_WATCHER_URL: "http://watcher.example.org" },
      "watcher.example.org",
    ],
    ["PORT", { ...ENV, PORT: "0" }, ""],
    ["PORT", { ...ENV, PORT: "70000" }, "70000"],
    ["PORT", { ...ENV, PORT: "80x" }, "80x"],
  ])("exits 1 on a bad %s, naming it without its value", (variable, env, value) => {
    const result = start(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(variable);
    if (value) {
      expect(result.stderr).not.toContain(value);
      expect(result.stdout).not.toContain(value);
    }
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      level: "error",
      msg: "invalid config",
      variable,
    });
  });
});

describe("parsePort", () => {
  it("treats an unset or blank PORT as 8080", () => {
    expect(parsePort(undefined)).toBe(8080);
    expect(parsePort("")).toBe(8080);
    expect(parsePort("   ")).toBe(8080);
  });

  it("takes 1 to 65535 and rejects anything else", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort(" 4173 ")).toBe(4173);
    expect(parsePort("65535")).toBe(65535);
    for (const bad of ["0", "65536", "-1", "80.5", "1e3", "0x50", "80x", "eighty"]) {
      expect(parsePort(bad)).toBeNull();
    }
  });
});

describe("media", () => {
  it("serves mp4 with its type and answers byte ranges with 206", async () => {
    const full = await get("/assets/hero-aaa111.mp4");
    expect(full.status).toBe(200);
    expect(full.headers["content-type"]).toBe("video/mp4");
    expect(full.headers["accept-ranges"]).toBe("bytes");
    const part = await get("/assets/hero-aaa111.mp4", "GET", { range: "bytes=2-5" });
    expect(part.status).toBe(206);
    expect(part.body).toBe("2345");
    expect(part.headers["content-range"]).toBe("bytes 2-5/10");
    expectSecurityHeaders(part.headers);
    const past = await get("/assets/hero-aaa111.mp4", "GET", { range: "bytes=10-" });
    expect(past.status).toBe(416);
    expect(past.headers["content-range"]).toBe("bytes */10");
  });

  it("parses single byte ranges", () => {
    expect(byteRange(undefined, 10)).toBeNull();
    expect(byteRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(byteRange("bytes=0-1", 10)).toEqual({ start: 0, end: 1 });
    expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange("bytes=4-99", 10)).toEqual({ start: 4, end: 9 });
    expect(byteRange("bytes=12-", 10)).toBe("unsatisfiable");
    expect(byteRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(byteRange("items=0-1", 10)).toBeNull();
    expect(byteRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(byteRange("bytes=-5", 0)).toBe("unsatisfiable");
    expect(byteRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(byteRange("bytes=5-2", 10)).toBeNull();
  });
});

describe("compression", () => {
  it("sends text brotli encoded to a client that accepts it", async () => {
    const reply = await getRaw("/assets/bundle-bbb222.js", {
      "accept-encoding": "gzip, deflate, br",
    });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-encoding"]).toBe("br");
    expect(reply.headers.vary).toBe("accept-encoding");
    expect(reply.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(reply.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(Number(reply.headers["content-length"])).toBe(reply.body.length);
    expect(reply.body.length).toBeLessThan(BUNDLE.length / 10);
    expect(brotliDecompressSync(reply.body).toString()).toBe(BUNDLE);
    expectSecurityHeaders(reply.headers);
  });

  it("falls back to gzip, and to the raw bytes without an accepted encoding", async () => {
    const gz = await getRaw("/assets/bundle-bbb222.js", { "accept-encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.body).toString()).toBe(BUNDLE);

    for (const accept of [undefined, "identity", "br;q=0, gzip;q=0"]) {
      const raw = await getRaw(
        "/assets/bundle-bbb222.js",
        accept ? { "accept-encoding": accept } : {},
      );
      expect(raw.headers["content-encoding"]).toBeUndefined();
      expect(raw.headers.vary).toBe("accept-encoding");
      expect(raw.body.toString()).toBe(BUNDLE);
    }
  });

  it("encodes index.html and /config.json, and answers HEAD without a body", async () => {
    const page = await getRaw("/challenge", { "accept-encoding": "br" });
    expect(page.headers["content-encoding"]).toBe("br");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(brotliDecompressSync(page.body).toString()).toBe(INDEX);
    expectSecurityHeaders(page.headers);

    const cfg = await getRaw("/config.json", { "accept-encoding": "gzip" });
    expect(cfg.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(cfg.body).toString())).toEqual(config);

    const head = await getRaw("/assets/bundle-bbb222.js", { "accept-encoding": "br" }, "HEAD");
    expect(head.headers["content-encoding"]).toBe("br");
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
    expect(head.body.length).toBe(0);
  });

  it("sends a body too small to gain from encoding as it is", async () => {
    const tiny = await getRaw("/assets/index-abc123.js", { "accept-encoding": "br, gzip" });
    expect(tiny.headers["content-encoding"]).toBeUndefined();
    expect(tiny.headers.vary).toBe("accept-encoding");
    expect(tiny.body.toString()).toBe("console.log(1);");
  });

  it("never encodes media, fonts or a byte range", async () => {
    const video = await getRaw("/assets/hero-aaa111.mp4", { "accept-encoding": "br" });
    expect(video.headers["content-encoding"]).toBeUndefined();
    expect(video.headers.vary).toBeUndefined();
    expect(video.body.toString()).toBe("0123456789");
    const font = await getRaw("/assets/font-def456.woff2", { "accept-encoding": "br" });
    expect(font.headers["content-encoding"]).toBeUndefined();

    const part = await getRaw("/assets/bundle-bbb222.js", {
      "accept-encoding": "br",
      range: "bytes=0-5",
    });
    expect(part.status).toBe(206);
    expect(part.headers["content-encoding"]).toBeUndefined();
    expect(part.body.toString()).toBe(BUNDLE.slice(0, 6));
  });

  it("negotiates by weight, brotli on a tie", () => {
    expect(negotiateEncoding(undefined)).toBeNull();
    expect(negotiateEncoding("")).toBeNull();
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(negotiateEncoding("gzip")).toBe("gzip");
    expect(negotiateEncoding("GZIP;Q=0.5")).toBe("gzip");
    expect(negotiateEncoding("br;q=0.4, gzip;q=0.8")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip;q=0")).toBeNull();
    expect(negotiateEncoding("*")).toBe("br");
    expect(negotiateEncoding("*;q=0.5, br;q=0")).toBe("gzip");
    expect(negotiateEncoding("br;q=nonsense, gzip")).toBe("gzip");
  });
});
