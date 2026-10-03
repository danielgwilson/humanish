// The v2-to-v3 converter. Every committed lab converts to a study that parses, takes the same route
// and plans the same; every comment survives or is reported; what it cannot convert as written it
// refuses.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, parseDocument, visit } from "yaml";

import { parseLabConfig } from "../../src/study/config.js";
import { planLab } from "../../src/study/plan.js";
import { routeOf } from "../../src/study/routing.js";
import { convertStudyText } from "../../src/study/convert.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function convert(text: string) {
  const result = convertStudyText(text, ROOT);
  if (!result.ok) throw new Error(result.reason);
  return result.conversion;
}

function refusal(text: string): string {
  const result = convertStudyText(text, ROOT);
  if (result.ok) throw new Error("converted");
  return result.reason;
}

// Every comment line in a YAML text, trimmed and sorted.
function commentsOf(text: string): string[] {
  const doc = parseDocument(text);
  const found: string[] = [doc.commentBefore ?? "", doc.comment ?? ""];
  visit(doc, (_key, node) => {
    if (typeof node === "object" && node !== null) {
      const commented = node as { commentBefore?: string | null; comment?: string | null };
      found.push(commented.commentBefore ?? "", commented.comment ?? "");
    }
  });
  return found
    .flatMap((comment) => comment.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("every committed lab", () => {
  it("converts to a v3 study that parses, takes the same route and plans the same", async () => {
    // The 21 v2 files this repo committed before its studies moved to humanish/studies.
    const dir = path.join(ROOT, "tests", "fixtures", "labs-v2");
    const names = (await readdir(dir)).filter((name) => name.endsWith(".yaml")).sort();
    expect(names).toHaveLength(21);
    const dropped: Record<string, string[]> = {};
    for (const name of names) {
      const text = await readFile(path.join(dir, name), "utf8");
      const conversion = convert(text);
      const v2 = parseLabConfig(parse(text));
      const v3 = parseLabConfig(parse(conversion.text));
      if (!v2.ok || !v3.ok) throw new Error(`${name} did not parse`);
      expect(v3.config.schema, name).toBe("humanish.study.v3");
      expect(routeOf(v3.config), name).toBe(routeOf(v2.config));
      for (const dryRun of [true, false]) {
        expect(plain(planLab(v3.config, { cwd: ROOT, dryRun })), name).toEqual(
          plain(planLab(v2.config, { cwd: ROOT, dryRun })),
        );
      }
      // Every comment is in the study, or reported with the key it sat on.
      const reported = conversion.dropped.flatMap((key) => (key.comments ?? "").split("\n"));
      expect([...commentsOf(conversion.text), ...reported.filter(Boolean)].sort(), name).toEqual(
        commentsOf(text),
      );
      if (conversion.dropped.length > 0) dropped[name] = conversion.dropped.map((key) => key.path);
    }
    expect(dropped).toEqual({
      "first-contact.yaml": ["execution.timeoutMs"],
      "handed-a-human-surface.yaml": ["execution.timeoutMs"],
      "last-mile.yaml": ["execution.timeoutMs"],
      "terminal-product-demo.yaml": ["execution.timeoutMs"],
    });
  });
});

describe("the conversion", () => {
  it("moves each key with its comments and places route, mode, participants and caps", () => {
    const source = [
      "schema: humanish.lab.v2",
      "id: demo",
      "description: A demo.",
      "# the subject",
      "subject:",
      "  source: app-url",
      "  appUrl: http://127.0.0.1:3000/",
      "actors:",
      "  # the one actor",
      "  - type: openai-computer-use",
      "    # three people",
      "    lanes:",
      "      - id: a # first",
      "      - id: b",
      "execution:",
      "  target: e2b-desktop",
      "  # spend cap",
      "  caps:",
      "    maxUsd: 2 # two dollars",
      "# how it runs",
      "scenario:",
      "  # live run",
      "  mode: live",
      "",
    ].join("\n");
    const conversion = convert(source);
    expect(conversion.text).toBe(
      [
        "schema: humanish.study.v3",
        "id: demo",
        "description: A demo.",
        "route: computer-use",
        "# how it runs",
        "# live run",
        "mode: live",
        "# the subject",
        "subject:",
        "  source: app-url",
        "  appUrl: http://127.0.0.1:3000/",
        "actor:",
        "  # the one actor",
        "  type: openai-computer-use",
        "# three people",
        "participants:",
        "  - id: a # first",
        "  - id: b",
        "# spend cap",
        "caps:",
        "  maxUsd: 2 # two dollars",
        "execution:",
        "  target: e2b-desktop",
        "",
      ].join("\n"),
    );
    expect(conversion.moved).toEqual([
      { from: "actors[0]", to: "actor" },
      { from: "actors[0].lanes", to: "participants" },
      { from: "execution.caps", to: "caps" },
      { from: "scenario.mode", to: "mode" },
    ]);
  });

  it("reports each dropped key with its value and comment", () => {
    const conversion = convert(
      [
        "schema: humanish.lab.v2",
        "id: demo",
        "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000/' }",
        "actors:",
        "  - type: openai-computer-use",
        "execution: { target: e2b-desktop }",
        "review:",
        "  # not read yet",
        "  scoring: rubric-v1",
        "personas:",
        "  - id: someone",
        "",
      ].join("\n"),
    );
    // A key is reported before the keys nested in it, so its report holds theirs.
    expect(conversion.dropped).toEqual([
      { path: "personas", value: [{ id: "someone" }] },
      { path: "review.scoring", value: "rubric-v1", comments: "not read yet" },
    ]);
    expect(conversion.text).not.toContain("review");
    expect(conversion.text).not.toContain("personas");
  });

  it("writes the scripted count as surfaces", () => {
    const conversion = convert(
      [
        "schema: humanish.lab.v2",
        "id: demo",
        "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000' }",
        "actors:",
        "  - type: scripted-browser",
        "    count: 2 # desktop and mobile",
        "scenario: { ref: scripted-first-run }",
        "",
      ].join("\n"),
    );
    expect(conversion.text).toContain("surfaces: [desktop, mobile] # desktop and mobile");
    expect(conversion.text).toContain("scenario: scripted-first-run");
  });

  it("writes count with laneFocus as { count, instruction }, and roster groups as entries", () => {
    const focused = convert(
      [
        "schema: humanish.lab.v2",
        "id: demo",
        "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000/' }",
        "actors:",
        "  - type: openai-computer-use",
        "    count: 3",
        "    laneFocus: { id: ignored, instruction: Try the export. }",
        "execution: { target: e2b-desktop }",
        "",
      ].join("\n"),
    );
    expect(parse(focused.text).participants).toEqual({ count: 3, instruction: "Try the export." });
    expect(focused.dropped).toEqual([{ path: "actors[0].laneFocus.id", value: "ignored" }]);

    const grouped = convert(
      [
        "schema: humanish.lab.v2",
        "id: demo",
        "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000/' }",
        "actors:",
        "  - type: openai-computer-use",
        "    roster:",
        "      - { id: new, count: 2, persona: synthetic-new-user }",
        "execution: { target: e2b-desktop }",
        "",
      ].join("\n"),
    );
    expect(parse(grouped.text).participants).toEqual([
      { id: "new", count: 2, persona: "synthetic-new-user" },
    ]);
  });
});

describe("quoted counts", () => {
  // v2 reads a quoted count as a number, and so must the v3 file.
  it.each([
    ["a count", ['    count: "2"'], 2],
    [
      "a count with laneFocus",
      ['    count: "2"', "    laneFocus: { instruction: Try it. }"],
      { count: 2, instruction: "Try it." },
    ],
    [
      "a roster group's count",
      ["    roster:", '      - { id: new, count: "2" }'],
      [{ id: "new", count: 2 }],
    ],
  ])("writes %s given as a string as a number", (_name, actor, participants) => {
    const source = [
      "schema: humanish.lab.v2",
      "id: demo",
      "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000/' }",
      "actors:",
      "  - type: openai-computer-use",
      ...actor,
      "execution: { target: e2b-desktop }",
      "",
    ].join("\n");
    expect(parse(convert(source).text).participants).toEqual(participants);
  });
});

describe("comments the conversion could lose", () => {
  it("keeps or reports comments in dropped keys, replaced lists and emptied sections", () => {
    const source = [
      "schema: humanish.lab.v2",
      "id: demo",
      "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000/' }",
      "actors:",
      "  - type: openai-computer-use",
      "    count: 2",
      "    laneFocus:",
      "      instruction: Try the export.",
      "      # focus tail",
      "  # actor tail",
      "execution:",
      "  # completion timeout rationale",
      "  completionTimeoutMs: 1000",
      "  target: e2b-desktop",
      "personas:",
      "  - id: somebody # preserve this rationale",
      "# scenario note",
      "scenario: {}",
      "defaults: { open: true }",
      "",
    ].join("\n");
    const conversion = convert(source);
    const reported = conversion.dropped.flatMap((key) => (key.comments ?? "").split("\n"));
    expect([...commentsOf(conversion.text), ...reported.filter(Boolean)].sort()).toEqual(
      commentsOf(source),
    );
    expect(conversion.dropped).toEqual([
      { path: "personas", value: [{ id: "somebody" }], comments: "preserve this rationale" },
      {
        path: "execution.completionTimeoutMs",
        value: 1000,
        comments: "completion timeout rationale",
      },
    ]);
    expect(conversion.text).toContain("# scenario note\ndefaults:");
    expect(conversion.text).not.toContain("# completion timeout rationale\n  target");
  });

  // A comment on a section's own line belongs to its mapping, which an emptied section takes away.
  it.each([
    ["scenario", ["scenario: # keep this study note", "  {}"]],
    ["valueless scenario", ["scenario: # keep this study note"]],
    [
      "valueless laneFocus",
      [
        "actors:",
        "  - type: openai-computer-use",
        "    count: 2",
        "    laneFocus: # keep this study note",
      ],
    ],
    [
      "laneFocus",
      [
        "actors:",
        "  - type: openai-computer-use",
        "    count: 2",
        "    laneFocus: # keep this study note",
        "      {}",
      ],
    ],
  ])("keeps the comment on an empty %s section's line", (_name, lines) => {
    const actor = lines[0] === "actors:" ? [] : ["actors:", "  - type: openai-computer-use"];
    const source = [
      "schema: humanish.lab.v2",
      "id: demo",
      "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000/' }",
      ...actor,
      ...lines,
      "execution: { target: e2b-desktop }",
      "",
    ].join("\n");
    expect(convert(source).text).toContain("# keep this study note");
  });

  it("keeps a comment between the scripted count's key and its value", () => {
    const conversion = convert(
      [
        "schema: humanish.lab.v2",
        "id: demo",
        "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000' }",
        "actors:",
        "  - type: scripted-browser",
        "    count: # desktop and mobile",
        '      "2"',
        "scenario: { ref: scripted-first-run }",
        "",
      ].join("\n"),
    );
    expect(conversion.text).toContain("# desktop and mobile");
    expect(parse(conversion.text).surfaces).toEqual(["desktop", "mobile"]);
  });

  it("keeps a comment between subject.topology's key and its value on route", async () => {
    const text = await readFile(
      path.join(ROOT, "tests", "fixtures", "labs-v2", "shared-world-concurrent-demo.yaml"),
      "utf8",
    );
    const source = text.replace(
      /  topology: shared-world # [^\n]*\n/,
      "  topology: # shared session rationale\n    shared-world\n",
    );
    expect(source).not.toBe(text);
    const conversion = convert(source);
    expect(conversion.text).toMatch(/# shared session rationale\nroute: shared-world/);
  });
});

// v2 reads a valueless `laneFocus:` as no focus at all, so the v3 file has none either.
// A focus mapping is rebuilt as { count, instruction }; a field v2 read as unset goes, its comment stays.
it("keeps the comment on a laneFocus field v2 reads as unset", () => {
  const conversion = convert(
    [
      "schema: humanish.lab.v2",
      "id: demo",
      "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000/' }",
      "actors:",
      "  - type: openai-computer-use",
      "    count: 2",
      "    laneFocus:",
      "      instruction: Try the export.",
      "      id: null # preserve rationale",
      "execution: { target: e2b-desktop }",
      "",
    ].join("\n"),
  );
  expect(parse(conversion.text).participants).toEqual({ count: 2, instruction: "Try the export." });
  expect(conversion.text).toContain("# preserve rationale");
});

// YAML gives an implicit empty value, such as `id` here, a null node.
it("converts a flow laneFocus with an implicit empty field, keeping its comment", () => {
  const conversion = convert(
    [
      "schema: humanish.lab.v2",
      "id: demo",
      "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000/' }",
      "actors:",
      "  - type: openai-computer-use",
      "    count: 2",
      "    laneFocus: {id, instruction: Try it.} # keep this rationale",
      "execution: { target: e2b-desktop }",
      "",
    ].join("\n"),
  );
  expect(parse(conversion.text).participants).toEqual({ count: 2, instruction: "Try it." });
  expect(conversion.text).toContain("# keep this rationale");
});

// v2 reads a valueless, empty or all-null `laneFocus` as no focus, so the v3 file has none either.
describe.each([
  ["laneFocus: # keep this study note"],
  ["laneFocus: {} # keep this study note"],
  ["laneFocus: { instruction: null } # keep this study note"],
])("%s", (focus) => {
  it("converts a preview count to a number and keeps the comment", () => {
    const conversion = convert(
      [
        "schema: humanish.lab.v2",
        "id: demo",
        "subject: { source: this-repo }",
        "actors:",
        "  - type: synthetic-persona",
        "    count: 2",
        `    ${focus}`,
        "",
      ].join("\n"),
    );
    expect(parse(conversion.text).participants).toBe(2);
    expect(conversion.text).toContain("# keep this study note");
  });

  it("keeps the comment on the scripted route", () => {
    const conversion = convert(
      [
        "schema: humanish.lab.v2",
        "id: demo",
        "subject: { source: app-url, appUrl: 'http://127.0.0.1:3000' }",
        "actors:",
        "  - type: scripted-browser",
        "    count: 2",
        `    ${focus}`,
        "scenario: { ref: scripted-first-run }",
        "",
      ].join("\n"),
    );
    expect(parse(conversion.text).surfaces).toEqual(["desktop", "mobile"]);
    expect(conversion.text).toContain("# keep this study note");
  });
});

describe("what the conversion refuses", () => {
  it("refuses an anchor or alias with its line", () => {
    expect(
      refusal(
        [
          "schema: humanish.lab.v2",
          "id: demo",
          "subject: { source: this-repo }",
          "actors:",
          "  - &actor { type: synthetic-persona }",
          "",
        ].join("\n"),
      ),
    ).toBe("line 5 uses a YAML anchor or alias. Write the value out in full, then migrate.");
  });

  it("refuses a terminal count it could only drop by changing what the file says", async () => {
    const terminal = await readFile(
      path.join(ROOT, "tests", "fixtures", "labs-v2", "terminal-product-demo.yaml"),
      "utf8",
    );
    const counted = terminal.replace(/^( {2}- type: \S+.*)$/m, "$1\n    count: 1");
    expect(counted).not.toBe(terminal);
    expect(refusal(counted)).toBe(
      "actors[0].count does nothing on the terminal route, and a v3 terminal study has no participants. Remove it, then migrate.",
    );
  });

  it("refuses a file that is already v3", () => {
    expect(refusal("schema: humanish.study.v3\nid: demo\n")).toBe(
      "its schema is not humanish.lab.v2.",
    );
  });
});
