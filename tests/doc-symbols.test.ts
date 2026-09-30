import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findDocSymbolIssues, findSymbolReferences } from "../scripts/lib/doc-symbols.js";

// Negative fixtures start from real files, so a change to how they declare a name is caught here
// before a doc points at it.
const real = (path: string) => readFileSync(path, "utf8");
const repo =
  (overrides: Record<string, string> = {}) =>
  (path: string) =>
    overrides[path] ?? (existsSync(path) ? real(path) : undefined);
const issues = (doc: string, overrides?: Record<string, string>) =>
  findDocSymbolIssues("docs/example.md", doc, repo(overrides)).map(
    ({ line, name, path }) => `${line} ${name} ${path}`,
  );

describe("doc symbol check", () => {
  it("reads the three explicit forms and nothing looser", () => {
    const doc = [
      "`routeOf` (`src/lab/plan.ts`) picks a route, and `runLab()` in `src/lab/engine.ts` runs it.",
      "`verifyRun` from `src/run/verify.ts`, `startRun` at `src/run/run.ts`, and",
      "(`reclaimPreflightSandboxes`, `src/run/reclaim.ts`) and `resolveLabManifest`",
      "   (`src/lab/discover.ts`).",
      "Not read: `routeOf` and `src/lab/plan.ts`; `LabConfig`, see `src/lab/types.ts`;",
      "`routeOf` (`docs/architecture/example.md`) and `--json` in `src/cli.ts`.",
    ].join("\n");
    expect(findSymbolReferences(doc)).toEqual([
      { line: 1, name: "routeOf", path: "src/lab/plan.ts" },
      { line: 1, name: "runLab", path: "src/lab/engine.ts" },
      { line: 2, name: "verifyRun", path: "src/run/verify.ts" },
      { line: 2, name: "startRun", path: "src/run/run.ts" },
      { line: 3, name: "reclaimPreflightSandboxes", path: "src/run/reclaim.ts" },
      { line: 3, name: "resolveLabManifest", path: "src/lab/discover.ts" },
    ]);
  });

  it("resolves declarations, members, re-exports and schema ids in the current files", () => {
    const doc = [
      "`routeOf` (`src/lab/plan.ts`), `FinishedRun.renderObserver` in `src/run/run.ts`,",
      "`LabOutcome.backend` in `src/index.ts`, `humanish.pricing.v1` in `src/run/pricing.ts`,",
      "`LabConfig` in `src/lab/types.ts`, `deriveFeedback` (`src/routes/terminal/types.ts`),",
      "`producesScreenshots` (`src/lab/routing.ts`),",
      "and `routeOf` (`src/lab/missing-file.ts`).",
    ].join("\n");
    expect(issues(doc)).toEqual([]);
  });

  it("fails when an existing file renames the symbol", () => {
    const plan = real("src/lab/plan.ts").replace(/\brouteOf\b/g, "routeFor");
    expect(issues("`routeOf` (`src/lab/plan.ts`)", { "src/lab/plan.ts": plan })).toEqual([
      "1 routeOf src/lab/plan.ts",
    ]);
  });

  it("fails when an existing file removes the symbol", () => {
    const pricing = real("src/run/pricing.ts").replace(
      /^export const PRICING_SCHEMA = .*$/m,
      'export const PRICING_SCHEMA = "humanish.pricing.v2";',
    );
    expect(
      issues("`humanish.pricing.v1` in `src/run/pricing.ts`", { "src/run/pricing.ts": pricing }),
    ).toEqual(["1 humanish.pricing.v1 src/run/pricing.ts"]);
  });

  it("fails when an existing file renames a member of a class it declares", () => {
    const run = real("src/run/run.ts").replace(/\brenderObserver\b/g, "renderHtml");
    expect(
      issues("`FinishedRun.renderObserver` in `src/run/run.ts`", { "src/run/run.ts": run }),
    ).toEqual(["1 FinishedRun.renderObserver src/run/run.ts"]);
  });

  it("fails when an existing file renames a field a doc names bare", () => {
    const types = real("src/routes/terminal/types.ts").replace(
      /\bderiveFeedback\b/g,
      "deriveFindings",
    );
    expect(
      issues("`deriveFeedback` (`src/routes/terminal/types.ts`)", {
        "src/routes/terminal/types.ts": types,
      }),
    ).toEqual(["1 deriveFeedback src/routes/terminal/types.ts"]);
  });

  it("fails when an existing file stops reading a field a doc says it checks", () => {
    const routing = real("src/lab/routing.ts").replace(
      /capabilities\.producesScreenshots/g,
      "capabilities.screenshots",
    );
    expect(
      issues("`producesScreenshots` (`src/lab/routing.ts`)", { "src/lab/routing.ts": routing }),
    ).toEqual(["1 producesScreenshots src/lab/routing.ts"]);
  });

  it("fails when the doc names a file that only imports the symbol", () => {
    expect(issues("`routeOf` in `src/lab/engine.ts`")).toEqual(["1 routeOf src/lab/engine.ts"]);
  });

  it("fails when a re-export is dropped from an existing file", () => {
    const index = real("src/index.ts").replace(/\bLabOutcome, /, "");
    expect(issues("`LabOutcome.backend` in `src/index.ts`", { "src/index.ts": index })).toEqual([
      "1 LabOutcome.backend src/index.ts",
    ]);
  });
});
