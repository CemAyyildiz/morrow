import type { DeployOptions } from "./args.js";
import type { Wasm } from "./build.js";
import type { ChainReader, PlannedAction, TxSender } from "./rpc.js";
import { verify } from "./verify.js";

/** Gas for `new`: it only writes the config. */
export const INIT_GAS = 30_000_000_000_000n;

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
 * Prints the plan. With `--send` it sends the batch, then verifies the account without requiring
 * it to be locked. Returns the exit code.
 */
export async function deploy(
  options: DeployOptions,
  wasm: Wasm,
  ports: DeployPorts,
  out: (line: string) => void,
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
  if (!options.send) {
    out("Dry run: nothing sent. Add --send to deploy.");
    return 0;
  }
  const sender = ports.sender();
  const txHash = await sender.send(deployBatch(options, wasm));
  out(`Sent: transaction ${txHash}`);
  return verify(
    [{ accountId: options.accountId, network: options.network, reader: ports.reader }],
    wasm,
    out,
    false,
  );
}
