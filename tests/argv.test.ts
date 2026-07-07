import { describe, expect, it } from "vitest";

import { normalizeCliArgv } from "../src/argv.js";

describe("CLI argv normalization", () => {
  it("supports pnpm script proof commands with a literal separator", () => {
    expect(normalizeCliArgv(["node", "homun", "--", "--help"])).toEqual([
      "node",
      "homun",
      "--help"
    ]);
  });

  it("leaves normal binary invocation arguments alone", () => {
    expect(normalizeCliArgv(["node", "homun", "init", "--dry-run"])).toEqual([
      "node",
      "homun",
      "init",
      "--dry-run"
    ]);
  });
});
