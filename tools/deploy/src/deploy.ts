import type { DeployOptions } from "./args.js";
import type { Wasm } from "./build.js";
import { NO_CONTRACT_HASH, type ChainReader, type PlannedAction, type TxSender } from "./rpc.js";
import { verify } from "./verify.js";

/** Gas for `new`: it only writes the config. */
export const INIT_GAS = 30_000_000_000_000n;
/** Room for the contract state `new` writes, on top of the code and the account's own bytes. */
export const INIT_STATE_MARGIN_BYTES = 2_000;

const YOCTO_PER_NEAR = 10n ** 24n;

/** yoctoNEAR as NEAR with 4 decimals, rounded down. */
export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = (yocto % YOCTO_PER_NEAR) / 10n ** 20n;
  return `${whole}.${frac.toString().padStart(4, "0")}`;
}

/** The balance the account needs after the deploy: (its bytes + code + state margin) × price, +10%. */
export function storageStake(storageUsage: number, codeBytes: number, pricePerByte: bigint) {
  const bytes = storageUsage + codeBytes + INIT_STATE_MARGIN_BYTES;
  return { bytes, yocto: (BigInt(bytes) * pricePerByte * 11n) / 10n };
}

/** The one batch `deploy` sends: DeployContract, then `new(...)` with no deposit. */
export function deployBatch(options: DeployOptions, wasm: Wasm): PlannedAction[] {
  return [
    { kind: "deployContract", code: wasm.code },
    {
      kind: "functionCall",
      method: "new",
      args: { ...options.init },
      gas: INIT_GAS,
      deposit: 0n,
    },
  ];
}

export interface DeployPorts {
  reader: ChainReader;
  /** Loads the key and builds the sender; called only with `--send`. */
  sender: () => TxSender;
}

/**
 * Read-only checks, printed in a dry run too: the account exists, holds no contract, and its
 * balance covers the storage stake; on mainnet every allowlisted creator exists.
 */
async function preflight(
  options: DeployOptions,
  wasm: Wasm,
  reader: ChainReader,
  out: (line: string) => void,
): Promise<string[]> {
  const { accountId } = options;
  const account = await reader.account(accountId);
  if (!account) return [`${accountId} does not exist: create and fund it first`];
  const problems: string[] = [];
  out(`Check: ${accountId} exists, balance ${formatNear(account.amount)} NEAR`);
  if (account.codeHash !== NO_CONTRACT_HASH) {
    problems.push(
      `${accountId} already holds a contract (code_hash ${account.codeHash}): deploy to a fresh account`,
    );
  } else {
    out("Check: no contract deployed yet");
  }
  const price = await reader.storagePricePerByte();
  const stake = storageStake(account.storageUsage, wasm.code.length, price);
  out(
    `Check: storage stake about ${formatNear(stake.yocto)} NEAR (${stake.bytes} bytes at ${price} yoctoNEAR/byte, plus 10%)`,
  );
  if (account.amount < stake.yocto) {
    problems.push(
      `balance ${formatNear(account.amount)} NEAR does not cover the storage stake ${formatNear(stake.yocto)} NEAR`,
    );
  }
  if (options.network === "mainnet") {
    for (const creator of options.init.creator_allowlist) {
      if (await reader.account(creator)) out(`Check: creator ${creator} exists`);
      else problems.push(`creator ${creator} does not exist on mainnet`);
    }
  }
  return problems;
}

/**
 * Prints the plan and the read-only checks. With `--send` and passing checks it sends the batch,
 * then verifies the account against the init just sent, without requiring the lock.
 */
export async function deploy(
  options: DeployOptions,
  wasm: Wasm,
  ports: DeployPorts,
  out: (line: string) => void,
  version: string,
): Promise<number> {
  const { init } = options;
  const allowlist = init.creator_allowlist.length
    ? init.creator_allowlist.join(",")
    : "(open: anyone may create a Vault)";
  out(`Deploy plan for ${options.accountId} (${options.network}, ${options.rpcUrl})`);
  out(`  1. DeployContract ${wasm.path} (${wasm.code.length} bytes, code_hash ${wasm.hash})`);
  out(`  2. FunctionCall new (${INIT_GAS / 1_000_000_000_000n} Tgas, no deposit)`);
  out(`       signer_account: ${init.signer_account}`);
  out(`       allowed_networks: ${init.allowed_networks.join(",")}`);
  out(`       creator_allowlist: ${allowlist}`);
  const problems = await preflight(options, wasm, ports.reader, out);
  if (problems.length > 0) {
    for (const p of problems) out(`FAIL ${options.accountId}: ${p}`);
    out("Refused: the deploy checks did not pass; nothing sent.");
    return 1;
  }
  if (!options.send) {
    out("Dry run: nothing sent. Add --send to deploy.");
    return 0;
  }
  const sender = ports.sender();
  const txHash = await sender.send(deployBatch(options, wasm));
  out(`Sent: transaction ${txHash}`);
  return verify(
    [
      {
        accountId: options.accountId,
        network: options.network,
        reader: ports.reader,
        expected: init,
      },
    ],
    wasm,
    out,
    { requireLocked: false, version },
  );
}
