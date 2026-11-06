import {
  MIN_VAULT_STORAGE_YOCTO,
  MINUTE_NS,
  MockContractClient,
  MorrowContractError,
  generateEnvelopeKeypair,
  type ContractClient,
  type MorrowEvent,
  type Policy,
  type SpendOp,
} from "@morrow/core-ts";
import type { ChainClock } from "@morrow/watcher";
import { describe, expect, it, vi } from "vitest";
import { exitCode, runScenarios } from "../runner.js";
import { judgeGuardian, judgePolicy, type JudgeSession } from "../session.js";
import { runFast, type FastBitcoin, type FastScenarioDeps } from "./s7-fast.js";

const OWNER = "owner.test.near";
const GUARDIAN = "guardian.test.near";
const CONTACT = "contact.owner.test.near";
const RECOVERY = `bcrt1q${"q".repeat(38)}`;
const DESTINATION = `bcrt1q${"p".repeat(38)}`;
const CONTRACT = "morrow-vault-dev3.testnet";
const TXID = "cd".repeat(32);
const S7_POLICY: Partial<Policy> = {
  fast_approval: true,
  delay_ns: (10n * MINUTE_NS).toString(),
  policy_change_delay_ns: (10n * MINUTE_NS).toString(),
  fast_approval_floor_ns: MINUTE_NS.toString(),
};

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
  owner?: Wrap;
  guardian?: Wrap;
  contact?: Wrap;
  reader?: Wrap;
  clock?: (mock: MockContractClient) => ChainClock;
  bitcoin?: Partial<FastBitcoin>;
  policy?: Partial<Policy>;
}

/**
 * S-7 against the mock contract, with fake regtest (one 0.01 BTC coin, a broadcast that pays the
 * destination) and a fake sleep that moves the mock's clock.
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
  const broadcasts: SpendOp[] = [];
  const bitcoin: FastBitcoin = {
    fund: async (_address, sats) => [{ txid: "ab".repeat(32), vout: 0, value_sats: String(sats) }],
    newAddress: async () => DESTINATION,
    broadcast: async (op) => {
      broadcasts.push(op);
      return TXID;
    },
    received: async (address, txid) =>
      address === DESTINATION && txid === TXID && broadcasts.length > 0
        ? BigInt(broadcasts[0]!.amount_sats)
        : 0n,
    ...options.bitcoin,
  };
  const createVault = vi.fn(async () => {
    const vaultId = await as(mock, OWNER).createVault({
      owner_key: `02${"22".repeat(32)}`,
      policy: judgePolicy(
        session,
        RECOVERY,
        [
          judgeGuardian(session),
          {
            guardian_key: `03${"33".repeat(32)}`,
            guardian_account: CONTACT,
            kind: "trusted_contact",
          },
        ],
        options.policy ?? S7_POLICY,
      ),
      deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
    });
    return {
      vaultId,
      owner: wrap(options.owner, as(mock, OWNER)),
      guardian: wrap(options.guardian, as(mock, GUARDIAN)),
      guardianAccount: GUARDIAN,
      contact: wrap(options.contact, as(mock, CONTACT)),
      contactAccount: CONTACT,
      envelopeKey,
      bitcoin,
    };
  });
  const deps: FastScenarioDeps = {
    contract: CONTRACT,
    reader: wrap(options.reader, mock),
    clock: options.clock?.(mock) ?? { now: async () => mock.now() },
    sleep: async (ms) => {
      mock.advance(BigInt(ms) * 1_000_000n);
    },
    createVault,
    rpcTimeoutMs: 2_000,
  };
  return { mock, deps, createVault, broadcasts };
}

async function run(deps: FastScenarioDeps, release = false) {
  const lines: string[] = [];
  const results = await runScenarios(
    [{ id: "S-7", name: "Fast Approval", mandatory: false, run: (ctx) => runFast(ctx, deps) }],
    { release, write: (line) => lines.push(line) },
  );
  return { lines, code: exitCode(results), result: lines.at(-1) };
}

const failed = (detail: string) => `S-7 Fast Approval FAIL: ${detail}`;
const refuse = (code: ConstructorParameters<typeof MorrowContractError>[0]) => async () => {
  throw new MorrowContractError(code);
};

describe("S-7 Fast Approval", () => {
  it("refuses the Backup Device and the Owner, approves down to the Floor, executes early and pays", async () => {
    const { mock, deps, broadcasts } = await fixture();
    const { lines, code } = await run(deps);
    expect(lines).toEqual([
      `  Vault 1: Delay 10 minutes, Fast Approval Floor 1 minute; Trusted Contact ${CONTACT}, Backup Device ${GUARDIAN}`,
      expect.stringMatching(
        /^ {2}Withdrawal 1 requested: executable at \S+, after the 10-minute Delay$/,
      ),
      "  Backup Device fast_approve rejected: ERR_NOT_TRUSTED_CONTACT",
      "  Owner fast_approve rejected: ERR_UNAUTHORIZED",
      "  Fast-approved by the Trusted Contact: the Delay now ends at the Fast Approval Floor",
      "  Execute before the Fast Approval Floor rejected: ERR_NOT_EXECUTABLE",
      expect.stringMatching(/^ {2}Waiting for the Fast Approval Floor \(executable at \S+\)$/),
      "  Contract froze the transaction 538 s before the original Delay would have ended",
      expect.stringMatching(/^ {2}Input 0 co-signed by the NEAR MPC network in \S+ s$/),
      `  Bitcoin transaction ${TXID} confirmed; destination received 500,000 sats`,
      "S-7 Fast Approval PASS",
    ]);
    expect(code).toBe(0);
    expect(broadcasts.map((op) => op.state)).toEqual(["signed"]);
    const op = await mock.getOp("1");
    expect(BigInt(op.executable_at!) - BigInt(op.created_at)).toBe(MINUTE_NS);
  });

  it("skips a contract that predates Fast Approval, sends nothing and exits 0", async () => {
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
    expect(lines).toEqual([`S-7 Fast Approval SKIP (${CONTRACT} predates Fast Approval)`]);
    expect(code).toBe(0);
    expect(createVault).not.toHaveBeenCalled();
  });

  it("fails on a Vault without the S-7 Fast Approval Policy", async () => {
    const { deps } = await fixture({ policy: { ...S7_POLICY, fast_approval: false } });
    expect((await run(deps)).result).toBe(
      failed("Vault 1 does not have the S-7 Fast Approval Policy"),
    );
  });

  it("fails when the Backup Device's approval is accepted, or refused with another code", async () => {
    const accepting = await fixture({
      guardian: (client) => override(client, { fastApprove: async () => undefined }),
    });
    expect((await run(accepting.deps)).result).toBe(
      failed("The Backup Device's fast_approve succeeded; expected ERR_NOT_TRUSTED_CONTACT"),
    );
    const other = await fixture({
      guardian: (client) => override(client, { fastApprove: refuse("ERR_UNAUTHORIZED") }),
    });
    expect((await run(other.deps)).result).toBe(failed("ERR_UNAUTHORIZED"));
  });

  it("fails when the Owner's approval is accepted, or refused with another code", async () => {
    const accepting = await fixture({
      owner: (client) => override(client, { fastApprove: async () => undefined }),
    });
    expect((await run(accepting.deps)).result).toBe(
      failed("The Owner's fast_approve succeeded; expected ERR_UNAUTHORIZED"),
    );
    const other = await fixture({
      owner: (client) => override(client, { fastApprove: refuse("ERR_NOT_TRUSTED_CONTACT") }),
    });
    expect((await run(other.deps)).result).toBe(failed("ERR_NOT_TRUSTED_CONTACT"));
  });

  it("fails when the Trusted Contact's approval does not lower executable_at", async () => {
    const { deps } = await fixture({
      contact: (client) => override(client, { fastApprove: async () => undefined }),
    });
    expect((await run(deps)).result).toMatch(
      /^S-7 Fast Approval FAIL: fast_approve did not lower executable_at \(still \S+\)$/,
    );
  });

  it("fails when the new executable_at is below approval time + the Floor", async () => {
    let approved = false;
    const { deps } = await fixture({
      contact: (client) =>
        override(client, {
          fastApprove: async (opId: string) => {
            await client.fastApprove(opId);
            approved = true;
          },
        }),
      reader: (client) =>
        override(client, {
          getOp: async (opId: string) => {
            const op = await client.getOp(opId);
            if (!approved || op.executable_at === null) return op;
            return { ...op, executable_at: (BigInt(op.executable_at) - 1n).toString() };
          },
        }),
    });
    expect((await run(deps)).result).toMatch(
      /^S-7 Fast Approval FAIL: executable_at \S+ is below the Fast Approval Floor \(approval time \+ 1 minute = \S+\)$/,
    );
  });

  it("fails when the new executable_at is well above approval time + the Floor", async () => {
    let approved = false;
    const { deps } = await fixture({
      contact: (client) =>
        override(client, {
          fastApprove: async (opId: string) => {
            await client.fastApprove(opId);
            approved = true;
          },
        }),
      reader: (client) =>
        override(client, {
          getOp: async (opId: string) => {
            const op = await client.getOp(opId);
            if (!approved || op.executable_at === null) return op;
            return { ...op, executable_at: (BigInt(op.executable_at) + MINUTE_NS).toString() };
          },
        }),
    });
    expect((await run(deps)).result).toMatch(
      /^S-7 Fast Approval FAIL: executable_at \S+ is not approval time \+ the Fast Approval Floor/,
    );
  });

  it("fails when an Execute before the new executable_at is not refused", async () => {
    const { deps } = await fixture({
      owner: (client) =>
        override(client, { beginExecute: async (opId: string) => client.getOp(opId) }),
    });
    expect((await run(deps)).result).toBe(
      failed("Execute before the new executable_at succeeded; expected ERR_NOT_EXECUTABLE"),
    );
  });

  it("fails after a bounded number of retries when Execute stays refused as early", async () => {
    const executes = vi.fn(refuse("ERR_NOT_EXECUTABLE"));
    const { deps } = await fixture({
      owner: (client) => override(client, { beginExecute: executes }),
    });
    expect((await run(deps)).result).toBe(failed("ERR_NOT_EXECUTABLE"));
    // One early Execute, then the first try after the wait and 20 retries.
    expect(executes).toHaveBeenCalledTimes(22);
  });

  it("refuses a Floor wait over 5 minutes", async () => {
    const { deps } = await fixture({
      clock: (mock) => ({ now: async () => mock.now() - 10n * MINUTE_NS }),
    });
    expect((await run(deps)).result).toMatch(
      /^S-7 Fast Approval FAIL: Withdrawal 1 is executable in \d+ s, beyond the 5-minute bound$/,
    );
  });

  it("fails when the withdrawal did not freeze before the original executable_at", async () => {
    const { deps } = await fixture({
      reader: (client) =>
        override(client, {
          eventsSince: async (cursor: string, limit: number) =>
            (await client.eventsSince(cursor, limit)).map((e: MorrowEvent) =>
              e.kind === "op_frozen"
                ? {
                    ...e,
                    block_timestamp: (BigInt(e.block_timestamp) + 10n * MINUTE_NS).toString(),
                  }
                : e,
            ),
        }),
    });
    expect((await run(deps)).result).toMatch(
      /^S-7 Fast Approval FAIL: Withdrawal 1 froze at \S+, not before the original executable_at \S+$/,
    );
  });

  it("fails when the destination is not paid", async () => {
    const { deps } = await fixture({ bitcoin: { received: async () => 0n } });
    expect((await run(deps)).result).toBe(failed("Destination received 0 sats"));
  });

  it("puts a time limit on each RPC call", async () => {
    const { deps } = await fixture({
      reader: (client) => override(client, { getOp: () => new Promise<never>(() => undefined) }),
    });
    expect((await run({ ...deps, rpcTimeoutMs: 50 })).result).toBe(
      failed("get_op timed out after 50 ms"),
    );
  });
});
