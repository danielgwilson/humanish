import { describe, expect, it } from "vitest";

import { normalizeCliArgv } from "../src/argv.js";

describe("CLI argv normalization", () => {
  it("supports pnpm script proof commands with a literal separator", () => {
    expect(normalizeCliArgv(["node", "humanish", "--", "--help"])).toEqual([
      "node",
      "humanish",
      "--help"
    ]);
  });

  it("leaves normal binary invocation arguments alone", () => {
    expect(normalizeCliArgv(["node", "humanish", "init", "--dry-run"])).toEqual([
      "node",
      "humanish",
      "init",
      "--dry-run"
    ]);
  });
});
