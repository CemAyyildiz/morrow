// Shared by the Scenarios that talk to the contract step by step (S-6, S-7): time limits, retried
// reads, exact refusals and the legacy-contract probe.
import {
  MorrowContractError,
  type ContractClient,
  type ErrorCode,
  type MorrowEvent,
} from "@morrow/core-ts";

/** Attempts of a read that follows a transaction, for an RPC node that lags behind. */
const READ_ATTEMPTS = 10;
const READ_RETRY_MS = 1_000;
/** `eventCount` gives up above this many events. */
export const MAX_EVENT_COUNT = 2n ** 32n;

/** Runs one RPC call or transaction, named `what` in errors. */
export type Call = <T>(what: string, work: () => Promise<T>) => Promise<T>;

export const direct: Call = (_what, work) => work();

/** Rejects when `work` takes longer than `ms`. */
export async function within<T>(ms: number, what: string, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** True when a view failed because the contract has no such method (near-api-js or raw RPC text). */
export function isMethodNotFound(error: unknown): boolean {
  if (error instanceof MorrowContractError) return false;
  const name = error instanceof Error ? error.name : "";
  return (
    name === "ContractMethodNotFoundError" ||
    /MethodNotFound|method is not found/i.test(message(error))
  );
}

/**
 * Whether the contract has Policy Changes (Story 5.1): a `get_policy_change` view answers with a
 * Morrow error (or a change) on a contract that has them, and with "method not found" on an older
 * one. Any other failure is thrown.
 */
export async function hasPolicyChanges(
  reader: ContractClient,
  call: Call = direct,
): Promise<boolean> {
  try {
    await call("get_policy_change", () => reader.getPolicyChange("0"));
    return true;
  } catch (error) {
    if (error instanceof MorrowContractError) return true;
    if (isMethodNotFound(error)) return false;
    throw error;
  }
}

/**
 * Whether the contract has Fast Approval (Story 8.4). 8.4 added no view of its own and the
 * contract `version` is still 0.1.0, so this is the Policy Change probe: Policy Changes (5.1) and
 * Fast Approval (8.4) first ship in the same deployment (7.5b), and a contract with one has the
 * other.
 */
export const hasFastApproval = hasPolicyChanges;

/**
 * The seq of the contract's latest event (0 with none). Seqs run 1..n with no gaps, and
 * `events_since(seq - 1, 1)` is empty exactly when `seq > n`, so a doubling search and a binary
 * search find n in O(log n) views instead of reading the whole history. Fails from
 * `MAX_EVENT_COUNT` events on, rather than searching without end.
 */
export async function eventCount(reader: ContractClient, call: Call = direct): Promise<bigint> {
  const exists = async (seq: bigint) =>
    (await call("events_since", () => reader.eventsSince((seq - 1n).toString(), 1))).length > 0;
  let low = 0n;
  let high = 1n;
  while (await exists(high)) {
    if (high >= MAX_EVENT_COUNT) {
      throw new Error(`events_since reports ${MAX_EVENT_COUNT} events or more`);
    }
    low = high;
    high *= 2n;
  }
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (await exists(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/** Asserts that `call` is refused with exactly `code`; any other error fails the Scenario. */
export async function refused(
  code: ErrorCode,
  what: string,
  call: () => Promise<unknown>,
): Promise<void> {
  try {
    await call();
  } catch (error) {
    if (error instanceof MorrowContractError && error.code === code) return;
    throw error;
  }
  throw new Error(`${what} succeeded; expected ${code}`);
}

/**
 * Worth another try: an RPC failure or timeout, or a change, op or Vault the RPC node does not
 * have yet. The public RPC is load-balanced, so one read can show a new Vault active and the next,
 * from a node that lags, still pending (ERR_VAULT_NOT_ACTIVE).
 */
export const transient = (error: unknown) =>
  !(error instanceof MorrowContractError) ||
  error.code === "ERR_CHANGE_NOT_FOUND" ||
  error.code === "ERR_OP_NOT_FOUND" ||
  error.code === "ERR_VAULT_NOT_FOUND" ||
  error.code === "ERR_VAULT_NOT_ACTIVE";

/**
 * A read right after this run's own transaction. The public RPC is load-balanced, so the node
 * that answers may not have that transaction yet; retried as `readAfter` does.
 */
export function afterWrite<T>(
  what: string,
  read: () => Promise<T>,
  settled: (value: T) => boolean = () => true,
): Promise<T> {
  return readAfter(
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    direct,
    what,
    read,
    settled,
  );
}

/** A signed op as the node shows it once every `sign_input` has landed. */
export const allSigned = (op: { signatures: (string | null)[] }) =>
  op.signatures.every((s) => s !== null);

/**
 * A read that follows a transaction, tried up to `READ_ATTEMPTS` times while it fails
 * transiently or `settled` says the node still shows the old state. Returns the last value read,
 * settled or not, for the caller to check.
 */
export async function readAfter<T>(
  sleep: (ms: number) => Promise<void>,
  call: Call,
  what: string,
  read: () => Promise<T>,
  settled: (value: T) => boolean,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await call(what, read);
      if (settled(value) || attempt >= READ_ATTEMPTS) return value;
    } catch (error) {
      if (!transient(error) || attempt >= READ_ATTEMPTS) throw error;
    }
    await sleep(READ_RETRY_MS);
  }
}

/** Pages of `events_since` that `findEvent` reads at most. */
const EVENT_PAGES = 10;

/**
 * The first event after seq `cursor` that `match` accepts, or null when none is among the next
 * `EVENT_PAGES` pages.
 */
export async function findEvent(
  reader: ContractClient,
  cursor: bigint,
  match: (event: MorrowEvent) => boolean,
  call: Call = direct,
): Promise<MorrowEvent | null> {
  let after = cursor;
  for (let page = 0; page < EVENT_PAGES; page++) {
    const events = await call("events_since", () => reader.eventsSince(after.toString(), 100));
    const found = events.find(match);
    if (found) return found;
    const last = events.at(-1);
    if (!last) return null;
    after = BigInt(last.seq);
  }
  return null;
}
