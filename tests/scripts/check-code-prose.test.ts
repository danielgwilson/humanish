import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { makeTestTempDir } from "../helpers/temp-dir.js";

const SCRIPT = path.resolve("scripts/check-code-prose.mjs");

/** Runs the checker over one fixture file in src/ and returns its lane-comments hits. */
async function laneHits(source: string): Promise<{ count: number; words: string[] }> {
  const cwd = await makeTestTempDir("humanish-prose-check-");
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "fixture.ts"), source);
  const output = execFileSync(process.execPath, [SCRIPT, "--list"], { cwd, encoding: "utf8" });
  const section = output.slice(output.indexOf("lane-comments:"));
  const count = Number(/^lane-comments: (\d+)/.exec(section)?.[1]);
  const words = [...section.matchAll(/^ {2}src\/fixture\.ts:\d+ (\S+)$/gm)].map(
    (match) => match[1]!,
  );
  return { count, words };
}

describe("prose:check counts lane in comment prose", () => {
  it("counts lane and lanes as words, in any case and comment style", async () => {
    const hits = await laneHits(
      [
        "// Each lane runs its own desktop.",
        "/** Lanes share nothing; a per-lane cap applies to the lane's loop. */",
        "const x = 1; // the LANE ends here",
        "",
      ].join("\n"),
    );

    expect(hits.words).toEqual(["lane", "Lanes", "lane", "lane", "LANE"]);
    expect(hits.count).toBe(5);
  });

  it("does not count the contract spellings, code spans, identifiers or code", async () => {
    const hits = await laneHits(
      [
        "// Declared in actors[0].lanes as lanes[] entries, rerun with --lanes lane-02,lane-04.",
        "// Ids default to lane-01..lane-NN; the topology is per-lane-worlds.",
        "// Code spans: `lanes`, `the lane`, `laneFocus`.",
        "// Identifiers: laneId, laneCount, multilane, lanesCount.",
        'const label = "lane";',
        "",
      ].join("\n"),
    );

    expect(hits.words).toEqual([]);
    expect(hits.count).toBe(0);
  });

  it("fails both above and below --max-lane-comments", async () => {
    const cwd = await makeTestTempDir("humanish-prose-cap-");
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "fixture.ts"), "// one lane\n// another lane\n");
    const run = (cap: number) => {
      try {
        execFileSync(process.execPath, [SCRIPT, `--max-lane-comments=${cap}`], { cwd });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };

    expect(run(2)).toBe(0);
    expect(run(1)).toBe(1);
    expect(run(3)).toBe(1);
  });
});
