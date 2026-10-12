// The publish boundary for existing raw runs. A derivative is an isolated
// workspace, never a new run in the source history. No provider APIs are involved.
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import type { ExportFailure, ExportOptions, ExportResult } from "./export.js";
import { renderObserver } from "../observer/render.js";
import { buildObserverData } from "../observer/data.js";
import { inventorySandboxIds, publicSandboxView, scrubSandboxIdBytes } from "../run/sandbox-ids.js";
import { splitStreamTraces } from "../run/stream-trace.js";
import { redactScreenshot, redactText } from "../evidence/redaction.js";
import {
  assertRewritableNumbers,
  derivedBundle,
  jsonBytes,
  transformText,
} from "./derivative-text.js";
import { streamScreenshotPaths } from "../verify/artifacts.js";
import { MAX_RUN_ENTRIES } from "../verify/scan-limit.js";
import { verifyRunPrepared, type VerifyResult } from "../verify/verify.js";
import { loadRunBundlePrepared, resolveRunPath } from "../run/locate.js";
import { type RunBundle } from "../run/bundle.js";
import {
  runIdOf,
  isPathInside,
  prepareRunArtifactPaths,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "../run/paths.js";
import { isAnalysisRecordPath } from "../analysis/sharing.js";
import { LOCAL_ONLY_RUN_FILES } from "../run/local-only-files.js";
import { readUnchangedFile } from "../run/evidence-files.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareManagedHumanishOutputDirectory,
  prepareSelectedOutputDirectory,
  writeContainedOutputFile,
  type PreparedSelectedOutputDirectory,
} from "../run/contained-output.js";

const DERIVATION_SCHEMA = "humanish.redacted-derivation.v1";
const TEXT_EXTENSIONS = new Set([
  ".json",
  ".ndjson",
  ".jsonl",
  ".md",
  ".txt",
  ".log",
  ".yaml",
  ".yml",
  ".csv",
]);
const OMITTED = new Map([
  ["observer/index.html", "regenerated Observer"],
  ["observer/observer-data.json", "regenerated Observer projection"],
  ["observer/study-analysis.json", "analysis must be regenerated against derivative evidence"],
  ...LOCAL_ONLY_RUN_FILES,
]);
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface InventoryFile {
  path: string;
  bytes: Buffer;
  sha256: string;
}
interface Inventory {
  files: InventoryFile[];
  bytes: number;
  digest: string;
}
interface DerivationEntry {
  path: string;
  sourceSha256: string;
  outputSha256?: string;
  action: "copied" | "blurred" | "updated" | "omitted";
  reason?: string;
}

/** Internal fault-injection seam. Never overrides reads, redaction or verification. */
export interface BundleExportHooks {
  beforePublish?: () => Promise<void>;
}

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function omittedReason(relative: string): string | undefined {
  if (relative.startsWith("analysis-automatic/") && isAnalysisRecordPath(relative))
    return "automatic execution intent and liveness do not transfer to a derivative";
  if (isAnalysisRecordPath(relative))
    return "analysis records bind original evidence hashes; reanalyze the derivative";
  if (relative.startsWith(".analysis-lock/")) return "local analysis execution lock";
  return (
    OMITTED.get(relative) ??
    (["feedback/draft.json", "feedback/issue.md"].includes(relative)
      ? "regenerate feedback from derivative evidence"
      : undefined)
  );
}

async function inventory(root: PreparedRunArtifactPaths, maxBytes: number): Promise<Inventory> {
  await validatePreparedRunArtifactPaths(root);
  const files: InventoryFile[] = [];
  let total = 0;
  let entriesSeen = 0;
  const walk = async (relative: string): Promise<void> => {
    const directory = path.join(root.physicalRunRoot, relative);
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new Error("Source contains an unsafe directory.");
    for (const name of (await readdir(directory)).sort()) {
      // TODO(#1766): read run.json first and take the scan's per-participant entry limit
      // (runEntryLimit) once it lands, so a run verify admits also exports.
      if (++entriesSeen > MAX_RUN_ENTRIES)
        throw new Error(`Source exceeds ${MAX_RUN_ENTRIES} inventory entries.`);
      if (name.includes("\\") || name.includes("\0"))
        throw new Error("Source contains an unsafe path segment.");
      const rel = relative ? `${relative}/${name}` : name;
      const info = await lstat(path.join(directory, name), { bigint: true });
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && !info.isFile()) ||
        (info.isFile() && info.nlink !== 1n)
      ) {
        throw new Error("Source contains a symlink, hardlink or special file.");
      }
      if (info.isDirectory()) {
        await walk(rel);
      } else {
        if (path.extname(rel).toLowerCase() === ".mp4")
          throw new Error(
            "Continuous video/audio cannot be redacted by bundle export. Use --local-only HTML export for a snapshot-only copy.",
          );
        // At most what is left of --max-bytes, so a file that grows after this lstat is refused
        // unread. With nothing left, an empty file still reads and any other is refused.
        const read = await readUnchangedFile(root, rel, Math.max(1, maxBytes - total));
        if (read.state === "unavailable")
          throw new Error("Source artifact could not be read through its bound identity.");
        if (read.state === "limit") throw new Error("Source inventory exceeds --max-bytes.");
        total += read.bytes.length;
        if (total > maxBytes) throw new Error("Source inventory exceeds --max-bytes.");
        files.push({ path: rel, bytes: read.bytes, sha256: hash(read.bytes) });
      }
    }
    const after = await lstat(directory, { bigint: true });
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error("Source directory changed during inventory.");
    }
  };
  await walk("");
  await validatePreparedRunArtifactPaths(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files,
    bytes: total,
    digest: hash(JSON.stringify(files.map((f) => [f.path, f.bytes.length, f.sha256]))),
  };
}

function assertFinished(bundle: RunBundle): void {
  const unfinished = [
    "running",
    "pending",
    "queued",
    "starting",
    "preparing",
    "not_started",
    "suspended",
  ];
  if (
    bundle.simulations.some((record) => unfinished.includes(record.status)) ||
    bundle.streams.some(
      (stream) =>
        unfinished.includes(stream.status) ||
        stream.liveActor !== undefined ||
        (stream.actor !== undefined && unfinished.includes(stream.actor.status)),
    )
  ) {
    throw new Error(
      "Bundle export requires a completed run; live or pending evidence cannot be published.",
    );
  }
}

/** Resolve existing aliases before creating any output parent, including aliases into a run. */
async function prospectivePhysicalPath(requested: string): Promise<string> {
  try {
    return await realpath(requested);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = path.dirname(requested);
    if (parent === requested) throw error;
    return path.join(await prospectivePhysicalPath(parent), path.basename(requested));
  }
}

function assertFeedbackReferences(bundle: RunBundle, source: Inventory): void {
  const retained = new Set(
    source.files.filter((file) => omittedReason(file.path) === undefined).map((file) => file.path),
  );
  retained.add("observer/index.html");
  retained.add("observer/observer-data.json");
  for (const candidate of bundle.feedbackCandidates) {
    for (const evidence of candidate.evidence) {
      if (!retained.has(evidence.path))
        throw new Error(
          "Feedback evidence must resolve to a retained or regenerated artifact in the derivative.",
        );
      if (evidence.kind === "screenshot" && path.extname(evidence.path).toLowerCase() !== ".png") {
        throw new Error("Feedback screenshot evidence must resolve to a transformed PNG.");
      }
    }
  }
}

/** PNG paths that run.json cites outside actor traces: feedback, adapter and stream artifacts. */
function citedPngPaths(bundle: RunBundle): Set<string> {
  const cited = [
    ...bundle.feedbackCandidates.flatMap((candidate) => candidate.evidence.map(({ path }) => path)),
    ...(bundle.adapterArtifacts ?? []).map((artifact) => artifact.path),
    ...bundle.streams.flatMap((stream) => stream.artifacts.map((artifact) => artifact.path)),
  ];
  return new Set(
    cited
      .map((cite) => path.posix.normalize(cite))
      .filter((cite) => path.extname(cite).toLowerCase() === ".png"),
  );
}

/**
 * The PNGs the derivative keeps. verify cannot read an image, so only one an actor trace registers
 * as a stream screenshot can be share_ready. A PNG nothing cites is dropped; a PNG that other
 * evidence cites refuses the export, since dropping it would change that evidence.
 */
function keptPngPaths(source: Inventory, bundle: RunBundle): Set<string> {
  const streamShots = streamScreenshotPaths(bundle);
  const cited = citedPngPaths(bundle);
  const kept = new Set<string>();
  for (const file of source.files) {
    if (path.extname(file.path).toLowerCase() !== ".png") continue;
    // A file that only claims to be a PNG may conceal a payload; refuse it rather than drop it.
    if (!file.bytes.subarray(0, 8).equals(PNG_MAGIC))
      throw new Error("PNG artifact has invalid signature.");
    if (streamShots.has(file.path)) {
      kept.add(file.path);
    } else if (cited.has(file.path)) {
      throw new Error(
        `Evidence cites ${file.path}, an image that is not a stream screenshot; verify cannot read it, so no export of this run can be share_ready.`,
      );
    }
  }
  return kept;
}

async function writeDerivative(
  source: Inventory,
  stagePaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
): Promise<{ images: number; entries: DerivationEntry[] }> {
  const entries: DerivationEntry[] = [];
  const imagePaths = keptPngPaths(source, bundle);
  const sandboxIds = inventorySandboxIds(source.files);
  // run.json and each trace file come from one rewritten bundle, so each trace's index binds the
  // bytes written here. A v1 source is written as v2.
  const derived = splitStreamTraces(
    publicSandboxView(derivedBundle(bundle, imagePaths), sandboxIds),
  );
  const derivedFiles = new Map<string, Buffer>([
    ["run.json", jsonBytes(derived.bundle)],
    ...derived.files.map((file): [string, Buffer] => [file.path, file.bytes]),
  ]);
  let images = 0;
  for (const file of source.files) {
    const isPng = path.extname(file.path).toLowerCase() === ".png";
    const reason =
      omittedReason(file.path) ??
      (isPng && !imagePaths.has(file.path)
        ? "unreferenced image: nothing cites it and verify cannot read it"
        : undefined);
    if (reason) {
      entries.push({ path: file.path, sourceSha256: file.sha256, action: "omitted", reason });
      continue;
    }
    const extension = path.extname(file.path).toLowerCase();
    let bytes: Buffer;
    let action: DerivationEntry["action"];
    if (extension === ".png") {
      if (!file.bytes.subarray(0, 8).equals(PNG_MAGIC))
        throw new Error("PNG artifact has invalid signature.");
      const redacted = redactScreenshot(file.bytes);
      if (!redacted.decoded)
        throw new Error("PNG artifact could not be decoded safely; export refuses a placeholder.");
      bytes = redacted.buffer;
      action = "blurred";
      images += 1;
    } else {
      if (!TEXT_EXTENSIONS.has(extension))
        throw new Error(
          `Unsupported artifact format ${extension || "(no extension)"}; bundle export supports PNG and UTF-8 text only.`,
        );
      bytes = transformText(file, imagePaths);
      const rewritten = derivedFiles.get(file.path);
      if (rewritten !== undefined) {
        assertRewritableNumbers(file.bytes.toString("utf8"));
        bytes = rewritten;
        derivedFiles.delete(file.path);
      }
      bytes = scrubSandboxIdBytes(file.path, bytes, sandboxIds);
      action = bytes.equals(file.bytes) ? "copied" : "updated";
    }
    await writeContainedOutputFile(stagePaths, file.path, bytes);
    entries.push({ path: file.path, sourceSha256: file.sha256, outputSha256: hash(bytes), action });
  }
  // A v1 source stream with no actor trace file gets one; its content came from run.json.
  const runJson = source.files.find((file) => file.path === "run.json");
  for (const [relative, bytes] of derivedFiles) {
    if (relative === "run.json" || runJson === undefined) continue;
    await writeContainedOutputFile(stagePaths, relative, bytes);
    entries.push({
      path: relative,
      sourceSha256: runJson.sha256,
      outputSha256: hash(bytes),
      action: "updated",
    });
  }
  return { images, entries };
}

async function removeOwnedDirectory(
  root: PreparedSelectedOutputDirectory,
  strict = false,
): Promise<void> {
  try {
    await assertPreparedSelectedOutputDirectory(root);
    await rm(root.physicalPath, { recursive: true });
  } catch {
    // Identity changed: do not remove a replacement.
    if (strict)
      throw new Error(
        "Private source snapshot cleanup was not confirmed; no derivative was published.",
      );
  }
}

/** The directories one bundle export owns; its finally releases whatever is still held. */
interface BundleWorkspace {
  stage: PreparedSelectedOutputDirectory | undefined;
  rawSnapshot: PreparedSelectedOutputDirectory | undefined;
  claimed: PreparedSelectedOutputDirectory | undefined;
  published: boolean;
}

export async function exportRedactedBundle(
  cwdInput: string,
  runInput: string,
  options: ExportOptions,
  hooks: BundleExportHooks = {},
): Promise<ExportResult | ExportFailure> {
  const cwd = path.resolve(cwdInput);
  const failure = (code: ExportFailure["error"]["code"], message: string): ExportFailure => ({
    schema: "humanish.export-result.v1",
    ok: false,
    cwd,
    run: runInput,
    error: { code, message },
  });
  if (options.redactScreenshots !== true || options.localOnly === true) {
    return failure(
      "HUMANISH_EXPORT_INVALID_OPTIONS",
      "--format bundle requires --redact-screenshots and does not accept --local-only.",
    );
  }
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    return failure(
      "HUMANISH_EXPORT_INVALID_OPTIONS",
      "--max-bytes must be a positive safe integer.",
    );
  const workspace: BundleWorkspace = {
    stage: undefined,
    rawSnapshot: undefined,
    claimed: undefined,
    published: false,
  };
  try {
    const runPaths = await resolveRunPath(cwd, runInput);
    if (!runPaths)
      return failure("HUMANISH_EXPORT_RUN_NOT_FOUND", "No run resolves from the selected run id.");
    const source = await inventory(runPaths, maxBytes);
    const runId = runIdOf(runPaths);
    assertExportableSource(source);
    const target = await resolveDestination(cwd, runPaths, runId, options);
    if (target.exists)
      return failure(
        "HUMANISH_EXPORT_OUTPUT_EXISTS",
        "Destination already exists; choose a new workspace directory.",
      );
    const { requested, parent, destination } = target;

    await assertPreparedSelectedOutputDirectory(parent);
    const stagePath = await mkdtemp(path.join(parent.physicalPath, ".humanish-export-"));
    const stage = await prepareSelectedOutputDirectory(parent.physicalPath, stagePath);
    workspace.stage = stage;
    const frozen = await verifyFrozenSource(workspace, source, runId);
    if ("shareSafety" in frozen) {
      return {
        ...failure(
          "HUMANISH_EXPORT_VERIFY_FAILED",
          "Source evidence failed verification; bundle export cannot repair invalid or blocked evidence.",
        ),
        shareSafety: frozen.shareSafety,
      };
    }
    const derivative = await buildDerivative(stage, source, runId, frozen.bundle, maxBytes);
    await hooks.beforePublish?.();
    const sourceAfter = await inventory(runPaths, maxBytes);
    if (sourceAfter.digest !== source.digest)
      throw new Error("Source changed during export; no derivative was published.");
    await publishDerivative(workspace, parent, stage, destination);
    return {
      schema: "humanish.export-result.v1",
      ok: true,
      cwd,
      runId,
      format: "bundle",
      path: path.relative(cwd, requested),
      bytes: derivative.bytes,
      embeddedImages: derivative.images,
      shareSafety: derivative.shareSafety,
      watermarked: false,
      warnings: [
        "Screenshots were blurred during export. Review text and findings before sharing; keep the readable original for local adjudication.",
      ],
    };
  } catch (error) {
    const exists = error instanceof Error && "code" in error && error.code === "EEXIST";
    return failure(
      exists ? "HUMANISH_EXPORT_OUTPUT_EXISTS" : "HUMANISH_EXPORT_BUNDLE_REFUSED",
      exists
        ? "Destination already exists; choose a new workspace directory."
        : error instanceof SyntaxError
          ? "Malformed JSON evidence; export refused."
          : error instanceof Error
            ? redactText(error.message)
            : "Bundle export failed without publishing a derivative.",
    );
  } finally {
    await releaseWorkspace(workspace);
  }
}

/** Refuses a run that is still in progress or is itself a derivative. */
function assertExportableSource(source: Inventory): void {
  const processStatus = source.files.find((file) => file.path === "status.json");
  if (
    processStatus &&
    (JSON.parse(processStatus.bytes.toString("utf8")) as { state?: unknown }).state !== "finished"
  ) {
    throw new Error(
      "Source process status is unfinished; wait for the run to finish before exporting.",
    );
  }
  if (source.files.some((file) => file.path === "derivation.json"))
    throw new Error("This run is already a derivative; export the retained original instead.");
}

/** The derivative workspace path, which must sit outside the source run history. */
async function resolveDestination(
  cwd: string,
  runPaths: PreparedRunArtifactPaths,
  runId: string,
  options: ExportOptions,
): Promise<{
  requested: string;
  parent: PreparedSelectedOutputDirectory;
  destination: string;
  exists: boolean;
}> {
  const requested = path.resolve(
    cwd,
    options.out ?? path.join(".humanish", "exports", `${runId}-redacted`),
  );
  const prospective = await prospectivePhysicalPath(requested);
  if (
    isPathInside(runPaths.physicalRunsRoot, prospective) ||
    isPathInside(prospective, runPaths.physicalRunRoot)
  ) {
    throw new Error("Derivative output must be outside the source run history.");
  }
  const parent =
    options.out === undefined
      ? await prepareManagedHumanishOutputDirectory(cwd, "exports")
      : await prepareSelectedOutputDirectory(cwd, path.dirname(requested));
  const destination = path.join(parent.physicalPath, path.basename(requested));
  if (
    isPathInside(runPaths.physicalRunsRoot, destination) ||
    isPathInside(destination, runPaths.physicalRunRoot)
  ) {
    throw new Error("Derivative output must be outside the source run history.");
  }
  const exists = await lstat(destination).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  return { requested, parent, destination, exists };
}

/**
 * Verifies the frozen source bytes and loads its bundle, or returns the share safety that refused
 * it. The raw snapshot is removed before the derivative is built.
 */
async function verifyFrozenSource(
  workspace: BundleWorkspace,
  source: Inventory,
  runId: string,
): Promise<{ bundle: RunBundle } | { shareSafety: VerifyResult["shareSafety"] }> {
  // Verify the same frozen bytes that will be transformed. Verifying the live
  // source and then rereading run.json permits an ABA edit to contaminate a
  // derivative whose receipt still names the first inventory's hashes.
  // Raw verification bytes stay in private OS temporary storage, even when
  // the caller selected a shared filesystem as the sanitized destination.
  const snapshotPath = await mkdtemp(path.join(tmpdir(), "humanish-export-source-"));
  const rawSnapshot = await prepareSelectedOutputDirectory(tmpdir(), snapshotPath);
  workspace.rawSnapshot = rawSnapshot;
  const snapshotPaths = await prepareRunArtifactPaths(rawSnapshot.physicalPath, runId);
  for (const file of source.files)
    await writeContainedOutputFile(snapshotPaths, file.path, file.bytes);
  const verified = await verifyRunPrepared(rawSnapshot.physicalPath, runId, snapshotPaths);
  if (
    !verified.ok ||
    (verified.shareSafety.status !== "share_ready" &&
      !(
        verified.shareSafety.status === "local_only" &&
        verified.shareSafety.reasons.every(
          // Both are repaired in the copy: frames are blurred, and an unread PNG is dropped or
          // refused by keptPngPaths. Any other unread file fails as an unsupported format.
          (reason) =>
            reason.code === "RAW_SCREENSHOTS" ||
            reason.code === "RAW_SANDBOX_ID" ||
            reason.code === "UNSCANNED_ARTIFACT",
        )
      ))
  ) {
    return { shareSafety: verified.shareSafety };
  }
  const loaded = await loadRunBundlePrepared(rawSnapshot.physicalPath, snapshotPaths);
  if (!loaded) throw new Error("Frozen source bundle could not be loaded.");
  const bundle = loaded.bundle;
  if (bundle.runId !== runId) throw new Error("Source run identity does not match its directory.");
  assertFinished(bundle);
  assertFeedbackReferences(bundle, source);
  await removeOwnedDirectory(rawSnapshot, true);
  workspace.rawSnapshot = undefined;
  return { bundle };
}

/**
 * Writes the blurred derivative into the stage with its receipt and regenerated Observer, and
 * requires it to verify as share_ready on its own.
 */
async function buildDerivative(
  stage: PreparedSelectedOutputDirectory,
  source: Inventory,
  runId: string,
  bundle: RunBundle,
  maxBytes: number,
): Promise<{ images: number; bytes: number; shareSafety: VerifyResult["shareSafety"] }> {
  const stagePaths = await prepareRunArtifactPaths(stage.physicalPath, runId);
  const transformed = await writeDerivative(source, stagePaths, bundle);
  const receipt = {
    schema: DERIVATION_SCHEMA,
    sourceRunId: runId,
    sourceInventorySha256: source.digest,
    createdAt: new Date().toISOString(),
    transformation: "png-blur-at-export-v1",
    note: "A redacted copy of the same study, not a new attempt. Original pixels are not present. Text and findings still require human review before sharing.",
    files: transformed.entries,
  };
  const transformedBundle = await loadRunBundlePrepared(stage.physicalPath, stagePaths);
  if (!transformedBundle) throw new Error("Derivative bundle could not be loaded.");
  await writeContainedOutputFile(
    stagePaths,
    "observer/observer-data.json",
    jsonBytes(buildObserverData(transformedBundle.bundle)),
  );
  const rendered = await renderObserver(stage.physicalPath, runId, { open: false });
  if (!rendered.ok) throw new Error("Derivative Observer could not be rebuilt.");
  const generated = [];
  for (const relative of ["observer/index.html", "observer/observer-data.json"]) {
    const read = await readUnchangedFile(stagePaths, relative, maxBytes);
    if (read.state === "limit") throw new Error("The regenerated Observer exceeds --max-bytes.");
    if (read.state === "unavailable")
      throw new Error("Regenerated Observer artifact could not be read safely.");
    generated.push({ path: relative, sha256: hash(read.bytes) });
  }
  await writeContainedOutputFile(
    stagePaths,
    "derivation.json",
    jsonBytes({ ...receipt, generated }),
  );
  const derivativeVerify = await verifyRunPrepared(stage.physicalPath, runId, stagePaths);
  if (!derivativeVerify.ok || derivativeVerify.shareSafety.status !== "share_ready") {
    throw new Error("Transformed bundle did not independently verify as share_ready.");
  }
  const output = await inventory(stagePaths, maxBytes);
  return {
    images: transformed.images,
    bytes: output.bytes,
    shareSafety: derivativeVerify.shareSafety,
  };
}

/**
 * Exclusive mkdir claims the new workspace. Only its complete, independently
 * verified .humanish tree is published by rename; no empty existing workspace
 * is overwritten by platform-dependent directory rename semantics.
 */
async function publishDerivative(
  workspace: BundleWorkspace,
  parent: PreparedSelectedOutputDirectory,
  stage: PreparedSelectedOutputDirectory,
  destination: string,
): Promise<void> {
  await assertPreparedSelectedOutputDirectory(parent);
  await assertPreparedSelectedOutputDirectory(stage);
  await mkdir(destination, { mode: 0o700 });
  const claimed = await prepareSelectedOutputDirectory(parent.physicalPath, destination);
  workspace.claimed = claimed;
  await assertPreparedSelectedOutputDirectory(parent);
  await assertPreparedSelectedOutputDirectory(claimed);
  await rename(
    path.join(stage.physicalPath, ".humanish"),
    path.join(claimed.physicalPath, ".humanish"),
  );
  workspace.published = true;
}

async function releaseWorkspace(workspace: BundleWorkspace): Promise<void> {
  if (workspace.rawSnapshot) await removeOwnedDirectory(workspace.rawSnapshot);
  if (workspace.stage) await removeOwnedDirectory(workspace.stage);
  if (workspace.claimed && !workspace.published) {
    try {
      await assertPreparedSelectedOutputDirectory(workspace.claimed);
      await rmdir(workspace.claimed.physicalPath);
    } catch {
      /* Never recursively delete an output another process populated. */
    }
  }
}
