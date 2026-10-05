import { describe, expect, it } from "vitest";

import { invocationFor } from "../../src/cli/invocation.js";

describe("the invocation suggested commands use, by where humanish is installed", () => {
  it("names npx in a project, so a stale global humanish is not what runs", () => {
    expect(invocationFor({ kind: "project", up: 0, manager: "npm" }, "1.2.3")).toBe("npx humanish");
    expect(invocationFor({ kind: "other", unmanagedCwd: false }, "1.2.3")).toBe("npx humanish");
  });

  it("pins the running version for a one-shot run, so the next command runs the same CLI", () => {
    expect(invocationFor({ kind: "one-shot", unmanagedCwd: false }, "1.2.3")).toBe(
      "npx humanish@1.2.3",
    );
  });

  it("uses the bare name where humanish is on the search path", () => {
    expect(invocationFor({ kind: "global", manager: "npm" }, "1.2.3")).toBe("humanish");
    expect(invocationFor({ kind: "checkout" }, "1.2.3")).toBe("humanish");
  });
});
