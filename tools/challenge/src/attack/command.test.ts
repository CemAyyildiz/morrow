import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAttackFlags, runAttackCommand, type AttackCommandDeps } from "./command.js";
import { ReportWriteError, repoRoot, type AttackReport } from "./report.js";
import type { AttackPorts } from "./run.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "attack-command-"));
  dirs.push(dir);
  return dir;
};
const quiet: AttackCommandDeps = {
  stdout: () => undefined,
  version: () => ({ commit: "abc", dirty: true }),
};

describe("parseAttackFlags", () => {
  it("has the documented defaults", () => {
    const flags = parseAttackFlags([], () => 42);
    expect(flags).toEqual({
      n: 100,
      rounds: 3,
      seed: 42,
      dryRun: false,
      out: null,
      roundWaitMs: 3_600_000,
      logWaitMs: 600_000,
    });
  });

  it("reads every flag", () => {
    const flags = parseAttackFlags([
      "--dry-run",
      "--n",
      "12",
      "--rounds",
      "1",
      "--seed",
      "0",
      "--out",
      "/tmp/r.json",
      "--round-wait",
      "5",
      "--log-wait",
      "2",
    ]);
    expect(flags).toMatchObject({
      dryRun: true,
      n: 12,
      rounds: 1,
      seed: 0,
      out: "/tmp/r.json",
      roundWaitMs: 300_000,
      logWaitMs: 120_000,
    });
  });

  it("rejects unknown flags, missing values and a flag in place of a value", () => {
    expect(() => parseAttackFlags(["--nope"])).toThrow(/Unknown flag/);
    expect(() => parseAttackFlags(["--n"])).toThrow(/needs a value/);
    expect(() => parseAttackFlags(["--out", "--dry-run"])).toThrow(/--out needs a value/);
    expect(() => parseAttackFlags(["--n", "0"])).toThrow(/whole number/);
    expect(() => parseAttackFlags(["--n", "1.5"])).toThrow(/whole number/);
  });
});

describe("runAttackCommand", () => {
  it("--dry-run --n 12 --rounds 1 writes a mock report outside evidence/ and returns 0", async () => {
    const out = join(await scratch(), "report.json");
    const code = await runAttackCommand(
      ["--dry-run", "--n", "12", "--rounds", "1", "--seed", "7", "--out", out],
      quiet,
    );
    expect(code).toBe(0);
    const report = JSON.parse(await readFile(out, "utf8")) as AttackReport;
    expect(report.header.network).toBe("mock");
    expect(report.header.tool_dirty).toBe(true);
    expect(report.attempts).toHaveLength(12);
  });

  it("refuses a mock report under the repository's evidence/", async () => {
    await expect(
      runAttackCommand(
        [
          "--dry-run",
          "--n",
          "12",
          "--rounds",
          "1",
          "--out",
          join(repoRoot(), "evidence", "x.json"),
        ],
        quiet,
      ),
    ).rejects.toThrow(ReportWriteError);
  });

  it("a failing live run returns 1", async () => {
    const ports: AttackPorts = {
      rounds: {
        current: async () => {
          throw new Error("GET /round: HTTP 503");
        },
      },
      near: {} as never,
      bitcoin: {
        getUtxos: async () => [],
        getTipHeight: async () => 1,
        broadcast: async () => "x",
      },
      feed: { entries: async () => [] },
      watcher: { tick: async () => null },
      clock: (() => {
        let t = 0;
        return {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        };
      })(),
    };
    ports.near = {
      tipHeight: async () => 1,
      codeHash: async () => "x",
    } as never;
    const written: AttackReport[] = [];
    const code = await runAttackCommand(["--round-wait", "1", "--n", "4"], {
      ...quiet,
      buildLive: () => ({ ports, nearNetwork: "testnet" }),
      write: async (_path, report) => {
        written.push(report);
      },
    });
    expect(code).toBe(1);
    expect(written[0]?.summary.stopped_reason).toMatch(/HTTP 503/);
  });
});
