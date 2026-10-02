import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { makeTestTempDir } from "../helpers/temp-dir.js";

const SCRIPT = path.resolve("scripts/check-code-prose.mjs");
const KINDS = ["issue-refs", "fix-tags", "caps", "lane-comments", "em-dashes"] as const;

/** Runs the checker over one fixture file in src/ and returns its exit status and stdout. */
async function run(args: string[], source: string): Promise<{ status: number; stdout: string }> {
  const cwd = await makeTestTempDir("humanish-prose-check-");
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "fixture.ts"), source);
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, stdout: failed.stdout };
  }
}

/** One kind's hits, from `--list`. */
async function hitsOf(
  kind: "lane-comments" | "em-dashes",
  source: string,
): Promise<{ count: number; words: string[] }> {
  const { stdout } = await run(["--list"], source);
  const lines = stdout.split("\n");
  const header = lines.findIndex((line) => line.startsWith(`${kind}: `));
  const after = lines.slice(header + 1);
  const listed = after.slice(
    0,
    after.findIndex((line) => !line.startsWith("  ")),
  );
  const count = Number(lines[header]!.slice(kind.length + 2).split(" ")[0]);
  const words = listed.map((line) => line.split(" ").at(-1)!);
  return { count, words };
}

const laneHits = (source: string) => hitsOf("lane-comments", source);

/** The checker's exit status with every cap at 0 except the ones given. */
async function exitWith(caps: Partial<Record<(typeof KINDS)[number], number>>, source: string) {
  const flags = KINDS.map((kind) => `--max-${kind}=${caps[kind] ?? 0}`);
  return (await run(flags, source)).status;
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
    const source = "// one lane\n// another lane\n";
    expect(await exitWith({ "lane-comments": 2 }, source)).toBe(0);
    expect(await exitWith({ "lane-comments": 1 }, source)).toBe(1);
    expect(await exitWith({ "lane-comments": 3 }, source)).toBe(1);
  });
});

describe("prose:check counts em dashes in comment prose", () => {
  it("counts the em dash and a spaced double hyphen in any comment style", async () => {
    const hits = await hitsOf(
      "em-dashes",
      [
        "// The run stops \u2014 the desktop is gone.",
        "/** One step -- then the next\u2014and the last. */",
        "const x = 1; // trailing -- dash",
        "",
      ].join("\n"),
    );

    expect(hits.words).toEqual(["\u2014", "--", "\u2014", "--"]);
    expect(hits.count).toBe(4);
  });

  it("does not count flags, rules, code spans, strings or a lint directive's separator", async () => {
    const hits = await hitsOf(
      "em-dashes",
      [
        "// Pass --count 2, or --participants lane-01.",
        "// ---- section ----",
        "// Code spans: `pnpm run api:proof -- --update`, `a \u2014 b`.",
        "// oxlint-disable-next-line no-unsafe-finally -- the reason the rule is off",
        'const label = "a \u2014 b -- c";',
        "",
      ].join("\n"),
    );

    expect(hits.words).toEqual([]);
    expect(hits.count).toBe(0);
  });

  it("counts a dash in a lint directive's reason", async () => {
    const hits = await hitsOf(
      "em-dashes",
      "// eslint-disable-next-line no-console -- the reason -- with a dash\n",
    );

    expect(hits.count).toBe(1);
  });

  it("fails both above and below --max-em-dashes", async () => {
    const source = "// one \u2014 two\n// three -- four\n";
    expect(await exitWith({ "em-dashes": 2 }, source)).toBe(0);
    expect(await exitWith({ "em-dashes": 1 }, source)).toBe(1);
    expect(await exitWith({ "em-dashes": 3 }, source)).toBe(1);
  });
});

describe("prose:check needs a cap for every count", () => {
  it("fails when a count has no --max flag, naming the flag and today's count", async () => {
    const flags = KINDS.filter((kind) => kind !== "em-dashes").map((kind) => `--max-${kind}=0`);
    const result = await run(flags, "// one \u2014 two\n// three -- four\n");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--max-em-dashes=2");
  });
});
