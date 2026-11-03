import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReportWriteError,
  checkReportPath,
  defaultReportPath,
  writeReport,
  type AttackReport,
} from "./report.js";

const EMPTY: AttackReport = {
  header: {
    tool_commit: null,
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
    on_log: "0/0",
    on_log_matched: 0,
    on_log_total: 0,
    missing_hashes: [],
    off_log: 0,
    allowed_harmless: 0,
    not_deployed: [],
    not_deployed_note: null,
    stopped_reason: null,
    passed: true,
  },
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "attack-report-"));
  dirs.push(dir);
  return dir;
};

describe("checkReportPath", () => {
  it("refuses a mock report under evidence/ and evidence/regtest/", () => {
    expect(() => checkReportPath("evidence/x.json", "mock")).toThrow(ReportWriteError);
    expect(() => checkReportPath("evidence/regtest/x.json", "mock")).toThrow(ReportWriteError);
  });
  it("refuses a regtest report under evidence/ but allows evidence/regtest/", () => {
    expect(() => checkReportPath("evidence/x.json", "regtest")).toThrow(ReportWriteError);
    expect(() => checkReportPath("evidence/regtest/x.json", "regtest")).not.toThrow();
  });
  it("allows a real-chain report under evidence/", () => {
    expect(() => checkReportPath("evidence/x.json", "signet")).not.toThrow();
    expect(() => checkReportPath("evidence/x.json", "bitcoin")).not.toThrow();
  });
  it("allows a mock report elsewhere", () => {
    expect(() => checkReportPath("/tmp/x.json", "mock")).not.toThrow();
    expect(() => checkReportPath("./x.json", "mock")).not.toThrow();
  });
});

describe("writeReport", () => {
  it("writes the report and keeps every section", async () => {
    const dir = await scratch();
    const path = join(dir, "report.json");
    await writeReport(path, EMPTY);
    const parsed = JSON.parse(await readFile(path, "utf8")) as AttackReport;
    expect(parsed.header.network).toBe("mock");
    expect(parsed.summary.passed).toBe(true);
    expect(parsed).toHaveProperty("header");
    expect(parsed).toHaveProperty("rounds");
    expect(parsed).toHaveProperty("attempts");
    expect(parsed).toHaveProperty("summary");
  });

  it("refuses to write a mock report into evidence/", async () => {
    await expect(writeReport("evidence/mock.json", EMPTY)).rejects.toThrow(ReportWriteError);
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
    expect(report.attempts).toHaveLength(100);
    expect(report.summary.sats_to_attackers).toBe(0);
    expect(report.summary.on_log_matched).toBe(report.summary.on_log_total);
    expect(report.summary.passed).toBe(true);
    // Every attempt carries the fields a judge checks against the chain.
    for (const attempt of report.attempts) {
      expect(attempt).toHaveProperty("expected");
      expect(attempt).toHaveProperty("actual");
      expect(attempt).toHaveProperty("args_sha256");
      expect(["refused", "accepted", "allowed_harmless", "off_log", "unreadable"]).toContain(
        attempt.actual_class,
      );
    }
  });
});

describe("defaultReportPath", () => {
  it("places real-chain reports in evidence/ and mock reports outside it", () => {
    expect(defaultReportPath("signet", "2026-11-03T12:30:00.000Z")).toBe(
      "evidence/challenge-attack-signet-2026-11-03T12-30-00-000Z.json",
    );
    expect(defaultReportPath("regtest", "2026-11-03T12:30:00.000Z")).toContain("evidence/regtest/");
    expect(defaultReportPath("mock", "2026-11-03T12:30:00.000Z")).toBe(
      "./challenge-attack-mock-2026-11-03T12-30-00-000Z.json",
    );
  });
});
