import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { redactText } from "../evidence/redaction.js";
import type { E2BDesktopModule } from "../substrates/e2b/sdk.js";
import {
  bindExistingRunArtifactPaths,
  RUNS_RELATIVE_ROOT,
  isSafeRunIdSegment,
  resolveRunsRoot,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "./paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  bindExistingManagedHumanishOutputDirectory,
  prepareContainedOutputFile,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
  writeContainedOutputFile,
} from "./contained-output.js";
import {
  RUN_BUNDLE_FILE,
  PUBLIC_TARGET_CWD,
  type ReviewSummary,
  type RunBundle,
} from "./bundle.js";
import {
  CLEANUP_SCHEMA,
  type CleanupAdapterResult,
  type CleanupResourceResult,
  type CleanupResult,
  type RunPointer,
} from "./results.js";
import { isReviewSummary, isRunBundle } from "./guards.js";
import { readLatest, readRunJsonIfExists, resolveRunPath } from "./locate.js";
import { withCuaReviewProvenance } from "./outcomes.js";
import { isNodeError, isRecord } from "./primitives.js";
import {
  invalidRunStorageVerifyResult,
  verifyResolvedRun,
  type VerifyResult,
} from "../verify/verify.js";

const RUNS_SCHEMA = "humanish.runs-result.v1";

export interface RunCleanupHooks {
  /** @deprecated Ignored. Stored provider ids are not authority to load or mutate a provider. */
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  cleanupAdapterResources?: (ctx: {
    cwd: string;
    runDir: string;
    bundle: RunBundle;
  }) => Promise<CleanupAdapterResult[]>;
  now?: () => Date;
}

export interface RunsResult {
  schema: typeof RUNS_SCHEMA;
  ok: boolean;
  cwd: string;
  runs: Array<{
    runId: string;
    createdAt: string | null;
    mode: string | null;
    path: string;
  }>;
  latest: string | null;
  error?: {
    code: "HUMANISH_RUNS_UNAVAILABLE";
    message: string;
  };
}

/** A cleanup result that refused before inspecting any resource. */
function cleanupRefusal(
  cwd: string,
  runInput: string,
  checkedAt: string,
  error: NonNullable<CleanupResult["error"]>,
  bundlePath?: string,
): CleanupResult {
  return {
    schema: CLEANUP_SCHEMA,
    ok: false,
    cwd,
    run: runInput,
    ...(bundlePath === undefined ? {} : { bundlePath }),
    checkedAt,
    summary: { resources: 0, killed: 0, alreadyClean: 0, failed: 0, skipped: 0 },
    resources: [],
    adapterResults: [],
    warnings: [],
    error,
  };
}

/** What the recorded evidence says about one provider resource; nothing is killed from here. */
function recordedResourceResult(
  resource: NonNullable<RunBundle["providerResources"]>[number],
): CleanupResourceResult {
  const base = { provider: resource.provider, kind: resource.kind, id: resource.id };
  if (resource.provider !== "e2b-desktop" || resource.kind !== "sandbox") {
    return {
      ...base,
      status: "skipped",
      message: "cleanup only supports e2b-desktop sandbox resources",
    };
  }
  if (resource.status === "killed" || resource.cleanup?.killed === true) {
    return {
      ...base,
      status: "already_clean",
      message: "resource was already recorded as killed",
    };
  }
  return {
    ...base,
    status: "failed",
    message: "automatic provider cleanup requires a verified resource lease",
  };
}

export async function cleanupRun(
  cwdInput: string,
  runInput: string,
  hooks: RunCleanupHooks = {},
): Promise<CleanupResult> {
  const cwd = path.resolve(cwdInput);
  const checkedAt = (hooks.now ?? (() => new Date()))().toISOString();
  let resolved: PreparedRunArtifactPaths | null;
  try {
    resolved = await resolveRunPath(cwd, runInput);
  } catch {
    return cleanupRefusal(cwd, runInput, checkedAt, {
      code: "HUMANISH_INVALID_RUN_BUNDLE",
      message: "Run storage failed containment validation.",
    });
  }

  if (!resolved) {
    return cleanupRefusal(cwd, runInput, checkedAt, {
      code: "HUMANISH_RUN_NOT_FOUND",
      message: `Run not found: ${runInput}`,
    });
  }

  const runPaths = resolved;
  const bundlePath = path.join(runPaths.absoluteRunRoot, RUN_BUNDLE_FILE);
  const cleanupPath = path.join(runPaths.absoluteRunRoot, "cleanup.json");
  await prepareContainedOutputFile(runPaths, "cleanup.json");
  const bundleBytes = await readContainedRegularFile(runPaths, RUN_BUNDLE_FILE);
  let bundle: unknown = null;
  if (bundleBytes) {
    try {
      bundle = JSON.parse(bundleBytes.toString("utf8")) as unknown;
    } catch {
      bundle = null;
    }
  }

  if (!isRunBundle(bundle)) {
    return cleanupRefusal(
      cwd,
      runInput,
      checkedAt,
      {
        code: "HUMANISH_INVALID_RUN_BUNDLE",
        message: "Run bundle failed cleanup shape validation.",
      },
      path.relative(cwd, bundlePath),
    );
  }

  const warnings: string[] = [];
  const providerResources = bundle.providerResources ?? [];
  const resources = providerResources.map(recordedResourceResult);

  let adapterResults: CleanupAdapterResult[] = [];
  if (hooks.cleanupAdapterResources) {
    try {
      adapterResults = await hooks.cleanupAdapterResources({
        cwd,
        runDir: runPaths.physicalRunRoot,
        bundle,
      });
    } catch (error) {
      adapterResults = [
        {
          id: "adapter-cleanup",
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        },
      ];
    }
    await validatePreparedRunArtifactPaths(runPaths);
  }

  if (providerResources.length === 0 && adapterResults.length === 0) {
    warnings.push("Run bundle recorded no provider resource evidence; nothing to inspect.");
  }

  const summary = {
    resources: resources.length,
    killed: resources.filter((resource) => resource.status === "killed").length,
    alreadyClean: resources.filter((resource) => resource.status === "already_clean").length,
    failed:
      resources.filter((resource) => resource.status === "failed").length +
      adapterResults.filter((result) => !result.ok).length,
    skipped: resources.filter((resource) => resource.status === "skipped").length,
  };
  const ok = summary.failed === 0;
  const result: CleanupResult = {
    schema: CLEANUP_SCHEMA,
    ok,
    cwd: PUBLIC_TARGET_CWD,
    run: runInput,
    runId: bundle.runId,
    bundlePath: path.relative(cwd, bundlePath),
    cleanupPath: path.relative(cwd, cleanupPath),
    checkedAt,
    summary,
    resources,
    adapterResults,
    warnings,
  };
  await validatePreparedRunArtifactPaths(runPaths);
  await writeContainedOutputFile(
    runPaths,
    "cleanup.json",
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return result;
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
): Promise<VerifyResult | (ReviewSummary & { path: string; runId: string })> {
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
  return {
    ...projected,
    path: path.relative(cwd, path.join(runPaths!.absoluteRunRoot, "review.json")),
    runId: path.basename(runPaths!.absoluteRunRoot),
  };
}
