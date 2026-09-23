import { expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";

// Value import of the producer is fine here (tests run in Node); the APP must never
// do this — lib/observer-data.ts is type-only so no CLI code reaches the artifact.
import { OBSERVER_DATA_SCHEMA as PRODUCER_SCHEMA } from "../../src/observer-data";
import { OBSERVER_DATA_PLACEHOLDER, OBSERVER_DATA_SCHEMA } from "../lib/data";
import { OBSERVER_DATA_PLACEHOLDER as INJECTOR_PLACEHOLDER } from "../scripts/inject";

it("the app's schema id matches the producer's frozen contract", () => {
  expect(OBSERVER_DATA_SCHEMA).toBe(PRODUCER_SCHEMA);
});

it("the app's slot marker matches the injector's", () => {
  expect(OBSERVER_DATA_PLACEHOLDER).toBe(INJECTOR_PLACEHOLDER);
});

import { STUDY_ANALYSIS_SCHEMA as ANALYSIS_PRODUCER_SCHEMA } from "../../src/study-analysis";
import { STUDY_ANALYSIS_SCHEMA } from "../lib/study-analysis";
it("the companion analysis schema matches the producer without importing it into app code", () => {
  expect(STUDY_ANALYSIS_SCHEMA).toBe(ANALYSIS_PRODUCER_SCHEMA);
});

const OBSERVER_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_ROOT = path.resolve(OBSERVER_ROOT, "../src");

function runtimeCliEdges(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edges: string[] = [];
  function visit(node: ts.Node): void {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) specifier = node.moduleSpecifier;
    else if (ts.isExportDeclaration(node) && !node.isTypeOnly) specifier = node.moduleSpecifier;
    else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === "require")) specifier = node.arguments[0];
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const target = specifier.text.startsWith(".") ? path.resolve(path.dirname(file), specifier.text)
        : specifier.text.startsWith("@/") ? path.resolve(OBSERVER_ROOT, specifier.text.slice(2))
        : path.isAbsolute(specifier.text) ? path.resolve(specifier.text) : null;
      if (target === CLI_ROOT || target?.startsWith(`${CLI_ROOT}${path.sep}`)) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        edges.push(`${path.relative(OBSERVER_ROOT, file)}:${line}: ${specifier.text}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return edges;
}

async function runtimeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? runtimeFiles(file)
      : /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [file] : [];
  }))).flat();
}

it("Observer runtime modules never import CLI values", async () => {
  const files = [path.join(OBSERVER_ROOT, "app.tsx"), path.join(OBSERVER_ROOT, "main.tsx"),
    ...await runtimeFiles(path.join(OBSERVER_ROOT, "components")), ...await runtimeFiles(path.join(OBSERVER_ROOT, "lib"))];
  const edges = (await Promise.all(files.map(async file => runtimeCliEdges(file, await readFile(file, "utf8"))))).flat();
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
  'export { type Value } from "../../src/fake";'
])("the boundary guard rejects a synthetic runtime edge: %s", source => {
  expect(runtimeCliEdges(path.join(OBSERVER_ROOT, "lib/boundary-fixture.ts"), source)).toHaveLength(1);
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
    'const example = \'import("../../src/fake")\';'
  ].join("\n");
  expect(runtimeCliEdges(path.join(OBSERVER_ROOT, "lib/boundary-fixture.ts"), source)).toEqual([]);
});
