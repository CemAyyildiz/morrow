import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseEncode } from "near-api-js";
import { UsageError, type BuildOptions } from "./args.js";

/**
 * The release flags of every Vault Contract wasm this tool builds. `make wasm` (the Makefile) uses
 * the same values; a unit test keeps the two in step.
 */
export const RUSTFLAGS = "--cfg near -C link-arg=-s";
export const RUST_IMAGE =
  "rust:1.97.1@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f";
/** `make wasm` output: the reproducible build judges compare against. */
export const REPRODUCIBLE_TARGET_DIR = "target/reproducible";
/** `build --local` output: the host toolchain, same flags, its own target dir. */
export const LOCAL_TARGET_DIR = "target/local-release";
export const WASM_IN_TARGET = "wasm32-unknown-unknown/release/morrow_vault.wasm";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const reproducibleWasm = (root = REPO_ROOT) =>
  join(root, REPRODUCIBLE_TARGET_DIR, WASM_IN_TARGET);
export const localWasm = (root = REPO_ROOT) => join(root, LOCAL_TARGET_DIR, WASM_IN_TARGET);

/** NEAR's `code_hash`: base58 of the sha256 of the wasm bytes. */
export function codeHash(code: Uint8Array): string {
  return baseEncode(createHash("sha256").update(code).digest());
}

export interface Wasm {
  path: string;
  code: Uint8Array;
  hash: string;
}

/**
 * Reads a wasm file and hashes it; `path` defaults to the `make wasm` output. A relative `path` is
 * read from where the command was typed (`INIT_CWD` under pnpm), not from tools/deploy.
 */
export function readWasm(
  path: string | undefined,
  root = REPO_ROOT,
  cwd = process.env.INIT_CWD ?? process.cwd(),
): Wasm {
  const file = path ? resolve(cwd, path) : reproducibleWasm(root);
  if (!existsSync(file)) {
    throw new UsageError(
      `${file} does not exist: run \`make wasm\` (or \`build --local\` and pass --wasm)`,
    );
  }
  const code = new Uint8Array(readFileSync(file));
  return { path: file, code, hash: codeHash(code) };
}

export interface BuildCommand {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  wasm: string;
}

/** The command `build` runs: `make wasm` (Docker), or cargo on the host with `--local`. */
export function buildCommand(
  options: BuildOptions,
  root = REPO_ROOT,
  env: NodeJS.ProcessEnv = process.env,
): BuildCommand {
  if (!options.local) {
    return { command: "make", args: ["wasm"], env: { ...env }, wasm: reproducibleWasm(root) };
  }
  return {
    command: "cargo",
    args: [
      "build",
      "-p",
      "morrow-vault",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
      "--locked",
    ],
    // CARGO_ENCODED_RUSTFLAGS would take precedence over RUSTFLAGS, so it is cleared.
    env: {
      ...env,
      RUSTFLAGS,
      CARGO_ENCODED_RUSTFLAGS: undefined,
      CARGO_TARGET_DIR: join(root, LOCAL_TARGET_DIR),
    },
    wasm: localWasm(root),
  };
}

export type Runner = (command: BuildCommand, cwd: string) => Promise<number>;

const spawnRunner: Runner = (command, cwd) =>
  new Promise((done, fail) => {
    const env = Object.fromEntries(
      Object.entries(command.env).filter(([, v]) => v !== undefined),
    ) as NodeJS.ProcessEnv;
    const child = spawn(command.command, command.args, { cwd, env, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) => done(code ?? 1));
  });

/** Builds the wasm and prints its path and `code_hash`. */
export async function build(
  options: BuildOptions,
  out: (line: string) => void,
  run: Runner = spawnRunner,
  root = REPO_ROOT,
): Promise<number> {
  const command = buildCommand(options, root);
  const status = await run(command, root);
  if (status !== 0) {
    out(`Build failed: \`${command.command} ${command.args.join(" ")}\` exited ${status}`);
    return 1;
  }
  const wasm = readWasm(command.wasm, root, root);
  out(`Wasm: ${wasm.path}`);
  out(`Size: ${wasm.code.length} bytes`);
  out(`code_hash: ${wasm.hash}`);
  if (options.local) {
    out("Local build: compare deployments against `make wasm` output for a reproducible hash.");
  }
  return 0;
}
