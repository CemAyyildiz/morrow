import {
  MINUTE_NS,
  MorrowContractError,
  NearContractClient,
  sealEnvelope,
  type ContractClient,
  type EnvelopeKeypair,
  type ErrorCode,
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
  type Logger,
} from "@morrow/watcher";
import { loadJudgeConfig } from "../config.js";
import { ScenarioSkip } from "../runner.js";
import type { ScenarioContext } from "../scenarios.js";
import { createJudgeVault, judgeSession } from "../session.js";

/** The tighter Delay and Policy Change Delay of step 2 (both are 1 minute in Judge Mode). */
const TWO_MINUTES = (2n * MINUTE_NS).toString();
/** How often S-6 checks for the guard's veto, and how long it waits for it. */
const POLL_MS = 2_000;
const VETO_WAIT_MS = 90_000;
/** Retries of an apply the chain still calls early, after the computed wait. */
const APPLY_RETRIES = 20;
const APPLY_RETRY_MS = 3_000;

/** The S-6 Vault and the clients that act on it. */
export interface PolicyVault {
  vaultId: string;
  /** Signed by the Owner. */
  owner: ContractClient;
  /** Signed by the Guardian, an `auto_clawback` Guardian of the Vault. */
  guardian: ContractClient;
  guardianAccount: string;
  /** The Vault's watcher key, so the guard reads the duress flag as a configured Watcher does. */
  watcher: EnvelopeKeypair;
}

export interface PolicyScenarioDeps {
  /** The Vault Contract account, named in the SKIP line. */
  contract: string;
  /** Unsigned client for views: the legacy check, the guard's reads and every assertion. */
  reader: ContractClient;
  /** The latest final NEAR block time. */
  clock: ChainClock;
  sleep(ms: number): Promise<void>;
  /** Creates the S-6 Vault. Called only once the contract is known to have Policy Changes. */
  createVault(): Promise<PolicyVault>;
  /** The in-process guard's poll interval. */
  guardIntervalMs: number;
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
export async function hasPolicyChanges(reader: ContractClient): Promise<boolean> {
  try {
    await reader.getPolicyChange("0");
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
 * search find n in O(log n) views instead of reading the whole history.
 */
export async function eventCount(reader: ContractClient): Promise<bigint> {
  const exists = async (seq: bigint) =>
    (await reader.eventsSince((seq - 1n).toString(), 1)).length > 0;
  let low = 0n;
  let high = 1n;
  while (await exists(high)) {
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

interface RunningGuard {
  stop(): void;
  /** The guard's last error about `changeId`, or its last error at all. */
  lastError(changeId: string): Promise<string | null>;
}

/**
 * The Watcher's real loosening guard, run in this process as the Vault's Guardian with no
 * Telegram: in-memory stores, a cursor starting at the contract's current event count (no
 * history replay), and no Owner Confirmation, so every loosening change is vetoed.
 */
async function startGuard(deps: PolicyScenarioDeps, vault: PolicyVault): Promise<RunningGuard> {
  const { reader, clock, guardIntervalMs } = deps;
  let lastLogged: string | null = null;
  // The guard's own JSON log lines stay out of the Judge Mode output; its last error is kept.
  const log: Logger = (level, msg, fields) => {
    if (level === "error") lastLogged = fields?.error ? `${msg}: ${String(fields.error)}` : msg;
  };
  const cursor = new InMemoryStore();
  await cursor.commit((await eventCount(reader)).toString(), "0");
  const store = new InMemoryGuardStore();
  const loop = new EventLoop({
    client: reader,
    store: cursor,
    handlers: [
      new LooseningGuard({
        reader,
        guardianAccount: vault.guardianAccount,
        store,
        envelopeKeypair: vault.watcher,
        challengeOwnerParent: null,
      }),
    ],
    clock,
    log,
    intervalMs: guardIntervalMs,
  });
  const ticker = new GuardTicker({
    reader,
    signer: vault.guardian,
    store,
    guardianAccount: vault.guardianAccount,
    clock,
    log,
    intervalMs: guardIntervalMs,
    // A testnet veto can take several seconds; a short limit would only cause retries.
    callTimeoutMs: Math.max(30_000, 3 * guardIntervalMs),
    envelopeKeyConfigured: true,
  });
  loop.start();
  ticker.start();
  return {
    stop: () => {
      loop.stop();
      ticker.stop();
    },
    lastError: async (changeId) => {
      const entry = await store.entry(changeId);
      const error =
        entry?.last_error ?? lastLogged ?? ticker.lastError?.error ?? loop.lastError?.error;
      if (!entry) return `${error ?? "none"}; the guard never recorded the change`;
      return error ?? null;
    },
  };
}

/**
 * S-6 Policy Change: a thief with the Owner keys cannot rewrite the rules. Script-bound fields
 * cannot change at all, a change waits the Policy Change Delay, a Guardian can veto it, and the
 * Guardian Watcher's loosening guard vetoes an unconfirmed loosening change on its own.
 */
export async function runPolicy(ctx: ScenarioContext, deps: PolicyScenarioDeps): Promise<void> {
  const { reader, clock, sleep } = deps;
  if (!(await hasPolicyChanges(reader))) {
    throw new ScenarioSkip(`${deps.contract} predates Policy Changes`);
  }
  const vault = await deps.createVault();
  const { vaultId, owner, guardian, guardianAccount } = vault;
  const propose = async (changes: ProposePolicyChangeArgs["changes"]) =>
    owner.proposePolicyChange({
      vault_id: vaultId,
      changes,
      envelope: await sealEnvelope("normal", vault.watcher.publicKeyHex),
    });
  const iso = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

  const guard = await startGuard(deps, vault);
  try {
    ctx.log(
      `Vault ${vaultId}: Guardian ${guardianAccount} (auto_clawback) runs the Watcher's loosening guard`,
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
    const { effective_at } = await reader.getPolicyChange(delayChange);
    ctx.log(
      `Policy Change ${delayChange} proposed: Delay and Policy Change Delay from 1 to 2 minutes`,
    );
    await refused("ERR_CHANGE_NOT_EFFECTIVE", "Applying before effective_at", () =>
      owner.applyPolicyChange(delayChange),
    );
    ctx.log("Apply before the Policy Change Delay rejected: ERR_CHANGE_NOT_EFFECTIVE");
    ctx.log(`Waiting for the Policy Change Delay (effective at ${iso(effective_at)})`);
    const waitMs = Number((BigInt(effective_at) - (await clock.now())) / 1_000_000n);
    await sleep(Math.max(0, waitMs) + 2_000);
    for (let attempt = 0; ; attempt++) {
      try {
        await owner.applyPolicyChange(delayChange);
        break;
      } catch (error) {
        const early =
          error instanceof MorrowContractError && error.code === "ERR_CHANGE_NOT_EFFECTIVE";
        if (!early || attempt >= APPLY_RETRIES) throw error;
        await sleep(APPLY_RETRY_MS);
      }
    }
    const { policy } = await reader.getVault(vaultId);
    if (policy.delay_ns !== TWO_MINUTES) {
      throw new Error(`get_vault shows delay_ns ${policy.delay_ns}, expected ${TWO_MINUTES}`);
    }
    ctx.log(`Applied after the delay: get_vault shows delay_ns ${policy.delay_ns}`);
    ctx.log("The guard left that change alone: it tightens the rules");

    const feeChange = await propose({
      fee_cap_sats: (BigInt(policy.fee_cap_sats) / 2n).toString(),
    });
    await guardian.vetoPolicyChange(feeChange);
    ctx.log(`Guardian vetoed Policy Change ${feeChange} (a lower Fee Cap)`);
    await refused("ERR_BAD_OP_STATE", "Applying a vetoed change", () =>
      owner.applyPolicyChange(feeChange),
    );
    const vetoed = await reader.getPolicyChange(feeChange);
    if (vetoed.state !== "vetoed") {
      throw new Error(`get_policy_change reports ${vetoed.state}, expected vetoed`);
    }
    ctx.log(
      "Applying the vetoed change rejected: ERR_BAD_OP_STATE; get_policy_change reports vetoed",
    );

    const looseChange = await propose({
      allowance_limit_sats: (BigInt(policy.allowance_limit_sats) + 100_000n).toString(),
    });
    ctx.log(
      `Policy Change ${looseChange} raises the Allowance limit with no Owner Confirmation; waiting up to 90 s for the guard`,
    );
    for (let waited = 0; ; waited += POLL_MS) {
      const change = await reader.getPolicyChange(looseChange);
      if (change.state === "vetoed" && change.vetoed_by === guardianAccount) break;
      if (change.state !== "pending") {
        throw new Error(
          `Loosening change ${looseChange} is ${change.state}${change.vetoed_by ? ` by ${change.vetoed_by}` : ""}, expected vetoed by ${guardianAccount}`,
        );
      }
      if (waited >= VETO_WAIT_MS) {
        throw new Error(
          `Loosening change ${looseChange} not vetoed within 90 s; the guard's last error: ${(await guard.lastError(looseChange)) ?? "none"}`,
        );
      }
      await sleep(POLL_MS);
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
    guardIntervalMs: 2_000,
    createVault: async () => {
      const session = await judgeSession();
      const { vaultId } = await createJudgeVault(session, { guardianKind: "auto_clawback" });
      return {
        vaultId,
        owner: session.client,
        guardian: session.guardianClient,
        guardianAccount: session.guardianAccountId,
        watcher: session.watcher,
      };
    },
  });
}
