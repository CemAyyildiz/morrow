import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  MINUTE_NS,
  MorrowContractError,
  NearContractClient,
  bytesToHex,
  sealEnvelope,
  type ContractClient,
  type EnvelopeKeypair,
  type ErrorCode,
  type Guardian,
  type PolicyChange,
  type ProposePolicyChangeArgs,
} from "@morrow/core-ts";
import {
  EventLoop,
  GuardTicker,
  InMemoryGuardStore,
  InMemoryStore,
  LooseningGuard,
  NearFinalBlockClock,
  type ChainClock,
  type GuardEntry,
  type Logger,
} from "@morrow/watcher";
import { loadJudgeConfig } from "../config.js";
import { ScenarioSkip } from "../runner.js";
import type { ScenarioContext } from "../scenarios.js";
import {
  createJudgeSubAccount,
  createJudgeVault,
  judgeGuardian,
  judgeSession,
} from "../session.js";

/** The tighter Delay and Policy Change Delay of step 2 (both are 1 minute in Judge Mode). */
const TWO_MINUTES = (2n * MINUTE_NS).toString();
/** How often S-6 checks on the guard, and how long it waits for the auto-veto. */
const POLL_MS = 2_000;
const VETO_WAIT_MS = 90_000;
/** How long the guard may take to record a change it can see. */
const RECORD_WAIT_MS = 30_000;
/** S-6 refuses to wait longer than this for a Policy Change Delay. */
const MAX_DELAY_WAIT_MS = 5 * 60_000;
/** Retries of an apply the chain still calls early, after the computed wait. */
const APPLY_RETRIES = 20;
const APPLY_RETRY_MS = 3_000;
/** Attempts of a read that follows a transaction, for an RPC node that lags behind. */
const READ_ATTEMPTS = 5;
const READ_RETRY_MS = 1_000;
/** `eventCount` gives up above this many events. */
export const MAX_EVENT_COUNT = 2n ** 32n;
/** 0.2 NEAR for the watcher's own Guardian account: plenty for its veto transactions. */
const WATCHER_FUNDING = 200_000_000_000_000_000_000_000n;

/** The S-6 Vault and the clients that act on it. */
export interface PolicyVault {
  vaultId: string;
  /** Signed by the Owner. */
  owner: ContractClient;
  /** The session Guardian, a `backup_device` Guardian of the Vault: S-6's own veto. */
  guardian: ContractClient;
  guardianAccount: string;
  /** The watcher's own `auto_clawback` Guardian account: the in-process guard signs with it. */
  watcher: ContractClient;
  watcherAccount: string;
  /** The Vault's watcher key, so the guard reads the duress flag as a configured Watcher does. */
  envelopeKey: EnvelopeKeypair;
}

export interface PolicyScenarioDeps {
  /** The Vault Contract account, named in the SKIP line. */
  contract: string;
  /** Unsigned client for views: the legacy check, the guard's reads and every assertion. */
  reader: ContractClient;
  /** The latest final NEAR block time. */
  clock: ChainClock;
  sleep(ms: number): Promise<void>;
  /** Wall-clock time in milliseconds, for the deadlines. */
  now(): number;
  /** Creates the S-6 Vault. Called only once the contract is known to have Policy Changes. */
  createVault(): Promise<PolicyVault>;
  /** The in-process guard's poll interval. */
  guardIntervalMs: number;
  /** The limit for each RPC call and transaction (Vault creation gets three times as long). */
  rpcTimeoutMs: number;
}

/** Runs one RPC call or transaction, named `what` in errors. */
type Call = <T>(what: string, work: () => Promise<T>) => Promise<T>;

const direct: Call = (_what, work) => work();

/** Rejects when `work` takes longer than `ms`. */
async function within<T>(ms: number, what: string, work: () => Promise<T>): Promise<T> {
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
async function refused(code: ErrorCode, what: string, call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (error) {
    if (error instanceof MorrowContractError && error.code === code) return;
    throw error;
  }
  throw new Error(`${what} succeeded; expected ${code}`);
}

/** Worth another try: an RPC failure or timeout, or a change the RPC node does not have yet. */
const transient = (error: unknown) =>
  !(error instanceof MorrowContractError) || error.code === "ERR_CHANGE_NOT_FOUND";

/**
 * A read that follows a transaction, tried up to `READ_ATTEMPTS` times while it fails
 * transiently or `settled` says the node still shows the old state. Returns the last value read,
 * settled or not, for the caller to check.
 */
async function readAfter<T>(
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

/** A guard entry as FAIL messages name it. */
const describeEntry = (entry: GuardEntry | null) =>
  entry ? `${entry.status}${entry.cause ? ` (${entry.cause})` : ""}` : "never recorded";

const describeState = (change: PolicyChange) =>
  `${change.state}${change.vetoed_by ? ` by ${change.vetoed_by}` : ""}`;

interface RunningGuard {
  stop(): void;
  entry(changeId: string): Promise<GuardEntry | null>;
  /** The guard's last error about `changeId`, else its last error at all. */
  lastError(changeId: string): Promise<string | null>;
}

/**
 * The Watcher's real loosening guard, run in this process as the watcher's own Guardian account,
 * with no Telegram: in-memory stores, a cursor starting at the contract's current event count (no
 * history replay), and no Owner Confirmation, so every loosening change is vetoed.
 */
async function startGuard(
  deps: PolicyScenarioDeps,
  vault: PolicyVault,
  call: Call,
): Promise<RunningGuard> {
  const { reader, clock, guardIntervalMs } = deps;
  let lastLogged: string | null = null;
  // The guard's own JSON log lines stay out of the Judge Mode output; its last error is kept.
  const log: Logger = (level, msg, fields) => {
    if (level === "error") lastLogged = fields?.error ? `${msg}: ${String(fields.error)}` : msg;
  };
  const cursor = new InMemoryStore();
  await cursor.commit((await eventCount(reader, call)).toString(), "0");
  const store = new InMemoryGuardStore();
  const loop = new EventLoop({
    client: reader,
    store: cursor,
    handlers: [
      new LooseningGuard({
        reader,
        guardianAccount: vault.watcherAccount,
        store,
        envelopeKeypair: vault.envelopeKey,
        challengeOwnerParent: null,
      }),
    ],
    clock,
    log,
    intervalMs: guardIntervalMs,
  });
  const ticker = new GuardTicker({
    reader,
    signer: vault.watcher,
    store,
    guardianAccount: vault.watcherAccount,
    clock,
    log,
    intervalMs: guardIntervalMs,
    // A testnet veto can take several seconds; a short limit would only cause retries.
    callTimeoutMs: Math.max(30_000, 3 * guardIntervalMs),
    envelopeKeyConfigured: true,
  });
  loop.start();
  try {
    ticker.start();
  } catch (error) {
    loop.stop();
    throw error;
  }
  return {
    // Neither loop offers a way to wait for a tick in flight: stop() cancels the next tick, and
    // one in flight runs to its end and schedules no other.
    stop: () => {
      loop.stop();
      ticker.stop();
    },
    entry: (changeId) => store.entry(changeId),
    lastError: async (changeId) =>
      (await store.entry(changeId))?.last_error ??
      lastLogged ??
      ticker.lastError?.error ??
      loop.lastError?.error ??
      null,
  };
}

/**
 * S-6 Policy Change: a thief with the Owner keys cannot rewrite the rules. Script-bound fields
 * cannot change at all, a change waits the Policy Change Delay, a Guardian can veto it, and the
 * Guardian Watcher's loosening guard, as its own Guardian account, vetoes an unconfirmed loosening
 * change on its own.
 */
export async function runPolicy(ctx: ScenarioContext, deps: PolicyScenarioDeps): Promise<void> {
  const { reader, clock, sleep, now } = deps;
  const call: Call = (what, work) => within(deps.rpcTimeoutMs, what, work);
  if (!(await hasPolicyChanges(reader, call))) {
    throw new ScenarioSkip(`${deps.contract} predates Policy Changes`);
  }
  const vault = await within(3 * deps.rpcTimeoutMs, "creating the S-6 Vault", deps.createVault);
  const { vaultId, owner, guardian, guardianAccount, watcherAccount } = vault;
  const propose = async (changes: ProposePolicyChangeArgs["changes"]) => {
    const envelope = await sealEnvelope("normal", vault.envelopeKey.publicKeyHex);
    return call("propose_policy_change", () =>
      owner.proposePolicyChange({ vault_id: vaultId, changes, envelope }),
    );
  };
  const apply = (changeId: string) =>
    call("apply_policy_change", () => owner.applyPolicyChange(changeId));
  const readChange = (changeId: string, settled: (change: PolicyChange) => boolean) =>
    readAfter(sleep, call, "get_policy_change", () => reader.getPolicyChange(changeId), settled);
  const iso = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

  const guard = await startGuard(deps, vault, call);
  /** Fails unless the guard recorded the change as not loosening, so it never vetoes it. */
  const leftAlone = async (changeId: string) => {
    const deadline = now() + RECORD_WAIT_MS;
    let entry = await guard.entry(changeId);
    while (!entry && now() < deadline) {
      await sleep(POLL_MS);
      entry = await guard.entry(changeId);
    }
    if (entry?.status === "skipped" && entry.cause === "not loosening") return;
    if (!entry) {
      throw new Error(
        `The guard never recorded tightening change ${changeId} within 30 s; last error: ${(await guard.lastError(changeId)) ?? "none"}`,
      );
    }
    if (entry.status === "vetoed")
      throw new Error(`The guard vetoed tightening change ${changeId}`);
    if (entry.status === "scheduled") {
      throw new Error(`The guard scheduled a veto of tightening change ${changeId}`);
    }
    throw new Error(
      `The guard has tightening change ${changeId} as ${describeEntry(entry)}, expected skipped (not loosening)`,
    );
  };

  try {
    ctx.log(
      `Vault ${vaultId}: the Watcher's loosening guard runs as ${watcherAccount} (auto_clawback); Guardian ${guardianAccount} (backup_device) vetoes by hand`,
    );

    await refused("ERR_SCRIPT_BOUND", "A Script-bound change", () =>
      propose({ escape_timelock_blocks: 7 }),
    );
    ctx.log("Script-bound change rejected: ERR_SCRIPT_BOUND");

    // The Policy Change Delay may never be below the Delay, so both go up together.
    const delayChange = await propose({
      delay_ns: TWO_MINUTES,
      policy_change_delay_ns: TWO_MINUTES,
    });
    const { effective_at } = await readChange(delayChange, () => true);
    ctx.log(
      `Policy Change ${delayChange} proposed: Delay and Policy Change Delay from 1 to 2 minutes`,
    );
    await refused("ERR_CHANGE_NOT_EFFECTIVE", "Applying before effective_at", () =>
      apply(delayChange),
    );
    ctx.log("Apply before the Policy Change Delay rejected: ERR_CHANGE_NOT_EFFECTIVE");
    await leftAlone(delayChange);
    const waitMs = Number(
      (BigInt(effective_at) - (await call("block", () => clock.now()))) / 1_000_000n,
    );
    if (waitMs > MAX_DELAY_WAIT_MS) {
      throw new Error(
        `Policy Change ${delayChange} is effective in ${Math.ceil(waitMs / 1_000)} s, beyond the 5-minute bound`,
      );
    }
    ctx.log(`Waiting for the Policy Change Delay (effective at ${iso(effective_at)})`);
    await sleep(Math.max(0, waitMs) + 2_000);
    for (let attempt = 0; ; attempt++) {
      try {
        await apply(delayChange);
        break;
      } catch (error) {
        const early =
          error instanceof MorrowContractError && error.code === "ERR_CHANGE_NOT_EFFECTIVE";
        if (!early || attempt >= APPLY_RETRIES) throw error;
        await sleep(APPLY_RETRY_MS);
      }
    }
    const { policy } = await readAfter(
      sleep,
      call,
      "get_vault",
      () => reader.getVault(vaultId),
      (v) => v.policy.delay_ns === TWO_MINUTES && v.policy.policy_change_delay_ns === TWO_MINUTES,
    );
    for (const field of ["delay_ns", "policy_change_delay_ns"] as const) {
      if (policy[field] !== TWO_MINUTES) {
        throw new Error(`get_vault shows ${field} ${policy[field]}, expected ${TWO_MINUTES}`);
      }
    }
    ctx.log(`Applied after the delay: get_vault shows delay_ns ${policy.delay_ns}`);
    ctx.log("The guard left that change alone: it tightens the rules");

    const feeChange = await propose({
      fee_cap_sats: (BigInt(policy.fee_cap_sats) / 2n).toString(),
    });
    await leftAlone(feeChange);
    await call("veto_policy_change", () => guardian.vetoPolicyChange(feeChange));
    const vetoed = await readChange(feeChange, (c) => c.state !== "pending");
    if (vetoed.state !== "vetoed" || vetoed.vetoed_by !== guardianAccount) {
      throw new Error(
        `get_policy_change reports ${describeState(vetoed)}, expected vetoed by ${guardianAccount}`,
      );
    }
    ctx.log(`Guardian vetoed Policy Change ${feeChange} (a lower Fee Cap)`);
    await refused("ERR_BAD_OP_STATE", "Applying a vetoed change", () => apply(feeChange));
    ctx.log(
      "Applying the vetoed change rejected: ERR_BAD_OP_STATE; get_policy_change reports vetoed",
    );

    const looseChange = await propose({
      allowance_limit_sats: (BigInt(policy.allowance_limit_sats) + 100_000n).toString(),
    });
    ctx.log(
      `Policy Change ${looseChange} raises the Allowance limit with no Owner Confirmation; waiting up to 90 s for the guard`,
    );
    const deadline = now() + VETO_WAIT_MS;
    let pollError: string | null = null;
    for (;;) {
      let change: PolicyChange | null = null;
      try {
        change = await call("get_policy_change", () => reader.getPolicyChange(looseChange));
        pollError = null;
      } catch (error) {
        // One failed poll is no verdict; the deadline still bounds the wait.
        if (!transient(error)) throw error;
        pollError = message(error);
      }
      if (change?.state === "vetoed" && change.vetoed_by === watcherAccount) break;
      if (change && change.state !== "pending") {
        throw new Error(
          `Loosening change ${looseChange} is ${describeState(change)}, expected vetoed by ${watcherAccount}`,
        );
      }
      if (now() >= deadline) {
        const entry = await guard.entry(looseChange);
        const error = (await guard.lastError(looseChange)) ?? pollError ?? "none";
        throw new Error(
          `Loosening change ${looseChange} not vetoed within 90 s; guard entry: ${describeEntry(entry)}; last error: ${error}`,
        );
      }
      await sleep(POLL_MS);
    }
    // The guard records its veto right after the transaction returns: allow it a moment.
    const entry = await readAfter(
      sleep,
      direct,
      "the guard store",
      () => guard.entry(looseChange),
      (e) => e?.status === "vetoed",
    );
    if (entry?.status !== "vetoed") {
      throw new Error(
        `Change ${looseChange} is vetoed by ${watcherAccount}, but the guard has it as ${describeEntry(entry)}`,
      );
    }
    ctx.log("Unconfirmed loosening change auto-vetoed by the Guardian Watcher");
  } finally {
    guard.stop();
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** S-6 against the configured Vault Contract on NEAR testnet. */
export async function runPolicyChange(ctx: ScenarioContext): Promise<void> {
  const config = loadJudgeConfig();
  await runPolicy(ctx, {
    contract: config.vaultContract,
    reader: new NearContractClient({ contractId: config.vaultContract, rpcUrl: config.nearRpcUrl }),
    clock: new NearFinalBlockClock(config.nearRpcUrl),
    sleep,
    now: () => Date.now(),
    guardIntervalMs: 2_000,
    rpcTimeoutMs: 60_000,
    createVault: async () => {
      const session = await judgeSession();
      // The guard gets an account of its own, so its veto is never confused with the manual one.
      const watcher = await createJudgeSubAccount(session, "watcher", WATCHER_FUNDING);
      const watcherGuardian: Guardian = {
        guardian_key: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)),
        guardian_account: watcher.accountId,
        kind: "auto_clawback",
      };
      const { vaultId } = await createJudgeVault(session, {
        guardians: [judgeGuardian(session), watcherGuardian],
      });
      return {
        vaultId,
        owner: session.client,
        guardian: session.guardianClient,
        guardianAccount: session.guardianAccountId,
        watcher: watcher.client,
        watcherAccount: watcher.accountId,
        envelopeKey: session.watcher,
      };
    },
  });
}
