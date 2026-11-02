import { describe, expect, it } from "vitest";
import { ERROR_CODES, EVENT_KINDS, MockContractClient, type ContractClient } from "@morrow/core-ts";

describe("@morrow/core-ts from another workspace package", () => {
  it("resolves the frozen interface and the mock with types", () => {
    const client: ContractClient = new MockContractClient();
    expect(typeof client.eventsSince).toBe("function");
    expect(EVENT_KINDS).toContain("withdrawal_requested");
    expect(ERROR_CODES.ERR_CLAWED_BACK).toMatch(/clawed back/);
  });
});
