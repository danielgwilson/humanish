import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { isRedactedFrameShape, screenshotEvidenceError } from "../evidence/image.js";
import { isAnalysisRecordPath } from "../analysis/sharing.js";
import { scanEncodedTextCached } from "../evidence/encoded-text.js";
import { readPlainText } from "../evidence/plain-text.js";
import { containsSensitive } from "../evidence/redaction.js";
import {
  isLocalEvidenceArtifactPath,
  isRiskyPublicArtifactPath,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "../run/paths.js";
import { openContainedRegularFile } from "../run/contained-output.js";
import type { RunBundle } from "../run/bundle.js";
import type { RunStream } from "../run/streams.js";
import { readSafeRunArtifactBytes, readSafeRunArtifactJson } from "../run/locate.js";
import { isRecord } from "../run/type-guards.js";
import { TERMINAL_EVENTS_ARTIFACT } from "../run/terminal-contract.js";
import { isZeroEventTerminalTrace } from "./actor.js";

/** Public-safety and evidence-reference findings stop at this many per list. */
export const MAX_REPORTED_FINDINGS = 50;

export async function missingLocalEvidenceArtifacts(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
): Promise<string[]> {
  const recordings = new Map(
    bundle.streams.flatMap((stream) =>
      stream.recording ? [[stream.recording.path, stream.recording] as const] : [],
    ),
  );
  const requiredPaths = new Map<string, { screenshot: boolean; allowEmpty: boolean }>();
  const addRequiredPath = (
    artifactPath: string,
    options: { screenshot?: boolean; allowEmpty?: boolean } = {},
  ): void => {
    const existing = requiredPaths.get(artifactPath);
    requiredPaths.set(artifactPath, {
      screenshot: Boolean(existing?.screenshot || options.screenshot),
      // Every consumer must permit emptiness: a terminal log cannot exempt the same path when
      // another stream, screenshot, or adapter also requires it as nonempty evidence.
      allowEmpty: options.allowEmpty === true && (existing?.allowEmpty ?? true),
    });
  };

  for (const stream of bundle.streams) {
    // A session that failed before output (or a silent terminal process) has a real zero-record
    // NDJSON stream. Both the embedded trace and its retained artifact must declare that fact.
    const emptyTerminalEvents =
      isZeroEventTerminalTrace(stream.actor) &&
      isZeroEventTerminalTrace(
        await readSafeRunArtifactJson(
          runPaths,
          stream.artifacts.find((artifact) => artifact.kind === "trace")?.path ?? "actor.json",
        ),
      );
    for (const artifact of stream.artifacts) {
      if (isLocalEvidenceArtifactPath(artifact.path)) {
        addRequiredPath(artifact.path, {
          screenshot: artifact.kind === "screenshot",
          allowEmpty:
            artifact.kind === "log" &&
            artifact.path === TERMINAL_EVENTS_ARTIFACT &&
            emptyTerminalEvents,
        });
      }
    }

    const embedPath = normalizeLocalEvidenceReference(
      stream.embed?.kind === "screenshot" ? stream.embed.url : undefined,
    );
    if (embedPath) {
      addRequiredPath(embedPath, { screenshot: true });
    }

    const uiScreenshotPath = normalizeLocalEvidenceReference(stream.ui?.screenshotUrl);
    if (uiScreenshotPath) {
      addRequiredPath(uiScreenshotPath, { screenshot: true });
    }

    if (
      stream.ui?.nestedObserverPath &&
      isLocalEvidenceArtifactPath(stream.ui.nestedObserverPath)
    ) {
      addRequiredPath(stream.ui.nestedObserverPath);
    }
    for (const reference of declaredActorScreenshotReferences(stream)) {
      if (isRunRootEvidenceReference(reference.path)) {
        addRequiredPath(reference.path, { screenshot: true });
      }
    }
  }

  for (const artifact of bundle.adapterArtifacts ?? []) {
    if (isLocalEvidenceArtifactPath(artifact.path)) {
      addRequiredPath(artifact.path, { screenshot: artifact.kind === "screenshot" });
    }
  }

  for (const candidate of bundle.feedbackCandidates ?? []) {
    for (const evidence of candidate.evidence) {
      if (isRunRootEvidenceReference(evidence.path)) {
        addRequiredPath(evidence.path, {
          screenshot: evidence.kind === "screenshot",
          // Feedback accepts an existing empty nonimage file. The conjunctive merge above
          // keeps any stricter stream, actor, or adapter requirement in force.
          allowEmpty: evidence.kind !== "screenshot",
        });
      }
    }
  }

  const missing: string[] = [];
  for (const [artifactPath, requirements] of requiredPaths) {
    const recording = recordings.get(artifactPath);
    if (recording) {
      const handle = await openContainedRegularFile(runPaths, artifactPath);
      try {
        if (!handle || (await handle.stat()).size !== recording.bytes) missing.push(artifactPath);
        else {
          const header = Buffer.alloc(12);
          const read = await handle.read(header, 0, header.length, 0);
          if (read.bytesRead !== header.length || header.toString("ascii", 4, 8) !== "ftyp")
            missing.push(`${artifactPath} (invalid MP4 header)`);
        }
      } finally {
        await handle?.close();
      }
      continue;
    }
    const bytes = await readSafeRunArtifactBytes(runPaths, artifactPath);
    if (!bytes || (bytes.length === 0 && !requirements.allowEmpty)) {
      missing.push(artifactPath);
      continue;
    }

    if (requirements.screenshot) {
      const imageError = screenshotEvidenceError(artifactPath, bytes);
      if (imageError) {
        missing.push(`${artifactPath} (${imageError})`);
      }
    }
  }

  return missing;
}

function declaredActorScreenshotReferences(
  stream: RunStream,
): Array<{ label: string; path: unknown; redaction: unknown }> {
  const references: Array<{ label: string; path: unknown; redaction: unknown }> = [];
  for (const field of ["actor", "liveActor"] as const) {
    const trace: unknown = stream[field];
    if (!isRecord(trace) || !Array.isArray(trace.items)) continue;
    trace.items.forEach((item: unknown, index: number) => {
      if (!isRecord(item) || !Object.hasOwn(item, "screenshotRef")) return;
      references.push({
        label: `${stream.id} ${field}.items[${index}].screenshotRef`,
        path: isRecord(item.screenshotRef) ? item.screenshotRef.path : undefined,
        redaction: isRecord(item.screenshotRef) ? item.screenshotRef.redaction : undefined,
      });
    });
  }
  return references;
}

/**
 * The PNG frames that actor traces register as stream screenshots, relative to the run root.
 * RAW_SCREENSHOTS grades these, so the public-safety scan does not report them as unread. Only
 * frames under screenshots/ count: the computer-use frame writer and the scripted-browser steps
 * write every frame there, and nothing else in the harness does. A trace reference elsewhere (an
 * adapter's PNG, say) stays required evidence but goes to UNSCANNED_ARTIFACT.
 */
export function streamScreenshotPaths(bundle: RunBundle): Set<string> {
  const paths = new Set<string>();
  for (const stream of bundle.streams) {
    for (const reference of declaredActorScreenshotReferences(stream)) {
      if (!isRunRootEvidenceReference(reference.path)) continue;
      const normalized = normalizedFramePath(reference.path);
      if (isHarnessScreenshotPath(normalized)) paths.add(normalized);
    }
  }
  return paths;
}

function isHarnessScreenshotPath(normalized: string): boolean {
  return normalized.startsWith("screenshots/") && normalized.toLowerCase().endsWith(".png");
}

function isRunRootEvidenceReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isLocalEvidenceArtifactPath(value) &&
    !path.win32.isAbsolute(value) &&
    !value.includes("\0") &&
    !/^[a-z][a-z\d+.-]*:/i.test(value)
  );
}

export function invalidRunEvidenceReferences(bundle: RunBundle): string[] {
  const findings: string[] = [];
  if (path.isAbsolute(bundle.cwd)) {
    findings.push(`run bundle persists absolute cwd ${bundle.cwd}`);
  }
  const adapterArtifactKeys = new Set<string>();
  for (const artifact of bundle.adapterArtifacts ?? []) {
    const key = `${artifact.namespace}:${artifact.kind}:${artifact.path}`;
    if (adapterArtifactKeys.has(key)) {
      findings.push(
        `adapter artifact duplicate ${artifact.namespace}:${artifact.kind}:${artifact.path}`,
      );
    }
    adapterArtifactKeys.add(key);
    if (!isLocalEvidenceArtifactPath(artifact.path)) {
      findings.push(
        `adapter artifact ${artifact.namespace}:${artifact.kind} nonlocal artifact ${artifact.path}`,
      );
    }
  }
  for (const candidate of bundle.feedbackCandidates ?? []) {
    for (const evidence of candidate.evidence) {
      if (!isRunRootEvidenceReference(evidence.path)) {
        findings.push(
          `feedback candidate ${candidate.id} nonlocal evidence ${String(evidence.path)}`,
        );
      }
    }
  }
  for (const stream of bundle.streams) {
    const seen = new Set<string>();
    for (const artifact of stream.artifacts) {
      const key = `${artifact.kind}:${artifact.path}`;
      if (seen.has(key)) {
        findings.push(`${stream.id} duplicate artifact ${artifact.kind}:${artifact.path}`);
      }
      seen.add(key);
      if (!isLocalEvidenceArtifactPath(artifact.path)) {
        findings.push(`${stream.id} nonlocal artifact ${artifact.kind}:${artifact.path}`);
      }
    }

    if (
      stream.ui?.nestedObserverPath &&
      !isLocalEvidenceArtifactPath(stream.ui.nestedObserverPath)
    ) {
      findings.push(
        `${stream.id} nonlocal nested observer reference ${stream.ui.nestedObserverPath}`,
      );
    }
    if (
      stream.embed?.kind === "screenshot" &&
      stream.embed.url &&
      !normalizeLocalEvidenceReference(stream.embed.url)
    ) {
      findings.push(`${stream.id} nonlocal screenshot embed ${stream.embed.url}`);
    }
    if (stream.ui?.screenshotUrl && !normalizeLocalEvidenceReference(stream.ui.screenshotUrl)) {
      findings.push(`${stream.id} nonlocal screenshot reference ${stream.ui.screenshotUrl}`);
    }
    for (const reference of declaredActorScreenshotReferences(stream)) {
      if (!isRunRootEvidenceReference(reference.path)) {
        findings.push(`${reference.label} is malformed or nonlocal`);
      }
    }
  }
  return findings.slice(0, MAX_REPORTED_FINDINGS);
}

/**
 * redaction.screenshots: "raw" is the SUPPORTED local default (full-fidelity frames in
 * gitignored .humanish), not a verify failure — but ok: true must never read as "share-ready",
 * so verify surfaces the posture as a warning in both human and JSON output. Read defensively
 * for the same reason as noEngagementActorFindings.
 */
export function rawScreenshotPostureWarnings(
  bundle: RunBundle,
  redactedShapeFrames: ReadonlySet<string>,
): string[] {
  const rawStreamIds = rawScreenshotStreamIds(bundle, redactedShapeFrames);

  if (rawStreamIds.length === 0) {
    return [];
  }

  return [
    `Screenshots are FULL-FIDELITY (raw) or carry no redaction claim on ${rawStreamIds.join(", ")} — supported for local use, NOT publish-safe as-is. Verify ok does not mean share-ready; set policies.redactScreenshots: true to blur a share-as-is bundle.`,
  ];
}

/**
 * The declared frames, as normalized run-root paths, whose bytes have the redactor's output shape
 * (isRedactedFrameShape). A frame that is missing or cannot be read is not in the set.
 */
export async function redactedShapeFramePaths(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
): Promise<Set<string>> {
  const shaped = new Set<string>();
  for (const stream of bundle.streams) {
    for (const reference of declaredActorScreenshotReferences(stream)) {
      if (!isRunRootEvidenceReference(reference.path)) continue;
      const normalized = normalizedFramePath(reference.path);
      if (shaped.has(normalized)) continue;
      const bytes = await readSafeRunArtifactBytes(runPaths, normalized).catch(() => null);
      if (bytes !== null && isRedactedFrameShape(bytes)) shaped.add(normalized);
    }
  }
  return shaped;
}

function normalizedFramePath(value: string): string {
  return path.posix.normalize(value.replace(/\\/g, "/"));
}

/**
 * The streams whose frames count as full-fidelity. A frame is redacted only when its bytes have
 * the redactor's output shape (`redactedShapeFrames`) and either it claims `blurred`, or it has no
 * claim and the stream's final trace posture is `blurred`: the computer-use loop blurs every frame
 * of such a trace, and bundles from before per-frame claims carry only the posture. Every other
 * frame is raw, including `ocr_scrubbed`, which no writer produces. An aggregate raw posture
 * outranks every frame claim.
 */
export function rawScreenshotStreamIds(
  bundle: RunBundle,
  redactedShapeFrames: ReadonlySet<string>,
): string[] {
  const rawStreamIds: string[] = [];
  for (const stream of bundle.streams) {
    const trace: unknown = stream.actor;
    const posture =
      isRecord(trace) && isRecord(trace.redaction) ? trace.redaction.screenshots : undefined;
    const frameRaw = declaredActorScreenshotReferences(stream).some((reference) => {
      const claimed =
        reference.redaction === "blurred" ||
        (reference.redaction === undefined && posture === "blurred");
      return !(
        claimed &&
        typeof reference.path === "string" &&
        redactedShapeFrames.has(normalizedFramePath(reference.path))
      );
    });
    if (posture === "raw" || frameRaw) {
      rawStreamIds.push(stream.id);
    }
  }
  return rawStreamIds;
}

/** Stream media the bundle registers; other grades (RAW_SCREENSHOTS, CONTINUOUS_MEDIA) cover it. */
interface RegisteredStreamMedia {
  recordingPaths: Set<string>;
  screenshotPaths: Set<string>;
}

/**
 * Scans every run file for secret and path patterns and returns the findings. A file that is not
 * registered stream media and that the scan cannot read as text (readPlainText), or cannot read at
 * all, goes to `unscanned`, so the caller can keep the run from grading share_ready.
 */
export async function scanRunPublicSafetyArtifacts(
  runPaths: PreparedRunArtifactPaths,
  derivedFindings: string[],
  media: RegisteredStreamMedia,
  unscanned: string[],
): Promise<string[]> {
  const findings: string[] = [];
  await validatePreparedRunArtifactPaths(runPaths);
  await scanRunPublicSafetyDirectory(runPaths, "", findings, derivedFindings, media, unscanned);
  await validatePreparedRunArtifactPaths(runPaths);
  return findings;
}

async function scanRunPublicSafetyDirectory(
  runPaths: PreparedRunArtifactPaths,
  relativeDirectory: string,
  findings: string[],
  derivedFindings: string[],
  media: RegisteredStreamMedia,
  unscanned: string[],
): Promise<void> {
  // Each authority has its own finding budget. Derived files must never consume
  // the source scan's budget and make an unscanned recording appear verified.
  if (findings.length >= MAX_REPORTED_FINDINGS && derivedFindings.length >= MAX_REPORTED_FINDINGS) {
    return;
  }

  const current = relativeDirectory
    ? path.join(runPaths.physicalRunRoot, ...relativeDirectory.split("/"))
    : runPaths.physicalRunRoot;
  const entries = await readdir(current).catch(() => []);
  for (const entryName of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entryName}` : entryName;
    const stats = await lstat(path.join(current, entryName), { bigint: true }).catch(() => null);
    const selectedFindings =
      !stats?.isDirectory() &&
      (relativePath === "observer/study-analysis.json" || isAnalysisRecordPath(relativePath))
        ? derivedFindings
        : findings;
    if (isRiskyPublicArtifactPath(relativePath) || containsSensitive(relativePath)) {
      if (selectedFindings.length < MAX_REPORTED_FINDINGS)
        selectedFindings.push(`risky artifact path ${relativePath}`);
    }
    // Readers map `\` to `/` and would read some other path, and export refuses the name.
    if (entryName.includes("\\")) {
      if (selectedFindings.length < MAX_REPORTED_FINDINGS)
        selectedFindings.push(`unsafe artifact leaf ${relativePath}`);
      continue;
    }

    if (
      !stats ||
      stats.isSymbolicLink() ||
      (!stats.isDirectory() && !stats.isFile()) ||
      (stats.isFile() && stats.nlink > 1n)
    ) {
      if (selectedFindings.length < MAX_REPORTED_FINDINGS)
        selectedFindings.push(`unsafe artifact leaf ${relativePath}`);
      continue;
    }

    if (stats.isDirectory()) {
      // A directory named analysis.json is not an owned record. Its children
      // can contain source evidence even after derived findings are saturated.
      await scanRunPublicSafetyDirectory(
        runPaths,
        relativePath,
        findings,
        derivedFindings,
        media,
        unscanned,
      );
      continue;
    }

    if (selectedFindings.length >= MAX_REPORTED_FINDINGS) continue;

    if (
      path.extname(relativePath).toLowerCase() === ".mp4" &&
      !media.recordingPaths.has(relativePath)
    ) {
      selectedFindings.push(`unregistered continuous media ${relativePath}`);
      continue;
    }
    // RAW_SCREENSHOTS and CONTINUOUS_MEDIA grade the stream media the bundle registers.
    if (media.recordingPaths.has(relativePath) || media.screenshotPaths.has(relativePath)) {
      continue;
    }
    // The scan reads a file by its bytes, not its name. A file that is not text, or that could
    // not be read at all, holds bytes the scan never saw.
    const bytes = await readSafeRunArtifactBytes(runPaths, relativePath).catch(() => null);
    const decoded = bytes === null ? undefined : readPlainText(bytes);
    if (decoded === undefined || !decoded.ok) {
      unscanned.push(relativePath);
      continue;
    }
    // serve renders observer/index.html from run.json and export regenerates it, so the on-disk
    // copy reaches neither. It embeds the Observer's own base64 fonts and scripts.
    const scan = scanEncodedTextCached(decoded.text, {
      allowOpaqueBase64: relativePath === "observer/index.html",
    });
    if (scan.sensitive) {
      selectedFindings.push(`sensitive text ${relativePath}`);
    } else if (scan.opaque) {
      unscanned.push(relativePath);
    }
  }
}

function normalizeLocalEvidenceReference(value: string | undefined): string | null {
  if (!value || value.includes("://") || path.isAbsolute(value)) {
    return null;
  }

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("../")) {
    return isLocalEvidenceArtifactPath(normalized.slice(3)) ? normalized.slice(3) : null;
  }

  return isLocalEvidenceArtifactPath(normalized) ? normalized : null;
}
