import { parseArgs, type ParseArgsConfig } from "node:util";

/** A usage or argument error: printed as one line, exit 1, nothing sent. */
export class UsageError extends Error {}

export type NearNetwork = "testnet" | "mainnet";
export const NEAR_NETWORKS: readonly NearNetwork[] = ["testnet", "mainnet"];

/** The Chain Signatures MPC signer a Vault Contract must call, per NEAR network. */
export const MPC_SIGNERS: Record<NearNetwork, string> = {
  testnet: "v1.signer-prod.testnet",
  mainnet: "v1.signer",
};

export const RPC_URLS: Record<NearNetwork, string> = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
};

/** The `BtcNetwork` names the contract knows (`contracts/vault/src/core/policy.rs`, snake_case). */
export const BTC_NETWORKS = ["regtest", "signet", "testnet4", "bitcoin"] as const;
export type BtcNetwork = (typeof BTC_NETWORKS)[number];

/** Arguments of the contract's `new(signer_account, allowed_networks, creator_allowlist)`. */
export interface InitArgs {
  signer_account: string;
  allowed_networks: BtcNetwork[];
  creator_allowlist: string[];
}

export interface Target {
  accountId: string;
  network: NearNetwork;
}

export interface BuildOptions {
  local: boolean;
}

export interface DeployOptions extends Target {
  rpcUrl: string;
  wasm: string | undefined;
  init: InitArgs;
  send: boolean;
}

export interface LockOptions extends Target {
  rpcUrl: string;
  wasm: string | undefined;
  confirm: string | undefined;
}

export interface VerifyOptions {
  targets: (Target & { rpcUrl: string })[];
  wasm: string | undefined;
}

// NEAR account id rules (nomicon): 2..64 chars, lowercase alphanumerics separated by `-`/`_`
// within a part and `.` between parts.
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function assertAccountId(value: string, flag: string): string {
  if (value.length < 2 || value.length > 64 || !ACCOUNT_ID.test(value)) {
    throw new UsageError(`${flag}: "${value}" is not a valid NEAR account id`);
  }
  return value;
}

/** The NEAR network an account id names by its suffix, or null (implicit and other ids). */
export function impliedNetwork(accountId: string): NearNetwork | null {
  if (accountId === "testnet" || accountId.endsWith(".testnet")) return "testnet";
  if (accountId === "near" || accountId.endsWith(".near")) return "mainnet";
  return null;
}

function parseNetwork(value: string | undefined): NearNetwork | undefined {
  if (value === undefined) return undefined;
  if (!(NEAR_NETWORKS as readonly string[]).includes(value)) {
    throw new UsageError(`--network: "${value}" is not testnet or mainnet`);
  }
  return value as NearNetwork;
}

/**
 * The account's network: `--network` when given (and it must agree with the id's suffix), else the
 * suffix (`.near` is mainnet), else testnet.
 */
export function resolveNetwork(accountId: string, flag: NearNetwork | undefined): NearNetwork {
  const implied = impliedNetwork(accountId);
  if (flag && implied && flag !== implied) {
    throw new UsageError(`--account ${accountId} is a ${implied} account, not ${flag}`);
  }
  return flag ?? implied ?? "testnet";
}

/** Comma-separated and repeated flag values, trimmed, empties dropped. */
function list(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Checks `new`'s arguments before anything is sent: the network's MPC signer, known and
 * non-repeated Bitcoin networks (mainnet: `bitcoin` only, and only mainnet may use `bitcoin`), and
 * allowlist ids that are valid accounts of the same NEAR network (required on mainnet).
 */
export function validateInit(init: InitArgs, network: NearNetwork): InitArgs {
  const expected = MPC_SIGNERS[network];
  if (init.signer_account !== expected) {
    throw new UsageError(
      `--signer: ${network} Vaults must use the MPC signer ${expected}, not "${init.signer_account}"`,
    );
  }
  if (init.allowed_networks.length === 0) {
    throw new UsageError("--networks: name at least one Bitcoin network");
  }
  for (const name of init.allowed_networks) {
    if (!(BTC_NETWORKS as readonly string[]).includes(name)) {
      throw new UsageError(
        `--networks: "${name}" is not a network the contract knows (${BTC_NETWORKS.join(", ")})`,
      );
    }
  }
  if (new Set(init.allowed_networks).size !== init.allowed_networks.length) {
    throw new UsageError("--networks: a network is listed twice");
  }
  if (network === "mainnet" && init.allowed_networks.some((n) => n !== "bitcoin")) {
    throw new UsageError("--networks: a mainnet deployment allows only bitcoin");
  }
  if (network === "testnet" && init.allowed_networks.includes("bitcoin")) {
    throw new UsageError(
      "--networks: bitcoin needs the mainnet MPC signer; deploy it with --network mainnet",
    );
  }
  if (network === "mainnet" && init.creator_allowlist.length === 0) {
    throw new UsageError("--creators: a mainnet deployment needs a creator allowlist");
  }
  for (const creator of init.creator_allowlist) {
    assertAccountId(creator, "--creators");
    const implied = impliedNetwork(creator);
    if (implied && implied !== network) {
      throw new UsageError(`--creators: ${creator} is a ${implied} account, not ${network}`);
    }
  }
  if (new Set(init.creator_allowlist).size !== init.creator_allowlist.length) {
    throw new UsageError("--creators: an account is listed twice");
  }
  return init;
}

const COMMON = {
  network: { type: "string" },
  rpc: { type: "string" },
  wasm: { type: "string" },
} as const;

function parse(argv: string[], options: NonNullable<ParseArgsConfig["options"]>) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false })
      .values as Record<string, unknown>;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? (v as string[]) : undefined);

function single(values: Record<string, unknown>, explicitFlagForMainnet: boolean) {
  const raw = str(values.account);
  if (!raw) throw new UsageError("--account is required");
  const accountId = assertAccountId(raw, "--account");
  const flag = parseNetwork(str(values.network));
  const network = resolveNetwork(accountId, flag);
  if (explicitFlagForMainnet && network === "mainnet" && flag !== "mainnet") {
    throw new UsageError(`${accountId} is a mainnet account: pass --network mainnet to confirm`);
  }
  return { accountId, network, rpcUrl: str(values.rpc) ?? RPC_URLS[network] };
}

export function parseBuild(argv: string[]): BuildOptions {
  const values = parse(argv, { local: { type: "boolean" } });
  return { local: values.local === true };
}

export function parseDeploy(argv: string[]): DeployOptions {
  const values = parse(argv, {
    ...COMMON,
    account: { type: "string" },
    signer: { type: "string" },
    networks: { type: "string", multiple: true },
    creators: { type: "string", multiple: true },
    send: { type: "boolean" },
  });
  const target = single(values, true);
  const signer = str(values.signer);
  if (!signer) throw new UsageError("--signer is required");
  const init = validateInit(
    {
      signer_account: signer,
      allowed_networks: list(strs(values.networks)) as BtcNetwork[],
      creator_allowlist: list(strs(values.creators)),
    },
    target.network,
  );
  return { ...target, wasm: str(values.wasm), init, send: values.send === true };
}

export function parseLock(argv: string[]): LockOptions {
  const values = parse(argv, {
    ...COMMON,
    account: { type: "string" },
    confirm: { type: "string" },
  });
  return { ...single(values, true), wasm: str(values.wasm), confirm: str(values.confirm) };
}

export function parseVerify(argv: string[]): VerifyOptions {
  const values = parse(argv, { ...COMMON, account: { type: "string", multiple: true } });
  const ids = list(strs(values.account)).map((id) => assertAccountId(id, "--account"));
  if (ids.length === 0) throw new UsageError("--account is required (repeat it for several)");
  if (new Set(ids).size !== ids.length)
    throw new UsageError("--account: an account is listed twice");
  const flag = parseNetwork(str(values.network));
  const targets = ids.map((accountId) => {
    const network = resolveNetwork(accountId, flag);
    return { accountId, network, rpcUrl: RPC_URLS[network] };
  });
  const rpc = str(values.rpc);
  if (rpc) {
    if (new Set(targets.map((t) => t.network)).size > 1) {
      throw new UsageError("--rpc: the accounts are on different networks; drop --rpc");
    }
    for (const t of targets) t.rpcUrl = rpc;
  }
  return { targets, wasm: str(values.wasm) };
}
