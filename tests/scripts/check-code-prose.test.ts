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
  "name-refs",
] as const;
const ROOTS = ["src", "tests", "scripts", "tui", "observer"] as const;
/** The labs root counts every kind but the two test-name kinds, each capped at 0 here. */
const LAB_CAPS = Object.fromEntries(
  KINDS.filter((kind) => kind !== "series-codes" && kind !== "name-refs").map((kind) => [kind, 0]),
);
const ROOT_SUFFIXES = ["", "-tests", "-scripts", "-tui", "-observer"] as const;
/** Kinds counted in src string literals only. */
const STRING_KINDS = [
  "string-em-dashes",
  "string-issue-refs",
  "string-slice",
  "string-rationale",
  "string-plural-s",
  "string-cua",
  "string-caps",
  "prompt-markers",
] as const;
/** A count named for its kind and root suffix: `caps` for src, `caps-tests` for the tests root. */
type Count =
  | `${(typeof KINDS)[number]}${(typeof ROOT_SUFFIXES)[number]}`
  | (typeof STRING_KINDS)[number]
  | "title-case-headers";

// The docs roots and their kinds, capped at 0 in every fixture here; check-doc-prose.test.ts
// covers what they count.
const DOC_ROOTS = ["docs", "site", "evidence"] as const;
const DOC_KINDS = [
  "issue-refs",
  "caps",
  "em-dashes",
  "invariant-refs",
  "authority",
  "honest",
  "archaeology",
  "contrast",
] as const;

/** A fixture scripts/caps.json: every count capped at 0 except the ones given, minus `omit`. */
function capsFile(caps: Partial<Record<Count, number>> = {}, omit: Count[] = []): string {
  const prose = Object.fromEntries([
    ...ROOTS.map((root, index) => [
      root,
      Object.fromEntries(
        [...KINDS, ...(root === "src" ? STRING_KINDS : [])].flatMap((kind) => {
          const count = `${kind}${ROOT_SUFFIXES[index]!}` as Count;
          return omit.includes(count) ? [] : [[kind, caps[count] ?? 0]];
        }),
      ),
    ]),
    ...DOC_ROOTS.map((root) => [root, Object.fromEntries(DOC_KINDS.map((kind) => [kind, 0]))]),
  ]);
  const titleCase: Count = "title-case-headers";
  const markdown = omit.includes(titleCase) ? {} : { [titleCase]: caps[titleCase] ?? 0 };
  return `${JSON.stringify({ prose: { ...prose, labs: LAB_CAPS, markdown } }, null, 2)}\n`;
}

/** Runs the checker over one fixture file (src/fixture.ts unless given) with a fixture
 *  scripts/caps.json, and returns its exit status and stdout. */
async function run(
  args: string[],
  source: string,
  file = "src/fixture.ts",
  caps = capsFile(),
): Promise<{ status: number; stdout: string }> {
  const cwd = await makeTestTempDir("humanish-prose-check-");
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), source);
  await mkdir(path.join(cwd, "scripts"), { recursive: true });
  await writeFile(path.join(cwd, "scripts", "caps.json"), caps);
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
  const root = ROOTS[ROOT_SUFFIXES.findLastIndex((suffix) => kind.endsWith(suffix))]!;
  const capPath = `prose.${root}.${kind.slice(0, kind.length - (root === "src" ? 0 : root.length + 1))}`;
  const header = lines.findIndex((line) => line.startsWith(`${capPath}: `));
  const after = lines.slice(header + 1);
  const listed = after.slice(
    0,
    after.findIndex((line) => !line.startsWith("  ")),
  );
  const count = Number(lines[header]!.slice(capPath.length + 2).split(" ")[0]);
  const words = listed.map((line) => line.split(" ").at(-1)!);
  return { count, words };
}

const laneHits = (source: string) => hitsOf("lane-comments", source);

/** The checker's exit status with every cap at 0 except the ones given. */
async function exitWith(caps: Partial<Record<Count, number>>, source: string) {
  return (await run([], source, undefined, capsFile(caps))).status;
}

describe("prose:check counts `lane` in comment prose", () => {
  it("counts `lane` and `lanes` as words, in any case and comment style", async () => {
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

  it("fails both above and below its `lane-comments` cap", async () => {
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

  it("fails both above and below its em-dashes cap", async () => {
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
    expect((await hitsOf("authority", source)).count).toBe(2);
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
      "// The invariants hold; a canonical path; a blocker; layered output.",
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
    expect((await hitsOf("name-refs-tests", source, file)).words).toEqual(["#123"]);
    expect((await hitsOf("issue-refs-tests", source, file)).count).toBe(0);
    expect((await hitsOf("caps-tests", source, file)).words).toEqual(["NOT"]);
    expect((await hitsOf("em-dashes-tests", source, file)).count).toBe(1);
  });
});

describe("prose:check reads its caps from scripts/caps.json", () => {
  it("fails a count with no cap, naming its path and today's count", async () => {
    const source = "// one \u2014 two\n// three -- four\n";
    const result = await run([], source, undefined, capsFile({}, ["em-dashes"]));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("prose.src.em-dashes: 2");
  });

  it("fails a cap for a count the checker no longer makes", async () => {
    const caps = JSON.parse(capsFile()) as { prose: Record<string, Record<string, number>> };
    caps.prose.src!["retired-kind"] = 0;
    const result = await run([], "// clean\n", undefined, JSON.stringify(caps));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Remove: prose.src.retired-kind");
  });

  it("exits 2 on a cap that is not a whole number", async () => {
    const caps = capsFile().replace('"caps": 0', '"caps": -1');
    expect((await run([], "// clean\n", undefined, caps)).status).toBe(2);
  });
});

describe("prose:check counts Title Case headers in the root markdown files", () => {
  it("counts a header of capitalized words, and skips sentence case and fenced code", async () => {
    const readme = [
      "# humanish",
      "## How It Works",
      "## Read the results",
      "### Library API",
      "```text",
      "## Exit Codes",
      "```",
      "## Release Status",
      "",
    ].join("\n");
    const { status, stdout } = await run(["--list"], readme, "README.md");
    const lines = stdout.split("\n");
    const header = lines.findIndex((line) =>
      line.startsWith("prose.markdown.title-case-headers: "),
    );
    expect(lines[header]).toBe("prose.markdown.title-case-headers: 2 (cap 0, over by 2)");
    expect(lines.slice(header + 1, header + 3)).toEqual([
      "  README.md:2 ## How It Works",
      "  README.md:8 ## Release Status",
    ]);
    expect(status).toBe(1);
  });
});

describe("prose:check counts prose in src strings apart from comments", () => {
  const source = [
    "// A comment \u2014 counted as a comment, never as a string.",
    'const a = "Stopped \u2014 the cap was reached (#581); fail closed.";',
    "const b = `Retry ${n} turn(s) in a later slice; the run is NOT ready.`;",
    'const c = "Rerun with `--max-usd 0 \u2014 turn(s)` to see it.";',
    "",
  ].join("\n");

  it("counts each string kind in literals and template text", async () => {
    const [dashes, refs, caps, slice, rationale, plural, commentDashes] = await Promise.all([
      hitsOf("string-em-dashes", source),
      hitsOf("string-issue-refs", source),
      hitsOf("string-caps", source),
      hitsOf("string-slice", source),
      hitsOf("string-rationale", source),
      hitsOf("string-plural-s", source),
      hitsOf("em-dashes", source),
    ]);

    expect(dashes.words).toEqual(["\u2014"]);
    expect(refs.words).toEqual(["#581"]);
    expect(caps.words).toEqual(["NOT"]);
    expect(slice.count).toBe(1);
    expect(rationale.count).toBe(1);
    expect(plural.words).toEqual(["n(s)"]);
    expect(commentDashes.count).toBe(1);
  });

  it("does not count CSS colors, HTML entities, http(s) or code spans", async () => {
    const markup = [
      'const css = "a{color:#111;border:1px solid #222}";',
      'const quote = "&#39;";',
      'const help = "Run `humanish run \u2014 later slice (#12)`.";',
      'const url = "a public http(s) URL";',
      "",
    ].join("\n");
    const [refs, dashes, slice, plural] = await Promise.all([
      hitsOf("string-issue-refs", markup),
      hitsOf("string-em-dashes", markup),
      hitsOf("string-slice", markup),
      hitsOf("string-plural-s", markup),
    ]);

    expect(refs.count).toBe(0);
    expect(dashes.count).toBe(0);
    expect(slice.count).toBe(0);
    expect(plural.count).toBe(0);
  });

  it("counts CUA as a word in strings, outside identifiers and code spans", async () => {
    const strings = [
      'const label = "CUA desktop";',
      'const code = "HUMANISH_CUA_LAB_FANOUT_INVALID";',
      'const help = "See `CUA` in the glossary.";',
      "",
    ].join("\n");
    const hits = await hitsOf("string-cua", strings);
    expect(hits.words).toEqual(["CUA"]);
  });

  it("counts strings only under src", async () => {
    const hits = await hitsOf("string-em-dashes", 'const a = "x \u2014 y";\n', "tests/fixture.ts");
    expect(hits.count).toBe(0);
  });

  it("skips the statement after a `prose-check: model prompt` comment, and nothing else", async () => {
    const prompted = [
      "// prose-check: model prompt (the participant model reads this)",
      'const prompt = "Reply with ONLY a JSON object \u2014 nothing else.";',
      'const message = "The run stopped \u2014 the cap was reached.";',
      "",
    ].join("\n");
    const [dashes, caps] = await Promise.all([
      hitsOf("string-em-dashes", prompted),
      hitsOf("string-caps", prompted),
    ]);

    expect(dashes.count).toBe(1);
    expect(caps.count).toBe(0);
  });

  it("counts each prompt marker, so a new exemption raises a cap", async () => {
    const marked = [
      "// prose-check: model prompt (the participant model reads this)",
      'const prompt = "Reply with JSON only.";',
      "",
    ].join("\n");
    const hits = await hitsOf("prompt-markers", marked);
    expect(hits.count).toBe(1);
    expect(await exitWith({ "prompt-markers": 1 }, marked)).toBe(0);
    expect(await exitWith({ "prompt-markers": 0 }, marked)).toBe(1);
  });

  it("does not count string literal types", async () => {
    const hits = await hitsOf(
      "string-rationale",
      'type Policy = "fail-closed" | "record-evidence";\nconst note = "the run fails closed";\n',
    );
    expect(hits.count).toBe(1);
  });

  it("fails both above and below the string-em-dashes cap", async () => {
    const others = {
      "em-dashes": 1,
      "string-issue-refs": 1,
      "string-caps": 1,
      "string-slice": 1,
      "string-rationale": 1,
      "string-plural-s": 1,
    } as const;
    expect(await exitWith({ ...others, "string-em-dashes": 1 }, source)).toBe(0);
    expect(await exitWith({ ...others, "string-em-dashes": 0 }, source)).toBe(1);
    expect(await exitWith({ ...others, "string-em-dashes": 2 }, source)).toBe(1);
  });
});

describe("prose:check reads the title and description of each lab", () => {
  /** The `prose.labs.<kind>` lines `--list` prints for one fixture lab file. */
  async function labHits(yaml: string): Promise<{ status: number; lines: string[] }> {
    const { status, stdout } = await run(["--list"], yaml, "humanish/labs/demo.yaml");
    return {
      status,
      lines: stdout.split("\n").filter((line) => line.includes("humanish/labs/demo.yaml")),
    };
  }

  it("counts each kind in a lab's title and description, with the field it came from", async () => {
    const { status, lines } = await labHits(
      [
        "schema: humanish.lab.v2",
        "id: demo",
        "title: The ONE study (#164)",
        "description: >-",
        "  It measures the honest answer \u2014 a seat per participant.",
        "mission: SAME as before, not counted",
        "",
      ].join("\n"),
    );

    expect(status).toBe(1);
    expect(lines).toEqual([
      "  humanish/labs/demo.yaml:3 title #164",
      "  humanish/labs/demo.yaml:3 title ONE",
      "  humanish/labs/demo.yaml:4 description \u2014",
      "  humanish/labs/demo.yaml:4 description seat",
      "  humanish/labs/demo.yaml:4 description honest",
    ]);
  });

  it("passes a lab whose title and description hold none of them", async () => {
    const { status, lines } = await labHits(
      [
        "schema: humanish.lab.v2",
        "id: demo",
        'title: "A demo study: one participant on a loopback app"',
        "description: Runs one participant against a loopback app as a dry run.",
        "",
      ].join("\n"),
    );

    expect(lines).toEqual([]);
    expect(status).toBe(0);
  });
});
