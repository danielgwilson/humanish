import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { makeTestTempDir } from "../helpers/temp-dir.js";

const SCRIPT = path.resolve("scripts/check-code-prose.mjs");
const KINDS = [
  "issue-refs",
  "fix-tags",
  "caps",
  "lane-comments",
  "em-dashes",
  "invariant-refs",
  "authority",
  "archaeology",
  "seat-comments",
  "cua-route",
  "honest",
  "history",
  "series-codes",
] as const;
const ROOT_SUFFIXES = ["", "-tests", "-scripts", "-tui"] as const;
type Count = `${(typeof KINDS)[number]}${(typeof ROOT_SUFFIXES)[number]}`;

/** Runs the checker over one fixture file (src/fixture.ts unless given) and returns its exit status
 *  and stdout. */
async function run(
  args: string[],
  source: string,
  file = "src/fixture.ts",
): Promise<{ status: number; stdout: string }> {
  const cwd = await makeTestTempDir("humanish-prose-check-");
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), source);
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
  kind: Count,
  source: string,
  file?: string,
): Promise<{ count: number; words: string[] }> {
  const { stdout } = await run(["--list"], source, file);
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
async function exitWith(caps: Partial<Record<Count, number>>, source: string) {
  const flags = ROOT_SUFFIXES.flatMap((suffix) =>
    KINDS.map((kind) => `--max-${kind}${suffix}=${caps[`${kind}${suffix}`] ?? 0}`),
  );
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

describe("prose:check counts all-caps runs and issue references", () => {
  it("counts a hyphenated caps word and a one-digit issue reference", async () => {
    const source = "// The LOAD-BEARING check stays.\n// Forward-declared (PR #2).\n";

    const caps = await hitsOf("caps", source);
    const refs = await hitsOf("issue-refs", source);

    expect(caps.words).toEqual(["LOAD-BEARING"]);
    expect(refs.words).toEqual(["#2"]);
    expect(caps.count + refs.count).toBe(2);
  });

  it("counts a caps part inside a mixed compound once", async () => {
    const hits = await hitsOf("caps", "// An operator-DECLARED origin, NOT the observed one.\n");

    expect(hits.words).toEqual(["operator-DECLARED", "NOT"]);
  });

  it("does not count compounds whose caps parts are all acronyms, paths, placeholders or code", async () => {
    const hits = await hitsOf(
      "caps",
      [
        "// JSON-RPC over an E2B-desktop, read as UTF-8 by the CLI.",
        "// The path /lobby/CODE and the placeholder <PORT>.",
        "// Code spans: `LOAD-BEARING`, `NOT`.",
        "// TODO(#12) stays a link.",
        "",
      ].join("\n"),
    );
    const refs = await hitsOf("issue-refs", "// TODO(#12) stays a link.\n");

    expect(hits.words).toEqual([]);
    expect(refs.count).toBe(0);
  });
});

describe("prose:check counts invariant numbers, authority words and review labels", () => {
  it("counts each kind once per match, in any case", async () => {
    const source = [
      "// Fails closed (invariant 6); see Invariant 5 too.",
      "// The load-bearing check follows the doctrine and the canonical form.",
      "// A red-team finding, blocker 2, the goal packet and safety contract item 4.",
      "// Shipped in this slice as layer 6.",
      "",
    ].join("\n");

    // `--list` prints each hit's last word, so `invariant 6` reads back as `6`.
    expect((await hitsOf("invariant-refs", source)).words).toEqual(["6", "5"]);
    expect((await hitsOf("authority", source)).count).toBe(3);
    expect((await hitsOf("archaeology", source)).words).toEqual([
      "red-team",
      "2",
      "packet",
      "4",
      "slice",
      "6",
    ]);
  });

  it("does not count code spans or words that only contain the pattern", async () => {
    const source = [
      "// Code spans: `invariant 6`, `load-bearing`, `this slice`.",
      "// The invariants hold; a canonicalized path; a blocker; layered output.",
      "",
    ].join("\n");

    for (const kind of ["invariant-refs", "authority", "archaeology"] as const) {
      expect((await hitsOf(kind, source)).count).toBe(0);
    }
  });

  it("holds the word kinds to their caps from both sides", async () => {
    const source = "// The seat is honest, as it used to be on the cua route.\n";
    const caps = { "seat-comments": 1, honest: 1, history: 1, "cua-route": 1 };
    expect(await exitWith(caps, source)).toBe(0);
    expect(await exitWith({ ...caps, honest: 0 }, source)).toBe(1);
    expect(await exitWith({ ...caps, history: 2 }, source)).toBe(1);
  });
});

describe("prose:check reads every root and counts test names", () => {
  it("counts a comment under tests/ against the -tests flag", async () => {
    const file = "tests/fixture.test.ts";

    expect((await hitsOf("caps-tests", "// NOT here\n", file)).count).toBe(1);
    expect((await hitsOf("caps", "// NOT here\n", file)).count).toBe(0);
  });

  it("reads it, describe and test names like comments, and series codes in names only", async () => {
    const source = [
      "// L14: a comment that opens with a code is not a test name.",
      'describe("L14: refuses a bad flag (#123)", () => {',
      '  it.each([1])("returns NOT %i", () => {});',
      '  test(`W5. keeps ${"x"} \u2014 the order`, () => {});',
      '  const label = "L2: a plain string";',
      "});",
      "",
    ].join("\n");
    const file = "tests/fixture.test.ts";

    expect((await hitsOf("series-codes-tests", source, file)).words).toEqual(["L14:", "W5."]);
    expect((await hitsOf("issue-refs-tests", source, file)).words).toEqual(["#123"]);
    expect((await hitsOf("caps-tests", source, file)).words).toEqual(["NOT"]);
    expect((await hitsOf("em-dashes-tests", source, file)).count).toBe(1);
  });
});

describe("prose:check needs a cap for every count", () => {
  it("fails when a count has no --max flag, naming the flag and today's count", async () => {
    const flags = ROOT_SUFFIXES.flatMap((suffix) => KINDS.map((kind) => `${kind}${suffix}`))
      .filter((count) => count !== "em-dashes")
      .map((count) => `--max-${count}=0`);
    const result = await run(flags, "// one \u2014 two\n// three -- four\n");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--max-em-dashes=2");
  });
});
