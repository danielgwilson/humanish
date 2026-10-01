import { describe, expect, it } from "vitest";

import { starterFiles } from "../../src/lab/init-templates.js";

describe("humanish format stack", () => {
  it("scaffolds humanish-owned authored source as .yaml, not .yml", () => {
    const authoredSourcePrefixes = ["humanish/personas/", "humanish/scenarios/", "humanish/labs/"];

    const authoredSourcePaths = starterFiles
      .map((file) => file.path)
      .filter((filePath) => authoredSourcePrefixes.some((prefix) => filePath.startsWith(prefix)));

    expect(authoredSourcePaths.length).toBeGreaterThan(0);
    expect(authoredSourcePaths.every((filePath) => filePath.endsWith(".yaml"))).toBe(true);
    expect(starterFiles.some((file) => file.path.endsWith(".yml"))).toBe(false);
  });
});
