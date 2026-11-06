import {
  MockContractClient,
  MorrowContractError,
  type ContractClient,
  type MorrowEvent,
} from "@morrow/core-ts";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_EVENT_COUNT,
  eventCount,
  findEvent,
  hasFastApproval,
  hasPolicyChanges,
  isMethodNotFound,
  readAfter,
  transient,
} from "./chain.js";

/** What near-api-js throws for a view of a method the contract does not have. */
class ContractMethodNotFoundError extends Error {
  override name = "ContractMethodNotFoundError";
}

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
  const withEvents = (n: number | bigint) => {
    const eventsSince = vi.fn(async (cursor: string, limit: number) => {
      const events: MorrowEvent[] = [];
      for (let seq = BigInt(cursor) + 1n; seq <= BigInt(n) && events.length < limit; seq++) {
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

  it("gives up at 2^32 events instead of searching without end", async () => {
    const { reader, eventsSince } = withEvents(MAX_EVENT_COUNT);
    await expect(eventCount(reader)).rejects.toThrow(`events_since reports ${MAX_EVENT_COUNT}`);
    expect(eventsSince).toHaveBeenCalledTimes(33);
    expect(await eventCount(withEvents(MAX_EVENT_COUNT - 1n).reader)).toBe(MAX_EVENT_COUNT - 1n);
  });
});

describe("hasFastApproval", () => {
  it("is the Policy Change probe: both features ship in the same deployment", () => {
    expect(hasFastApproval).toBe(hasPolicyChanges);
  });
});

describe("findEvent", () => {
  /** Events 1..n, every seventh a `fast_approved`. */
  const reader = (n: number) =>
    ({
      eventsSince: vi.fn(async (cursor: string, limit: number) => {
        const events: MorrowEvent[] = [];
        for (let seq = Number(cursor) + 1; seq <= n && events.length < limit; seq++) {
          events.push({
            seq: String(seq),
            kind: seq % 7 === 0 ? "fast_approved" : "op_signed",
          } as MorrowEvent);
        }
        return events;
      }),
    }) as unknown as ContractClient;

  it("finds the first matching event after the cursor, across pages", async () => {
    const r = reader(1_000);
    expect((await findEvent(r, 0n, (e) => e.kind === "fast_approved"))?.seq).toBe("7");
    expect((await findEvent(r, 7n, (e) => e.kind === "fast_approved"))?.seq).toBe("14");
    expect((await findEvent(r, 0n, (e) => e.seq === "250"))?.seq).toBe("250");
  });

  it("returns null at the end of the events, and after a bounded number of pages", async () => {
    expect(await findEvent(reader(5), 0n, (e) => e.kind === "fast_approved")).toBeNull();
    const many = reader(5_000);
    expect(await findEvent(many, 0n, (e) => e.seq === "4000")).toBeNull();
    expect(many.eventsSince).toHaveBeenCalledTimes(10);
  });
});

describe("readAfter", () => {
  const sleep = vi.fn(async () => undefined);

  it("retries transient failures and stale reads, then returns the last value", async () => {
    let n = 0;
    const read = async () => {
      n++;
      if (n === 1) throw new MorrowContractError("ERR_OP_NOT_FOUND");
      if (n === 2) throw new Error("fetch failed");
      return n;
    };
    expect(
      await readAfter(
        sleep,
        (_, w) => w(),
        "get_op",
        read,
        (v) => v >= 4,
      ),
    ).toBe(4);
    expect(
      await readAfter(
        sleep,
        (_, w) => w(),
        "get_op",
        async () => 0,
        () => false,
      ),
    ).toBe(0);
  });

  it("throws a refusal at once", async () => {
    const read = vi.fn(async () => {
      throw new MorrowContractError("ERR_UNAUTHORIZED");
    });
    await expect(
      readAfter(
        sleep,
        (_, w) => w(),
        "get_op",
        read,
        () => true,
      ),
    ).rejects.toThrow("ERR_UNAUTHORIZED");
    expect(read).toHaveBeenCalledTimes(1);
    expect(transient(new MorrowContractError("ERR_CHANGE_NOT_FOUND"))).toBe(true);
  });
});
