import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReportWriteError,
  checkReportPath,
  defaultReportPath,
  repoRoot,
  reportNetwork,
  writeReport,
  type AttackReport,
} from "./report.js";

const EMPTY: AttackReport = {
  header: {
    tool_commit: null,
    tool_dirty: false,
    seed: 7,
    network: "mock",
    near_network: "testnet",
    contract_id: "vault.challenge",
    code_hash: null,
    started_at: "2026-11-03T00:00:00.000Z",
    ended_at: "2026-11-03T00:00:00.000Z",
    near_tip_start: null,
    near_tip_end: null,
    btc_tip_start: null,
    btc_tip_end: null,
    challenge_rounds: [],
    public_keys: [],
  },
  rounds: [],
  attempts: [],
  summary: {
    attacker_addresses: [],
    sats_to_attackers: 0,
    unreadable_balances: [],
    on_log: "0/0",
    on_log_matched: 0,
    on_log_total: 0,
    missing_hashes: [],
    off_log: 0,
    allowed_harmless: 0,
    skipped: [],
    unreadable: [],
    unexpected: [],
    clawback_missing: [],
    veto_missing: [],
    not_deployed: [],
    not_deployed_note: null,
    stopped_reason: null,
    passed: true,
  },
};

const ROOT = "/repo";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("repoRoot", () => {
  it("finds the workspace root from the tool's directory", () => {
    const root = repoRoot();
    expect(root).not.toMatch(/tools[\\/]challenge$/);
    expect(repoRoot(join(root, "tools", "challenge"))).toBe(root);
  });
});

describe("checkReportPath (relative to the repository root)", () => {
  it("refuses a mock or unknown-network report under evidence/, case-folded", () => {
    expect(() => checkReportPath("/repo/evidence/x.json", "mock", ROOT)).toThrow(ReportWriteError);
    expect(() => checkReportPath("/repo/Evidence/x.json", "mock", ROOT)).toThrow(ReportWriteError);
    expect(() => checkReportPath("/repo/evidence/regtest/x.json", "mock", ROOT)).toThrow();
    expect(() => checkReportPath("/repo/evidence/x.json", "unknown", ROOT)).toThrow();
  });
  it("refuses a regtest report under evidence/ but allows evidence/regtest/", () => {
    expect(() => checkReportPath("/repo/evidence/x.json", "regtest", ROOT)).toThrow();
    expect(() => checkReportPath("/repo/evidence/regtest/x.json", "regtest", ROOT)).not.toThrow();
  });
  it("allows a real-chain report under evidence/", () => {
    expect(() => checkReportPath("/repo/evidence/x.json", "signet", ROOT)).not.toThrow();
  });
  it("only the root's evidence/ counts, not a nested one or one outside the repository", () => {
    expect(() => checkReportPath("/repo/tools/evidence/x.json", "mock", ROOT)).not.toThrow();
    expect(() => checkReportPath("/elsewhere/evidence/x.json", "mock", ROOT)).not.toThrow();
  });
});

describe("writeReport", () => {
  it("writes the report with every section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attack-report-"));
    dirs.push(dir);
    const path = join(dir, "report.json");
    await writeReport(path, EMPTY, ROOT);
    const parsed = JSON.parse(await readFile(path, "utf8")) as AttackReport;
    expect(Object.keys(parsed)).toEqual(["header", "rounds", "attempts", "summary"]);
    expect(parsed.header.tool_dirty).toBe(false);
  });

  it("refuses a mock report into the repository's evidence/ before writing", async () => {
    await expect(writeReport(join(repoRoot(), "evidence", "mock.json"), EMPTY)).rejects.toThrow(
      ReportWriteError,
    );
  });
});

describe("defaultReportPath", () => {
  it("places real-chain reports in <repo>/evidence/ and mock reports in the temp dir", () => {
    const at = "2026-11-03T12:30:00.000Z";
    expect(defaultReportPath("signet", at, ROOT)).toBe(
      "/repo/evidence/challenge-attack-signet-2026-11-03T12-30-00-000Z.json",
    );
    expect(defaultReportPath("regtest", at, ROOT)).toContain("/repo/evidence/regtest/");
    expect(defaultReportPath("mock", at, ROOT).startsWith(tmpdir())).toBe(true);
    expect(defaultReportPath("unknown", at, ROOT).startsWith(tmpdir())).toBe(true);
  });
});

describe("reportNetwork", () => {
  it("maps Bitcoin networks and rejects anything else", () => {
    expect(reportNetwork("signet")).toBe("signet");
    expect(reportNetwork("dogecoin")).toBeNull();
  });
});

describe("committed dry-run sample", () => {
  it("is a valid schema example: mock, passed, 100 attempts, no leak, full log", async () => {
    const raw = await readFile(
      new URL("../../test/fixtures/attack-report.sample.json", import.meta.url),
      "utf8",
    );
    const report = JSON.parse(raw) as AttackReport;
    expect(report.header.network).toBe("mock");
    expect(report.header).toHaveProperty("tool_dirty");
    expect(report.attempts).toHaveLength(100);
    expect(report.summary.sats_to_attackers).toBe(0);
    expect(report.summary.on_log_matched).toBe(report.summary.on_log_total);
    expect(report.summary.passed).toBe(true);
    for (const attempt of report.attempts) {
      for (const field of ["args", "args_sha256", "expected", "actual", "unexpected", "note"]) {
        expect(attempt).toHaveProperty(field);
      }
      expect([
        "refused",
        "accepted",
        "allowed_harmless",
        "off_log",
        "skipped",
        "unreadable",
      ]).toContain(attempt.actual_class);
    }
  });
});
