import { describe, expect, it } from "vitest";

import { normalizeCliArgv } from "../src/argv.js";

describe("CLI argv normalization", () => {
  it("supports pnpm script proof commands with a literal separator", () => {
    expect(normalizeCliArgv(["node", "mimetic", "--", "--help"])).toEqual([
      "node",
      "mimetic",
      "--help"
    ]);
  });

  it("leaves normal binary invocation arguments alone", () => {
    expect(normalizeCliArgv(["node", "mimetic", "init", "--dry-run"])).toEqual([
      "node",
      "mimetic",
      "init",
      "--dry-run"
    ]);
  });
});
