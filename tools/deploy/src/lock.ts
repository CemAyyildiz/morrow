import type { LockOptions } from "./args.js";
import type { Wasm } from "./build.js";
import { formatNear } from "./deploy.js";
import {
  describePermission,
  isFullAccess,
  type ChainReader,
  type PlannedAction,
  type TxSender,
} from "./rpc.js";
import { checkAccount, configSummary, verify } from "./verify.js";

export interface LockPorts {
  reader: ChainReader;
  /** Loads the key and builds the sender; called only once every pre-check has passed. */
  sender: () => TxSender;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Locks the account: one batch that redeploys the verified wasm and deletes every access key
 * (full-access and function-call, the signing key last), so the locked code is exactly this build
 * and no key can sign as the contract afterwards.
 *
 * Refuses, sending nothing, unless `--confirm` equals the account id and the account already
 * passes `verify` apart from the lock: code hash equal to the local build, `get_config` equal to
 * the expected init and the contract version. After any send attempt it re-reads the account and
 * exits 1 unless it is locked with this code.
 */
export async function lock(
  options: LockOptions,
  wasm: Wasm,
  ports: LockPorts,
  out: (line: string) => void,
  version: string,
): Promise<number> {
  const { accountId, network } = options;
  if (options.confirm !== accountId) {
    out(
      `Refused: locking ${accountId} is irreversible. Pass --confirm ${accountId} to delete its access keys.`,
    );
    return 1;
  }
  const target = { accountId, network };
  const check = { expected: options.expected, version };
  const pre = await checkAccount(ports.reader, target, wasm.hash, {
    ...check,
    requireLocked: false,
  });
  if (pre.problems.length > 0) {
    for (const p of pre.problems) out(`FAIL ${accountId}: ${p}`);
    out("Refused: the pre-lock verify did not pass; nothing sent.");
    return 1;
  }
  const keys = pre.keys ?? [];
  const final = [{ ...target, reader: ports.reader, expected: options.expected }];
  if (keys.length === 0) {
    out(`Locked: ${accountId} already has no access keys; nothing sent.`);
    return verify(final, wasm, out, { version });
  }
  const sender = ports.sender();
  const signing = keys.find((k) => k.publicKey === sender.publicKey);
  if (!signing || !isFullAccess(signing.permission)) {
    out(`Refused: the signing key ${sender.publicKey} is not a full-access key of ${accountId}.`);
    return 1;
  }
  const ordered = [...keys.filter((k) => k !== signing), signing];
  const batch: PlannedAction[] = [
    { kind: "deployContract", code: wasm.code },
    ...ordered.map((k): PlannedAction => ({ kind: "deleteKey", publicKey: k.publicKey })),
  ];
  out(`Lock plan for ${accountId} (${network}) at final block ${pre.blockHeight}`);
  if (pre.config) out(`  ${configSummary(pre.config)}`);
  out(`  code_hash: ${wasm.hash}`);
  out(
    `  Balance: ${formatNear(pre.amount ?? 0n)} NEAR. After the lock this balance can never be withdrawn.`,
  );
  out(`  1. DeployContract ${wasm.path} (${wasm.code.length} bytes, code_hash ${wasm.hash})`);
  ordered.forEach((k, i) =>
    out(`  ${i + 2}. DeleteKey ${k.publicKey} (${describePermission(k.permission)})`),
  );
  try {
    out(`Sent: transaction ${await sender.send(batch)}`);
  } catch (error) {
    out(`Send failed: ${message(error)}`);
    out("Re-reading the account to report its real state.");
  }
  return verify(final, wasm, out, { version });
}
