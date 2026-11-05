import { MPC_SIGNERS, type Target } from "./args.js";
import { NO_CONTRACT_HASH, fullAccessKeys, type ChainReader } from "./rpc.js";

/** `get_config` as the contract returns it. */
export interface DeployedConfig {
  signer_account: string;
  allowed_networks: string[];
  creator_allowlist: string[];
  version: string;
}

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

/** The config, or the reason it is not a Vault Contract config for this network. */
export function checkConfig(value: unknown, target: Target): DeployedConfig | string {
  if (typeof value !== "object" || value === null) return "get_config returned no config";
  const c = value as Record<string, unknown>;
  if (
    typeof c.signer_account !== "string" ||
    !strings(c.allowed_networks) ||
    !strings(c.creator_allowlist) ||
    typeof c.version !== "string"
  ) {
    return "get_config is missing signer_account, allowed_networks, creator_allowlist or version";
  }
  const config = c as unknown as DeployedConfig;
  const signer = MPC_SIGNERS[target.network];
  if (config.signer_account !== signer) {
    return `signer_account is ${config.signer_account}, not the ${target.network} MPC signer ${signer}`;
  }
  if (config.allowed_networks.length === 0) return "allowed_networks is empty";
  if (target.network === "mainnet" && config.allowed_networks.some((n) => n !== "bitcoin")) {
    return `allowed_networks is ${config.allowed_networks.join(",")}; mainnet allows only bitcoin`;
  }
  return config;
}

export interface AccountReport {
  target: Target;
  codeHash: string | null;
  fullAccessKeys: number | null;
  config: DeployedConfig | null;
  problems: string[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads one account: code hash against `localHash`, full-access keys, `get_config`. */
export async function checkAccount(
  reader: ChainReader,
  target: Target,
  localHash: string,
  requireLocked: boolean,
): Promise<AccountReport> {
  const report: AccountReport = {
    target,
    codeHash: null,
    fullAccessKeys: null,
    config: null,
    problems: [],
  };
  try {
    report.codeHash = await reader.codeHash(target.accountId);
    if (report.codeHash === NO_CONTRACT_HASH) report.problems.push("no contract is deployed");
    else if (report.codeHash !== localHash) {
      report.problems.push(
        `code_hash ${report.codeHash} differs from the local build ${localHash}`,
      );
    }
  } catch (error) {
    report.problems.push(`RPC error reading the account: ${message(error)}`);
    return report;
  }
  try {
    report.fullAccessKeys = fullAccessKeys(await reader.accessKeys(target.accountId)).length;
    if (requireLocked && report.fullAccessKeys > 0) {
      report.problems.push(`not locked: ${report.fullAccessKeys} full-access key(s)`);
    }
  } catch (error) {
    report.problems.push(`RPC error reading access keys: ${message(error)}`);
  }
  try {
    const config = checkConfig(await reader.getConfig(target.accountId), target);
    if (typeof config === "string") report.problems.push(config);
    else report.config = config;
  } catch (error) {
    report.problems.push(`get_config failed: ${message(error)}`);
  }
  return report;
}

function describe(report: AccountReport, localHash: string): string[] {
  const { target } = report;
  const lines = [`${target.accountId} (${target.network})`];
  if (report.codeHash !== null) {
    const same = report.codeHash === localHash ? "matches the local build" : "DIFFERS";
    lines.push(`  code_hash: ${report.codeHash} (${same})`);
  }
  if (report.fullAccessKeys === 0) lines.push("  Locked: no full-access keys");
  else if (report.fullAccessKeys !== null) {
    lines.push(`  Not locked: ${report.fullAccessKeys} full-access key(s)`);
  }
  if (report.config) {
    const c = report.config;
    const allowlist = c.creator_allowlist.length === 0 ? "(open)" : c.creator_allowlist.join(",");
    lines.push(
      `  get_config: signer ${c.signer_account}, networks ${c.allowed_networks.join(",")}, allowlist ${allowlist}, version ${c.version}`,
    );
  }
  return lines;
}

export interface VerifyTarget extends Target {
  reader: ChainReader;
}

/**
 * Verifies every target against the local build and, with several, that they run the same code.
 * Returns the exit code: 0 only when every check passes.
 */
export async function verify(
  targets: VerifyTarget[],
  local: { path: string; hash: string },
  out: (line: string) => void,
  requireLocked = true,
): Promise<number> {
  out(`Local build: ${local.path}`);
  out(`  code_hash: ${local.hash}`);
  const reports: AccountReport[] = [];
  for (const target of targets) {
    const report = await checkAccount(target.reader, target, local.hash, requireLocked);
    reports.push(report);
    for (const line of describe(report, local.hash)) out(line);
  }
  const failures = reports.flatMap((r) =>
    r.problems.map((p) => `FAIL ${r.target.accountId}: ${p}`),
  );
  const hashes = new Set(reports.map((r) => r.codeHash).filter((h) => h !== null));
  if (hashes.size > 1) {
    const each = reports.map((r) => `${r.target.accountId}=${r.codeHash ?? "?"}`).join(", ");
    failures.push(`FAIL the accounts run different code: ${each}`);
  }
  if (failures.length > 0) {
    for (const line of failures) out(line);
    out(`Deployment NOT verified: ${failures.length} problem(s)`);
    return 1;
  }
  const state = reports.every((r) => r.fullAccessKeys === 0) ? "locked" : "not locked yet";
  out(`Deployment verified: ${targets.length} account(s), code_hash ${local.hash}, ${state}`);
  return 0;
}
