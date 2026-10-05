// StudyConfig has the keys of a humanish.study.v3 file. The humanish.lab.v2 fields it replaced
// (`actors`, `laneFocus`, `execution.caps`, `scenario.caps`, `scenario.mode`, `scenario.ref`,
// `scenario.inline` and `subject.topology`) are read only by migrate, which converts a v2 file, and
// by parse/front.ts, which tells a person where a moved key went. This test parses every file under
// src/ and fails on a read of a v2 field anywhere else. It reads syntax, so it also sees reads the
// compiler cannot tie to StudyConfig: a `Record<string, unknown>` cast, or a structural
// `{ actors?: ... }` parameter.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

// migrate reads v2 files; parse/front.ts names the v2 keys a v3 file must not set.
const EXEMPT = ["src/study/migrate/", "src/study/parse/front.ts"];

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

describe("src reads no humanish.lab.v2 study field outside migrate", () => {
  it("has no read of a v2 study field outside migrate and parse/front.ts", () => {
    expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.code}`)).toEqual([]);
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
