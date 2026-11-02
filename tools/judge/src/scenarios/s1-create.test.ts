import { describe, expect, it } from "vitest";
import { judgeAccountId } from "./s1-create.js";

describe("judgeAccountId", () => {
  it("is a valid, unique-looking testnet account id", () => {
    const id = judgeAccountId(1_762_070_400_000, 0.123456789);
    expect(id).toMatch(/^morrow-judge-[a-z0-9]+-[a-z0-9]{1,6}\.testnet$/);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(judgeAccountId(1, 0.5)).not.toBe(judgeAccountId(2, 0.5));
  });
});
