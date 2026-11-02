import { describe, expect, it } from "vitest";
import { createLogger, redact } from "./log.js";

describe("redact", () => {
  it("hides nested secrets and *_key fields; passes *public_key fields through", () => {
    expect(
      redact({
        round: 1,
        nested: { owner_key_secret: "aa", list: [{ admin_token: "t" }] },
        parent_key: "ed25519:parent",
        recovery_key: "11",
        guardian_key: "02ab",
        new_public_key: "ed25519:new",
        old_public_key: "ed25519:old",
      }),
    ).toEqual({
      round: 1,
      nested: { owner_key_secret: "[redacted]", list: [{ admin_token: "[redacted]" }] },
      parent_key: "[redacted]",
      recovery_key: "[redacted]",
      guardian_key: "[redacted]",
      new_public_key: "ed25519:new",
      old_public_key: "ed25519:old",
    });
  });

  it("applies to logger fields", () => {
    const lines: string[] = [];
    createLogger("t", (line) => lines.push(line))("info", "m", {
      owner_account_full_access_key: "ed25519:x",
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "info",
      msg: "m",
      owner_account_full_access_key: "[redacted]",
    });
  });
});
