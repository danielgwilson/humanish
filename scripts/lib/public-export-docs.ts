/**
 * Finds the names src/index.ts exports whose declaration has no leading doc comment. Each export
 * is followed through `export { x } from`, `export type { x } from` and `export * from` to the
 * module that declares it, so a re-exported type is checked where it is written.
 */
import { posix } from "node:path";
import { parseSync } from "oxc-parser";

export interface UndocumentedExport {
  name: string;
  /** The declaring module, or the module where the chain ended when no declaration was found. */
  file: string;
  line: number;
  reason: "no doc comment" | "declaration not found";
}

interface Module {
  text: string;
  comments: ReadonlyArray<{ type: string; value: string; start: number; end: number }>;
  body: ReadonlyArray<Statement>;
}

interface Statement {
  type: string;
  start: number;
  declaration?: Declaration | null;
  specifiers?: ReadonlyArray<{ local: Name; exported: Name }>;
  source?: { value: string } | null;
  id?: Name | null;
  declarations?: ReadonlyArray<{ id: Name }>;
}

type Declaration = Statement;
type Name = { name?: string; value?: string };

const nameOf = (name: Name): string => name.name ?? name.value ?? "";

/** The names a declaration statement introduces: one for a function or type, several for a const. */
function declaredNames(statement: Statement): string[] {
  const declaration =
    statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
  if (!declaration) return [];
  if (declaration.declarations) return declaration.declarations.map((item) => nameOf(item.id));
  return declaration.id ? [nameOf(declaration.id)] : [];
}

/** The module a relative specifier names, from the importing module's path. */
function resolve(from: string, specifier: string): string {
  return posix.join(posix.dirname(from), specifier.replace(/\.js$/, ".ts"));
}

export function findUndocumentedExports(
  readModule: (file: string) => string | undefined,
  indexPath = "src/index.ts",
): UndocumentedExport[] {
  const cache = new Map<string, Module | undefined>();
  const load = (file: string): Module | undefined => {
    if (!cache.has(file)) {
      const text = readModule(file);
      if (text === undefined) cache.set(file, undefined);
      else {
        const parsed = parseSync(file, text);
        cache.set(file, {
          text,
          comments: parsed.comments,
          body: parsed.program.body as unknown as Statement[],
        });
      }
    }
    return cache.get(file);
  };
  const lineOf = (module: Module, offset: number) =>
    module.text.slice(0, offset).split("\n").length;
  const documented = (module: Module, statement: Statement) =>
    module.comments.some(
      (comment) =>
        comment.type === "Block" &&
        comment.value.startsWith("*") &&
        module.text.slice(comment.end, statement.start).trim() === "",
    );

  /** The module and statement that declare `name`, following re-exports; undefined when none do. */
  const declarationOf = (
    file: string,
    name: string,
    seen: Set<string>,
  ): { file: string; module: Module; statement: Statement } | undefined => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const module = load(file);
    if (!module) return undefined;
    for (const statement of module.body) {
      if (statement.type === "ExportNamedDeclaration" && statement.declaration) {
        if (declaredNames(statement).includes(name)) return { file, module, statement };
      }
      if (statement.type === "ExportNamedDeclaration" && !statement.declaration) {
        for (const specifier of statement.specifiers ?? []) {
          if (nameOf(specifier.exported) !== name) continue;
          const local = nameOf(specifier.local);
          if (statement.source)
            return declarationOf(resolve(file, statement.source.value), local, seen);
          const declared = module.body.find((other) => declaredNames(other).includes(local));
          if (declared) return { file, module, statement: declared };
        }
      }
      if (statement.type === "ExportAllDeclaration" && statement.source) {
        const found = declarationOf(resolve(file, statement.source.value), name, seen);
        if (found) return found;
      }
    }
    return undefined;
  };

  const index = load(indexPath);
  if (!index) return [{ name: "*", file: indexPath, line: 1, reason: "declaration not found" }];
  const issues: UndocumentedExport[] = [];
  for (const statement of index.body) {
    if (statement.type !== "ExportNamedDeclaration" || !statement.source) continue;
    for (const specifier of statement.specifiers ?? []) {
      const name = nameOf(specifier.exported);
      const target = resolve(indexPath, statement.source.value);
      const found = declarationOf(target, nameOf(specifier.local), new Set());
      if (!found) {
        issues.push({ name, file: target, line: 1, reason: "declaration not found" });
      } else if (!documented(found.module, found.statement)) {
        const line = lineOf(found.module, found.statement.start);
        issues.push({ name, file: found.file, line, reason: "no doc comment" });
      }
    }
  }
  return issues;
}
