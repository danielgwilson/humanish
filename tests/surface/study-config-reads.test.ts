// StudyConfig still has the humanish.lab.v2 shape, and the v3 shape replaces `actors`, `laneFocus`,
// `execution.caps`, `scenario.caps`, `scenario.mode`, `scenario.ref` and `subject.topology`. Code
// outside the parser reads those values through src/study/study-fields.ts, so the shape changes in
// one file. This test parses every file under src/ and fails on a direct read of a v2 field outside
// the parser, migrate and the accessors. It reads syntax, so it also sees reads the compiler cannot
// tie to StudyConfig: a `Record<string, unknown>` cast, or a structural `{ actors?: ... }` parameter.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

// The types declare the v2 shape; the parser, its key table, migrate and the accessors read it.
const EXEMPT = [
  "src/study/types.ts",
  "src/study/config.ts",
  "src/study/keys.ts",
  "src/study/parse/",
  "src/study/migrate/",
  "src/study/study-fields.ts",
];

const PER_ACTOR =
  "reads each declared actor; a library config may declare more than one, and the v3 shape has one";
const INERT_ROW =
  "an inert-field row keeps its v2 name until the v3 shape lands, because migrate reports it as a v2 path";
const V2_ONLY = "a v2 key with no v3 key; the check goes with the v2 shape";
const OTHER_CAPS =
  "reads the caps block this route does not use, which a route-aware capsOf cannot return";

/** Direct reads that stay until StudyConfig takes the v3 shape: the file, the code, how many, why. */
const ALLOWED: readonly { file: string; code: string; count: number; reason: string }[] = [
  { file: "src/study/persona-resolve.ts", code: "rosterOf(actor)", count: 1, reason: PER_ACTOR },
  { file: "src/study/url-credentials.ts", code: "rosterOf(actor)", count: 1, reason: PER_ACTOR },
  { file: "src/study/warnings.ts", code: "rosterOf(actor)", count: 5, reason: INERT_ROW },
  { file: "src/study/warnings.ts", code: "focusOf(actor)", count: 4, reason: INERT_ROW },
  {
    file: "src/study/warnings.ts",
    code: 'StudyConfig["actors"]',
    count: 1,
    reason: `the actor type of the inert-field rows; ${INERT_ROW}`,
  },
  {
    file: "src/study/warnings.ts",
    code: "config.subject.topology",
    count: 1,
    reason: `any topology, including per-lane-worlds; ${INERT_ROW}`,
  },
  {
    file: "src/study/warnings.ts",
    code: "config.execution?.caps",
    count: 1,
    reason: `${OTHER_CAPS}; ${INERT_ROW}`,
  },
  {
    file: "src/study/warnings.ts",
    code: "config.scenario?.caps",
    count: 2,
    reason: `${OTHER_CAPS}; ${INERT_ROW}`,
  },
  {
    file: "src/study/warnings.ts",
    code: "config.scenario?.inline",
    count: 1,
    reason: `${V2_ONLY}; ${INERT_ROW}`,
  },
  {
    file: "src/study/validation.ts",
    code: "focusOf(actor)",
    count: 1,
    reason: `laneFocus with lanes: ${V2_ONLY}`,
  },
  {
    file: "src/study/validation.ts",
    code: "config.scenario?.caps",
    count: 1,
    reason: `a scenario.caps budget on computer use: ${OTHER_CAPS}`,
  },
  {
    file: "src/study/composition-rules.ts",
    code: "config.subject.topology",
    count: 1,
    reason: `any topology on a scripted clone, including per-lane-worlds: ${V2_ONLY}`,
  },
  {
    file: "src/substrates/local/runtime-config.ts",
    code: "config.execution?.caps",
    count: 2,
    reason: "a budget in either caps block refuses a local Codex participant",
  },
  {
    file: "src/substrates/local/runtime-config.ts",
    code: "config.scenario?.caps",
    count: 2,
    reason: "a budget in either caps block refuses a local Codex participant",
  },
];

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** The expression under parentheses, `!` and an optional chain's wrapper. */
function unwrap(node: unknown): Node | undefined {
  let current = isNode(node) ? node : undefined;
  while (
    current &&
    ["ParenthesizedExpression", "TSNonNullExpression", "ChainExpression"].includes(current.type)
  ) {
    current = isNode(current.expression) ? current.expression : undefined;
  }
  return current;
}

/** A property's name: `a.name`, `a["name"]` or a `{ name }` key. */
function keyName(node: Node): string | undefined {
  const key = node.type === "MemberExpression" ? node.property : node.key;
  if (!isNode(key)) return undefined;
  if (key.type === "Identifier") return node.computed === true ? undefined : String(key.name);
  return key.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
}

/** True when an expression is `<name>` or `<anything>.<name>`. */
function endsWith(node: unknown, name: string): boolean {
  const inner = unwrap(node);
  if (inner?.type === "Identifier") return inner.name === name;
  return inner?.type === "MemberExpression" && keyName(inner) === name;
}

const V2_KEYS = new Set(["actors", "laneFocus"]);
// A field the v3 shape moves, and the blocks that hold it in the v2 shape.
const BLOCK_FIELDS = new Map<string, readonly string[]>([
  ["caps", ["execution", "scenario"]],
  ["mode", ["scenario"]],
  ["ref", ["scenario"]],
  ["inline", ["scenario"]],
  ["topology", ["subject"]],
]);

/** True when a node reads a v2 field. `inPattern` is set inside an object pattern. */
function v2Read(node: Node, inPattern: boolean): boolean {
  if (node.type === "MemberExpression") {
    const name = keyName(node);
    if (name === undefined) return false;
    if (V2_KEYS.has(name)) return true;
    return (BLOCK_FIELDS.get(name) ?? []).some((block) => endsWith(node.object, block));
  }
  if (node.type === "CallExpression") {
    const callee = unwrap(node.callee);
    return callee?.type === "Identifier" && ["rosterOf", "focusOf"].includes(String(callee.name));
  }
  // `const { actors } = config` and a structural `{ actors?: ... }` parameter type.
  if (node.type === "Property" || node.type === "TSPropertySignature") {
    const name = keyName(node);
    return name !== undefined && V2_KEYS.has(name) && (node.type !== "Property" || inPattern);
  }
  if (node.type === "TSIndexedAccessType") {
    const index = isNode(node.indexType) ? node.indexType : undefined;
    const literal = isNode(index?.literal) ? index.literal : undefined;
    return typeof literal?.value === "string" && V2_KEYS.has(literal.value);
  }
  return false;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly code: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** Every direct v2 read in a file, outermost first; a read inside a reported one is not reported. */
function v2Reads(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  const visit = (value: unknown, inPattern: boolean): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, inPattern);
      return;
    }
    if (!isNode(value)) return;
    if (v2Read(value, inPattern)) {
      hits.push({
        file,
        line: text.slice(0, value.start).split("\n").length,
        code: text.slice(value.start, value.end).replace(/\s+/g, " "),
      });
      return;
    }
    // A Property inside an object pattern binds a name; inside an object literal it sets one.
    const pattern =
      value.type === "ObjectPattern" ? true : value.type === "ObjectExpression" ? false : inPattern;
    for (const [key, child] of Object.entries(value)) if (key !== "parent") visit(child, pattern);
  };
  visit(parseSync(file, text).program, false);
  return hits;
}

const hits = sourceFiles("src")
  .filter(
    (file) =>
      !EXEMPT.some((exempt) => (exempt.endsWith("/") ? file.startsWith(exempt) : file === exempt)),
  )
  .flatMap((file) => v2Reads(file, readFileSync(file, "utf8")));

const keyOf = (file: string, code: string) => `${file} ${code}`;

describe("src reads the study through src/study/study-fields.ts", () => {
  it("has no direct read of a v2 study field outside the parser and the accessors", () => {
    const allowed = new Set(ALLOWED.map((entry) => keyOf(entry.file, entry.code)));
    const direct = hits
      .filter((hit) => !allowed.has(keyOf(hit.file, hit.code)))
      .map((hit) => `${hit.file}:${hit.line} ${hit.code}`);
    expect(direct).toEqual([]);
  });

  it("each allowed read still occurs, as often as listed", () => {
    for (const entry of ALLOWED) {
      const found = hits.filter((hit) => hit.file === entry.file && hit.code === entry.code);
      expect(found.length, `${entry.file} ${entry.code}: ${entry.reason}`).toBe(entry.count);
    }
  });

  it("finds a planted read in each form it guards", () => {
    const planted = [
      "const a = config.actors[0];",
      'const b = (config as Record<string, unknown>)["actors"];',
      "const c = actor?.laneFocus;",
      "const d = config.execution?.caps;",
      "const e = config.scenario?.mode;",
      "const f = scenario.ref;",
      "const g = config.subject.topology;",
      "const h = rosterOf(actor);",
      "const { actors } = config;",
      "function i(config: { actors?: unknown[] }) { return config; }",
      'type J = StudyConfig["actors"];',
    ];
    for (const line of planted) {
      expect(v2Reads("planted.ts", line), line).toHaveLength(1);
    }
    for (const line of [
      "const k = { actors: [] };",
      "const l = run.lanes;",
      "const m = bundle.topology;",
      'const n = "config.actors[0]";',
      "// config.actors[0]",
    ]) {
      expect(v2Reads("planted.ts", line), line).toEqual([]);
    }
  });
});
