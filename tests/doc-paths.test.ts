import { describe, expect, it } from "vitest";
import {
  buildRepoIndex,
  findCommentPathIssues,
  findDocPathIssues,
  isCheckedDoc,
  isCheckedSource,
} from "../scripts/lib/doc-paths.js";

const index = buildRepoIndex([
  "README.md",
  "docs/architecture/example.md",
  "docs/ramp/README.md",
  "scripts/tui-smoke.mjs",
  "src/actors/codex/app-server-ui.ts",
  "src/guest-runtime-main.ts",
  "src/routes/terminal/lab.ts",
  "src/run/verify.ts",
  "src/substrates/e2b/desktop-launch.ts",
  "src/substrates/e2b/detached.ts",
  "tests/routes/computer-use/cdp-probe.test.ts",
  "tui/src/app.tsx",
]);

const paths = (issues: { path: string }[]) => issues.map(({ path }) => path);

describe("doc path check", () => {
  it("selects current docs and skips dated history folders", () => {
    expect(
      [
        "README.md",
        "ARCHITECTURE.md",
        "CONTEXT.md",
        "docs/contracts/core.md",
        "docs/goals/current.md",
        "docs/plans/2026-06-01-plan.md",
        "docs/roadmap/v0.md",
        "site/content/docs/quickstart.mdx",
        "site/content/docs/notes.md",
        "tui/AGENTS.md",
        "CHANGELOG.md",
      ].filter(isCheckedDoc),
    ).toEqual([
      "README.md",
      "ARCHITECTURE.md",
      "CONTEXT.md",
      "docs/contracts/core.md",
      "site/content/docs/quickstart.mdx",
    ]);
    expect(
      ["src/run/verify.ts", "src/cli.js", "tests/run.test.ts"].filter(isCheckedSource),
    ).toEqual(["src/run/verify.ts"]);
  });

  it("reports a missing src or tests path with its line and accepts one that exists", () => {
    const text = [
      "Intro.",
      "",
      "See `src/run/verify.ts` and `tests/routes/computer-use/cdp-probe.test.ts` and",
      "`src/run/history.ts:12` and `tests/observer-artifact.test.ts` for details.",
    ].join("\n");
    expect(findDocPathIssues("docs/contracts/run.md", text, index)).toEqual([
      { file: "docs/contracts/run.md", line: 4, path: "src/run/history.ts" },
      { file: "docs/contracts/run.md", line: 4, path: "tests/observer-artifact.test.ts" },
    ]);
  });

  it("resolves relative links from the doc and checks this repo's GitHub source links", () => {
    const text = [
      "[lab](../../src/routes/terminal/lab.ts)",
      "[old](../../src/e2b-terminal-lab.ts)",
      "[one level short](../src/run/verify.ts)",
      "[ok](https://github.com/example/humanish/blob/main/src/run/verify.ts)",
      "[gone](https://github.com/example/humanish/blob/main/src/run.ts)",
    ].join("\n");
    expect(paths(findDocPathIssues("docs/architecture/example.md", text, index))).toEqual([
      "../../src/e2b-terminal-lab.ts",
      "../src/run/verify.ts",
      "src/run.ts",
    ]);
  });

  it("resolves a markdown link from the file that contains it", () => {
    const text = [
      "Read the [ramp](docs/ramp/README.md) first.",
      "Or the [ramp](../ramp/README.md), its [folder](../ramp/) and its [folder](../ramp).",
      "The ramp lives at `docs/ramp/README.md`.",
      "[gone](../ramp/missing.md#intro), [anchor](#intro), [site](/docs/cli), [web](https://example.com/docs/x.md)",
    ].join("\n");
    expect(findDocPathIssues("docs/principles/example.md", text, index)).toEqual([
      {
        file: "docs/principles/example.md",
        line: 1,
        path: "docs/ramp/README.md",
        resolved: "docs/principles/docs/ramp/README.md",
      },
      {
        file: "docs/principles/example.md",
        line: 4,
        path: "../ramp/missing.md",
        resolved: "docs/ramp/missing.md",
      },
    ]);
  });

  it("checks files and directories under every listed root", () => {
    const text = [
      "| `src/run/` | `src/run/verify.ts` | `src/lanes/` |",
      "`scripts/tui-smoke.mjs` and `scripts/gone.mjs`",
      "`tests/fixtures/labs.json`",
      "`tui/src/app.tsx` and `tui/src/navigation.ts`",
      "[example](docs/architecture/example.md) and [gone](docs/architecture/gone.md)",
    ].join("\n");
    expect(paths(findDocPathIssues("ARCHITECTURE.md", text, index))).toEqual([
      "src/lanes/",
      "scripts/gone.mjs",
      "tests/fixtures/labs.json",
      "tui/src/navigation.ts",
      "docs/architecture/gone.md",
    ]);
  });

  it("ignores bundle paths, .js names, nested roots, globs, placeholders and other repositories", () => {
    const text = [
      // Every run bundle has an observer/ folder, so observer/ is not a checked root.
      "`observer/observer-data.json`",
      "`src/cli.js`",
      "`observer/src/missing.ts`",
      "`src/routes/*/lab.ts`",
      "`src/routes/<route>/lab.ts`",
      "https://github.com/example/other/blob/main/src/missing.ts",
    ].join("\n");
    expect(findDocPathIssues("docs/contracts/run.md", text, index)).toEqual([]);
  });
});

describe("src comment path check", () => {
  it("reports a renamed module named in a comment, with its line", () => {
    const text = [
      "// Registry contract. The live implementation is in `e2b-terminal-lab.ts`.",
      "export const x = 1;",
      "/**",
      " * See detached.ts and src/routes/terminal/lab.ts.",
      " * The old loader lived in e2b-desktop-launch.ts.",
      " */",
      "export const y = 2;",
    ].join("\n");
    expect(findCommentPathIssues("src/actors/terminal-agent.ts", text, index)).toEqual([
      { file: "src/actors/terminal-agent.ts", line: 1, path: "e2b-terminal-lab.ts" },
      { file: "src/actors/terminal-agent.ts", line: 5, path: "e2b-desktop-launch.ts" },
    ]);
  });

  it("resolves repo, src and file-relative paths and maps .js specifiers to their source", () => {
    const text = [
      "// src/run/verify.ts, run/verify.ts, routes/terminal/lab.ts and scripts/tui-smoke.mjs exist.",
      "// The guest starts guest-runtime-main.js; ../../run/verify.js is two folders up.",
      "// ./app-server-ui.js is next to this file; tui/src/app.js is emitted from app.tsx.",
    ].join("\n");
    expect(findCommentPathIssues("src/actors/codex/example.ts", text, index)).toEqual([]);
    expect(findCommentPathIssues("src/run/example.ts", "// see ./verify.js\n", index)).toEqual([]);
  });

  it("reports a missing file under a known directory and a missing relative file", () => {
    const text = [
      "// tests/chrome-cdp-probe.test.ts runs it.",
      "// ../run/history.js holds the index.",
      // Resolves to src/app.tsx: only tui/src/app.tsx ends that way, and a relative path must
      // name the exact file.
      "// ../app.tsx is the entry.",
      // A .js specifier maps to .ts or .tsx source; the .mjs script is imported by its own name.
      "// ../../scripts/tui-smoke.js runs it.",
    ].join("\n");
    expect(paths(findCommentPathIssues("src/actors/example.ts", text, index))).toEqual([
      "tests/chrome-cdp-probe.test.ts",
      "../run/history.js",
      "../app.tsx",
      "../../scripts/tui-smoke.js",
    ]);
  });

  it("ignores URLs, packages, absolute paths, build output, examples and product names", () => {
    const text = [
      "// https://example.com/assets/app-shell.js and http://localhost:3000/main.ts",
      "// https://example.com/view?file=missing-module.ts has the name in a query string.",
      "// @e2b/desktop/dist/index.js, node:fs, /opt/humanish/guest-media-worker.js",
      "// dist/tui-app.js is the bundled TUI.",
      '// A scorer ref such as "scorers/example.mjs" or "../outside.mjs" is user input.',
      "// Next.js, node.js and three.js are products; Widget.tsx is a name in the user's app.",
      "// unknown/segment.ts has no known first directory.",
      "// ${name}.ts and src/routes/*/lab.ts are patterns.",
    ].join("\n");
    expect(findCommentPathIssues("src/run/example.ts", text, index)).toEqual([]);
  });

  it("reads comments only", () => {
    const text = 'export const file = "missing-module.ts";\n';
    expect(findCommentPathIssues("src/run/example.ts", text, index)).toEqual([]);
  });
});
