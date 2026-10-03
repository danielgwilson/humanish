// A deprecated alias or option promises its removal in a source comment, "// Removed in 0.109.0:".
// Once package.json reaches that version, this test names every promise still in the code, so a
// promised removal cannot slip into another release.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MARKER = /^\s*(?:\/\/|\*)\s*Removed in (\d+)\.(\d+)\.(\d+):/gm;
const ROOTS = ["src", "tui/src", "scripts"];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules")
      files.push(...(await sourceFiles(full)));
    else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const parts = (version: string): number[] => version.split(".").map(Number);
function atOrPast(version: string, marker: number[]): boolean {
  const have = parts(version);
  for (let index = 0; index < 3; index += 1)
    if (have[index] !== marker[index]) return have[index]! > marker[index]!;
  return true;
}

/** The markers in `text` whose version `version` has reached. */
function duePromises(text: string, version: string): string[] {
  return [...text.matchAll(MARKER)]
    .filter((match) => atOrPast(version, [match[1], match[2], match[3]].map(Number)))
    .map((match) => match[0].trim());
}

describe("removal promises in source comments", () => {
  it("reads a marker and compares it with the version", () => {
    const text =
      "  // Removed in 0.109.0: an alias\n * Removed in 1.0.0: another\nwas removed in 0.106.0";
    expect(duePromises(text, "0.108.4")).toEqual([]);
    expect(duePromises(text, "0.109.0")).toEqual(["// Removed in 0.109.0:"]);
    expect(duePromises(text, "1.2.0")).toHaveLength(2);
  });

  it("has none the package version has reached", async () => {
    const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const due: string[] = [];
    for (const root of ROOTS)
      for (const file of await sourceFiles(root))
        for (const marker of duePromises(await readFile(file, "utf8"), version))
          due.push(`${file}: ${marker}`);
    expect(due, `package.json is ${version}; delete what these promise`).toEqual([]);
  });
});
