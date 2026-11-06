import {
  MIN_VAULT_STORAGE_YOCTO,
  MINUTE_NS,
  MockContractClient,
  MorrowContractError,
  generateEnvelopeKeypair,
  type ContractClient,
  type ProposePolicyChangeArgs,
} from "@morrow/core-ts";
import type { ChainClock } from "@morrow/watcher";
import { describe, expect, it, vi } from "vitest";
import { exitCode, runScenarios } from "../runner.js";
import { judgeGuardian, judgePolicy, type JudgeSession } from "../session.js";
import { runPolicy, type PolicyScenarioDeps } from "./s6-policy.js";

const OWNER = "owner.test.near";
const GUARDIAN = "guardian.test.near";
const WATCHER = "watcher.owner.test.near";
const RECOVERY = `bcrt1q${"q".repeat(38)}`;
const CONTRACT = "morrow-vault-dev3.testnet";
const ONE_MINUTE = MINUTE_NS.toString();
const TWO_MINUTES = (2n * MINUTE_NS).toString();

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

/** `client` with some of its methods replaced. */
function override(client: ContractClient, methods: Partial<ContractClient>): ContractClient {
  return new Proxy(client, {
    get: (target, prop, receiver) =>
      Object.hasOwn(methods, prop)
        ? methods[prop as keyof ContractClient]
        : (Reflect.get(target, prop, receiver) as unknown),
  });
}

/** What near-api-js throws for a view of a method the contract does not have. */
class ContractMethodNotFoundError extends Error {
  override name = "ContractMethodNotFoundError";
}

type Wrap = (client: ContractClient, mock: MockContractClient) => ContractClient;

interface FixtureOptions {
  /** Wrap the Owner's, the session Guardian's and the watcher's clients, or the reader. */
  owner?: Wrap;
  guardian?: Wrap;
  watcher?: Wrap;
  reader?: Wrap;
  clock?: (mock: MockContractClient) => ChainClock;
  rpcTimeoutMs?: number;
}

/**
 * S-6 against the mock contract: the session Guardian (`backup_device`) and the watcher's own
 * Guardian (`auto_clawback`), with a fake sleep that moves the mock's clock and a wall clock read
 * from it.
 */
async function fixture(options: FixtureOptions = {}) {
  const mock = new MockContractClient();
  const envelopeKey = await generateEnvelopeKeypair();
  const session = {
    guardianKey: `02${"11".repeat(32)}`,
    guardianAccountId: GUARDIAN,
    watcher: envelopeKey,
  } as JudgeSession;
  const wrap = (f: Wrap | undefined, client: ContractClient) => (f ? f(client, mock) : client);
  const createVault = vi.fn(async () => {
    const vaultId = await as(mock, OWNER).createVault({
      owner_key: `02${"22".repeat(32)}`,
      policy: judgePolicy(session, RECOVERY, [
        judgeGuardian(session),
        { guardian_key: `03${"33".repeat(32)}`, guardian_account: WATCHER, kind: "auto_clawback" },
      ]),
      deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
    });
    return {
      vaultId,
      owner: wrap(options.owner, as(mock, OWNER)),
      guardian: wrap(options.guardian, as(mock, GUARDIAN)),
      guardianAccount: GUARDIAN,
      watcher: wrap(options.watcher, as(mock, WATCHER)),
      watcherAccount: WATCHER,
      envelopeKey,
    };
  });
  const deps: PolicyScenarioDeps = {
    contract: CONTRACT,
    reader: wrap(options.reader, mock),
    clock: options.clock?.(mock) ?? { now: async () => mock.now() },
    // Moves chain time, then gives the guard's real timers a moment to run.
    sleep: async (ms) => {
      mock.advance(BigInt(ms) * 1_000_000n);
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    now: () => Number(mock.now() / 1_000_000n),
    createVault,
    guardIntervalMs: 1,
    rpcTimeoutMs: options.rpcTimeoutMs ?? 2_000,
  };
  return { mock, deps, createVault };
}

async function run(deps: PolicyScenarioDeps, release = false) {
  const lines: string[] = [];
  const results = await runScenarios(
    [{ id: "S-6", name: "Policy Change", mandatory: false, run: (ctx) => runPolicy(ctx, deps) }],
    { release, write: (line) => lines.push(line) },
  );
  return { lines, code: exitCode(results), result: lines.at(-1) };
}

/** The S-6 result line of a run that fails with `detail`. */
const failed = (detail: string) => `S-6 Policy Change FAIL: ${detail}`;

const AUTO_VETO = "  Unconfirmed loosening change auto-vetoed by the Guardian Watcher";

/** Owner client whose proposal of the loosening change is followed at once by `after`. */
const afterLoosening =
  (after: (mock: MockContractClient, changeId: string, envelope: string) => Promise<void>): Wrap =>
  (client, mock) =>
    override(client, {
      proposePolicyChange: async (args: ProposePolicyChangeArgs) => {
        const changeId = await client.proposePolicyChange(args);
        if ("allowance_limit_sats" in args.changes) await after(mock, changeId, args.envelope);
        return changeId;
      },
    });

describe("S-6 Policy Change", () => {
  it("refuses Script-bound and early changes, applies after the delay, and both vetoes land", async () => {
    const { mock, deps } = await fixture();
    const { lines, code } = await run(deps);
    expect(lines).toEqual([
      `  Vault 1: the Watcher's loosening guard runs as ${WATCHER} (auto_clawback); Guardian ${GUARDIAN} (backup_device) vetoes by hand`,
      "  Script-bound change rejected: ERR_SCRIPT_BOUND",
      "  Policy Change 1 proposed: Delay and Policy Change Delay from 1 to 2 minutes",
      "  Apply before the Policy Change Delay rejected: ERR_CHANGE_NOT_EFFECTIVE",
      expect.stringMatching(/^ {2}Waiting for the Policy Change Delay \(effective at \S+\)$/),
      `  Applied after the delay: get_vault shows delay_ns ${TWO_MINUTES}`,
      "  The guard left that change alone: it tightens the rules",
      "  Guardian vetoed Policy Change 2 (a lower Fee Cap)",
      "  Applying the vetoed change rejected: ERR_BAD_OP_STATE; get_policy_change reports vetoed",
      "  Policy Change 3 raises the Allowance limit with no Owner Confirmation; waiting up to 90 s for the guard",
      AUTO_VETO,
      "S-6 Policy Change PASS",
    ]);
    expect(code).toBe(0);

    const vault = await mock.getVault("1");
    expect(vault.policy.delay_ns).toBe(TWO_MINUTES);
    expect(vault.policy.policy_change_delay_ns).toBe(TWO_MINUTES);
    expect(vault.policy.fee_cap_sats).toBe("100000");
    expect(vault.policy.allowance_limit_sats).toBe("100000");
    expect(await mock.getPolicyChange("1")).toMatchObject({ state: "applied" });
    expect(await mock.getPolicyChange("2")).toMatchObject({ state: "vetoed", vetoed_by: GUARDIAN });
    expect(await mock.getPolicyChange("3")).toMatchObject({ state: "vetoed", vetoed_by: WATCHER });
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

  it("fails naming the guard entry and its last error when the guard does not veto in 90 s", async () => {
    const { mock, deps } = await fixture({
      watcher: (client) =>
        override(client, {
          vetoPolicyChange: async () => {
            throw new Error("NEAR RPC unreachable");
          },
        }),
    });
    const { lines, code, result } = await run(deps);
    expect(result).toBe(
      failed(
        "Loosening change 3 not vetoed within 90 s; guard entry: scheduled; last error: NEAR RPC unreachable",
      ),
    );
    expect(lines).not.toContain(AUTO_VETO);
    expect(code).toBe(1);
    expect(await mock.getPolicyChange("3")).toMatchObject({ state: "pending" });
  });

  it("fails when the session Guardian, not the watcher, vetoes the loosening change", async () => {
    const { deps } = await fixture({
      owner: afterLoosening(async (mock, changeId) => {
        await as(mock, GUARDIAN)
          .vetoPolicyChange(changeId)
          .catch(() => undefined);
      }),
    });
    const { result } = await run(deps);
    expect(result).toBe(
      failed(`Loosening change 3 is vetoed by ${GUARDIAN}, expected vetoed by ${WATCHER}`),
    );
  });

  it("fails at once when the loosening change leaves pending some other way", async () => {
    const { mock, deps } = await fixture({
      owner: afterLoosening(async (mock, changeId, envelope) => {
        await as(mock, OWNER).vetoPolicyChange(changeId, envelope);
      }),
    });
    const before = mock.now();
    const { result } = await run(deps);
    expect(result).toBe(failed(`Loosening change 3 is withdrawn, expected vetoed by ${WATCHER}`));
    expect(mock.now() - before).toBeLessThan(5n * MINUTE_NS);
  });

  it("fails when the watcher's veto is on chain but the guard store does not show it", async () => {
    // Someone vetoes as the watcher account behind the guard's back.
    const { deps } = await fixture({
      owner: afterLoosening(async (mock, changeId) => {
        await as(mock, WATCHER).vetoPolicyChange(changeId);
      }),
    });
    const { result } = await run(deps);
    expect(result).toMatch(
      new RegExp(
        `^S-6 Policy Change FAIL: Change 3 is vetoed by ${WATCHER}, but the guard has it as `,
      ),
    );
    expect(result).not.toContain("as vetoed");
  });

  it("fails when a Script-bound change is accepted, or refused with another code", async () => {
    const accepting = await fixture({
      owner: (client) =>
        override(client, {
          proposePolicyChange: async (args: ProposePolicyChangeArgs) =>
            "escape_timelock_blocks" in args.changes ? "99" : client.proposePolicyChange(args),
        }),
    });
    expect((await run(accepting.deps)).result).toBe(
      failed("A Script-bound change succeeded; expected ERR_SCRIPT_BOUND"),
    );
    const otherCode = await fixture({
      owner: (client) =>
        override(client, {
          // Only the Script-bound proposal gets the wrong code; the rest go through.
          proposePolicyChange: async (args: ProposePolicyChangeArgs) => {
            if (!("escape_timelock_blocks" in args.changes))
              return client.proposePolicyChange(args);
            throw new MorrowContractError("ERR_POLICY_BOUNDS");
          },
        }),
    });
    expect((await run(otherCode.deps)).result).toBe(failed("ERR_POLICY_BOUNDS"));
  });

  it("fails when an early apply is not refused", async () => {
    const { deps } = await fixture({
      owner: (client) => override(client, { applyPolicyChange: async () => undefined }),
    });
    expect((await run(deps)).result).toBe(
      failed("Applying before effective_at succeeded; expected ERR_CHANGE_NOT_EFFECTIVE"),
    );
  });

  it("fails after a bounded number of retries when the apply stays refused as early", async () => {
    const applies = vi.fn(async () => {
      throw new MorrowContractError("ERR_CHANGE_NOT_EFFECTIVE");
    });
    const { deps } = await fixture({
      owner: (client) => override(client, { applyPolicyChange: applies }),
    });
    expect((await run(deps)).result).toBe(failed("ERR_CHANGE_NOT_EFFECTIVE"));
    // One early apply, then the first try after the wait and 20 retries.
    expect(applies).toHaveBeenCalledTimes(22);
  });

  it("refuses a Policy Change Delay wait over 5 minutes", async () => {
    const { deps } = await fixture({
      clock: (mock) => ({ now: async () => mock.now() - 10n * MINUTE_NS }),
    });
    expect((await run(deps)).result).toMatch(
      /^S-6 Policy Change FAIL: Policy Change 1 is effective in \d+ s, beyond the 5-minute bound$/,
    );
  });

  it.each(["delay_ns", "policy_change_delay_ns"] as const)(
    "fails when get_vault does not show the new %s",
    async (field) => {
      const { deps } = await fixture({
        reader: (client) =>
          override(client, {
            getVault: async (vaultId: string) => {
              const vault = await client.getVault(vaultId);
              return { ...vault, policy: { ...vault.policy, [field]: ONE_MINUTE } };
            },
          }),
      });
      expect((await run(deps)).result).toBe(
        failed(`get_vault shows ${field} ${ONE_MINUTE}, expected ${TWO_MINUTES}`),
      );
    },
  );

  it("fails when the guard treats a tightening change as loosening", async () => {
    // The guard reads a 3-minute Delay, so the change to 2 minutes looks like a lower Delay.
    const { deps } = await fixture({
      reader: (client) =>
        override(client, {
          getVault: async (vaultId: string) => {
            const vault = await client.getVault(vaultId);
            return { ...vault, policy: { ...vault.policy, delay_ns: (3n * MINUTE_NS).toString() } };
          },
        }),
    });
    expect((await run(deps)).result).toMatch(
      /^S-6 Policy Change FAIL: The guard (vetoed|scheduled a veto of) tightening change 1$/,
    );
  });

  it("fails when the apply of a vetoed change succeeds", async () => {
    const { deps } = await fixture({
      owner: (client) =>
        override(client, {
          applyPolicyChange: async (changeId: string) =>
            changeId === "2" ? undefined : client.applyPolicyChange(changeId),
        }),
    });
    expect((await run(deps)).result).toBe(
      failed("Applying a vetoed change succeeded; expected ERR_BAD_OP_STATE"),
    );
  });

  it("fails when the Guardian's veto does not leave the change vetoed", async () => {
    const { deps } = await fixture({
      guardian: (client) => override(client, { vetoPolicyChange: async () => undefined }),
    });
    expect((await run(deps)).result).toBe(
      failed(`get_policy_change reports pending, expected vetoed by ${GUARDIAN}`),
    );
  });

  it("retries a lagging read after a transaction and tolerates a failed poll", async () => {
    const flaky = { proposed: 0, vault: 0, poll: 0 };
    const { deps } = await fixture({
      reader: (client, mock) =>
        override(client, {
          getPolicyChange: async (changeId: string) => {
            const change = await client.getPolicyChange(changeId);
            // The first read of a fresh change, and the first read of the guard's veto, fail.
            if (changeId === "1" && flaky.proposed++ === 0) {
              throw new MorrowContractError("ERR_CHANGE_NOT_FOUND");
            }
            if (changeId === "3" && change.state === "vetoed" && flaky.poll++ === 0) {
              throw new Error("ECONNRESET");
            }
            return change;
          },
          getVault: async (vaultId: string) => {
            const vault = await client.getVault(vaultId);
            const applied =
              (await mock.getPolicyChange("1").catch(() => null))?.state === "applied";
            // The first read after the apply still shows the old Policy.
            if (applied && flaky.vault++ === 0) {
              return { ...vault, policy: { ...vault.policy, delay_ns: ONE_MINUTE } };
            }
            return vault;
          },
        }),
    });
    const { result } = await run(deps);
    expect(result).toBe("S-6 Policy Change PASS");
    expect(flaky.proposed).toBeGreaterThan(1);
    expect(flaky.vault).toBeGreaterThan(1);
    expect(flaky.poll).toBeGreaterThan(1);
  });

  it("puts a time limit on each RPC call", async () => {
    const { deps } = await fixture({
      rpcTimeoutMs: 50,
      reader: (client) =>
        override(client, { getPolicyChange: () => new Promise<never>(() => undefined) }),
    });
    expect((await run(deps)).result).toBe(failed("get_policy_change timed out after 50 ms"));
  });
});

describe("judgePolicy", () => {
  it("has only the session Guardian, a backup_device, unless Guardians are given", async () => {
    const session = {
      guardianKey: `02${"11".repeat(32)}`,
      guardianAccountId: GUARDIAN,
      watcher: await generateEnvelopeKeypair(),
    } as JudgeSession;
    expect(judgePolicy(session, RECOVERY).guardians).toEqual([
      { guardian_key: session.guardianKey, guardian_account: GUARDIAN, kind: "backup_device" },
    ]);
    const watcher = {
      guardian_key: `03${"33".repeat(32)}`,
      guardian_account: WATCHER,
      kind: "auto_clawback" as const,
    };
    expect(judgePolicy(session, RECOVERY, [judgeGuardian(session), watcher]).guardians).toEqual([
      judgeGuardian(session),
      watcher,
    ]);
  });
});
