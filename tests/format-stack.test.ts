import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { starterFiles } from "../src/init-templates.js";

describe("Mimetic format stack", () => {
  it("documents the standard in the public project layout contract", async () => {
    const layout = await readFile("docs/architecture/project-layout.md", "utf8");

    expect(layout).toContain("## Mimetic Format Stack");
    expect(layout).toContain("`.yaml` for human-authored Mimetic source");
    expect(layout).toContain("Prefer `.yaml` over `.yml`");
    expect(layout).toContain("`.ts` for executable project integration");
    expect(layout).toContain("`.json` for generated machine artifacts and fixtures");
    expect(layout).toContain("`.ndjson` for appendable event or transcript streams");
    expect(layout).toContain("`.github/workflows/*.yml`");
    expect(layout).toContain("TOML is not part of the current Mimetic stack");
  });

  it("scaffolds Mimetic-owned authored source as .yaml, not .yml", () => {
    const authoredSourcePrefixes = [
      "mimetic/personas/",
      "mimetic/scenarios/",
      "mimetic/policies/",
      "mimetic/review/"
    ];

    const authoredSourcePaths = starterFiles
      .map((file) => file.path)
      .filter((filePath) => authoredSourcePrefixes.some((prefix) => filePath.startsWith(prefix)));

    expect(authoredSourcePaths.length).toBeGreaterThan(0);
    expect(authoredSourcePaths.every((filePath) => filePath.endsWith(".yaml"))).toBe(true);
    expect(starterFiles.some((file) => file.path.endsWith(".yml"))).toBe(false);
    expect(starterFiles.some((file) => file.path === "mimetic/config.ts")).toBe(true);
    expect(starterFiles.some((file) => file.path === "mimetic/fixtures/synthetic-login-state.json")).toBe(true);
  });
});
