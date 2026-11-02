import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStateLock } from "./store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stateFile() {
  const dir = await mkdtemp(join(tmpdir(), "morrow-lock-"));
  dirs.push(dir);
  return join(dir, "state", "rounds.json");
}

describe("acquireStateLock", () => {
  it("is exclusive while held, holds the pid, and is free again after release", async () => {
    const file = await stateFile();
    const lock = acquireStateLock(file);
    expect(lock.path).toBe(`${file}.lock`);
    expect(await readFile(lock.path, "utf8")).toBe(String(process.pid));
    expect(() => acquireStateLock(file)).toThrow(/STATE_LOCKED: .* held by pid/);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    acquireStateLock(file).release();
  });

  it("takes over a stale lock whose pid is not alive", async () => {
    const file = await stateFile();
    acquireStateLock(file).release();
    await writeFile(`${file}.lock`, "2147483646");
    const lock = acquireStateLock(file);
    expect(await readFile(lock.path, "utf8")).toBe(String(process.pid));
    lock.release();
  });
});
