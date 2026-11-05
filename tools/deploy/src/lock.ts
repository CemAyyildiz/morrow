import type { LockOptions } from "./args.js";
import type { Wasm } from "./build.js";
import { fullAccessKeys, type ChainReader, type PlannedAction, type TxSender } from "./rpc.js";
import { checkAccount, verify } from "./verify.js";

export interface LockPorts {
  reader: ChainReader;
  /** Loads the key and builds the sender; called only once every pre-check has passed. */
  sender: () => TxSender;
}

/**
 * Deletes every full-access key of the account in one batch. Refuses, sending nothing, unless
 * `--confirm` equals the account id and the account already passes `verify` apart from the lock
 * (code hash equal to the local build, `get_config` answering). Afterwards it re-reads the keys
 * and fails if any full-access key remains. Returns the exit code.
 */
export async function lock(
  options: LockOptions,
  wasm: Wasm,
  ports: LockPorts,
  out: (line: string) => void,
): Promise<number> {
  const { accountId, network } = options;
  if (options.confirm !== accountId) {
    out(
      `Refused: locking ${accountId} is irreversible. Pass --confirm ${accountId} to delete its full-access keys.`,
    );
    return 1;
  }
  const target = { accountId, network };
  const pre = await checkAccount(ports.reader, target, wasm.hash, false);
  if (pre.problems.length > 0) {
    for (const p of pre.problems) out(`FAIL ${accountId}: ${p}`);
    out("Refused: the pre-lock verify did not pass; nothing sent.");
    return 1;
  }
  const keys = fullAccessKeys(await ports.reader.accessKeys(accountId));
  if (keys.length === 0) {
    out(`Locked: ${accountId} already has no full-access keys; nothing sent.`);
    return verify([{ ...target, reader: ports.reader }], wasm, out);
  }
  const sender = ports.sender();
  if (!keys.some((k) => k.publicKey === sender.publicKey)) {
    out(`Refused: the signing key ${sender.publicKey} is not a full-access key of ${accountId}.`);
    return 1;
  }
  // The signing key goes last: the batch is authorised before it runs, but this keeps the
  // order obvious when reading the transaction.
  const ordered = [
    ...keys.filter((k) => k.publicKey !== sender.publicKey),
    ...keys.filter((k) => k.publicKey === sender.publicKey),
  ];
  const batch: PlannedAction[] = ordered.map((k) => ({
    kind: "deleteKey",
    publicKey: k.publicKey,
  }));
  out(`Deleting ${batch.length} full-access key(s) of ${accountId}:`);
  for (const k of ordered) out(`  DeleteKey ${k.publicKey}`);
  const txHash = await sender.send(batch);
  out(`Sent: transaction ${txHash}`);

  const remaining = fullAccessKeys(await ports.reader.accessKeys(accountId));
  if (remaining.length > 0) {
    out(`FAIL ${accountId}: ${remaining.length} full-access key(s) remain after the lock:`);
    for (const k of remaining) out(`  ${k.publicKey}`);
    return 1;
  }
  out(`Locked: ${accountId} has no full-access keys`);
  return verify([{ ...target, reader: ports.reader }], wasm, out);
}
