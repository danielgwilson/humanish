// Turns the facts lib/arch-bench-project.ts reads into the numbers `pnpm arch:bench` reports:
// per-folder depth, deletion-test candidates, the interface as test surface and the two-adapter
// rule. Pure functions over plain data, so tests feed them small hand-written projects.
import {
  srcFolderOf,
  type ModuleFacts,
  type ProjectFacts,
  type SeamFacts,
} from "./arch-bench-project.js";

export interface FolderRow {
  folder: string;
  files: number;
  codeLines: number;
  /** Distinct declarations that modules in other src folders import from this folder's files. */
  interfaceSymbols: number;
  /** codeLines / interfaceSymbols, or null when no other folder imports anything. */
  linesPerSymbol: number | null;
  /** Files of this folder that a module in another src folder imports. */
  filesImportedFromOutside: number;
  /** Other src folders that import any file of this folder. */
  importingFolders: number;
}

export interface DeletionCandidate {
  path: string;
  codeLines: number;
  /** The one src module that imports it. */
  importer: string;
  /** Test files that import it too. */
  testImporters: number;
}

export interface FolderTestReach {
  folder: string;
  /** Files of the folder that a test imports. */
  testImported: number;
  /**
   * Of those, the files only modules in the same folder import. Tests reach past the folder's
   * interface to import them.
   */
  pastInterface: string[];
}

export interface TestSurface {
  srcModules: number;
  /** src modules that at least one test file imports. */
  testImportedModules: number;
  share: number;
  testFiles: number;
  /** Test files with at least one `vi.mock` or `vi.doMock` of a src module. */
  testFilesMockingSrc: number;
  /** `vi.mock` and `vi.doMock` calls that replace a src module. */
  srcMockCalls: number;
  folders: FolderTestReach[];
}

export type SeamVerdict = "none" | "one-adapter" | "production-and-test" | "two-or-more";

export interface SeamRow {
  id: string;
  name: string;
  path: string;
  reasons: string[];
  /** The seam is a function type. */
  callable: boolean;
  members: number;
  functionMembers: number;
  srcImplementations: number;
  srcFiles: number;
  testImplementations: number;
  testFiles: number;
  /**
   * none: no production implementation found. one-adapter: one production implementation and no
   * test one. production-and-test: one production implementation and at least one in tests.
   * two-or-more: two or more production implementations.
   */
  verdict: SeamVerdict;
}

export interface ArchitectureMeasures {
  totals: { srcFiles: number; srcCodeLines: number; testFiles: number; testCodeLines: number };
  folders: FolderRow[];
  deletionCandidates: DeletionCandidate[];
  testSurface: TestSurface;
  seams: SeamRow[];
}

export interface MeasureOptions {
  /** A deletion-test candidate has at most this many code lines. */
  maxLines: number;
}

export function measureArchitecture(
  facts: ProjectFacts,
  options: MeasureOptions,
): ArchitectureMeasures {
  const src = facts.modules.filter((module) => module.role === "src");
  const tests = facts.modules.filter((module) => module.role === "test");
  return {
    totals: {
      srcFiles: src.length,
      srcCodeLines: sum(src.map((module) => module.codeLines)),
      testFiles: tests.length,
      testCodeLines: sum(tests.map((module) => module.codeLines)),
    },
    folders: folderRows(facts.modules),
    deletionCandidates: deletionCandidates(facts.modules, options.maxLines),
    testSurface: testSurface(facts.modules),
    seams: seamRows(facts.seams),
  };
}

interface FolderInterface {
  files: number;
  codeLines: number;
  /** Declarations modules in other src folders import, as `<path>#<name>`. */
  symbols: Set<string>;
  /** Files of the folder that modules in other src folders import. */
  targets: Set<string>;
  /** Other src folders that import the folder. */
  importers: Set<string>;
}

/** Each top-level src folder's size and what other src folders import from it. */
function folderInterfaces(modules: readonly ModuleFacts[]): Map<string, FolderInterface> {
  const folders = new Map<string, FolderInterface>();
  const folderOf = (name: string) => {
    let folder = folders.get(name);
    if (folder === undefined) {
      folder = {
        files: 0,
        codeLines: 0,
        symbols: new Set(),
        targets: new Set(),
        importers: new Set(),
      };
      folders.set(name, folder);
    }
    return folder;
  };
  for (const module of modules) {
    const from = srcFolderOf(module.path);
    if (module.role !== "src" || from === undefined) continue;
    const own = folderOf(from);
    own.files++;
    own.codeLines += module.codeLines;
    for (const edge of module.imports) {
      const to = srcFolderOf(edge.target);
      if (to === undefined || to === from) continue;
      const folder = folderOf(to);
      for (const symbol of edge.symbols) folder.symbols.add(symbol);
      folder.targets.add(edge.target);
      folder.importers.add(from);
    }
  }
  return folders;
}

/** One row per top-level src folder, largest first. */
function folderRows(modules: readonly ModuleFacts[]): FolderRow[] {
  return [...folderInterfaces(modules)]
    .map(([folder, row]) => ({
      folder,
      files: row.files,
      codeLines: row.codeLines,
      interfaceSymbols: row.symbols.size,
      linesPerSymbol: row.symbols.size === 0 ? null : Math.round(row.codeLines / row.symbols.size),
      filesImportedFromOutside: row.targets.size,
      importingFolders: row.importers.size,
    }))
    .sort(
      (left, right) => right.codeLines - left.codeLines || left.folder.localeCompare(right.folder),
    );
}

/** src modules of at most `maxLines` code lines that exactly one other src module imports. */
function deletionCandidates(
  modules: readonly ModuleFacts[],
  maxLines: number,
): DeletionCandidate[] {
  const importers = importersOf(modules);
  const candidates: DeletionCandidate[] = [];
  for (const module of modules) {
    if (module.role !== "src" || module.codeLines > maxLines) continue;
    const by = importers.get(module.path);
    const srcImporters = [...(by?.src ?? [])];
    if (srcImporters.length !== 1) continue;
    candidates.push({
      path: module.path,
      codeLines: module.codeLines,
      importer: srcImporters[0]!,
      testImporters: by?.test.size ?? 0,
    });
  }
  return candidates.sort(
    (left, right) => left.codeLines - right.codeLines || left.path.localeCompare(right.path),
  );
}

/**
 * How much of src/ tests reach directly, how often they replace a src module, and per folder the
 * files tests import that are not part of the folder's interface. A file is part of its folder's
 * interface when a module in another src folder imports it, when it declares something another
 * folder imports through a re-export, or when no src module imports it at all (an entry point,
 * such as src/index.ts or a file only scripts load).
 */
function testSurface(modules: readonly ModuleFacts[]): TestSurface {
  const src = modules.filter((module) => module.role === "src");
  const tests = modules.filter((module) => module.role === "test");
  const srcPaths = new Set(src.map((module) => module.path));
  const importers = importersOf(modules);
  const testImported = src.filter((module) => (importers.get(module.path)?.test.size ?? 0) > 0);
  let srcMockCalls = 0;
  let testFilesMockingSrc = 0;
  for (const test of tests) {
    const calls = test.mocks.filter((target) => srcPaths.has(target)).length;
    srcMockCalls += calls;
    if (calls > 0) testFilesMockingSrc++;
  }
  const interfaces = folderInterfaces(modules);
  const declaresInterface = new Set(
    [...interfaces.values()].flatMap((folder) =>
      [...folder.symbols].map((symbol) => symbol.slice(0, symbol.lastIndexOf("#"))),
    ),
  );
  const folders = new Map<string, FolderTestReach>();
  for (const module of testImported) {
    const folder = srcFolderOf(module.path)!;
    const reach = folders.get(folder) ?? { folder, testImported: 0, pastInterface: [] };
    reach.testImported++;
    const inInterface =
      interfaces.get(folder)?.targets.has(module.path) ||
      declaresInterface.has(module.path) ||
      importers.get(module.path)!.src.size === 0;
    if (!inInterface) reach.pastInterface.push(module.path);
    folders.set(folder, reach);
  }
  return {
    srcModules: src.length,
    testImportedModules: testImported.length,
    share: src.length === 0 ? 0 : testImported.length / src.length,
    testFiles: tests.length,
    testFilesMockingSrc,
    srcMockCalls,
    folders: [...folders.values()]
      .map((reach) => ({ ...reach, pastInterface: reach.pastInterface.sort() }))
      .sort(
        (left, right) =>
          right.pastInterface.length - left.pastInterface.length ||
          left.folder.localeCompare(right.folder),
      ),
  };
}

/** Every seam with its implementation counts, the ones with one production implementation first. */
function seamRows(seams: readonly SeamFacts[]): SeamRow[] {
  const order: Record<SeamVerdict, number> = {
    "one-adapter": 0,
    "production-and-test": 1,
    none: 2,
    "two-or-more": 3,
  };
  return seams
    .map((seam) => {
      const src = seam.implementations.filter((site) => site.path.startsWith("src/"));
      const tests = seam.implementations.filter((site) => site.path.startsWith("tests/"));
      const verdict: SeamVerdict =
        src.length === 0
          ? "none"
          : src.length >= 2
            ? "two-or-more"
            : tests.length > 0
              ? "production-and-test"
              : "one-adapter";
      return {
        id: seam.id,
        name: seam.name,
        path: seam.path,
        reasons: seam.reasons,
        callable: seam.callable,
        members: seam.members,
        functionMembers: seam.functionMembers,
        srcImplementations: src.length,
        srcFiles: new Set(src.map((site) => site.path)).size,
        testImplementations: tests.length,
        testFiles: new Set(tests.map((site) => site.path)).size,
        verdict,
      };
    })
    .sort(
      (left, right) =>
        order[left.verdict] - order[right.verdict] || left.id.localeCompare(right.id),
    );
}

/** For each module, the src and test files that import it, self-imports aside. */
function importersOf(
  modules: readonly ModuleFacts[],
): Map<string, { src: Set<string>; test: Set<string> }> {
  const importers = new Map<string, { src: Set<string>; test: Set<string> }>();
  for (const module of modules) {
    for (const edge of module.imports) {
      if (edge.target === module.path) continue;
      const by = importers.get(edge.target) ?? { src: new Set<string>(), test: new Set<string>() };
      by[module.role].add(module.path);
      importers.set(edge.target, by);
    }
  }
  return importers;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
