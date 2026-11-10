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
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

/** Public RPC hosts whose network is known without asking them. */
const KNOWN_RPC_HOSTS: Record<string, NearNetwork> = {
  "rpc.testnet.near.org": "testnet",
  "rpc.mainnet.near.org": "mainnet",
  "test.rpc.fastnear.com": "testnet",
  "rpc.testnet.fastnear.com": "testnet",
  "free.rpc.fastnear.com": "mainnet",
  "rpc.mainnet.fastnear.com": "mainnet",
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
  /** The init the deployment must hold; `lock` refuses any other config. */
  expected: InitArgs;
}

export interface VerifyAccount extends Target {
  rpcUrl: string;
  /** When given, `get_config` must equal it. */
  expected: InitArgs | undefined;
}

export interface VerifyOptions {
  targets: VerifyAccount[];
  wasm: string | undefined;
}

// NEAR account id rules (nomicon): 2..64 chars, lowercase alphanumerics separated by `-`/`_`
// within a part and `.` between parts.
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

const isAccountId = (value: string) =>
  value.length >= 2 && value.length <= 64 && ACCOUNT_ID.test(value);

export function assertAccountId(value: string, flag: string): string {
  if (!isAccountId(value)) {
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
 * The account's network: `--network` when given (and it must agree with a `.testnet`/`.near`
 * suffix), else the suffix. Any other id needs `--network`.
 */
export function resolveNetwork(accountId: string, flag: NearNetwork | undefined): NearNetwork {
  const implied = impliedNetwork(accountId);
  if (flag && implied && flag !== implied) {
    throw new UsageError(`--account ${accountId} is a ${implied} account, not ${flag}`);
  }
  const network = flag ?? implied;
  if (!network) {
    throw new UsageError(
      `--account ${accountId} names no network by its suffix: pass --network testnet|mainnet`,
    );
  }
  return network;
}

/** The network of a known public RPC host, or null. */
export function knownRpcNetwork(url: string): NearNetwork | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new UsageError(`--rpc: "${url}" is not a URL`);
  }
  return KNOWN_RPC_HOSTS[host] ?? null;
}

/** Refuses an RPC of another network: by its known host, else by its own `status` chain_id. */
export async function assertRpcNetwork(
  url: string,
  network: NearNetwork,
  chainId: () => Promise<string>,
): Promise<void> {
  const actual = knownRpcNetwork(url) ?? (await chainId());
  if (actual !== network) {
    throw new UsageError(`--rpc ${url} serves ${actual}, not ${network}`);
  }
}

/** Comma-separated and repeated flag values, trimmed, empties dropped. */
function list(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export interface InitProblem {
  flag: "--signer" | "--networks" | "--creators";
  field: keyof InitArgs;
  message: string;
}

/**
 * The one rule set for a Vault Contract init, used before `deploy` sends and on every deployed
 * `get_config`: the network's MPC signer, known and non-repeated Bitcoin networks (mainnet:
 * `bitcoin` only, and only mainnet may use `bitcoin`), and allowlist ids that are valid accounts
 * of the same NEAR network, not repeated (required on mainnet).
 */
export function initProblems(init: InitArgs, network: NearNetwork): InitProblem[] {
  const problems: InitProblem[] = [];
  const signer = (message: string) =>
    problems.push({ flag: "--signer", field: "signer_account", message });
  const networks = (message: string) =>
    problems.push({ flag: "--networks", field: "allowed_networks", message });
  const creators = (message: string) =>
    problems.push({ flag: "--creators", field: "creator_allowlist", message });

  const expected = MPC_SIGNERS[network];
  if (init.signer_account !== expected) {
    signer(`${network} Vaults must use the MPC signer ${expected}, not "${init.signer_account}"`);
  }
  if (init.allowed_networks.length === 0) networks("name at least one Bitcoin network");
  for (const name of init.allowed_networks) {
    if (!(BTC_NETWORKS as readonly string[]).includes(name)) {
      networks(`"${name}" is not a network the contract knows (${BTC_NETWORKS.join(", ")})`);
    }
  }
  if (new Set(init.allowed_networks).size !== init.allowed_networks.length) {
    networks("a network is listed twice");
  }
  if (network === "mainnet" && init.allowed_networks.some((n) => n !== "bitcoin")) {
    networks("a mainnet deployment allows only bitcoin");
  }
  if (network === "testnet" && init.allowed_networks.includes("bitcoin")) {
    networks("bitcoin needs the mainnet MPC signer; deploy it with --network mainnet");
  }
  if (network === "mainnet" && init.creator_allowlist.length === 0) {
    creators("a mainnet deployment needs a creator allowlist");
  }
  for (const creator of init.creator_allowlist) {
    if (!isAccountId(creator)) {
      creators(`"${creator}" is not a valid NEAR account id`);
      continue;
    }
    const implied = impliedNetwork(creator);
    if (implied && implied !== network) {
      creators(`${creator} is a ${implied} account, not ${network}`);
    }
  }
  if (new Set(init.creator_allowlist).size !== init.creator_allowlist.length) {
    creators("an account is listed twice");
  }
  return problems;
}

/** Checks `new`'s arguments before anything is sent (see `initProblems`). */
export function validateInit(init: InitArgs, network: NearNetwork): InitArgs {
  const [first] = initProblems(init, network);
  if (first) throw new UsageError(`${first.flag}: ${first.message}`);
  return init;
}

const COMMON = {
  network: { type: "string" },
  rpc: { type: "string" },
  wasm: { type: "string" },
} as const;

const INIT_FLAGS = {
  signer: { type: "string" },
  networks: { type: "string", multiple: true },
  creators: { type: "string", multiple: true },
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

/** `--signer`, `--networks`, `--creators` as an init; undefined when none is given and optional. */
function initFrom(
  values: { signer?: unknown; networks?: unknown; creators?: unknown },
  network: NearNetwork,
  required: boolean,
): InitArgs | undefined {
  const signer = str(values.signer);
  const networks = strs(values.networks);
  const creators = strs(values.creators);
  if (!required && signer === undefined && networks === undefined && creators === undefined) {
    return undefined;
  }
  if (!signer) throw new UsageError("--signer is required");
  return validateInit(
    {
      signer_account: signer,
      allowed_networks: list(networks) as BtcNetwork[],
      creator_allowlist: list(creators),
    },
    network,
  );
}

function requiredInit(values: Record<string, unknown>, network: NearNetwork): InitArgs {
  const init = initFrom(values, network, true);
  if (!init) throw new UsageError("--signer is required");
  return init;
}

function single(values: Record<string, unknown>) {
  const raw = str(values.account);
  if (!raw) throw new UsageError("--account is required");
  const accountId = assertAccountId(raw, "--account");
  const flag = parseNetwork(str(values.network));
  const network = resolveNetwork(accountId, flag);
  if (network === "mainnet" && flag !== "mainnet") {
    throw new UsageError(`${accountId} is a mainnet account: pass --network mainnet to confirm`);
  }
  return { accountId, network, rpcUrl: str(values.rpc) ?? RPC_URLS[network] };
}

export function parseBuild(argv: string[]): BuildOptions {
  const values = parse(argv, { local: { type: "boolean" } });
  return { local: values.local === true };
}

export function parseHash(argv: string[]): { wasm: string | undefined } {
  return { wasm: str(parse(argv, { wasm: { type: "string" } }).wasm) };
}

export function parseDeploy(argv: string[]): DeployOptions {
  const values = parse(argv, {
    ...COMMON,
    ...INIT_FLAGS,
    account: { type: "string" },
    send: { type: "boolean" },
  });
  const target = single(values);
  const init = requiredInit(values, target.network);
  return { ...target, wasm: str(values.wasm), init, send: values.send === true };
}

export function parseLock(argv: string[]): LockOptions {
  const values = parse(argv, {
    ...COMMON,
    ...INIT_FLAGS,
    account: { type: "string" },
    confirm: { type: "string" },
  });
  const target = single(values);
  return {
    ...target,
    wasm: str(values.wasm),
    confirm: str(values.confirm),
    expected: requiredInit(values, target.network),
  };
}

/**
 * `--account A [--signer S --networks N --creators C] [--account B ...]`: the init flags after an
 * `--account` are what that account's `get_config` must equal.
 */
export function parseVerify(argv: string[]): VerifyOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        ...COMMON,
        account: { type: "string", multiple: true },
        signer: { type: "string", multiple: true },
        networks: { type: "string", multiple: true },
        creators: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const flag = parseNetwork(str(parsed.values.network));
  interface Group {
    ids: string[];
    signer?: string;
    networks?: string[];
    creators?: string[];
  }
  const groups: Group[] = [];
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    const value = token.value ?? "";
    if (token.name === "account") {
      groups.push({ ids: list([value]) });
    } else if (token.name === "signer" || token.name === "networks" || token.name === "creators") {
      const group = groups.at(-1);
      if (!group) throw new UsageError(`--${token.name} must follow the --account it describes`);
      if (token.name === "signer") {
        if (group.signer !== undefined)
          throw new UsageError("--signer: given twice for one --account");
        group.signer = value;
      } else {
        group[token.name] = [...(group[token.name] ?? []), value];
      }
    }
  }
  const targets: VerifyAccount[] = groups.flatMap((group) =>
    group.ids.map((id) => {
      const accountId = assertAccountId(id, "--account");
      const network = resolveNetwork(accountId, flag);
      return {
        accountId,
        network,
        rpcUrl: RPC_URLS[network],
        expected: initFrom(group, network, false),
      };
    }),
  );
  if (targets.length === 0) throw new UsageError("--account is required (repeat it for several)");
  const ids = targets.map((t) => t.accountId);
  if (new Set(ids).size !== ids.length)
    throw new UsageError("--account: an account is listed twice");
  const rpc = str(parsed.values.rpc);
  if (rpc) {
    if (new Set(targets.map((t) => t.network)).size > 1) {
      throw new UsageError("--rpc: the accounts are on different networks; drop --rpc");
    }
    for (const t of targets) t.rpcUrl = rpc;
  }
  return { targets, wasm: str(parsed.values.wasm) };
}
