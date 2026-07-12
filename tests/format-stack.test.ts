import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { starterFiles } from "../src/init-templates.js";

describe("Humanish format stack", () => {
  it("documents the standard in the public project layout contract", async () => {
    const layout = await readFile("docs/architecture/project-layout.md", "utf8");

    expect(layout).toContain("## Humanish Format Stack");
    expect(layout).toContain("`.yaml` for human-authored Humanish source");
    expect(layout).toContain("Prefer `.yaml` over `.yml`");
    expect(layout).toContain("`.ts` for executable project integration");
    expect(layout).toContain("`.json` for generated machine artifacts and synthetic fixtures");
    expect(layout).toContain("`.ndjson` for appendable event or transcript streams");
    expect(layout).toContain("`.github/workflows/*.yml`");
    expect(layout).toContain("TOML is not part of the current Humanish stack");
  });

  it("scaffolds Humanish-owned authored source as .yaml, not .yml", () => {
    const authoredSourcePrefixes = [
      "humanish/personas/",
      "humanish/scenarios/",
      "humanish/labs/",
      "humanish/policies/",
      "humanish/review/"
    ];

    const authoredSourcePaths = starterFiles
      .map((file) => file.path)
      .filter((filePath) => authoredSourcePrefixes.some((prefix) => filePath.startsWith(prefix)));

    expect(authoredSourcePaths.length).toBeGreaterThan(0);
    expect(authoredSourcePaths.every((filePath) => filePath.endsWith(".yaml"))).toBe(true);
    expect(starterFiles.some((file) => file.path.endsWith(".yml"))).toBe(false);
    expect(starterFiles.some((file) => file.path === "humanish/config.ts")).toBe(true);
    expect(starterFiles.some((file) => file.path === "humanish/fixtures/synthetic-login-state.json")).toBe(true);
  });
});
