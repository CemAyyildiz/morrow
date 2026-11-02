import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("package seed", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toMatch(/^@morrow\//);
  });
});
