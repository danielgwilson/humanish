// Renders a `pnpm arch:bench` result as the terminal tables and as the dated Markdown summary that
// docs/evidence/architecture/ keeps beside the JSON.
import type { Locality, RouteMetric, Spread } from "./arch-bench-history.js";
import type { ArchitectureMeasures, SeamRow } from "./arch-bench-measure.js";

export interface ArchBenchResult extends ArchitectureMeasures {
  schema: "humanish.arch-bench.v1";
  createdAt: string;
  source: {
    /** HEAD of the checkout that was measured. */
    head: string;
    /** src/, tests/ or tsconfig.json had uncommitted changes. */
    dirty: boolean;
    typescript: string;
  };
  options: { maxLines: number };
  history: {
    ref: string;
    refCommit: string;
    since: string;
    locality: Locality;
    routes: RouteMetric;
  };
}

export const SEAM_RULE =
  "A seam is an interface or type alias declared in src/ that has a function member or is a " +
  "function type, and either its name ends in Deps, Dependencies, Provider, Executor, Adapter or " +
  "Substrate, or a function or constructor parameter in another top-level src folder is " +
  "annotated with it and at least half of its members are functions. An implementation is a " +
  "class that names the seam in implements; an object literal, arrow function or function " +
  "expression the compiler types as the seam, as an interface extending it or as an " +
  "intersection including it; an object literal with no named type that declares every " +
  "required member and a function member and is assignable to the seam; or an as or satisfies " +
  "cast of another expression to the seam. Each site counts once per seam, in src/ or in tests/.";

const VERDICTS: Record<SeamRow["verdict"], string> = {
  none: "no production implementation found",
  "one-adapter": "one adapter",
  "production-and-test": "production and test",
  "two-or-more": "two or more in src/",
};

interface Style {
  markdown: boolean;
  code(text: string): string;
  heading(text: string): string;
  table(headers: string[], rows: (string | number)[][]): string;
}

export function renderText(result: ArchBenchResult): string {
  return render(result, {
    markdown: false,
    code: (text) => text,
    heading: (text) => `${text}\n${"-".repeat(text.length)}`,
    table: textTable,
  });
}

export function renderMarkdown(result: ArchBenchResult, jsonName: string): string {
  return render(
    result,
    {
      markdown: true,
      code: (text) => `\`${text}\``,
      heading: (text) => `## ${text}`,
      table: markdownTable,
    },
    jsonName,
  );
}

function render(result: ArchBenchResult, style: Style, jsonName?: string): string {
  const sections = [
    header(result, style, jsonName),
    depth(result, style),
    deletion(result, style),
    testSurface(result, style),
    seams(result, style),
    locality(result, style),
  ];
  return `${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}

function header(result: ArchBenchResult, style: Style, jsonName?: string): string[] {
  const { source, totals, history } = result;
  const date = result.createdAt.slice(0, 10);
  const dirty = source.dirty ? ", with uncommitted changes in src/ or tests/" : "";
  const links = jsonName
    ? ` Full result: [${jsonName}](${jsonName}). Definitions and limits: [README](README.md).`
    : "";
  return [
    style.markdown
      ? `# Architecture benchmark, ${date}, ${source.head}`
      : `Architecture benchmark, ${date}`,
    "",
    `Measured src/ and tests/ at ${style.code(source.head)}${dirty} with TypeScript ${source.typescript}. ` +
      `History: ${style.code(history.ref)} at ${style.code(history.refCommit)}, commits since ${history.since}.${links}`,
    "",
    `${totals.srcFiles} src files with ${totals.srcCodeLines} code lines; ` +
      `${totals.testFiles} test files with ${totals.testCodeLines} code lines.`,
  ];
}

function depth(result: ArchBenchResult, style: Style): string[] {
  return [
    style.heading("Depth per top-level src folder"),
    "",
    style.table(
      [
        "folder",
        "files",
        "code lines",
        "interface symbols",
        "lines per symbol",
        "files other folders import",
        "importing folders",
      ],
      result.folders.map((row) => [
        style.code(row.folder),
        row.files,
        row.codeLines,
        row.interfaceSymbols,
        row.linesPerSymbol ?? "-",
        row.filesImportedFromOutside,
        row.importingFolders,
      ]),
    ),
  ];
}

function deletion(result: ArchBenchResult, style: Style): string[] {
  const candidates = result.deletionCandidates;
  return [
    style.heading("Deletion-test candidates"),
    "",
    `${candidates.length} src modules have at most ${result.options.maxLines} code lines and exactly one src module importing them.`,
    "",
    style.table(
      ["module", "code lines", "imported by", "test files importing it"],
      candidates.map((row) => [
        style.code(row.path),
        row.codeLines,
        style.code(row.importer),
        row.testImporters,
      ]),
    ),
  ];
}

function testSurface(result: ArchBenchResult, style: Style): string[] {
  const surface = result.testSurface;
  const lines = [
    style.heading("The interface as test surface"),
    "",
    `Tests import ${surface.testImportedModules} of ${surface.srcModules} src modules directly (${Math.round(surface.share * 100)}%). ` +
      `${surface.testFilesMockingSrc} of ${surface.testFiles} test files call vi.mock or vi.doMock on a src module, ${surface.srcMockCalls} calls in all.`,
    "",
    style.table(
      ["folder", "files tests import", "of those, files only the folder itself imports"],
      surface.folders.map((row) => [
        style.code(row.folder),
        row.testImported,
        row.pastInterface.length,
      ]),
    ),
  ];
  const reached = surface.folders.flatMap((row) => row.pastInterface);
  if (style.markdown && reached.length > 0) {
    lines.push(
      "",
      "Files tests import past their folder's interface:",
      "",
      ...reached.map((path) => `- ${style.code(path)}`),
    );
  }
  return lines;
}

function seams(result: ArchBenchResult, style: Style): string[] {
  const count = (verdict: SeamRow["verdict"]) =>
    result.seams.filter((row) => row.verdict === verdict).length;
  const single = result.seams.filter((row) => row.srcImplementations === 1);
  const others = result.seams.filter((row) => row.srcImplementations !== 1);
  return [
    style.heading("Two-adapter rule"),
    "",
    SEAM_RULE,
    "",
    `${result.seams.length} seams: ${count("one-adapter")} with one adapter, ${count("production-and-test")} with one production ` +
      `and at least one test implementation, ${count("two-or-more")} with two or more in src/, and ${count("none")} with no production implementation found.`,
    "",
    `Seams with one production implementation (${single.length}):`,
    "",
    style.table(
      [
        "seam",
        "declared in",
        "found by",
        "function members",
        "src sites",
        "test sites (files)",
        "verdict",
      ],
      single.map((row) => [
        style.code(row.name),
        style.code(row.path),
        row.reasons.join(", "),
        row.callable ? "function type" : `${row.functionMembers} of ${row.members}`,
        row.srcImplementations,
        `${row.testImplementations} (${row.testFiles})`,
        VERDICTS[row.verdict],
      ]),
    ),
    "",
    "Other seams:",
    "",
    style.table(
      ["seam", "declared in", "found by", "src sites (files)", "test sites (files)", "verdict"],
      others.map((row) => [
        style.code(row.name),
        style.code(row.path),
        row.reasons.join(", "),
        `${row.srcImplementations} (${row.srcFiles})`,
        `${row.testImplementations} (${row.testFiles})`,
        VERDICTS[row.verdict],
      ]),
    ),
  ];
}

function locality(result: ArchBenchResult, style: Style): string[] {
  const { history } = result;
  const { locality: spread, routes } = history;
  return [
    style.heading("Locality"),
    "",
    `${spread.commits} commits on ${style.code(history.ref)} since ${history.since}; ${spread.all.commits} touched src/. ` +
      `${spread.structural} of those have a subject starting with Move, Rename, Refactor, Inline or Split.`,
    "",
    style.table(
      ["commits", "count", "mean top-level src folders", "max", "distribution (folders: commits)"],
      [
        ["all that touch src/", ...spreadCells(spread.all)],
        ["without Move, Rename, Refactor, Inline, Split", ...spreadCells(spread.behavior)],
      ],
    ),
    "",
    `Route folders, by the route duplication rules: ${routes.touchingOne} commits touched one or more, and ` +
      `${routes.touchingTwoOrMore.commits} touched two or more, with a mean of ${fixed(routes.touchingTwoOrMore.mean)} ` +
      `and a maximum of ${routes.touchingTwoOrMore.max}.`,
    "",
    `Baseline: the ${routes.baseline.commits} behavior commits touched a mean of ${fixed(routes.baseline.whenLanded.mean)} route folders ` +
      `when they landed (computed from git), and ${fixed(routes.baseline.replayed.mean)} replayed on main at ` +
      `${style.code(routes.baseline.replayBase)} (recorded hand count).`,
  ];
}

function spreadCells(spread: Spread): (string | number)[] {
  const distribution = Object.entries(spread.distribution)
    .map(([folders, commits]) => `${folders}: ${commits}`)
    .join(", ");
  return [spread.commits, fixed(spread.mean), spread.max, distribution];
}

function fixed(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
}

function markdownTable(headers: string[], rows: (string | number)[][]): string {
  const line = (row: (string | number)[]) => `| ${row.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function textTable(headers: string[], rows: (string | number)[][]): string {
  const cells = rows.map((row) => row.map(String));
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...cells.map((row) => row[column]!.length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...cells.map(line)].join(
    "\n",
  );
}
