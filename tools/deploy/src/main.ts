/**
 * Vault Contract deployment tooling.
 *
 *   build  [--local]                       build the release wasm, print its code_hash
 *                                          (default: `make wasm`, the pinned Docker image)
 *   hash   --wasm PATH                     print a wasm file's code_hash
 *   deploy --account A --signer S --networks N[,N] [--creators C[,C]] [--send]
 *                                          read-only checks, then DeployContract + new(...) in
 *                                          one transaction; a dry run unless --send
 *   lock   --account A --signer S --networks N [--creators C] --confirm A
 *                                          after a pre-lock verify against that init: redeploy
 *                                          the verified wasm and delete every access key
 *   verify --account A [--signer S --networks N --creators C] [--account B ...]
 *                                          read-only: code_hash against the local build, no
 *                                          access keys, get_config (equal to the init flags that
 *                                          follow the account, when given); equal code across
 *                                          accounts
 *
 * Common flags: --network testnet|mainnet (default: from a .testnet/.near suffix), --rpc URL
 * (must serve that network), --wasm PATH (default: the `make wasm` output).
 * Keys: MORROW_DEPLOY_PRIVATE_KEY, else ~/.near-credentials/<network>/<account>.json. Never printed.
 */
import { pathToFileURL } from "node:url";
import {
  UsageError,
  assertRpcNetwork,
  parseBuild,
  parseDeploy,
  parseHash,
  parseLock,
  parseVerify,
} from "./args.js";
import { build, contractVersion, readWasm } from "./build.js";
import { deploy } from "./deploy.js";
import { lock } from "./lock.js";
import { loadSigningKey, nearReader, nearSender, type ChainReader } from "./rpc.js";
import { verify } from "./verify.js";

const USAGE =
  "Usage: deploy <build|hash|deploy|lock|verify> [flags] (see tools/deploy/src/main.ts)";

export interface MainPorts {
  reader: (rpcUrl: string) => ChainReader;
}

export async function main(
  argv: string[],
  out: (line: string) => void,
  ports: MainPorts = { reader: (url) => nearReader(url) },
): Promise<number> {
  const [command, ...flags] = argv;
  const checkedReader = async (rpcUrl: string, network: "testnet" | "mainnet") => {
    const reader = ports.reader(rpcUrl);
    await assertRpcNetwork(rpcUrl, network, () => reader.networkId());
    return reader;
  };
  switch (command) {
    case "build":
      return build(parseBuild(flags), out);
    case "hash": {
      const { wasm } = parseHash(flags);
      if (!wasm) throw new UsageError("--wasm is required");
      const file = readWasm(wasm);
      out(`Wasm: ${file.path}`);
      out(`code_hash: ${file.hash}`);
      return 0;
    }
    case "deploy": {
      const options = parseDeploy(flags);
      const wasm = readWasm(options.wasm);
      const reader = await checkedReader(options.rpcUrl, options.network);
      const sender = () =>
        nearSender(
          options.rpcUrl,
          options.accountId,
          loadSigningKey(options.accountId, options.network),
        );
      return deploy(options, wasm, { reader, sender }, out, contractVersion());
    }
    case "lock": {
      const options = parseLock(flags);
      const wasm = readWasm(options.wasm);
      const reader = await checkedReader(options.rpcUrl, options.network);
      const sender = () =>
        nearSender(
          options.rpcUrl,
          options.accountId,
          loadSigningKey(options.accountId, options.network),
        );
      return lock(options, wasm, { reader, sender }, out, contractVersion());
    }
    case "verify": {
      const options = parseVerify(flags);
      const wasm = readWasm(options.wasm);
      const targets = [];
      for (const t of options.targets) {
        targets.push({ ...t, reader: await checkedReader(t.rpcUrl, t.network) });
      }
      return verify(targets, wasm, out, { version: contractVersion() });
    }
    default:
      throw new UsageError(USAGE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), (line) => console.log(line)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
