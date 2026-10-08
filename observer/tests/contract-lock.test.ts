import { expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseSync } from "oxc-parser";

// Value import of the producer is fine here (tests run in Node); the app must never
// do this: lib/observer-data.ts is type-only so no CLI code reaches the artifact.
import { OBSERVER_DATA_SCHEMA as PRODUCER_SCHEMA } from "../../src/observer/data";
import { OBSERVER_DATA_PLACEHOLDER, OBSERVER_DATA_SCHEMA } from "../lib/data";
import { OBSERVER_DATA_PLACEHOLDER as INJECTOR_PLACEHOLDER } from "../scripts/inject";

it("the app's schema id matches the producer's frozen contract", () => {
  expect(OBSERVER_DATA_SCHEMA).toBe(PRODUCER_SCHEMA);
});

it("the app's slot marker matches the injector's", () => {
  expect(OBSERVER_DATA_PLACEHOLDER).toBe(INJECTOR_PLACEHOLDER);
});

import { ANALYSIS_SCHEMA as ANALYSIS_PRODUCER_SCHEMA } from "../../src/analysis/types";
import { ANALYSIS_SCHEMA } from "../lib/study-analysis";
it("the companion analysis schema matches the producer without importing it into app code", () => {
  expect(ANALYSIS_SCHEMA).toBe(ANALYSIS_PRODUCER_SCHEMA);
});

const OBSERVER_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_ROOT = path.resolve(OBSERVER_ROOT, "../src");

type AstNode = { type?: unknown; start?: unknown } & Record<string, unknown>;
const isNode = (value: unknown): value is AstNode => typeof value === "object" && value !== null;
const field = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};
const literal = (node: AstNode | undefined): string | undefined =>
  node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;

// A runtime edge is anything that survives type erasure under verbatimModuleSyntax: value
// imports and re-exports (including `import { type X }`, which emits `import {} from`), dynamic
// import(), require() and `import x = require()`.
function runtimeEdges(
  file: string,
  source: string,
): Array<{ edge: string; target: string | null }> {
  const { program, errors } = parseSync(file, source, { sourceType: "module" });
  if (errors.length > 0) throw new Error(`${file} does not parse: ${errors[0]?.message}`);
  const edges: Array<{ edge: string; target: string | null }> = [];
  const record = (specifier: string | undefined, start: unknown): void => {
    if (specifier === undefined || typeof start !== "number") return;
    const target = specifier.startsWith(".")
      ? path.resolve(path.dirname(file), specifier)
      : specifier.startsWith("@/")
        ? path.resolve(OBSERVER_ROOT, specifier.slice(2))
        : path.isAbsolute(specifier)
          ? path.resolve(specifier)
          : null;
    const line = source.slice(0, start).split("\n").length;
    edges.push({ edge: `${path.relative(OBSERVER_ROOT, file)}:${line}: ${specifier}`, target });
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isNode(value)) return;
    switch (value.type) {
      case "ImportDeclaration":
        if (value.importKind !== "type") record(literal(field(value, "source")), value.start);
        break;
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (value.exportKind !== "type") record(literal(field(value, "source")), value.start);
        break;
      case "ImportExpression":
        record(literal(field(value, "source")), value.start);
        break;
      case "CallExpression": {
        const callee = field(value, "callee");
        const [first] = Array.isArray(value.arguments) ? value.arguments : [];
        if (callee?.type === "Identifier" && callee.name === "require" && isNode(first))
          record(literal(first), value.start);
        break;
      }
      case "TSImportEqualsDeclaration": {
        const reference = field(value, "moduleReference");
        if (value.importKind !== "type" && reference?.type === "TSExternalModuleReference")
          record(literal(field(reference, "expression")), value.start);
        break;
      }
    }
    for (const [key, child] of Object.entries(value)) if (key !== "parent") visit(child);
  };
  visit(program);
  return edges;
}

async function runtimeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory()
          ? runtimeFiles(file)
          : /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)
            ? [file]
            : [];
      }),
    )
  ).flat();
}

// The CLI modules the app may bundle: the run cost, the participant caption every surface shows,
// and the closing report's limits. Each must keep only type imports, which the test below checks,
// so no CLI code comes with them.
const SHARED_CLI_MODULES = [
  path.join(CLI_ROOT, "run", "run-cost.ts"),
  path.join(CLI_ROOT, "run", "participant-caption.ts"),
  path.join(CLI_ROOT, "actors", "closing-report-limits.ts"),
];

function runtimeCliEdges(file: string, source: string): string[] {
  return runtimeEdges(file, source)
    .filter(({ target }) => target === CLI_ROOT || target?.startsWith(`${CLI_ROOT}${path.sep}`))
    .filter(({ target }) => !SHARED_CLI_MODULES.includes(target?.replace(/\.js$/, ".ts") ?? ""))
    .map(({ edge }) => edge);
}

it.each(SHARED_CLI_MODULES.map((module) => [path.basename(module), module] as const))(
  "the shared module %s carries only type imports into the artifact",
  async (_name, module) => {
    const edges = runtimeEdges(module, await readFile(module, "utf8"));
    expect(edges.map(({ edge }) => edge)).toEqual([]);
  },
);

it("Observer runtime modules never import CLI values", async () => {
  const files = [
    path.join(OBSERVER_ROOT, "app.tsx"),
    path.join(OBSERVER_ROOT, "main.tsx"),
    ...(await runtimeFiles(path.join(OBSERVER_ROOT, "components"))),
    ...(await runtimeFiles(path.join(OBSERVER_ROOT, "lib"))),
  ];
  const edges = (
    await Promise.all(
      files.map(async (file) => runtimeCliEdges(file, await readFile(file, "utf8"))),
    )
  ).flat();
  expect(edges).toEqual([]);
});

it.each([
  'import { value } from "../../src/fake";',
  'import "../../src/fake";',
  'export { value } from "../../src/fake";',
  'export * from "../../src/fake";',
  'const value = import("../../src/fake");',
  'const value = require("../../src/fake");',
  'import value = require("../../src/fake");',
  'import { value } from "@/../src/fake";',
  // Under verbatimModuleSyntax these emit import/export {} from, retaining a runtime edge.
  'import { type Value } from "../../src/fake";',
  'export { type Value } from "../../src/fake";',
])("the boundary guard rejects a synthetic runtime edge: %s", (source) => {
  expect(runtimeCliEdges(path.join(OBSERVER_ROOT, "lib/boundary-fixture.ts"), source)).toHaveLength(
    1,
  );
});

it("the boundary guard permits erased types and Observer-local values", () => {
  const source = [
    'import type { Value } from "../../src/fake";',
    'export type { Value } from "../../src/fake";',
    'export type * from "../../src/fake";',
    'type Value = import("../../src/fake").Value;',
    'import type Value = require("../../src/fake");',
    'import { value } from "./local";',
    'const value = import("@/lib/local");',
    '// import { value } from "../../src/fake";',
    "const example = 'import(\"../../src/fake\")';",
  ].join("\n");
  expect(runtimeCliEdges(path.join(OBSERVER_ROOT, "lib/boundary-fixture.ts"), source)).toEqual([]);
});
