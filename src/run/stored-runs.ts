import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { redactText } from "../evidence/redaction.js";
import {
  bindExistingRunArtifactPaths,
  RUNS_RELATIVE_ROOT,
  isSafeRunIdSegment,
  resolveRunsRoot,
  type PreparedRunArtifactPaths,
} from "./paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  bindExistingManagedHumanishOutputDirectory,
  type PreparedSelectedOutputDirectory,
} from "./contained-output.js";
import { RUN_BUNDLE_FILE, type ReviewSummary } from "./bundle.js";
import type { RunPointer } from "./results.js";
import { isReviewSummary, isRunOutcome } from "./bundle-shape.js";
import {
  bundleDisplayFacts,
  displayedReview,
  runDisplay,
  type DisplayedBundle,
  type RunDisplay,
} from "./display.js";
import { RUN_STATUS_FILE } from "./status.js";
import { readLatest, readRunJsonIfExists, resolveRunPath } from "./locate.js";
import { withCuaReviewProvenance } from "./outcomes.js";
import { isNodeError, isRecord } from "./type-guards.js";
import {
  invalidRunStorageVerifyResult,
  verifyResolvedRun,
  type VerifyResult,
} from "../verify/verify.js";

const RUNS_SCHEMA = "humanish.runs-result.v1";

export interface RunsResult {
  schema: typeof RUNS_SCHEMA;
  ok: boolean;
  cwd: string;
  runs: Array<{
    runId: string;
    createdAt: string | null;
    mode: string | null;
    path: string;
    /** How the run reads (runDisplay in src/run/display.ts); absent when it has no readable run.json. */
    display?: RunDisplay;
  }>;
  latest: string | null;
  error?: {
    code: "HUMANISH_RUNS_UNAVAILABLE";
    message: string;
  };
}

export async function listRuns(cwdInput: string): Promise<RunsResult> {
  const cwd = path.resolve(cwdInput);
  const runsRootPath = resolveRunsRoot(cwd);

  // ENOENT (no .humanish/runs yet) is a normal empty state: ok:true, no runs. Any
  // other readdir failure (e.g. permission denied) is a real I/O failure and must
  // not be swallowed into a false "no runs" report.
  let entries: string[];
  let runsRoot: PreparedSelectedOutputDirectory | null = null;
  try {
    runsRoot = await bindExistingManagedHumanishOutputDirectory(cwd, "runs");
    entries = runsRoot ? await readdir(runsRoot.physicalPath) : [];
    if (runsRoot) {
      await assertPreparedSelectedOutputDirectory(runsRoot);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      entries = [];
    } else {
      return runsUnavailableResult(cwd, error);
    }
  }

  let latest: RunPointer | null;
  try {
    latest = runsRoot ? await readLatest(runsRoot) : null;
  } catch (error) {
    return runsUnavailableResult(cwd, error);
  }

  const runs = [];
  for (const entryName of entries) {
    if (entryName === "latest.json" || !isSafeRunIdSegment(entryName)) {
      continue;
    }
    const entryPath = path.join(runsRootPath, entryName);
    const entryStats = await lstat(entryPath, { bigint: true }).catch(() => null);
    if (!entryStats) {
      continue;
    }
    if (
      entryStats.isSymbolicLink() ||
      (!entryStats.isDirectory() && !entryStats.isFile()) ||
      (entryStats.isFile() && entryStats.nlink > 1n)
    ) {
      return runsUnavailableResult(cwd, new Error(`Unsafe humanish runs entry: ${entryName}`));
    }
    if (!entryStats.isDirectory()) {
      continue;
    }
    let entryRunPaths: PreparedRunArtifactPaths;
    try {
      entryRunPaths = await bindExistingRunArtifactPaths(cwd, entryName);
    } catch (error) {
      return runsUnavailableResult(cwd, error);
    }
    if (runsRoot && entryRunPaths.physicalRunsRoot !== runsRoot.physicalPath) {
      return runsUnavailableResult(
        cwd,
        new Error("humanish runs root changed physical destination."),
      );
    }
    const bundle = await readRunJsonIfExists(entryRunPaths, RUN_BUNDLE_FILE);
    runs.push({
      runId: entryName,
      createdAt: isRecord(bundle) && typeof bundle.createdAt === "string" ? bundle.createdAt : null,
      mode: isRecord(bundle) && typeof bundle.mode === "string" ? bundle.mode : null,
      path: path.join(RUNS_RELATIVE_ROOT, entryName),
      ...(await listedRunDisplay(entryRunPaths, bundle)),
    });
  }

  if (runsRoot) {
    try {
      await assertPreparedSelectedOutputDirectory(runsRoot);
    } catch (error) {
      return runsUnavailableResult(cwd, error);
    }
  }

  return {
    schema: RUNS_SCHEMA,
    ok: true,
    cwd,
    runs: runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    latest: latest?.runId ?? null,
  };
}

/**
 * A listed run's display, from its run.json and, for a bundle without an outcome, its status
 * record. Like the listing's other fields it reads the file without verifying it; a run.json
 * that is not an object naming a run gets none.
 */
async function listedRunDisplay(
  runPaths: PreparedRunArtifactPaths,
  bundle: unknown,
): Promise<{ display?: RunDisplay }> {
  const displayed = displayedBundle(bundle);
  if (displayed === undefined) return {};
  const status =
    displayed.outcome === undefined
      ? await readRunJsonIfExists(runPaths, RUN_STATUS_FILE)
      : undefined;
  return { display: runDisplay(bundleDisplayFacts(displayed, status)) };
}

/** The fields runDisplay reads from an unchecked run.json; none when it does not name a run. */
function displayedBundle(bundle: unknown): DisplayedBundle | undefined {
  if (!isRecord(bundle) || typeof bundle.runId !== "string") return undefined;
  return {
    runId: bundle.runId,
    ...(typeof bundle.mode === "string" ? { mode: bundle.mode } : {}),
    ...(isRecord(bundle.review) && typeof bundle.review.verdict === "string"
      ? { review: { verdict: bundle.review.verdict } }
      : {}),
    ...(Array.isArray(bundle.simulations)
      ? {
          simulations: bundle.simulations
            .filter(isRecord)
            .map((record) => (typeof record.status === "string" ? { status: record.status } : {})),
        }
      : {}),
    ...(isRunOutcome(bundle.outcome) ? { outcome: bundle.outcome } : {}),
  };
}

function runsUnavailableResult(cwd: string, error: unknown): RunsResult {
  return {
    schema: RUNS_SCHEMA,
    ok: false,
    cwd,
    runs: [],
    latest: null,
    error: {
      code: "HUMANISH_RUNS_UNAVAILABLE",
      message: redactText(error instanceof Error ? error.message : String(error)),
    },
  };
}

export async function readReview(
  cwdInput: string,
  runInput: string,
): Promise<VerifyResult | (ReviewSummary & { path: string; runId: string; display?: RunDisplay })> {
  const cwd = path.resolve(cwdInput);
  let runPaths: PreparedRunArtifactPaths | null;
  try {
    runPaths = await resolveRunPath(cwd, runInput);
  } catch {
    return invalidRunStorageVerifyResult(cwd, runInput);
  }
  const verified = await verifyResolvedRun(cwd, runInput, runPaths);

  if (!verified.ok || !verified.bundlePath) {
    return verified;
  }

  const review = runPaths ? await readRunJsonIfExists(runPaths, "review.json") : null;

  if (!isReviewSummary(review)) {
    return {
      ...verified,
      ok: false,
      error: {
        code: "HUMANISH_INVALID_RUN_BUNDLE",
        message: "review.json is missing or invalid.",
      },
    };
  }

  const bundle = runPaths ? await readRunJsonIfExists(runPaths, RUN_BUNDLE_FILE) : null;
  const projected =
    isRecord(bundle) && Array.isArray(bundle.streams)
      ? withCuaReviewProvenance(review, bundle.streams.filter(isRecord))
      : review;
  const displayed = displayedBundle(bundle);
  const { display } = runPaths ? await listedRunDisplay(runPaths, bundle) : {};
  return {
    ...(displayed === undefined || display === undefined
      ? projected
      : displayedReview(projected, displayed, display)),
    path: path.relative(cwd, path.join(runPaths!.absoluteRunRoot, "review.json")),
    runId: path.basename(runPaths!.absoluteRunRoot),
    ...(display === undefined ? {} : { display }),
  };
}
