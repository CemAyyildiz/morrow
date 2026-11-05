import { describe, expect, it } from "vitest";
import { changeBinding } from "./binding.js";

describe("changeBinding", () => {
  const change = {
    vault_id: "7",
    change_id: "3",
    changes: { recovery_address: "tb1qnew", fee_cap_sats: "200000" },
    effective_at: "1793608920000000000",
  };

  it("changes when any bound field changes, not with the key order of the changes", () => {
    const base = changeBinding(change);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    for (const other of [
      { ...change, vault_id: "8" },
      { ...change, change_id: "4" },
      { ...change, effective_at: "1793608920000000001" },
      { ...change, changes: { ...change.changes, recovery_address: "tb1qnex" } },
      { ...change, changes: { ...change.changes, fee_cap_sats: "200001" } },
      { ...change, changes: { recovery_address: "tb1qnew" } },
      // "7" + "33" vs "73" + "3": the separators keep the fields apart.
      { ...change, vault_id: "73", change_id: "" },
    ]) {
      expect(changeBinding(other)).not.toBe(base);
    }
    const reordered = { fee_cap_sats: "200000", recovery_address: "tb1qnew" };
    expect(changeBinding({ ...change, changes: reordered })).toBe(base);
  });
});
