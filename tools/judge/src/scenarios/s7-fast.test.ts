import {
  MIN_VAULT_STORAGE_YOCTO,
  MINUTE_NS,
  MockContractClient,
  MorrowContractError,
  generateEnvelopeKeypair,
  type ContractClient,
  type Guardian,
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
  contactKind?: Guardian["kind"];
  guardianKind?: Guardian["kind"];
}

/** Time between the withdrawal request and the approval, so the two cannot be confused. */
const BEFORE_APPROVAL_NS = 30_000_000_000n;

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
          { ...judgeGuardian(session), kind: options.guardianKind ?? "backup_device" },
          {
            guardian_key: `03${"33".repeat(32)}`,
            guardian_account: CONTACT,
            kind: options.contactKind ?? "trusted_contact",
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
      // The Trusted Contact approves 30 s after the request.
      contact: wrap(
        options.contact,
        override(as(mock, CONTACT), {
          fastApprove: async (opId: string) => {
            mock.advance(BEFORE_APPROVAL_NS);
            return as(mock, CONTACT).fastApprove(opId);
          },
        }),
      ),
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

/** Options whose reader shows `change(op)` for every `get_op` after the contact's approval. */
function afterApproval(change: (op: SpendOp) => SpendOp): FixtureOptions {
  let approved = false;
  return {
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
          return approved ? change(op) : op;
        },
      }),
  };
}

/** A reader whose `events_since` passes each event through `map`. */
const mapEvents =
  (map: (event: MorrowEvent) => MorrowEvent | MorrowEvent[]): Wrap =>
  (client) =>
    override(client, {
      eventsSince: async (cursor: string, limit: number) =>
        (await client.eventsSince(cursor, limit)).flatMap(map),
    });

/** `op.executable_at` moved by `ns`. */
const shifted = (op: SpendOp, ns: bigint): SpendOp => ({
  ...op,
  executable_at: (BigInt(op.executable_at ?? "0") + ns).toString(),
});

const POLICY_MISMATCH = "Vault 1 does not have the S-7 Fast Approval Policy";

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
      "  Contract froze the transaction 508 s before the original Delay would have ended",
      expect.stringMatching(/^ {2}Input 0 co-signed by the NEAR MPC network in \S+ s$/),
      `  Bitcoin transaction ${TXID} confirmed; destination received 500,000 sats`,
      "S-7 Fast Approval PASS",
    ]);
    expect(code).toBe(0);
    expect(broadcasts.map((op) => op.state)).toEqual(["signed"]);
    const op = await mock.getOp("1");
    // Approval time + the Floor, not request time + the Floor.
    expect(BigInt(op.executable_at!) - BigInt(op.created_at)).toBe(BEFORE_APPROVAL_NS + MINUTE_NS);
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

  it.each([
    [
      "a Delay other than 10 minutes",
      { policy: { ...S7_POLICY, delay_ns: (9n * MINUTE_NS).toString() } },
    ],
    [
      "a Floor other than 1 minute",
      { policy: { ...S7_POLICY, fast_approval_floor_ns: (2n * MINUTE_NS).toString() } },
    ],
    ["a contact that is not a Trusted Contact", { contactKind: "backup_device" }],
    ["a Backup Device that is a Trusted Contact", { guardianKind: "trusted_contact" }],
  ] as [string, FixtureOptions][])("fails on a Vault with %s", async (_, options) => {
    const { deps } = await fixture(options);
    expect((await run(deps)).result).toBe(failed(POLICY_MISMATCH));
  });

  it("fails when executable_at is not one Delay after the request", async () => {
    const { deps } = await fixture({
      reader: (client) =>
        override(client, {
          getOp: async (opId: string) => {
            const op = await client.getOp(opId);
            return { ...op, created_at: (BigInt(op.created_at) + 1n).toString() };
          },
        }),
    });
    expect((await run(deps)).result).toBe(
      failed("Withdrawal 1 is not executable one Delay after its request"),
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
    const { deps } = await fixture(afterApproval((op) => shifted(op, -1n)));
    expect((await run(deps)).result).toMatch(
      /^S-7 Fast Approval FAIL: executable_at \S+ is below the Fast Approval Floor \(approval time \+ 1 minute = \S+\)$/,
    );
  });

  it("fails when the new executable_at is 6 s above approval time + the Floor", async () => {
    const { deps } = await fixture(afterApproval((op) => shifted(op, 6_000_000_000n)));
    expect((await run(deps)).result).toMatch(
      /^S-7 Fast Approval FAIL: executable_at \S+ is not approval time \+ the Fast Approval Floor \(\S+\)$/,
    );
  });

  it("fails when the fast_approved event and get_op disagree on executable_at", async () => {
    const { deps } = await fixture({
      reader: mapEvents((e) =>
        e.kind === "fast_approved"
          ? {
              ...e,
              data: { ...e.data, executable_at: (BigInt(e.data.executable_at) + 1n).toString() },
            }
          : e,
      ),
    });
    expect((await run(deps)).result).toMatch(
      /^S-7 Fast Approval FAIL: The fast_approved event has executable_at \d+, get_op has \d+$/,
    );
  });

  it("fails when the fast_approved event names another approver", async () => {
    const { deps } = await fixture({
      reader: mapEvents((e) =>
        e.kind === "fast_approved" ? { ...e, data: { ...e.data, by: "stranger.test.near" } } : e,
      ),
    });
    expect((await run(deps)).result).toBe(
      failed("Withdrawal 1 was fast-approved by stranger.test.near"),
    );
  });

  it("finds this withdrawal's events when another op's come first", async () => {
    // Each fast_approved and op_frozen of op 1 is preceded by one of op 99 that would fail S-7.
    const { deps } = await fixture({
      reader: mapEvents((e) => {
        if (e.kind === "fast_approved" && e.data.op_id === "1") {
          const data = { ...e.data, op_id: "99", by: "stranger.test.near", executable_at: "1" };
          return [{ ...e, block_timestamp: "1", data }, e];
        }
        if (e.kind === "op_frozen" && e.data.op_id === "1") {
          return [{ ...e, block_timestamp: "1", data: { ...e.data, op_id: "99" } }, e];
        }
        return e;
      }),
    });
    expect((await run(deps)).result).toBe("S-7 Fast Approval PASS");
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

  it("fails when the withdrawal froze before its lowered executable_at", async () => {
    const { deps } = await fixture({
      reader: mapEvents((e) =>
        e.kind === "op_frozen"
          ? { ...e, block_timestamp: (BigInt(e.block_timestamp) - 3_000_000_000n).toString() }
          : e,
      ),
    });
    expect((await run(deps)).result).toMatch(
      /^S-7 Fast Approval FAIL: Withdrawal 1 froze at \S+, before its executable_at \S+$/,
    );
  });

  it("fails when the op is not signed before the broadcast", async () => {
    const { deps, broadcasts } = await fixture({
      reader: (client) =>
        override(client, {
          getOp: async (opId: string) => {
            const op = await client.getOp(opId);
            return op.state === "signed" ? { ...op, state: "frozen" } : op;
          },
        }),
    });
    expect((await run(deps)).result).toBe(failed("Op 1 is frozen, expected signed"));
    expect(broadcasts).toEqual([]);
  });

  it("fails when the destination is paid the wrong amount", async () => {
    const { deps } = await fixture({ bitcoin: { received: async () => 499_999n } });
    expect((await run(deps)).result).toBe(failed("Destination received 499999 sats"));
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
