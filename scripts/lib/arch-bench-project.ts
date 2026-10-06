// Reads what `pnpm arch:bench` measures out of the repo's TypeScript project. It drives TypeScript
// 7's compiler API (`typescript/unstable/sync`, which talks to the native compiler over a pipe), so
// module specifiers resolve the way `tsc` resolves them, and an import reached through `export *`,
// an index file or a renamed re-export lands on the declaration it names. The result is plain data;
// lib/arch-bench-measure.ts turns it into numbers.
import { posix } from "node:path";
import {
  API,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Checker,
  type Project,
  type Symbol as TsSymbol,
  type Type,
} from "typescript/unstable/sync";
import {
  SyntaxKind,
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isExportDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isQualifiedName,
  isSatisfiesExpression,
  isSpreadAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isVariableDeclaration,
  type AsExpression,
  type CallExpression,
  type ClassLikeDeclaration,
  type ExportDeclaration,
  type Expression,
  type ImportDeclaration,
  type ImportTypeNode,
  type Node,
  type ObjectLiteralExpression,
  type SatisfiesExpression,
  type SourceFile,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";

export type ModuleRole = "src" | "test";

export interface ModuleFacts {
  /** Repo-relative path, such as `src/run/run.ts`. */
  path: string;
  /** `src` for files under src/, `test` for files under tests/. */
  role: ModuleRole;
  /** Lines holding code. Blank lines and lines with only comments on them are left out. */
  codeLines: number;
  imports: ImportFacts[];
  /** Repo-relative modules the file replaces with `vi.mock` or `vi.doMock`, one entry per call. */
  mocks: string[];
}

export interface ImportFacts {
  /** The repo-relative module the specifier resolves to. */
  target: string;
  /**
   * The declarations the import reaches, followed through re-exports, as `<path>#<name>`. A
   * namespace import, `export *` and a dynamic import whose names are not read in place reach
   * every export of the target. A side-effect import reaches none.
   */
  symbols: string[];
}

export type SeamReason = "name" | "parameter";

export type ImplementationKind = "implements" | "typed" | "structural" | "cast";

export interface ImplementationSite {
  path: string;
  line: number;
  kind: ImplementationKind;
}

export interface SeamFacts {
  /** `<path>#<name>` of the interface or type alias. */
  id: string;
  name: string;
  path: string;
  /** `name`: the name ends in a seam suffix. `parameter`: another src folder takes it as a parameter. */
  reasons: SeamReason[];
  /** The type is a function type. */
  callable: boolean;
  members: number;
  functionMembers: number;
  implementations: ImplementationSite[];
}

export interface ProjectFacts {
  modules: ModuleFacts[];
  seams: SeamFacts[];
}

/** Interface and type alias names that read as an injected dependency. */
const SEAM_NAME = /(?:Deps|Dependencies|Provider|Executor|Adapter|Substrate)$/;

/** The top-level folder under src/ that holds a path, or `(root)` for a file directly in src/. */
export function srcFolderOf(path: string): string | undefined {
  const parts = path.split("/");
  if (parts[0] !== "src" || parts.length < 2) return undefined;
  return parts.length === 2 ? "(root)" : parts[1];
}

/**
 * Opens `<root>/tsconfig.json` and reads the facts of every file under src/ and tests/ in it.
 * `files` replaces the disk with an in-memory project, keyed by absolute path; the compiler's own
 * lib files still come from disk.
 */
export function readProjectFacts(root: string, files?: Record<string, string>): ProjectFacts {
  const api = new API({ cwd: root, ...(files ? { fs: createVirtualFileSystem(files) } : {}) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [posix.join(root, "tsconfig.json")] });
    const project = snapshot.getProjects()[0];
    if (project === undefined) throw new Error(`no TypeScript project at ${root}/tsconfig.json`);
    return new FactReader(project, root).read();
  } finally {
    api.close();
  }
}

interface SeamShape {
  facts: SeamFacts;
  declared: Type;
  /** Required property names, which a structural implementation must declare. */
  required: string[];
  functionNames: string[];
}

class FactReader {
  private readonly checker: Checker;
  /** Repo-relative path to role, for every src/ and tests/ file in the program. */
  private readonly roles = new Map<string, ModuleRole>();
  private readonly exportsCache = new Map<number, string[]>();
  private readonly seams = new Map<string, SeamShape>();
  private readonly seamsOfTypeCache = new Map<number, SeamShape[]>();

  constructor(
    private readonly project: Project,
    private readonly root: string,
  ) {
    this.checker = project.checker;
    for (const fileName of project.program.getSourceFileNames()) {
      const path = this.relative(fileName);
      if (path === undefined || !path.endsWith(".ts") || path.endsWith(".d.ts")) continue;
      if (path.startsWith("src/")) this.roles.set(path, "src");
      else if (path.startsWith("tests/")) this.roles.set(path, "test");
    }
  }

  read(): ProjectFacts {
    const sources = new Map(
      [...this.roles.keys()].sort().map((path) => [path, this.sourceFile(path)] as const),
    );
    const modules = [...sources].map(([path, file]) => this.moduleFacts(path, file));
    this.collectSeams([...sources].filter(([path]) => this.roles.get(path) === "src"));
    for (const [path, file] of sources) this.collectImplementations(path, file);
    const seams = [...this.seams.values()]
      .map((shape) => shape.facts)
      .sort((left, right) => left.id.localeCompare(right.id));
    return { modules, seams };
  }

  private sourceFile(path: string): SourceFile {
    const file = this.project.program.getSourceFile(posix.join(this.root, path));
    if (file === undefined) throw new Error(`the compiler did not return ${path}`);
    return file;
  }

  private relative(fileName: string): string | undefined {
    const path = posix.relative(this.root, fileName);
    return path.startsWith("..") ? undefined : path;
  }

  private moduleFacts(path: string, file: SourceFile): ModuleFacts {
    const imports: ImportFacts[] = [];
    const mocks: string[] = [];
    const add = (edge: ImportFacts | undefined) => {
      if (edge) imports.push(edge);
    };
    for (const statement of file.statements) {
      if (isImportDeclaration(statement)) add(this.importDeclaration(statement));
      else if (isExportDeclaration(statement)) add(this.exportDeclaration(statement));
    }
    const visit = (node: Node): void => {
      if (isCallExpression(node)) {
        if (node.expression.kind === SyntaxKind.ImportKeyword) add(this.dynamicImport(node));
        const mocked = this.mockTarget(path, node);
        if (mocked !== undefined) mocks.push(mocked);
      } else if (isImportTypeNode(node)) {
        add(this.importType(node));
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
    return { path, role: this.roles.get(path)!, codeLines: codeLines(file), imports, mocks };
  }

  private importDeclaration(node: ImportDeclaration): ImportFacts | undefined {
    const target = this.moduleOf(node.moduleSpecifier);
    if (target === undefined) return undefined;
    const clause = node.importClause;
    const symbols: string[] = [];
    if (clause?.name) symbols.push(...this.declarationsOf(clause.name));
    const bindings = clause?.namedBindings;
    if (bindings?.kind === SyntaxKind.NamespaceImport) {
      symbols.push(...this.exportsOf(node.moduleSpecifier));
    } else if (bindings?.kind === SyntaxKind.NamedImports) {
      for (const element of bindings.elements) symbols.push(...this.declarationsOf(element.name));
    }
    return { target, symbols: unique(symbols) };
  }

  private exportDeclaration(node: ExportDeclaration): ImportFacts | undefined {
    if (node.moduleSpecifier === undefined) return undefined;
    const target = this.moduleOf(node.moduleSpecifier);
    if (target === undefined) return undefined;
    const clause = node.exportClause;
    if (clause === undefined || clause.kind === SyntaxKind.NamespaceExport) {
      return { target, symbols: this.exportsOf(node.moduleSpecifier) };
    }
    const symbols = clause.elements.flatMap((element) => this.declarationsOf(element.name));
    return { target, symbols: unique(symbols) };
  }

  /** `import("./x.js")`: the names a destructuring or a property access reads, else every export. */
  private dynamicImport(call: CallExpression): ImportFacts | undefined {
    const specifier = call.arguments[0];
    if (specifier === undefined || !isStringLike(specifier)) return undefined;
    const target = this.moduleOf(specifier);
    if (target === undefined) return undefined;
    const names = namesReadFrom(call);
    const symbols = names
      ? names.flatMap((name) => this.exportNamed(specifier, name))
      : this.exportsOf(specifier);
    return { target, symbols: unique(symbols) };
  }

  /** `import("./x.js").Name` or `typeof import("./x.js")` in a type position. */
  private importType(node: ImportTypeNode): ImportFacts | undefined {
    if (!isLiteralTypeNode(node.argument) || !isStringLike(node.argument.literal)) return undefined;
    const specifier = node.argument.literal;
    const target = this.moduleOf(specifier);
    if (target === undefined) return undefined;
    const first = node.qualifier && leftmostName(node.qualifier);
    const symbols = first ? this.exportNamed(specifier, first) : this.exportsOf(specifier);
    return { target, symbols: unique(symbols) };
  }

  /** The module a `vi.mock("../src/x.js")` or `vi.mock(import("../src/x.js"))` call replaces. */
  private mockTarget(path: string, call: CallExpression): string | undefined {
    const callee = call.expression;
    if (!isPropertyAccessExpression(callee) || !isIdentifier(callee.expression)) return undefined;
    if (callee.expression.text !== "vi" || !isIdentifier(callee.name)) return undefined;
    if (callee.name.text !== "mock" && callee.name.text !== "doMock") return undefined;
    const argument = call.arguments[0];
    if (argument === undefined) return undefined;
    if (isCallExpression(argument)) {
      const inner = argument.arguments[0];
      return inner && isStringLike(inner) ? this.moduleOf(inner) : undefined;
    }
    return isStringLike(argument) ? this.resolveRelative(path, argument.text) : undefined;
  }

  /** vi.mock takes a plain string, so it resolves the way Node maps a `.js` specifier to `.ts`. */
  private resolveRelative(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const base = posix.join(posix.dirname(from), specifier);
    const candidates = [base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}/index.ts`, base];
    return candidates.find((candidate) => this.roles.has(candidate));
  }

  private moduleSymbol(specifier: Node): TsSymbol | undefined {
    const symbol = this.checker.getSymbolAtLocation(specifier);
    return symbol && symbol.flags & SymbolFlags.ValueModule ? symbol : undefined;
  }

  /** The src/ or tests/ file a module specifier resolves to; undefined for packages. */
  private moduleOf(specifier: Node): string | undefined {
    const declaration = this.moduleSymbol(specifier)?.declarations[0];
    const path = declaration && this.relative(declaration.path);
    return path !== undefined && this.roles.has(path) ? path : undefined;
  }

  private declarationsOf(name: Node): string[] {
    const symbol = this.resolve(name);
    const key = symbol && this.keyOf(symbol);
    return key === undefined ? [] : [key];
  }

  private exportsOf(specifier: Node): string[] {
    const module = this.moduleSymbol(specifier);
    if (module === undefined) return [];
    const cached = this.exportsCache.get(module.id);
    if (cached) return cached;
    const keys = unique(
      this.checker.getExportsOfModule(module).flatMap((symbol) => {
        const original = this.original(symbol);
        return (original && this.keyOf(original)) ?? [];
      }),
    );
    this.exportsCache.set(module.id, keys);
    return keys;
  }

  private exportNamed(specifier: Node, name: string): string[] {
    const module = this.moduleSymbol(specifier);
    const symbol = module && this.checker.getMemberInModuleExports(module, name);
    const original = symbol && this.original(symbol);
    const key = original && this.keyOf(original);
    return key === undefined ? [] : [key];
  }

  /** The symbol an alias chain ends at; undefined when it does not resolve. */
  private original(symbol: TsSymbol): TsSymbol | undefined {
    const target =
      symbol.flags & SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    return this.checker.isUnknownSymbol(target) ? undefined : target;
  }

  private resolve(name: Node): TsSymbol | undefined {
    const symbol = this.checker.getSymbolAtLocation(name);
    return symbol && this.original(symbol);
  }

  /** `<path>#<name>` of a resolved symbol's first declaration. */
  private keyOf(symbol: TsSymbol): string | undefined {
    const declaration = symbol.declarations[0];
    if (declaration === undefined) return undefined;
    return `${this.relative(declaration.path) ?? declaration.path}#${symbol.name}`;
  }

  /**
   * Seam candidates: an interface or type alias declared in src/ whose name ends in a seam suffix,
   * or one that a function or constructor parameter in another src folder is annotated with.
   */
  private collectSeams(files: [string, SourceFile][]): void {
    const candidates = new Map<string, { symbol: TsSymbol; reasons: Set<SeamReason> }>();
    const add = (symbol: TsSymbol, reason: SeamReason) => {
      const key = this.keyOf(symbol);
      if (key === undefined) return;
      const candidate = candidates.get(key) ?? { symbol, reasons: new Set<SeamReason>() };
      candidate.reasons.add(reason);
      candidates.set(key, candidate);
    };
    for (const [path, file] of files) {
      for (const statement of file.statements) {
        if (!isInterfaceDeclaration(statement) && !isTypeAliasDeclaration(statement)) continue;
        if (!SEAM_NAME.test(statement.name.text)) continue;
        const symbol = this.resolve(statement.name);
        if (symbol) add(symbol, "name");
      }
      const visit = (node: Node): void => {
        if (isParameterDeclaration(node) && node.type && isTypeReferenceNode(node.type)) {
          const symbol = this.resolve(rightmostName(node.type.typeName));
          if (symbol && this.isCrossFolderType(symbol, path)) add(symbol, "parameter");
        }
        node.forEachChild(visit);
      };
      file.forEachChild(visit);
    }
    for (const [id, { symbol, reasons }] of candidates) {
      const shape = this.seamShape(id, symbol, reasons);
      if (shape) this.seams.set(id, shape);
    }
  }

  private isCrossFolderType(symbol: TsSymbol, path: string): boolean {
    if (!(symbol.flags & (SymbolFlags.Interface | SymbolFlags.TypeAlias))) return false;
    const declaration = symbol.declarations[0];
    const declaredIn = declaration && this.relative(declaration.path);
    if (declaredIn === undefined || this.roles.get(declaredIn) !== "src") return false;
    return srcFolderOf(declaredIn) !== srcFolderOf(path);
  }

  /**
   * Keeps a candidate that has behavior to inject: a function type, or an object type with a
   * function-typed member. A candidate kept only for the parameter rule needs at least half of its
   * members to be functions, which leaves out option bags that carry one callback.
   */
  private seamShape(id: string, symbol: TsSymbol, reasons: Set<SeamReason>): SeamShape | undefined {
    const declared = this.checker.getDeclaredTypeOfSymbol(symbol);
    if (declared.isErrorType()) return undefined;
    const callable = this.checker.getSignaturesOfType(declared, SignatureKind.Call).length > 0;
    const isObject = (declared.flags & (TypeFlags.Object | TypeFlags.Intersection)) !== 0;
    const properties = isObject ? this.checker.getPropertiesOfType(declared) : [];
    const functionNames: string[] = [];
    const required: string[] = [];
    for (const property of properties) {
      if (!(property.flags & SymbolFlags.Optional)) required.push(property.name);
      const type = this.checker.getTypeOfSymbol(property);
      const value = type && this.checker.getNonNullableType(type);
      if (value && this.checker.getSignaturesOfType(value, SignatureKind.Call).length > 0) {
        functionNames.push(property.name);
      }
    }
    const behaviorShaped =
      functionNames.length > 0 &&
      (reasons.has("name") || functionNames.length * 2 >= properties.length);
    if (!callable && !behaviorShaped) return undefined;
    const hash = id.lastIndexOf("#");
    return {
      declared,
      required,
      functionNames,
      facts: {
        id,
        name: id.slice(hash + 1),
        path: id.slice(0, hash),
        reasons: [...reasons].sort(),
        callable,
        members: properties.length,
        functionMembers: functionNames.length,
        implementations: [],
      },
    };
  }

  /**
   * An implementation is a class that names the seam in `implements`; an object literal, arrow
   * function or function expression the compiler types as the seam, as an interface that extends
   * it or as an intersection that includes it; an object literal with no named type that declares
   * every required member and at least one function member and is assignable to the seam; or an
   * `as` or `satisfies` cast of any other expression to the seam. A typed object literal has to
   * declare a function member of the seam or spread in another object; one that spreads in a
   * value already typed as the seam, or is itself spread into another literal, derives from an
   * implementation counted elsewhere.
   */
  private collectImplementations(path: string, file: SourceFile): void {
    if (this.seams.size === 0) return;
    const anyCallable = [...this.seams.values()].some((shape) => shape.facts.callable);
    const record = (node: Node, shapes: readonly SeamShape[], kind: ImplementationKind) => {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      for (const shape of shapes) shape.facts.implementations.push({ path, line, kind });
    };
    const visit = (node: Node): void => {
      if (isClassDeclaration(node) || isClassExpression(node)) {
        record(node, this.implementedBy(node), "implements");
      } else if (isObjectLiteralExpression(node) && !isSpreadIntoParent(node)) {
        const typed = this.contextualSeams(node);
        if (typed === undefined) record(node, this.structuralSeams(node), "structural");
        else record(node, this.literalImplements(node, typed), "typed");
      } else if (anyCallable && (isArrowFunction(node) || isFunctionExpression(node))) {
        record(node, this.contextualSeams(node) ?? [], "typed");
      } else if (isAsExpression(node) || isSatisfiesExpression(node)) {
        const cast = this.castSeam(node);
        if (cast) record(node, [cast], "cast");
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }

  private implementedBy(node: ClassLikeDeclaration): SeamShape[] {
    const shapes: SeamShape[] = [];
    for (const clause of node.heritageClauses ?? []) {
      if (clause.token !== SyntaxKind.ImplementsKeyword) continue;
      for (const type of clause.types) {
        const shape = this.seamNamed(rightmostName(type.expression));
        if (shape) shapes.push(shape);
      }
    }
    return shapes;
  }

  private seamNamed(name: Node): SeamShape | undefined {
    const symbol = this.resolve(name);
    const key = symbol && this.keyOf(symbol);
    return key === undefined ? undefined : this.seams.get(key);
  }

  /**
   * The seams the compiler types an expression as, possibly none. undefined when there is no
   * contextual type or only anonymous ones, which leaves the literal to the structural rule.
   */
  private contextualSeams(node: Expression): SeamShape[] | undefined {
    const type = this.checker.getContextualType(node);
    if (type === undefined) return undefined;
    const parts = type.isUnionType() ? type.getTypes() : [type];
    let named = false;
    for (const part of parts) {
      const symbol = part.getAliasSymbol() ?? part.getSymbol();
      if (symbol === undefined || symbol.name.startsWith("__")) continue;
      named = true;
      const shapes = this.seamsOfType(part);
      if (shapes.length > 0) return shapes;
    }
    return named ? [] : undefined;
  }

  /**
   * The seam a named type is, plus the seams one level down: the interfaces it extends and the
   * members of the intersection it aliases.
   */
  private seamsOfType(type: Type): SeamShape[] {
    const cached = this.seamsOfTypeCache.get(type.id);
    if (cached !== undefined) return cached;
    const seamOf = (part: Type) => {
      const symbol = part.getAliasSymbol() ?? part.getSymbol();
      const key = symbol && this.keyOf(symbol);
      return key === undefined ? undefined : this.seams.get(key);
    };
    const below = type.isClassOrInterface()
      ? this.checker.getBaseTypes(type)
      : type.isIntersectionType()
        ? type.getTypes()
        : [];
    const shapes = [seamOf(type), ...below.map(seamOf)].filter(
      (shape): shape is SeamShape => shape !== undefined,
    );
    const found = [...new Set(shapes)];
    this.seamsOfTypeCache.set(type.id, found);
    return found;
  }

  /**
   * The typed seams a literal implements: it declares one of a seam's function members or spreads
   * in another object, and spreads in nothing already typed as that seam. `{}` as a default
   * argument and `{ ...deps, now }` are left out.
   */
  private literalImplements(node: ObjectLiteralExpression, typed: SeamShape[]): SeamShape[] {
    if (typed.length === 0) return [];
    const keys = new Set<string>();
    const spreadSeams = new Set<SeamShape>();
    let spreads = false;
    for (const property of node.properties) {
      if (isSpreadAssignment(property)) {
        spreads = true;
        const type = this.checker.getTypeAtLocation(property.expression);
        const parts = type === undefined ? [] : type.isUnionType() ? type.getTypes() : [type];
        for (const part of parts)
          for (const shape of this.seamsOfType(part)) spreadSeams.add(shape);
      } else if (isIdentifier(property.name) || isStringLike(property.name)) {
        keys.add(property.name.text);
      }
    }
    return typed.filter(
      (shape) =>
        !spreadSeams.has(shape) && (spreads || shape.functionNames.some((name) => keys.has(name))),
    );
  }

  private structuralSeams(node: ObjectLiteralExpression): SeamShape[] {
    const keys = new Set<string>();
    for (const property of node.properties) {
      if (isSpreadAssignment(property)) return [];
      const name = property.name;
      if (isIdentifier(name) || isStringLike(name)) keys.add(name.text);
    }
    const shapes = [...this.seams.values()].filter(
      (shape) =>
        !shape.facts.callable &&
        shape.required.every((name) => keys.has(name)) &&
        shape.functionNames.some((name) => keys.has(name)),
    );
    if (shapes.length === 0) return [];
    const type = this.checker.getTypeAtLocation(node);
    if (type === undefined) return [];
    return shapes.filter((shape) => this.checker.isTypeAssignableTo(type, shape.declared));
  }

  /** `x as Seam` or `x satisfies Seam`, where x is not a literal the other rules already count. */
  private castSeam(node: AsExpression | SatisfiesExpression): SeamShape | undefined {
    if (!isTypeReferenceNode(node.type)) return undefined;
    let operand: Expression = node.expression;
    while (isParenthesizedExpression(operand)) operand = operand.expression;
    if (
      isObjectLiteralExpression(operand) ||
      isArrowFunction(operand) ||
      isFunctionExpression(operand)
    ) {
      return undefined;
    }
    return this.seamNamed(rightmostName(node.type.typeName));
  }
}

/**
 * Lines with code on them. Comments are found by scanning the text after the compiler's string,
 * template and regular expression literals are set aside, so a `//` inside a string is code.
 */
function codeLines(file: SourceFile): number {
  const text = file.text;
  const literals: [number, number][] = [];
  const literalKinds = new Set<SyntaxKind>([
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.TemplateHead,
    SyntaxKind.TemplateMiddle,
    SyntaxKind.TemplateTail,
    SyntaxKind.RegularExpressionLiteral,
  ]);
  const visit = (node: Node): void => {
    if (literalKinds.has(node.kind)) literals.push([node.getStart(file), node.end]);
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  literals.sort((left, right) => left[0] - right[0]);
  const code = new Set<number>();
  let line = 0;
  let next = 0;
  let index = 0;
  while (index < text.length) {
    while (next < literals.length && literals[next]![1] <= index) next++;
    const literal = literals[next];
    const char = text[index]!;
    let end = index + 1;
    if (literal !== undefined && literal[0] === index) {
      end = literal[1];
      for (let at = index; at < end; at++) {
        if (text[at] === "\n") line++;
        else if (!/\s/.test(text[at]!)) code.add(line);
      }
      index = end;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      end = newline < 0 ? text.length : newline;
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      end = close < 0 ? text.length : close + 2;
      for (let at = index; at < end; at++) if (text[at] === "\n") line++;
    } else if (char === "\n") {
      line++;
    } else if (!/\s/.test(char)) {
      code.add(line);
    }
    index = end;
  }
  return code.size;
}

/** The export names read off `await import(...)`: `const { a } = await import(...)` or `(await import(...)).a`. */
function namesReadFrom(call: CallExpression): string[] | undefined {
  let node: Node = call;
  while (isAwaitExpression(node.parent) || isParenthesizedExpression(node.parent)) {
    node = node.parent;
  }
  const parent = node.parent;
  if (isPropertyAccessExpression(parent)) {
    return isIdentifier(parent.name) ? [parent.name.text] : undefined;
  }
  if (!isVariableDeclaration(parent) || !isObjectBindingPattern(parent.name)) return undefined;
  const names: string[] = [];
  for (const element of parent.name.elements) {
    const key = element.propertyName ?? element.name;
    if (key === undefined || !(isIdentifier(key) || isStringLike(key))) return undefined;
    names.push(key.text);
  }
  return names;
}

/** The `{ now }` and `{}` of `{ ...deps, ...(ok ? { now } : {}) }`. */
function isSpreadIntoParent(node: ObjectLiteralExpression): boolean {
  let current: Node = node.parent;
  while (
    isParenthesizedExpression(current) ||
    isConditionalExpression(current) ||
    isBinaryExpression(current)
  ) {
    current = current.parent;
  }
  return isSpreadAssignment(current);
}

function isStringLike(node: Node): node is Node & { text: string } {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);
}

/** `Name` in `ns.Name` and `a.b.Name`, for type references and `implements` clauses. */
function rightmostName(node: Node): Node {
  if (isQualifiedName(node)) return node.right;
  if (isPropertyAccessExpression(node)) return node.name;
  return node;
}

/** `a` in `a.b.C`: the export an import type's qualifier starts from. */
function leftmostName(node: Node): string | undefined {
  let current = node;
  while (isQualifiedName(current)) current = current.left;
  return isIdentifier(current) ? current.text : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
