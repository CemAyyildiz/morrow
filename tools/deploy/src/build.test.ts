import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOCAL_TARGET_DIR,
  REPO_ROOT,
  REPRODUCIBLE_TARGET_DIR,
  RUSTFLAGS,
  RUST_IMAGE,
  build,
  buildCommand,
  codeHash,
  localWasm,
  readWasm,
  reproducibleWasm,
} from "./build.js";
import { output } from "./test-helpers.js";

describe("codeHash", () => {
  // Computed independently of near-api-js: Node's sha256 and a hand-written base58 encoder.
  //   sha256("")    = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  it("is base58(sha256(code))", () => {
    expect(codeHash(new Uint8Array())).toBe("GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn");
    expect(codeHash(new TextEncoder().encode("abc"))).toBe(
      "DYu3G8aGTMBW1WrTw76zxQJQU4DHLw9MLyy7peG4LKkY",
    );
  });
});

describe("make wasm", () => {
  const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
  const target = makefile.slice(makefile.indexOf("\nwasm:"));

  it("uses the same image, flags and target dir as this tool", () => {
    expect(makefile).toContain(`RUST_IMAGE := ${RUST_IMAGE}`);
    expect(makefile).toContain(`WASM_RUSTFLAGS := ${RUSTFLAGS}`);
    expect(target).toContain("--platform linux/amd64");
    expect(target).toContain(`CARGO_TARGET_DIR=/work/${REPRODUCIBLE_TARGET_DIR}`);
    expect(target).toContain(
      "cargo build -p morrow-vault --target wasm32-unknown-unknown --release --locked",
    );
  });

  it("pins the image by digest", () => {
    expect(RUST_IMAGE).toMatch(/^rust:1\.97\.1@sha256:[0-9a-f]{64}$/);
  });
});

describe("buildCommand", () => {
  it("default: runs `make wasm` and reads its output", () => {
    const command = buildCommand({ local: false }, "/repo", {});
    expect([command.command, ...command.args]).toEqual(["make", "wasm"]);
    expect(command.wasm).toBe(reproducibleWasm("/repo"));
  });

  it("--local: host cargo with the same RUSTFLAGS, --locked and its own target dir", () => {
    const command = buildCommand({ local: true }, "/repo", {
      PATH: "/bin",
      CARGO_ENCODED_RUSTFLAGS: "-Cfoo",
    });
    expect([command.command, ...command.args]).toEqual([
      "cargo",
      "build",
      "-p",
      "morrow-vault",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
      "--locked",
    ]);
    expect(command.env).toMatchObject({
      PATH: "/bin",
      RUSTFLAGS,
      CARGO_ENCODED_RUSTFLAGS: undefined,
      CARGO_TARGET_DIR: join("/repo", LOCAL_TARGET_DIR),
    });
    expect(command.wasm).toBe(localWasm("/repo"));
  });
});

describe("build", () => {
  it("prints the wasm path and code_hash after a successful build", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-deploy-"));
    const o = output();
    const code = await build(
      { local: true },
      o.out,
      async (command) => {
        mkdirSync(dirname(command.wasm), { recursive: true });
        writeFileSync(command.wasm, new Uint8Array());
        return 0;
      },
      root,
    );
    expect(code).toBe(0);
    expect(o.lines).toContain(`Wasm: ${localWasm(root)}`);
    expect(o.lines).toContain("code_hash: GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn");
  });

  it("exits 1 when the build fails", async () => {
    const o = output();
    expect(await build({ local: false }, o.out, async () => 101, "/nowhere")).toBe(1);
    expect(o.lines).toEqual(["Build failed: `make wasm` exited 101"]);
  });
});

describe("readWasm", () => {
  it("names the missing file and how to build it", () => {
    expect(() => readWasm(undefined, "/nowhere")).toThrow(/does not exist: run `make wasm`/);
  });

  it("reads a relative --wasm from the directory the command was typed in", () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-deploy-"));
    writeFileSync(join(dir, "v.wasm"), new TextEncoder().encode("abc"));
    expect(readWasm("v.wasm", "/nowhere", dir)).toMatchObject({
      path: join(dir, "v.wasm"),
      hash: "DYu3G8aGTMBW1WrTw76zxQJQU4DHLw9MLyy7peG4LKkY",
    });
  });
});
