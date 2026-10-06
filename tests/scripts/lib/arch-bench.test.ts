import { beforeAll, describe, expect, it } from "vitest";
import {
  measureArchitecture,
  type ArchitectureMeasures,
} from "../../../scripts/lib/arch-bench-measure.js";
import {
  readProjectFacts,
  srcFolderOf,
  type ProjectFacts,
} from "../../../scripts/lib/arch-bench-project.js";
import {
  renderMarkdown,
  renderText,
  type ArchBenchResult,
} from "../../../scripts/lib/arch-bench-report.js";

// A three-folder project with known answers. Folder a declares the Shell seam and reaches it
// through an index file that re-exports with `export *` and a rename; folder b imports a by the
// index, by a namespace import and by a dynamic import; src/index.ts imports b.
const root = "/fixture";
const files: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2023",
      lib: ["ES2023"],
      strict: true,
      types: [],
    },
    include: ["src/**/*.ts", "tests/**/*.ts"],
  }),
  "package.json": JSON.stringify({ type: "module" }),
  "src/a/shell.ts": [
    "// The seam.",
    "export interface Shell {",
    "  run(command: string): Promise<string>;",
    "  /* a block",
    "     comment */",
    "  close(): void;",
    "}",
    "",
    'export const VERSION = "1"; // trailing comment',
    "",
  ].join("\n"),
  "src/a/helper.ts": [
    'import { internal } from "./internal.js";',
    "/** Says hello. */",
    "export function helper(): string {",
    "  return `// not a comment ${internal}",
    "* still the string`;",
    "}",
    "",
  ].join("\n"),
  "src/a/internal.ts": "export const internal = 1;\n",
  "src/a/extra.ts": "export const extra = 3;\n",
  "src/a/options.ts": [
    "export interface Options {",
    "  label: string;",
    "  width: number;",
    "  height: number;",
    "  onDone?: () => void;",
    "}",
    "",
  ].join("\n"),
  "src/a/index.ts": [
    'export * from "./shell.js";',
    'export { helper as assist } from "./helper.js";',
    'export { extra } from "./extra.js";',
    "",
  ].join("\n"),
  "src/b/tiny.ts": "export const tiny = 2;\n",
  "src/b/use.ts": [
    'import { type Shell, VERSION, assist, extra } from "../a/index.js";',
    'import type { Options } from "../a/options.js";',
    'import * as shellModule from "../a/shell.js";',
    'import { tiny } from "./tiny.js";',
    "",
    "export interface ClockDeps {",
    "  now?: () => number;",
    "}",
    "",
    "export function go(shell: Shell): Promise<string> {",
    "  return shell.run(`${VERSION} ${assist()} ${tiny + extra} ${Object.keys(shellModule).length}`);",
    "}",
    "",
    "export function stamp(deps: ClockDeps = {}): number {",
    "  return (deps.now ?? Date.now)();",
    "}",
    "",
    "export function configure(options: Options): string {",
    "  return options.label;",
    "}",
    "",
    "export function withClose(shell: Shell): Shell {",
    "  return { ...shell, close() {} };",
    "}",
    "",
    "export const realShell: Shell = {",
    "  async run(command) {",
    "    return command;",
    "  },",
    "  close() {},",
    "};",
    "",
  ].join("\n"),
  "src/b/lazy.ts": [
    "export async function load(): Promise<string> {",
    '  const { helper } = await import("../a/helper.js");',
    "  return helper();",
    "}",
    "",
  ].join("\n"),
  "src/index.ts": 'export { go } from "./b/use.js";\n',
  "tests/a.test.ts": [
    'import { extra } from "../src/a/extra.js";',
    'import { internal } from "../src/a/internal.js";',
    'import { helper } from "../src/a/helper.js";',
    'import type { Shell } from "../src/a/index.js";',
    'import { go, stamp } from "../src/b/use.js";',
    "",
    "declare const vi: { mock(path: string): void; doMock(path: string, factory: () => object): void };",
    'vi.mock("../src/b/tiny.js");',
    'vi.doMock("../src/a/shell.js", () => ({}));',
    'vi.mock("node:fs");',
    "",
    "const fake = {",
    "  async run(command: string) {",
    "    return command;",
    "  },",
    "  close() {},",
    "};",
    "",
    "class FakeShell implements Shell {",
    "  async run(command: string) {",
    "    return command;",
    "  }",
    "  close() {}",
    "}",
    "",
    "const cast = {} as unknown as Shell;",
    "export const all = [extra, internal, helper(), go(fake), go(new FakeShell()), go(cast), stamp({ now: () => 1 })];",
    "",
  ].join("\n"),
};

const absolute = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [`${root}/${path}`, text]),
);

let facts: ProjectFacts;
let measures: ArchitectureMeasures;

beforeAll(() => {
  facts = readProjectFacts(root, absolute);
  measures = measureArchitecture(facts, { maxLines: 3 });
});

const module = (path: string) => facts.modules.find((candidate) => candidate.path === path)!;

describe("arch:bench project facts", () => {
  it("counts code lines without blank lines, comments, or comment-like text inside strings", () => {
    expect(module("src/a/shell.ts").codeLines).toBe(5);
    expect(module("src/a/helper.ts").codeLines).toBe(5);
    expect(module("src/a/internal.ts").codeLines).toBe(1);
  });

  it("follows export *, renamed re-exports, namespace and dynamic imports to declarations", () => {
    const targets = (path: string) =>
      module(path).imports.map((edge) => [edge.target, [...edge.symbols].sort()]);
    expect(targets("src/b/use.ts")).toEqual([
      [
        "src/a/index.ts",
        [
          "src/a/extra.ts#extra",
          "src/a/helper.ts#helper",
          "src/a/shell.ts#Shell",
          "src/a/shell.ts#VERSION",
        ],
      ],
      ["src/a/options.ts", ["src/a/options.ts#Options"]],
      ["src/a/shell.ts", ["src/a/shell.ts#Shell", "src/a/shell.ts#VERSION"]],
      ["src/b/tiny.ts", ["src/b/tiny.ts#tiny"]],
    ]);
    expect(targets("src/b/lazy.ts")).toEqual([["src/a/helper.ts", ["src/a/helper.ts#helper"]]]);
    expect(targets("src/a/index.ts")).toEqual([
      ["src/a/shell.ts", ["src/a/shell.ts#Shell", "src/a/shell.ts#VERSION"]],
      ["src/a/helper.ts", ["src/a/helper.ts#helper"]],
      ["src/a/extra.ts", ["src/a/extra.ts#extra"]],
    ]);
  });
});

describe("arch:bench measures", () => {
  it("measures each folder's interface as the distinct declarations other folders import", () => {
    expect(measures.folders).toEqual([
      {
        folder: "b",
        files: 3,
        codeLines: module("src/b/use.ts").codeLines + 5,
        interfaceSymbols: 1,
        linesPerSymbol: module("src/b/use.ts").codeLines + 5,
        filesImportedFromOutside: 1,
        importingFolders: 1,
      },
      {
        folder: "a",
        files: 6,
        codeLines: 21,
        interfaceSymbols: 5,
        linesPerSymbol: 4,
        filesImportedFromOutside: 4,
        importingFolders: 1,
      },
      {
        folder: "(root)",
        files: 1,
        codeLines: 1,
        interfaceSymbols: 0,
        linesPerSymbol: null,
        filesImportedFromOutside: 0,
        importingFolders: 0,
      },
    ]);
  });

  it("lists small modules exactly one src module imports as deletion-test candidates", () => {
    expect(measures.deletionCandidates).toEqual([
      { path: "src/a/extra.ts", codeLines: 1, importer: "src/a/index.ts", testImporters: 1 },
      { path: "src/a/internal.ts", codeLines: 1, importer: "src/a/helper.ts", testImporters: 1 },
      { path: "src/b/tiny.ts", codeLines: 1, importer: "src/b/use.ts", testImporters: 0 },
      { path: "src/a/index.ts", codeLines: 3, importer: "src/b/use.ts", testImporters: 1 },
    ]);
  });

  it("finds the files tests import past their folder's interface, and the src mocks", () => {
    expect(measures.testSurface).toEqual({
      srcModules: 10,
      testImportedModules: 5,
      share: 5 / 10,
      testFiles: 1,
      testFilesMockingSrc: 1,
      srcMockCalls: 2,
      folders: [
        // extra.ts is reached only through index.ts, but it declares what folder b imports.
        { folder: "a", testImported: 4, pastInterface: ["src/a/internal.ts"] },
        { folder: "b", testImported: 1, pastInterface: [] },
      ],
    });
  });
});

describe("arch:bench seams and report", () => {
  it("finds seams by name and by cross-folder parameter, and counts their implementations", () => {
    const seams = Object.fromEntries(
      facts.seams.map((seam) => [
        seam.name,
        {
          reasons: seam.reasons,
          sites: seam.implementations.map((site) => `${site.path}:${site.line} ${site.kind}`),
        },
      ]),
    );
    // Options carries one callback among four members, so it is an option bag.
    expect(seams).toEqual({
      ClockDeps: { reasons: ["name"], sites: ["tests/a.test.ts:27 typed"] },
      Shell: {
        reasons: ["parameter"],
        sites: [
          "src/b/use.ts:26 typed",
          "tests/a.test.ts:12 structural",
          "tests/a.test.ts:19 implements",
          "tests/a.test.ts:26 cast",
        ],
      },
    });
    expect(
      measures.seams.map((row) => [
        row.name,
        row.srcImplementations,
        row.testImplementations,
        row.verdict,
      ]),
    ).toEqual([
      ["Shell", 1, 3, "production-and-test"],
      ["ClockDeps", 0, 1, "none"],
    ]);
  });

  it("names the top-level src folder of a path", () => {
    expect(srcFolderOf("src/run/run.ts")).toBe("run");
    expect(srcFolderOf("src/routes/terminal/route.ts")).toBe("routes");
    expect(srcFolderOf("src/index.ts")).toBe("(root)");
    expect(srcFolderOf("tests/run.test.ts")).toBeUndefined();
  });

  it("renders every folder and seam in both report forms", () => {
    const empty = { commits: 0, mean: null, max: 0, distribution: {} };
    const result: ArchBenchResult = {
      ...measures,
      schema: "humanish.arch-bench.v1",
      createdAt: "2026-10-06T00:00:00.000Z",
      source: { head: "0123abcd", dirty: false, typescript: "7.0.2" },
      options: { maxLines: 3 },
      history: {
        ref: "origin/main",
        refCommit: "0123abcd",
        since: "2026-09-29",
        locality: { commits: 0, structural: 0, all: empty, behavior: empty },
        routes: {
          touchingOne: 0,
          touchingTwoOrMore: empty,
          baseline: {
            replayBase: "0123abcd",
            commits: 0,
            whenLanded: empty,
            replayed: empty,
            perCommit: [],
          },
        },
      },
    };
    const textRows = renderText(result)
      .split("\n")
      .map((line) => line.split(/\s{2,}/));
    const markdownRows = renderMarkdown(result, "x.json")
      .split("\n")
      .map((line) => line.split(" | "));
    for (const [folder, files] of [
      ["a", "6"],
      ["b", "3"],
      ["(root)", "1"],
    ]) {
      expect(textRows).toContainEqual(expect.arrayContaining([folder, files]));
      expect(markdownRows).toContainEqual(expect.arrayContaining([`| \`${folder}\``, files]));
    }
    for (const seam of ["Shell", "ClockDeps"]) {
      expect(textRows).toContainEqual(expect.arrayContaining([seam]));
      expect(markdownRows).toContainEqual(expect.arrayContaining([`| \`${seam}\``]));
    }
  });
});
