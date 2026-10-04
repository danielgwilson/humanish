import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { type Command, CommanderError } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { buildObserverData, type ObserverData } from "../../src/observer/data.js";
import type { LibraryHistory } from "../../src/observer/library.js";
import { serveObserverLibrary } from "../../src/observer/serve.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { computeStats } from "../../src/run/stats.js";
import { listRuns } from "../../src/run/stored-runs.js";
import {
  outcomeCases,
  outcomeRoot,
  writeOutcomeCase,
  type OutcomeCase,
} from "../helpers/outcome-fixtures.js";

// Every surface that says whether a run passed, on every failure golden plus a blocked, a timed-out
// and an interrupted run. Each surface must show the case's state, so no surface shows a pass for a
// run that failed and all of them agree. The TUI's glyphs are checked on the same table in
// tui/tests/outcome-surfaces.test.tsx.

/** A surface's state, or its verdict where a surface shows no state, as surfaces before 0.110.1 did. */
interface Shown {
  display?: { state: string } | undefined;
  verdict?: string | undefined;
  mode?: string | null | undefined;
}

function shownState(shown: Shown): string {
  if (shown.display !== undefined) return shown.display.state;
  switch (shown.verdict) {
    case undefined:
      return "none";
    case "pass":
      return "passed";
    case "fail":
      return "failed";
    case "contract_proof_only":
      return shown.mode === "dry-run" ? "dry_run" : "no_verdict";
    default:
      return shown.verdict;
  }
}

type Display = { display?: { state: string } };
const displayOf = (value: unknown): { state: string } | undefined => (value as Display).display;

const ofObserverData = (data: ObserverData): string =>
  shownState({ display: displayOf(data.run), verdict: data.run.status, mode: data.run.mode });

interface Surfaces {
  /** What each surface shows, by surface name. */
  states: Record<string, string>;
  /** The served Observer's process status for the run. */
  runtime: string | undefined;
}

async function readSurfaces(root: string, outcome: OutcomeCase): Promise<Surfaces> {
  const { cwd, runId } = await writeOutcomeCase(root, outcome);
  const runDir = path.join(cwd, ".humanish", "runs", runId);
  const states: Record<string, string> = {};

  const stats = await computeStats(cwd);
  if (!stats.ok) throw new Error(stats.error.message);
  const outcomes = (stats.totals as { outcomes?: Record<string, number> }).outcomes;
  const counted = Object.keys(outcomes ?? stats.totals.verdicts);
  states["stats state"] =
    outcomes === undefined
      ? shownState({ verdict: counted[0], mode: stats.totals.dryRun === 1 ? "dry-run" : "live" })
      : (counted[0] ?? "none");
  states["stats pass count"] = stats.studies[0]?.passed === 1 ? "passed" : "not passed";

  const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
  states["Observer data"] = ofObserverData(buildObserverData(bundle));
  if (outcome.routeWritten) {
    const written = JSON.parse(
      await readFile(path.join(runDir, "observer", "observer-data.json"), "utf8"),
    ) as ObserverData;
    states["Observer data the route wrote"] = ofObserverData(written);
    const review = await readFile(path.join(runDir, "review.md"), "utf8");
    const line = /^- outcome: (.+)$/m.exec(review)?.[1];
    const verdict = /^- (?:verdict|run gate): (\S+)/m.exec(review)?.[1];
    states["review.md"] =
      line === undefined ? shownState({ verdict, mode: bundle.mode }) : stateOfLabel(line);
  }

  const runs = await listRuns(cwd);
  states["runs list"] = shownState({ display: displayOf(runs.runs[0]) });
  // review prints nothing about a run that fails verify; verify says why.
  const headline = await reviewHeadline(cwd, runId);
  if (headline !== undefined) states["review headline"] = stateOfLabel(headline);

  const started = await serveObserverLibrary(cwd, {
    port: 0,
    safe: false,
    expose: false,
    edgeAuthed: false,
  });
  if (!started.ok) throw new Error(started.error.message);
  try {
    const history = (await (
      await fetch(new URL("/_humanish/history.json", started.server.url))
    ).json()) as LibraryHistory;
    const row = history.runs.find((candidate) => candidate.runId === runId);
    states["run library"] = shownState({
      display: displayOf(row),
      verdict: row?.status,
      mode: row?.mode,
    });
    const served = (await (
      await fetch(
        new URL(`/_humanish/runs/${runId}/observer/observer-data.json`, started.server.url),
      )
    ).json()) as ObserverData;
    states["served Observer"] = ofObserverData(served);
    return { states, runtime: served.runtime?.state };
  } finally {
    await started.server.close();
  }
}

/** `humanish review`'s headline: what its first line says after the run id, when it prints one. */
async function reviewHeadline(cwd: string, runId: string): Promise<string | undefined> {
  const out: string[] = [];
  const program = createProgram({
    writeOut: (text) => out.push(text),
    writeErr: () => {},
    setExitCode: () => {},
  });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(["node", "humanish", "review", "--run", runId, "--cwd", cwd], {
      from: "node",
    });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
  }
  return /^humanish review \S+: (.+)$/m.exec(out.join(""))?.[1];
}

// The words a review.md outcome line or a review headline starts with, as states. Before 0.110.2
// the headline said the verdict ("pass", "fail") wherever it did not lead with a display label.
const STATES_BY_WORD: Record<string, string> = {
  pass: "passed",
  fail: "failed",
  "timed out": "timed_out",
  "no verdict": "no_verdict",
  "dry run": "dry_run",
};

/** The state a label names: a review.md outcome line and review's headline start with it. */
function stateOfLabel(line: string): string {
  const label = line.split(/[:;(]/)[0]!.trim();
  return STATES_BY_WORD[label] ?? label;
}

let root: string;
const cases = await outcomeCases();
const shown = new Map<string, Surfaces>();

beforeAll(async () => {
  root = await outcomeRoot();
  for (const outcome of cases) shown.set(outcome.name, await readSurfaces(root, outcome));
}, 120_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.each(cases.map((outcome) => [outcome.name, outcome] as const))("%s", (_name, outcome) => {
  it("shows a pass on no surface unless the run passed", () => {
    const passing = Object.entries(shown.get(outcome.name)!.states)
      .filter(([, state]) => state === "passed")
      .map(([surface]) => surface);
    expect(passing).toEqual(
      outcome.expected === "passed" ? Object.keys(shown.get(outcome.name)!.states) : [],
    );
  });

  it(`shows ${outcome.expected} on every surface`, () => {
    const states = shown.get(outcome.name)!.states;
    const expected = Object.fromEntries(
      Object.keys(states).map((surface) => [
        surface,
        surface === "stats pass count"
          ? outcome.expected === "passed"
            ? "passed"
            : "not passed"
          : outcome.expected,
      ]),
    );
    expect(states).toEqual(expected);
  });
});

it("prints a review headline for every case but the one verify refuses", () => {
  const without = cases
    .filter((outcome) => shown.get(outcome.name)!.states["review headline"] === undefined)
    .map((outcome) => outcome.name);
  expect(without).toEqual(["terminal/teardown-unproven"]);
});

it("shows the interrupted run as interrupted in the served Observer's process status", () => {
  expect(shown.get("synthetic/interrupted")!.runtime).toBe("interrupted");
});
