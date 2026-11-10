import { describe, expect, it } from "vitest";
import { ERROR_CODES, MorrowContractError } from "../contract/errors.js";
import type { PolicyChangeState, SpendOpState, VaultState } from "../contract/types.js";
import * as everything from "../index.js";
import {
  NETWORK_BUSY,
  changeStateLabel,
  executeErrorMessage,
  opStateLabel,
  vaultStateLabel,
  type DisplayMode,
} from "./mode.js";

describe("displayMode", () => {
  it.each([
    ["pending", "Pending", "Pending"],
    ["frozen", "Executing", "Executing"],
    ["signed", "Signed", "Signed"],
    ["cancelled", "Cancelled", "Pending"],
    ["voided", "Clawed back", "Pending"],
  ] as [SpendOpState, string, string][])("renders a %s request", (state, normal, duress) => {
    expect(opStateLabel(state, "normal")).toBe(normal);
    expect(opStateLabel(state, "duress")).toBe(duress);
  });

  it.each([
    ["pending_keys", "Pending keys", "Pending keys"],
    ["active", "Active", "Active"],
    ["clawed_back", "Clawed back", "Active"],
  ] as [VaultState, string, string][])("renders a %s Vault", (state, normal, duress) => {
    expect(vaultStateLabel(state, "normal")).toBe(normal);
    expect(vaultStateLabel(state, "duress")).toBe(duress);
  });

  it.each([
    ["pending", "Pending", "Pending"],
    ["applied", "Applied", "Applied"],
    ["vetoed", "Vetoed", "Pending"],
    ["withdrawn", "Withdrawn", "Withdrawn"],
  ] as [PolicyChangeState, string, string][])(
    "renders a %s Policy Change",
    (state, normal, duress) => {
      expect(changeStateLabel(state, "normal")).toBe(normal);
      expect(changeStateLabel(state, "duress")).toBe(duress);
    },
  );

  it.each([
    ["normal", new MorrowContractError("ERR_CLAWED_BACK"), ERROR_CODES.ERR_CLAWED_BACK],
    ["duress", new MorrowContractError("ERR_CLAWED_BACK"), NETWORK_BUSY],
    ["normal", new MorrowContractError("ERR_NOT_EXECUTABLE"), ERROR_CODES.ERR_NOT_EXECUTABLE],
    ["duress", new MorrowContractError("ERR_NOT_EXECUTABLE"), ERROR_CODES.ERR_NOT_EXECUTABLE],
    ["normal", new MorrowContractError("ERR_BAD_OP_STATE"), ERROR_CODES.ERR_BAD_OP_STATE],
    ["duress", new MorrowContractError("ERR_BAD_OP_STATE"), NETWORK_BUSY],
    ["duress", new Error("fetch failed"), "fetch failed"],
  ] as [DisplayMode, unknown, string][])(
    "shows a failed Execute in %s mode",
    (mode, error, message) => {
      expect(executeErrorMessage(error, mode)).toBe(message);
    },
  );

  it("shows an unknown state or code as itself", () => {
    for (const mode of ["normal", "duress"] as DisplayMode[]) {
      expect(opStateLabel("parked" as SpendOpState, mode)).toBe("parked");
      expect(vaultStateLabel("frozen" as VaultState, mode)).toBe("frozen");
      expect(changeStateLabel("queued" as PolicyChangeState, mode)).toBe("queued");
      const unknown = new MorrowContractError("ERR_NEW_THING" as never);
      expect(executeErrorMessage(unknown, mode)).toBe("ERR_NEW_THING");
    }
  });

  it("never names the Clawback in duress mode", () => {
    expect(NETWORK_BUSY).toBe("Network busy, try again later.");
    expect(NETWORK_BUSY).not.toMatch(/claw|duress|ERR_/i);
  });

  it("is exported from the package index", () => {
    expect(everything.opStateLabel).toBe(opStateLabel);
    expect(everything.executeErrorMessage).toBe(executeErrorMessage);
  });
});
