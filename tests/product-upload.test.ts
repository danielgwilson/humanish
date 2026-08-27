import { describe, expect, it } from "vitest";

import { parseLabConfig } from "../src/lab-config.js";

function lab(product: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "humanish.lab.v2",
    id: "upload-lab",
    subject: { source: "terminal-product", product: { name: "humanish", publicSurfaces: ["https://example.com/x"], ...product } },
    actors: [{ type: "codex-exec", mission: "study it" }],
    execution: { target: "e2b-terminal" },
    scenario: { mode: "dry-run" }
  };
}

describe("subject.product.upload — meeting a build that is not published yet", () => {
  it("accepts a project-relative file", () => {
    const parsed = parseLabConfig(lab({ upload: "humanish-0.57.0.tgz", install: "npm i -g \"$HUMANISH_PRODUCT_UPLOAD\"" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.subject.product?.upload).toBe("humanish-0.57.0.tgz");
  });

  it("refuses to climb out of the project", () => {
    // This reads a file off the operator's disk and puts it on a machine an autonomous agent is
    // about to drive. "../../.ssh/id_rsa" is the reason the rule is a rule.
    for (const bad of ["../secrets.tgz", "a/../../b.tgz", "/etc/passwd", "C:\\keys.tgz"]) {
      const parsed = parseLabConfig(lab({ upload: bad, install: "true" }));
      expect(parsed.ok, `${bad} must be refused`).toBe(false);
      if (!parsed.ok) expect(parsed.error.message).toContain("subject.product.upload");
    }
  });

  it("refuses an empty path rather than treating it as absent", () => {
    const parsed = parseLabConfig(lab({ upload: "   ", install: "true" }));
    expect(parsed.ok).toBe(false);
  });

  it("stays optional — every existing terminal lab parses unchanged", () => {
    const parsed = parseLabConfig(lab({ install: "true" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.subject.product?.upload).toBeUndefined();
  });
});
