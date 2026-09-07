// The publish boundary for existing raw runs (#136). A derivative is an isolated
// workspace, never a new run in the source history. No provider APIs are involved.
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

import { ACTOR_TRACE_SCHEMA } from "./actor-contract.js";
import type { ExportFailure, ExportOptions, ExportResult } from "./export.js";
import { renderObserver } from "./observer.js";
import { buildObserverData } from "./observer-data.js";
import { containsSensitive, redactScreenshot, redactText } from "./redaction.js";
import { loadRunBundlePrepared, resolveRunPath, verifyRunPrepared, type RunBundle } from "./run.js";
import { isPathInside, prepareRunArtifactPaths, validatePreparedRunArtifactPaths, type PreparedRunArtifactPaths } from "./run-paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareManagedHumanishOutputDirectory,
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  writeContainedOutputFile,
  type PreparedSelectedOutputDirectory
} from "./selected-output-paths.js";

export const DERIVATION_SCHEMA = "humanish.redacted-derivation.v1";
const MAX_FILES = 10_000;
const TEXT_EXTENSIONS = new Set([".json", ".ndjson", ".jsonl", ".md", ".txt", ".log", ".yaml", ".yml", ".csv"]);
const OMITTED = new Map([
  ["observer/index.html", "regenerated Observer"],
  ["observer/observer-data.json", "regenerated Observer projection"],
  ["status.json", "local process status is not a new attempt"],
  ["sandbox-receipts.ndjson", "operational journal does not confer a derivative resource lease"]
]);
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface InventoryFile { path: string; bytes: Buffer; sha256: string }
interface Inventory { files: InventoryFile[]; bytes: number; digest: string }
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

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function omittedReason(relative: string): string | undefined {
  return OMITTED.get(relative)
    ?? (["feedback/draft.json", "feedback/issue.md"].includes(relative) ? "regenerate feedback from derivative evidence" : undefined);
}

async function inventory(root: PreparedRunArtifactPaths, maxBytes: number): Promise<Inventory> {
  await validatePreparedRunArtifactPaths(root);
  const files: InventoryFile[] = [];
  let total = 0;
  let entriesSeen = 0;
  const walk = async (relative: string): Promise<void> => {
    const directory = path.join(root.physicalRunRoot, relative);
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Source contains an unsafe directory.");
    for (const name of (await readdir(directory)).sort()) {
      if (++entriesSeen > MAX_FILES) throw new Error(`Source exceeds ${MAX_FILES} inventory entries.`);
      if (name.includes("\\") || name.includes("\0")) throw new Error("Source contains an unsafe path segment.");
      const rel = relative ? `${relative}/${name}` : name;
      const info = await lstat(path.join(directory, name), { bigint: true });
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1n)) {
        throw new Error("Source contains a symlink, hardlink or special file.");
      }
      if (info.isDirectory()) {
        await walk(rel);
      } else {
        if (info.size > BigInt(maxBytes - total)) throw new Error("Source inventory exceeds --max-bytes.");
        const bytes = await readContainedRegularFile(root, rel);
        if (bytes === null) throw new Error("Source artifact could not be read through its bound identity.");
        total += bytes.length;
        if (total > maxBytes) throw new Error("Source inventory exceeds --max-bytes.");
        files.push({ path: rel, bytes, sha256: hash(bytes) });
      }
    }
    const after = await lstat(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error("Source directory changed during inventory.");
    }
  };
  await walk("");
  await validatePreparedRunArtifactPaths(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, bytes: total, digest: hash(JSON.stringify(files.map((f) => [f.path, f.bytes.length, f.sha256]))) };
}

function assertFinished(bundle: RunBundle): void {
  const unfinished = ["running", "pending", "queued", "starting", "preparing", "not_started", "suspended"];
  if (bundle.simulations.some((sim) => unfinished.includes(sim.status))
    || bundle.streams.some((stream) => unfinished.includes(stream.status)
      || stream.liveActor !== undefined
      || (stream.actor !== undefined && unfinished.includes(stream.actor.status)))) {
    throw new Error("Bundle export requires a completed run; live or pending evidence cannot be published.");
  }
}

/** Resolve existing aliases before creating any output parent, including aliases into a run. */
async function prospectivePhysicalPath(requested: string): Promise<string> {
  try { return await realpath(requested); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = path.dirname(requested);
    if (parent === requested) throw error;
    return path.join(await prospectivePhysicalPath(parent), path.basename(requested));
  }
}

function assertNoInlineRaster(text: string): void {
  // Decode common JSON/YAML quoted escapes before checking. Unknown embedded bytes
  // are refused: copying a text extension must not smuggle untransformed pixels.
  const decoded = text
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  if (containsSensitive(text) || containsSensitive(decoded)) throw new Error("Decoded text contains a secret-shaped value or private path; export refused.");
  if (/data\s*:\s*(?:image\/|application\/|text\/|[^,\s]*;base64,|,)/i.test(decoded) || /iVBORw0KGgo|\/9j\/[A-Za-z0-9+/]|R0lGOD|UklGR[A-Za-z0-9+/]{4}|<svg\b/i.test(decoded)) {
    throw new Error("Text contains an inline image/data payload; embedded raster redaction is unsupported.");
  }
}

function decodeText(file: InventoryFile): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); }
  catch { throw new Error("Source text contains invalid UTF-8 or binary bytes."); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error("Source text contains binary control bytes.");
  assertNoInlineRaster(text);
  return text;
}

function updateScreenshotDeclarations(value: unknown, imagePaths: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => updateScreenshotDeclarations(entry, imagePaths));
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(object)) result[key] = updateScreenshotDeclarations(entry, imagePaths);
  if (object.schema === ACTOR_TRACE_SCHEMA && object.redaction !== null && typeof object.redaction === "object") {
    const original = object.redaction as Record<string, unknown>;
    if (original.screenshots === "raw" || original.screenshots === "blurred") {
      result.redaction = {
        ...original,
        screenshots: "blurred",
        notes: `${typeof original.notes === "string" ? original.notes : ""} Exported copy: screenshots blurred during export; original capture posture: ${original.screenshots}. See derivation.json.`
      };
    }
    if (Array.isArray(result.items)) {
      result.items = result.items.map((item: unknown) => {
        if (item === null || typeof item !== "object") return item;
        const entry = item as Record<string, unknown>;
        if (entry.screenshotRef === undefined) return item;
        if (entry.screenshotRef === null || typeof entry.screenshotRef !== "object") throw new Error("Actor screenshot reference is malformed.");
        const ref = entry.screenshotRef as Record<string, unknown>;
        if (typeof ref.path !== "string" || !imagePaths.has(ref.path)) {
          throw new Error("Actor screenshot reference must resolve to a PNG transformed from this run's inventory.");
        }
        return { ...entry, screenshotRef: { ...ref, redaction: "blurred" } };
      });
    }
  }
  return result;
}

function assertFeedbackReferences(bundle: RunBundle, source: Inventory): void {
  const retained = new Set(source.files.filter((file) => omittedReason(file.path) === undefined).map((file) => file.path));
  retained.add("observer/index.html");
  retained.add("observer/observer-data.json");
  for (const candidate of bundle.feedbackCandidates) {
    for (const evidence of candidate.evidence) {
      if (!retained.has(evidence.path)) throw new Error("Feedback evidence must resolve to a retained or regenerated artifact in the derivative.");
      if (evidence.kind === "screenshot" && path.extname(evidence.path).toLowerCase() !== ".png") {
        throw new Error("Feedback screenshot evidence must resolve to a transformed PNG.");
      }
    }
  }
}

function transformText(file: InventoryFile, imagePaths: ReadonlySet<string>): Buffer {
  const text = decodeText(file);
  const extension = path.extname(file.path).toLowerCase();
  if (extension === ".json") {
    const parsed: unknown = JSON.parse(text);
    // Parsing also resolves escape sequences in string values before inspection.
    assertNoInlineRaster(JSON.stringify(parsed));
    const transformed = updateScreenshotDeclarations(parsed, imagePaths);
    if (JSON.stringify(transformed) === JSON.stringify(parsed)) return file.bytes;
    assertRewritableNumbers(text);
    return jsonBytes(transformed);
  }
  if (extension === ".ndjson" || extension === ".jsonl") {
    const lines = text.split("\n");
    const transformed = lines.map((line) => {
      if (line.trim().length === 0) return line;
      const parsed: unknown = JSON.parse(line);
      assertNoInlineRaster(JSON.stringify(parsed));
      const updated = JSON.stringify(updateScreenshotDeclarations(parsed, imagePaths));
      if (updated === JSON.stringify(parsed)) return line;
      assertRewritableNumbers(line);
      return updated;
    });
    return Buffer.from(transformed.join("\n"));
  }
  if (extension === ".yaml" || extension === ".yml") {
    assertNoInlineRaster(JSON.stringify(parseYaml(text, { maxAliasCount: 100, logLevel: "silent" })) ?? "");
  }
  return file.bytes;
}

function assertRewritableNumbers(json: string): void {
  // Opaque adapter JSON stays byte-identical. A known trace that actually needs
  // rewriting must not silently round an identifier outside JS's integer range.
  const unquoted = json.replace(/"(?:\\.|[^"\\])*"/g, '""');
  for (const match of unquoted.matchAll(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const number = Number(match[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
      throw new Error("A trace requiring redaction contains an unsafe numeric value; represent large identifiers as strings before capture.");
    }
  }
}

async function writeDerivative(
  source: Inventory,
  stagePaths: PreparedRunArtifactPaths,
  bundle: RunBundle
): Promise<{ images: number; entries: DerivationEntry[] }> {
  const entries: DerivationEntry[] = [];
  const imagePaths = new Set(source.files.filter((file) => path.extname(file.path).toLowerCase() === ".png").map((file) => file.path));
  let images = 0;
  for (const file of source.files) {
    const reason = omittedReason(file.path);
    if (reason) {
      entries.push({ path: file.path, sourceSha256: file.sha256, action: "omitted", reason });
      continue;
    }
    const extension = path.extname(file.path).toLowerCase();
    let bytes: Buffer;
    let action: DerivationEntry["action"];
    if (extension === ".png") {
      if (!file.bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("PNG artifact has invalid signature.");
      const redacted = redactScreenshot(file.bytes);
      if (!redacted.decoded) throw new Error("PNG artifact could not be decoded safely; export refuses a placeholder.");
      bytes = redacted.buffer;
      action = "blurred";
      images += 1;
    } else {
      if (!TEXT_EXTENSIONS.has(extension)) throw new Error(`Unsupported artifact format ${extension || "(no extension)"}; bundle export supports PNG and UTF-8 text only.`);
      bytes = transformText(file, imagePaths);
      if (file.path === "run.json") {
        assertRewritableNumbers(file.bytes.toString("utf8"));
        const transformed = updateScreenshotDeclarations(bundle, imagePaths) as RunBundle;
        transformed.redaction = {
          status: "passed",
          notes: `${bundle.redaction.notes} Exported copy: screenshots were blurred during export; the original capture is retained separately. See derivation.json.`
        };
        for (const stream of transformed.streams) {
          for (const artifact of stream.artifacts) {
            if (artifact.kind === "screenshot") artifact.label = artifact.label.replace(/\((raw|blurred)\)/g, "(blurred at export)");
          }
        }
        bytes = jsonBytes(transformed);
      }
      action = bytes.equals(file.bytes) ? "copied" : "updated";
    }
    await writeContainedOutputFile(stagePaths, file.path, bytes);
    entries.push({ path: file.path, sourceSha256: file.sha256, outputSha256: hash(bytes), action });
  }
  return { images, entries };
}

async function removeOwnedDirectory(root: PreparedSelectedOutputDirectory, strict = false): Promise<void> {
  try {
    await assertPreparedSelectedOutputDirectory(root);
    await rm(root.physicalPath, { recursive: true });
  } catch {
    // Identity changed: do not remove a replacement.
    if (strict) throw new Error("Private source snapshot cleanup was not confirmed; no derivative was published.");
  }
}

export async function exportRedactedBundle(
  cwdInput: string,
  runInput: string,
  options: ExportOptions,
  hooks: BundleExportHooks = {}
): Promise<ExportResult | ExportFailure> {
  const cwd = path.resolve(cwdInput);
  const failure = (code: ExportFailure["error"]["code"], message: string): ExportFailure => ({
    schema: "humanish.export-result.v1", ok: false, cwd, run: runInput, error: { code, message }
  });
  if (options.redactScreenshots !== true || options.localOnly === true) {
    return failure("HUMANISH_EXPORT_INVALID_OPTIONS", "--format bundle requires --redact-screenshots and does not accept --local-only.");
  }
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return failure("HUMANISH_EXPORT_INVALID_OPTIONS", "--max-bytes must be a positive safe integer.");
  let stage: PreparedSelectedOutputDirectory | undefined;
  let rawSnapshot: PreparedSelectedOutputDirectory | undefined;
  let claimed: PreparedSelectedOutputDirectory | undefined;
  let published = false;
  try {
    const runPaths = await resolveRunPath(cwd, runInput);
    if (!runPaths) return failure("HUMANISH_EXPORT_RUN_NOT_FOUND", "No run resolves from the selected run id.");
    const source = await inventory(runPaths, maxBytes);
    const runId = path.basename(runPaths.physicalRunRoot);
    const processStatus = source.files.find((file) => file.path === "status.json");
    if (processStatus && (JSON.parse(processStatus.bytes.toString("utf8")) as { state?: unknown }).state !== "finished") {
      throw new Error("Source process status is unfinished; wait for the run to finish before exporting.");
    }
    if (source.files.some((file) => file.path === "derivation.json")) throw new Error("This run is already a derivative; export the retained original instead.");

    const requested = path.resolve(cwd, options.out ?? path.join(".humanish", "exports", `${runId}-redacted`));
    const prospective = await prospectivePhysicalPath(requested);
    if (isPathInside(runPaths.physicalRunsRoot, prospective) || isPathInside(prospective, runPaths.physicalRunRoot)) {
      throw new Error("Derivative output must be outside the source run history.");
    }
    const parent = options.out === undefined
      ? await prepareManagedHumanishOutputDirectory(cwd, "exports")
      : await prepareSelectedOutputDirectory(cwd, path.dirname(requested));
    const destination = path.join(parent.physicalPath, path.basename(requested));
    if (isPathInside(runPaths.physicalRunsRoot, destination) || isPathInside(destination, runPaths.physicalRunRoot)) {
      throw new Error("Derivative output must be outside the source run history.");
    }
    if (await lstat(destination).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    })) return failure("HUMANISH_EXPORT_OUTPUT_EXISTS", "Destination already exists; choose a new workspace directory.");

    await assertPreparedSelectedOutputDirectory(parent);
    const stagePath = await mkdtemp(path.join(parent.physicalPath, ".humanish-export-"));
    stage = await prepareSelectedOutputDirectory(parent.physicalPath, stagePath);
    // Verify the SAME frozen bytes that will be transformed. Verifying the live
    // source and then rereading run.json permits an ABA edit to contaminate a
    // derivative whose receipt still names the first inventory's hashes.
    // Raw verification bytes stay in private OS temporary storage, even when
    // the caller selected a shared filesystem as the sanitized destination.
    const snapshotPath = await mkdtemp(path.join(tmpdir(), "humanish-export-source-"));
    rawSnapshot = await prepareSelectedOutputDirectory(tmpdir(), snapshotPath);
    const snapshotPaths = await prepareRunArtifactPaths(rawSnapshot.physicalPath, runId);
    for (const file of source.files) await writeContainedOutputFile(snapshotPaths, file.path, file.bytes);
    const verified = await verifyRunPrepared(rawSnapshot.physicalPath, runId, snapshotPaths);
    if (!verified.ok || (verified.shareSafety.status !== "share_ready"
      && !(verified.shareSafety.status === "local_only" && verified.shareSafety.reasons.every((reason) => reason.code === "RAW_SCREENSHOTS")))) {
      return { ...failure("HUMANISH_EXPORT_VERIFY_FAILED", "Source evidence failed verification; bundle export cannot repair invalid or blocked evidence."), shareSafety: verified.shareSafety };
    }
    const loaded = await loadRunBundlePrepared(rawSnapshot.physicalPath, snapshotPaths);
    if (!loaded) throw new Error("Frozen source bundle could not be loaded.");
    const bundle = loaded.bundle;
    if (bundle.runId !== runId) throw new Error("Source run identity does not match its directory.");
    assertFinished(bundle);
    assertFeedbackReferences(bundle, source);
    await removeOwnedDirectory(rawSnapshot, true);
    rawSnapshot = undefined;
    const stagePaths = await prepareRunArtifactPaths(stage.physicalPath, runId);
    const transformed = await writeDerivative(source, stagePaths, bundle);
    const receipt = {
      schema: DERIVATION_SCHEMA,
      sourceRunId: runId,
      sourceInventorySha256: source.digest,
      createdAt: new Date().toISOString(),
      transformation: "png-blur-at-export-v1",
      note: "A redacted copy of the same study, not a new attempt. Original pixels are not present. Text and findings still require human review before sharing.",
      files: transformed.entries
    };
    const transformedBundle = await loadRunBundlePrepared(stage.physicalPath, stagePaths);
    if (!transformedBundle) throw new Error("Derivative bundle could not be loaded.");
    await writeContainedOutputFile(stagePaths, "observer/observer-data.json", jsonBytes(buildObserverData(transformedBundle.bundle)));
    const rendered = await renderObserver(stage.physicalPath, runId, { open: false });
    if (!rendered.ok) throw new Error("Derivative Observer could not be rebuilt.");
    const generated = [];
    for (const relative of ["observer/index.html", "observer/observer-data.json"]) {
      const bytes = await readContainedRegularFile(stagePaths, relative);
      if (bytes === null) throw new Error("Regenerated Observer artifact could not be read safely.");
      generated.push({ path: relative, sha256: hash(bytes) });
    }
    await writeContainedOutputFile(stagePaths, "derivation.json", jsonBytes({ ...receipt, generated }));
    const derivativeVerify = await verifyRunPrepared(stage.physicalPath, runId, stagePaths);
    if (!derivativeVerify.ok || derivativeVerify.shareSafety.status !== "share_ready") {
      throw new Error("Transformed bundle did not independently verify as share_ready.");
    }
    const output = await inventory(stagePaths, maxBytes);
    await hooks.beforePublish?.();
    const sourceAfter = await inventory(runPaths, maxBytes);
    if (sourceAfter.digest !== source.digest) throw new Error("Source changed during export; no derivative was published.");
    await assertPreparedSelectedOutputDirectory(parent);
    await assertPreparedSelectedOutputDirectory(stage);
    // Exclusive mkdir claims the new workspace. Only its complete, independently
    // verified .humanish tree is published by rename; no empty existing workspace
    // is overwritten by platform-dependent directory rename semantics.
    await mkdir(destination, { mode: 0o700 });
    claimed = await prepareSelectedOutputDirectory(parent.physicalPath, destination);
    await assertPreparedSelectedOutputDirectory(parent);
    await assertPreparedSelectedOutputDirectory(claimed);
    await rename(path.join(stage.physicalPath, ".humanish"), path.join(claimed.physicalPath, ".humanish"));
    published = true;
    return {
      schema: "humanish.export-result.v1", ok: true, cwd, runId, format: "bundle",
      path: path.relative(cwd, requested), bytes: output.bytes, embeddedImages: transformed.images,
      shareSafety: derivativeVerify.shareSafety, watermarked: false,
      warnings: ["Screenshots were blurred during export. Review text and findings before sharing; keep the readable original for local adjudication."]
    };
  } catch (error) {
    const exists = error instanceof Error && "code" in error && error.code === "EEXIST";
    return failure(exists ? "HUMANISH_EXPORT_OUTPUT_EXISTS" : "HUMANISH_EXPORT_BUNDLE_REFUSED",
      exists ? "Destination already exists; choose a new workspace directory."
        : error instanceof SyntaxError ? "Malformed JSON evidence; export refused."
        : error instanceof Error ? redactText(error.message) : "Bundle export failed without publishing a derivative.");
  } finally {
    if (rawSnapshot) await removeOwnedDirectory(rawSnapshot);
    if (stage) await removeOwnedDirectory(stage);
    if (claimed && !published) {
      try { await assertPreparedSelectedOutputDirectory(claimed); await rmdir(claimed.physicalPath); }
      catch { /* Never recursively delete an output another process populated. */ }
    }
  }
}
