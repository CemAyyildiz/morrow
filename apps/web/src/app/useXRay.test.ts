import { describe, expect, it } from "vitest";
import { signedOp } from "./xray.fixture";
import { heldAfter, type HeldXRay } from "./useXRay";

describe("X-Ray read state", () => {
  const xray = signedOp();

  it("a good read holds the X-Ray, fresh", () => {
    expect(heldAfter(null, "a", { kind: "ok", xray }, 1_000)).toEqual({
      key: "a",
      state: { kind: "ok", xray, readAt: 1_000, now: 1_000, stale: false },
    });
  });

  it("a failed read after a good one keeps the data, marked stale", () => {
    const good = heldAfter(null, "a", { kind: "ok", xray }, 1_000);
    const after = heldAfter(good, "a", { kind: "unreachable" }, 11_000);
    expect(after.state).toEqual({ kind: "ok", xray, readAt: 1_000, now: 11_000, stale: true });
  });

  it("without data of the same target, the page says what failed", () => {
    const other: HeldXRay = heldAfter(null, "b", { kind: "ok", xray }, 1_000);
    expect(heldAfter(other, "a", { kind: "unreachable" }, 2_000).state).toEqual({
      kind: "unreachable",
    });
    expect(heldAfter(null, "a", { kind: "input", message: "No op 9" }, 2_000).state).toEqual({
      kind: "input",
      message: "No op 9",
    });
  });
});
