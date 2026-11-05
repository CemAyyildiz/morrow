/**
 * Vault Contract deployment tooling.
 *
 *   build  [--local]                       build the release wasm, print its code_hash
 *                                          (default: `make wasm`, the pinned Docker image)
 *   deploy --account A --signer S --networks N[,N] [--creators C[,C]] [--send]
 *                                          DeployContract + new(...) in one transaction;
 *                                          a dry run unless --send
 *   lock   --account A --confirm A         delete every full-access key, after a pre-lock verify
 *   verify --account A [--account B ...]   read-only: code_hash against the local build, locked,
 *                                          get_config; equal code across accounts
 *
 * Common flags: --network testnet|mainnet (default: from the account suffix, else testnet),
 * --rpc URL, --wasm PATH (default: the `make wasm` output).
 * Keys: MORROW_DEPLOY_PRIVATE_KEY, else ~/.near-credentials/<network>/<account>.json. Never printed.
 */
import { pathToFileURL } from "node:url";
import { UsageError, parseBuild, parseDeploy, parseLock, parseVerify } from "./args.js";
import { build, readWasm } from "./build.js";
import { deploy } from "./deploy.js";
import { lock } from "./lock.js";
import { loadSigningKey, nearReader, nearSender } from "./rpc.js";
import { verify } from "./verify.js";

const USAGE = "Usage: deploy <build|deploy|lock|verify> [flags] (see tools/deploy/src/main.ts)";

export async function main(argv: string[], out: (line: string) => void): Promise<number> {
  const [command, ...flags] = argv;
  switch (command) {
    case "build":
      return build(parseBuild(flags), out);
    case "deploy": {
      const options = parseDeploy(flags);
      return deploy(
        options,
        readWasm(options.wasm),
        {
          reader: nearReader(options.rpcUrl),
          sender: () =>
            nearSender(
              options.rpcUrl,
              options.accountId,
              loadSigningKey(options.accountId, options.network),
            ),
        },
        out,
      );
    }
    case "lock": {
      const options = parseLock(flags);
      return lock(
        options,
        readWasm(options.wasm),
        {
          reader: nearReader(options.rpcUrl),
          sender: () =>
            nearSender(
              options.rpcUrl,
              options.accountId,
              loadSigningKey(options.accountId, options.network),
            ),
        },
        out,
      );
    }
    case "verify": {
      const options = parseVerify(flags);
      const targets = options.targets.map((t) => ({ ...t, reader: nearReader(t.rpcUrl) }));
      return verify(targets, readWasm(options.wasm), out);
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
