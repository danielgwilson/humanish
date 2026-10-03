// Finds doc references that pair a code name with the file that holds it, such as
// "`routeOf` (`src/study/plan.ts`)", and reports the ones whose file no longer declares that name.
// A rename, a move or a deletion leaves these pointers behind; a reader who opens the file then
// finds nothing by that name. Only three explicit forms are read, so a name that merely sits near
// a path is never checked.
import { parseSync } from "oxc-parser";

export interface SymbolIssue {
  file: string;
  line: number;
  name: string;
  path: string;
}

// A code file under a source root. Other paths (docs, YAML, JSON) are not parsed for names.
const CODE_PATH = String.raw`(?:src|tests|scripts|tui|site|runtime|observer)/[\w./-]+\.(?:tsx?|mts|mjs)`;
// An identifier, optionally dotted (`Run.finish`, `StudyOutcome.backend`), or a dotted string id
// such as a schema name (`humanish.pricing.v1`). A trailing `()` is allowed on the name.
const NAME = String.raw`[A-Za-z_$][\w$]*(?:\.[\w$-]+)*`;
const SYMBOL_REFERENCE = new RegExp(
  [
    // `name` (`path`)
    String.raw`\`(${NAME})(?:\(\))?\`\s*\(\s*\`(${CODE_PATH})\`\s*\)`,
    // `name` in `path`, `name` from `path`, `name` at `path`
    String.raw`\`(${NAME})(?:\(\))?\`\s+(?:in|from|at)\s+\`(${CODE_PATH})\``,
    // (`name`, `path`)
    String.raw`\(\s*\`(${NAME})(?:\(\))?\`\s*,\s*\`(${CODE_PATH})\`\s*\)`,
  ].join("|"),
  "g",
);

export interface SymbolReference {
  line: number;
  name: string;
  path: string;
}

export function findSymbolReferences(text: string): SymbolReference[] {
  const references: SymbolReference[] = [];
  for (const match of text.matchAll(SYMBOL_REFERENCE)) {
    const name = match[1] ?? match[3] ?? match[5]!;
    const path = match[2] ?? match[4] ?? match[6]!;
    references.push({ line: text.slice(0, match.index).split("\n").length, name, path });
  }
  return references;
}

/** The names a source file makes available to a reader who opens it. */
export interface FileSymbols {
  /** Declared anywhere in the file: functions, classes, variables, types, enums, namespaces. */
  declared: ReadonlySet<string>;
  /** Named by an export specifier, including re-exports from another module. */
  exported: ReadonlySet<string>;
  /** Class, interface, type-literal, object-literal and enum member names. */
  members: ReadonlySet<string>;
  /** Property names read or written through `object.name` in the file. */
  accessed: ReadonlySet<string>;
  /** String literal values, which is where schema ids live. */
  strings: ReadonlySet<string>;
}

const DECLARATION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
  "TSModuleDeclaration",
]);
const MEMBER_TYPES = new Set([
  "MethodDefinition",
  "PropertyDefinition",
  "TSPropertySignature",
  "TSMethodSignature",
  "Property",
  "TSEnumMember",
]);

type Node = { type?: unknown; [key: string]: unknown };

function nameOf(node: unknown): string | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const value = node as Node;
  if (typeof value.name === "string") return value.name;
  if (typeof value.value === "string") return value.value;
  return undefined;
}

export function collectFileSymbols(path: string, source: string): FileSymbols {
  const declared = new Set<string>();
  const exported = new Set<string>();
  const members = new Set<string>();
  const accessed = new Set<string>();
  const strings = new Set<string>();
  const bindings = (pattern: unknown): void => {
    if (pattern === null || typeof pattern !== "object") return;
    const node = pattern as Node;
    if (node.type === "Identifier" && typeof node.name === "string") declared.add(node.name);
    else if (node.type === "ObjectPattern" && Array.isArray(node.properties))
      for (const property of node.properties as Node[])
        bindings(property.value ?? property.argument);
    else if (node.type === "ArrayPattern" && Array.isArray(node.elements))
      for (const element of node.elements) bindings(element);
    else if (node.type === "AssignmentPattern") bindings(node.left);
    else if (node.type === "RestElement") bindings(node.argument);
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as Node;
    if (typeof node.type === "string") {
      if (DECLARATION_TYPES.has(node.type)) {
        const name = nameOf(node.id);
        if (name !== undefined) declared.add(name);
      } else if (node.type === "VariableDeclarator") {
        bindings(node.id);
      } else if (node.type === "ExportSpecifier") {
        const name = nameOf(node.exported);
        if (name !== undefined) exported.add(name);
      } else if (MEMBER_TYPES.has(node.type)) {
        const name = nameOf(node.type === "TSEnumMember" ? node.id : node.key);
        if (name !== undefined) members.add(name);
      } else if (node.type === "MemberExpression" && node.computed !== true) {
        const name = nameOf(node.property);
        if (name !== undefined) accessed.add(name);
      } else if (node.type === "Literal" && typeof node.value === "string") {
        strings.add(node.value);
      } else if (node.type === "TemplateElement") {
        const cooked = (node.value as { cooked?: unknown } | undefined)?.cooked;
        if (typeof cooked === "string") strings.add(cooked);
      }
    }
    for (const key of Object.keys(node)) {
      if (key !== "type" && key !== "start" && key !== "end") visit(node[key]);
    }
  };
  visit(parseSync(path, source).program);
  return { declared, exported, members, accessed, strings };
}

// A versioned id such as `humanish.pricing.v1`. Docs pair one with the file that declares it or
// with the test that freezes it, and a test may name it only in a comment beside an imported
// constant, so a schema id resolves when the file mentions it anywhere.
const SCHEMA_ID = /^[a-z][\w-]*(?:\.[\w-]+)*\.v\d+$/;

/**
 * Whether the file still holds the name. A plain name must be declared, exported, a member or a
 * property read there; docs list hook and option fields by their bare names and say which file
 * checks one. An import or a bare call does not count, so a doc that names the importer of a
 * moved function fails. A dotted name needs its head declared or exported, and when the head is
 * declared in this file, each later part must be a member or declaration in it too.
 */
export function resolvesIn(name: string, symbols: FileSymbols, source = ""): boolean {
  if (SCHEMA_ID.test(name)) return symbols.strings.has(name) || source.includes(name);
  const [head, ...rest] = name.split(".");
  if (symbols.declared.has(head!)) {
    return rest.every((part) => symbols.members.has(part) || symbols.declared.has(part));
  }
  if (rest.length === 0 && (symbols.members.has(head!) || symbols.accessed.has(head!))) return true;
  return symbols.exported.has(head!);
}

/**
 * Checks each symbol reference in a doc against its file. `readSource` returns the file's text,
 * or undefined when the file does not exist; the path check reports those.
 */
export function findDocSymbolIssues(
  file: string,
  text: string,
  readSource: (path: string) => string | undefined,
  cache: Map<string, { source: string; symbols: FileSymbols }> = new Map(),
): SymbolIssue[] {
  const issues: SymbolIssue[] = [];
  for (const { line, name, path } of findSymbolReferences(text)) {
    let entry = cache.get(path);
    if (entry === undefined) {
      const source = readSource(path);
      if (source === undefined) continue;
      entry = { source, symbols: collectFileSymbols(path, source) };
      cache.set(path, entry);
    }
    if (!resolvesIn(name, entry.symbols, entry.source)) issues.push({ file, line, name, path });
  }
  return issues;
}
