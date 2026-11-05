import {
  MIN_VAULT_STORAGE_YOCTO,
  MINUTE_NS,
  MockContractClient,
  MorrowContractError,
  generateEnvelopeKeypair,
  type ContractClient,
  type MorrowEvent,
} from "@morrow/core-ts";
import { describe, expect, it, vi } from "vitest";
import { exitCode, runScenarios } from "../runner.js";
import { judgePolicy, type JudgeSession } from "../session.js";
import {
  eventCount,
  hasPolicyChanges,
  isMethodNotFound,
  runPolicy,
  type PolicyScenarioDeps,
} from "./s6-policy.js";

const OWNER = "owner.test.near";
const GUARDIAN = "guardian.test.near";
const RECOVERY = `bcrt1q${"q".repeat(38)}`;
const CONTRACT = "morrow-vault-dev3.testnet";

/** A view of the shared mock that signs every call as `account`. */
function as(mock: MockContractClient, account: string): ContractClient {
  return new Proxy(mock, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        target.asCaller(account);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** What near-api-js throws for a view of a method the contract does not have. */
class ContractMethodNotFoundError extends Error {
  override name = "ContractMethodNotFoundError";
}

interface FixtureOptions {
  /** Wraps the Guardian's signed client (the guard's signer and S-6's own veto). */
  guardian?: (client: ContractClient) => ContractClient;
}

/** S-6 against the mock contract, with a fake sleep that moves the mock's clock. */
async function fixture({ guardian = (c) => c }: FixtureOptions = {}) {
  const mock = new MockContractClient();
  const watcher = await generateEnvelopeKeypair();
  const session = {
    guardianKey: `02${"11".repeat(32)}`,
    guardianAccountId: GUARDIAN,
    watcher,
  } as JudgeSession;
  const createVault = vi.fn(async () => {
    const vaultId = await as(mock, OWNER).createVault({
      owner_key: `02${"22".repeat(32)}`,
      policy: judgePolicy(session, RECOVERY, "auto_clawback"),
      deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
    });
    return {
      vaultId,
      owner: as(mock, OWNER),
      guardian: guardian(as(mock, GUARDIAN)),
      guardianAccount: GUARDIAN,
      watcher,
    };
  });
  const deps: PolicyScenarioDeps = {
    contract: CONTRACT,
    reader: mock,
    clock: { now: async () => mock.now() },
    // Moves chain time, then gives the guard's real timers a moment to run.
    sleep: async (ms) => {
      mock.advance(BigInt(ms) * 1_000_000n);
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    createVault,
    guardIntervalMs: 1,
  };
  return { mock, deps, createVault };
}

async function run(deps: PolicyScenarioDeps, release = false) {
  const lines: string[] = [];
  const results = await runScenarios(
    [
      {
        id: "S-6",
        name: "Policy Change",
        mandatory: false,
        run: (ctx) => runPolicy(ctx, deps),
      },
    ],
    { release, write: (line) => lines.push(line) },
  );
  return { lines, code: exitCode(results) };
}

describe("S-6 Policy Change", () => {
  it("refuses Script-bound and early changes, applies after the delay, and both vetoes land", async () => {
    const { mock, deps } = await fixture();
    const { lines, code } = await run(deps);
    expect(lines).toEqual([
      `  Vault 1: Guardian ${GUARDIAN} (auto_clawback) runs the Watcher's loosening guard`,
      "  Script-bound change rejected: ERR_SCRIPT_BOUND",
      "  Policy Change 1 proposed: Delay and Policy Change Delay from 1 to 2 minutes",
      "  Apply before the Policy Change Delay rejected: ERR_CHANGE_NOT_EFFECTIVE",
      expect.stringMatching(/^ {2}Waiting for the Policy Change Delay \(effective at \S+\)$/),
      `  Applied after the delay: get_vault shows delay_ns ${2n * MINUTE_NS}`,
      "  The guard left that change alone: it tightens the rules",
      "  Guardian vetoed Policy Change 2 (a lower Fee Cap)",
      "  Applying the vetoed change rejected: ERR_BAD_OP_STATE; get_policy_change reports vetoed",
      "  Policy Change 3 raises the Allowance limit with no Owner Confirmation; waiting up to 90 s for the guard",
      "  Unconfirmed loosening change auto-vetoed by the Guardian Watcher",
      "S-6 Policy Change PASS",
    ]);
    expect(code).toBe(0);

    const vault = await mock.getVault("1");
    expect(vault.policy.delay_ns).toBe((2n * MINUTE_NS).toString());
    expect(vault.policy.policy_change_delay_ns).toBe((2n * MINUTE_NS).toString());
    expect(vault.policy.fee_cap_sats).toBe("100000");
    expect(vault.policy.allowance_limit_sats).toBe("100000");
    expect(await mock.getPolicyChange("1")).toMatchObject({ state: "applied" });
    expect(await mock.getPolicyChange("2")).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    expect(await mock.getPolicyChange("3")).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
  });

  it("skips a contract that predates Policy Changes, sends nothing and exits 0", async () => {
    const createVault = vi.fn();
    const reader = new Proxy({} as ContractClient, {
      get: (_, prop) =>
        prop === "getPolicyChange"
          ? async () => {
              throw new ContractMethodNotFoundError(
                "Contract method is not found at block height 7",
              );
            }
          : () => {
              throw new Error(`unexpected call ${String(prop)}`);
            },
    });
    const { deps } = await fixture();
    const { lines, code } = await run({ ...deps, reader, createVault }, true);
    expect(lines).toEqual([`S-6 Policy Change SKIP (${CONTRACT} predates Policy Changes)`]);
    expect(code).toBe(0);
    expect(createVault).not.toHaveBeenCalled();
  });

  it("fails, naming the guard's last error, when the guard does not veto in 90 s", async () => {
    const { mock, deps } = await fixture({
      // The Guardian's own veto (change 2) works; every veto of the loosening change fails.
      guardian: (client) =>
        new Proxy(client, {
          get: (target, prop, receiver) =>
            prop === "vetoPolicyChange"
              ? async (changeId: string) => {
                  if (changeId === "3") throw new Error("NEAR RPC unreachable");
                  return target.vetoPolicyChange(changeId);
                }
              : (Reflect.get(target, prop, receiver) as unknown),
        }),
    });
    const { lines, code } = await run(deps);
    expect(lines.at(-1)).toBe(
      "S-6 Policy Change FAIL: Loosening change 3 not vetoed within 90 s; the guard's last error: NEAR RPC unreachable",
    );
    expect(lines).not.toContain(
      "  Unconfirmed loosening change auto-vetoed by the Guardian Watcher",
    );
    expect(code).toBe(1);
    expect(await mock.getPolicyChange("3")).toMatchObject({ state: "pending" });
  });

  it("fails when an early apply is not refused", async () => {
    const { deps } = await fixture();
    const created = deps.createVault;
    const { lines, code } = await run({
      ...deps,
      createVault: async () => {
        const vault = await created();
        const owner = new Proxy(vault.owner, {
          get: (target, prop, receiver) =>
            prop === "applyPolicyChange"
              ? async () => undefined
              : (Reflect.get(target, prop, receiver) as unknown),
        });
        return { ...vault, owner };
      },
    });
    expect(lines.at(-1)).toBe(
      "S-6 Policy Change FAIL: Applying before effective_at succeeded; expected ERR_CHANGE_NOT_EFFECTIVE",
    );
    expect(code).toBe(1);
  });
});

describe("hasPolicyChanges", () => {
  const reader = (getPolicyChange: () => Promise<never>) =>
    ({ getPolicyChange }) as unknown as ContractClient;

  it("is true when get_policy_change answers with a Morrow error", async () => {
    expect(await hasPolicyChanges(new MockContractClient())).toBe(true);
  });

  it("is false when the method does not exist", async () => {
    const missing = reader(async () => {
      throw new ContractMethodNotFoundError("Contract method is not found at block height 7");
    });
    expect(await hasPolicyChanges(missing)).toBe(false);
    const raw = reader(async () => {
      throw new Error("wasm execution failed with error: MethodResolveError(MethodNotFound)");
    });
    expect(await hasPolicyChanges(raw)).toBe(false);
  });

  it("throws any other failure instead of guessing", async () => {
    const down = reader(async () => {
      throw new Error("fetch failed");
    });
    await expect(hasPolicyChanges(down)).rejects.toThrow("fetch failed");
    expect(isMethodNotFound(new MorrowContractError("ERR_CHANGE_NOT_FOUND"))).toBe(false);
  });
});

describe("eventCount", () => {
  /** A contract with events 1..n, as `events_since` serves them. */
  const withEvents = (n: number) => {
    const eventsSince = vi.fn(async (cursor: string, limit: number) => {
      const events: MorrowEvent[] = [];
      for (let seq = Number(cursor) + 1; seq <= n && events.length < limit; seq++) {
        events.push({ seq: String(seq) } as MorrowEvent);
      }
      return events;
    });
    return { reader: { eventsSince } as unknown as ContractClient, eventsSince };
  };

  it("finds the latest seq without reading the whole history", async () => {
    for (const n of [0, 1, 2, 7, 100, 1_000, 12_345]) {
      const { reader, eventsSince } = withEvents(n);
      expect(await eventCount(reader)).toBe(BigInt(n));
      expect(eventsSince.mock.calls.length).toBeLessThanOrEqual(
        2 * Math.ceil(Math.log2(n + 2)) + 2,
      );
    }
  });
});

describe("judgePolicy", () => {
  it("keeps the Guardian a backup_device unless a kind is given", async () => {
    const session = {
      guardianKey: `02${"11".repeat(32)}`,
      guardianAccountId: GUARDIAN,
      watcher: await generateEnvelopeKeypair(),
    } as JudgeSession;
    expect(judgePolicy(session, RECOVERY).guardians[0]?.kind).toBe("backup_device");
    expect(judgePolicy(session, RECOVERY, "auto_clawback").guardians[0]?.kind).toBe(
      "auto_clawback",
    );
  });
});
