import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { isRecord } from "../../src/run/type-guards.js";
import { inflateProjections } from "./run-golden-projections.js";

// Every failure golden under tests/golden/failures, restored to a run directory a surface can
// read, plus three runs no golden holds: a run stopped by SIGINT, and a run whose participant was
// blocked or timed out. tests/run/outcome-surfaces.test.ts and tui/tests/outcome-surfaces.test.tsx
// read the same table, so every surface that says whether a run passed is checked on one set.

const FAILURES = path.resolve(import.meta.dirname, "../golden/failures");
const AT = "2026-10-01T06:00:00.000Z";

/** What a run's display state is, as every surface must show it. */
type ExpectedState = "running" | "passed" | "failed" | "blocked" | "timed_out" | "interrupted";

export interface OutcomeCase {
  /** The golden's name under tests/golden/failures, or `synthetic/<what>`. */
  name: string;
  expected: ExpectedState;
  /** The run directory's files, by path relative to it; `../latest.json` is the runs root pointer. */
  files: Record<string, unknown>;
  /** The golden's review.md and observer-data.json were written by the route for this outcome. */
  routeWritten: boolean;
}

const FAILURE_GOLDENS = [
  "computer-use/cleanup-unconfirmed",
  "computer-use/desktop-module-missing",
  "computer-use/session-throws",
  "scripted/browser-launch-fails",
  "scripted/clone-install-fails",
  "scripted/session-throws",
  "shared-world/seat-actor-error",
  "shared-world/seat-harness-error",
  "terminal/product-install-fails",
  "terminal/runtime-bootstrap-throws",
  "terminal/teardown-unproven",
] as const;

// The one golden whose result is ok: a sandbox release that is unconfirmed only warns on this route.
const PASSING = new Set<string>(["computer-use/cleanup-unconfirmed"]);

// Placeholders runDirSnapshot writes for measured numbers; a reader needs numbers there.
const NUMBERS: Record<string, number> = {
  "[pid]": 4242,
  "[epoch-ms]": Date.parse(AT),
  "[durationMs]": 1000,
  "[elapsedMs]": 1000,
  "[wallMs]": 1000,
  "[minutes]": 1,
  "[desktopMinutes]": 1,
};

function restore(value: unknown, runId: string): unknown {
  if (typeof value === "string") {
    if (value === "[fresh]") return new Date().toISOString();
    if (value in NUMBERS) return NUMBERS[value];
    return value.split("[run]").join(runId).split("[ts]").join(AT);
  }
  if (Array.isArray(value)) return value.map((entry) => restore(entry, runId));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, restore(entry, runId)]),
    );
  return value;
}

async function golden(name: string): Promise<Record<string, unknown>> {
  const snapshot = JSON.parse(
    await readFile(path.join(FAILURES, `${name}.json`), "utf8"),
  ) as Record<string, unknown>;
  return inflateProjections(snapshot);
}

const clone = <T>(value: T): T => structuredClone(value);

/** A blank 1x1 PNG, written where the golden holds a screenshot's digest. */
const PLACEHOLDER_PNG = PNG.sync.write(new PNG({ width: 1, height: 1 }));

function record(files: Record<string, unknown>, file: string): Record<string, unknown> {
  const value = files[file];
  if (!isRecord(value)) throw new Error(`${file} is not a JSON object in the golden`);
  return value;
}

/**
 * The passing golden with its participant judged `verdict`, as a gate route then fails it; the run
 * writes review.json from run.json's review, so both carry the verdict.
 */
function judgedAs(
  files: Record<string, unknown>,
  verdict: "blocked" | "timed_out",
): Record<string, unknown> {
  const next = clone(files);
  const run = record(next, "run.json");
  run.review = { ...(run.review as object), verdict };
  next["review.json"] = run.review;
  if (isRecord(run.outcome)) run.outcome = { ...run.outcome, ok: false };
  const status = record(next, "status.json");
  status.outcome = { ...(status.outcome as object), verdict, ok: false };
  record(next, "<result>").ok = false;
  return next;
}

/**
 * The passing golden stopped by SIGINT before it finished: run.json is the last live flush, with
 * the outcome the signal handler writes, review.json is that flush's review, and status.json is
 * the interrupted record.
 */
function interrupted(files: Record<string, unknown>): Record<string, unknown> {
  const next = clone(files);
  const run = record(next, "run.json");
  run.review = { ...(run.review as object), verdict: "contract_proof_only" };
  next["review.json"] = run.review;
  run.simulations = (run.simulations as Record<string, unknown>[]).map((simulation) => ({
    ...simulation,
    status: "running",
  }));
  run.outcome = { state: "interrupted", ok: false, signal: "SIGINT", at: AT };
  const status = record(next, "status.json");
  delete status.outcome;
  status.state = "interrupted";
  status.signal = "SIGINT";
  record(next, "<result>").ok = false;
  return next;
}

function unfinished(
  files: Record<string, unknown>,
  status: "missing" | "fresh" | "stale" | "invalid" | "mismatched",
) {
  const next = interrupted(files);
  delete record(next, "run.json").outcome;
  const heartbeat = record(next, "status.json");
  heartbeat.state = "running";
  delete heartbeat.signal;
  delete heartbeat.completedAt;
  if (status === "missing") delete next["status.json"];
  if (status === "invalid") next["status.json"] = {};
  if (status === "mismatched") heartbeat.runId = "another-run";
  if (status === "fresh") heartbeat.updatedAt = "[fresh]";
  return next;
}

function betweenWrites(files: Record<string, unknown>) {
  const next = clone(files);
  const heartbeat = record(next, "status.json");
  heartbeat.state = "running";
  delete heartbeat.completedAt;
  delete heartbeat.outcome;
  return next;
}

/** Every case, the failure goldens first. */
export async function outcomeCases(): Promise<OutcomeCase[]> {
  const cases: OutcomeCase[] = [];
  for (const name of FAILURE_GOLDENS) {
    cases.push({
      name,
      expected: PASSING.has(name) ? "passed" : "failed",
      files: await golden(name),
      routeWritten: true,
    });
  }
  const passing = await golden("computer-use/cleanup-unconfirmed");
  cases.push(
    {
      name: "synthetic/blocked",
      expected: "blocked",
      files: judgedAs(passing, "blocked"),
      routeWritten: false,
    },
    {
      name: "synthetic/timed-out",
      expected: "timed_out",
      files: judgedAs(passing, "timed_out"),
      routeWritten: false,
    },
    {
      name: "synthetic/interrupted",
      expected: "interrupted",
      files: interrupted(passing),
      routeWritten: false,
    },
  );
  for (const status of ["missing", "fresh", "stale", "invalid", "mismatched"] as const) {
    cases.push({
      name: `synthetic/no-outcome-${status}`,
      expected: status === "fresh" ? "running" : "interrupted",
      files: unfinished(passing, status),
      routeWritten: false,
    });
  }
  cases.push({
    name: "synthetic/between-writes",
    expected: "passed",
    files: betweenWrites(passing),
    routeWritten: false,
  });
  return cases;
}

/**
 * Write one case as the only run of a new project under `root`, with the placeholders replaced by
 * readable values. A binary file the golden holds only as a digest (every one is a screenshot) is
 * written as a blank 1x1 PNG, so verify, which `humanish review` runs first, finds each referenced
 * frame. The Observer page is left out: no reader here opens it.
 */
export async function writeOutcomeCase(
  root: string,
  outcome: OutcomeCase,
): Promise<{ cwd: string; runId: string }> {
  const cwd = await mkdtemp(path.join(root, "project-"));
  const runId = `outcome-${outcome.name.replace(/[^a-z0-9]+/g, "-")}`;
  const runsRoot = path.join(cwd, ".humanish", "runs");
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  for (const [file, value] of Object.entries(outcome.files)) {
    if (file.startsWith("<") || file === "observer/index.html") continue;
    const target = path.resolve(runDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    if (typeof value === "string" && value.startsWith("sha256:")) {
      await writeFile(target, PLACEHOLDER_PNG);
      continue;
    }
    const restored = restore(value, runId);
    const text =
      typeof restored === "string"
        ? restored
        : file.endsWith(".ndjson") && Array.isArray(restored)
          ? `${restored.map((line) => JSON.stringify(line)).join("\n")}\n`
          : `${JSON.stringify(restored, null, 2)}\n`;
    await writeFile(target, text, "utf8");
  }
  return { cwd, runId };
}

/** A temp root for the cases, named so the suite's temp-leak guard checks it. */
export function outcomeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "humanish-outcome-"));
}
