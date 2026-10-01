// `humanish export`: one file a coworker can open (#471).
//
// A run is a directory. Sharing it meant a tunnel (`serve --expose`) or a hand-zipped bundle,
// neither of which is "send one thing". The Observer is already a single-file artifact with the
// run's data inlined; what keeps it from travelling is the screenshots it references by path.
// Export embeds each unique raster once and writes ONE .html that opens offline.
//
// Share safety is the point, not a step: export runs verify inside the flow and refuses a bundle
// that is not share_ready. A local_only bundle (raw screenshots) exports only with an explicit
// --local-only, and the file it writes says so in a banner nothing can miss.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { renderObserver } from "../observer/render.js";
import { renderObserverHtml, type ObserverExportAssets } from "../observer/artifact.js";
import { buildObserverData, type ObserverData } from "../observer/data.js";
import { resolveRunPath } from "../run/locate.js";
import { verifyRun, type VerifyResult } from "../verify/verify.js";
import { type RunBundle } from "../run/bundle.js";
import { exportRedactedBundle } from "./export-bundle.js";
import { loadStudyAnalysis } from "../analysis/load.js";
import { studyAnalysisSharingProblems } from "../analysis/sharing.js";
import { STUDY_EVIDENCE_LIMITS, validateStudyAnalysisEvidence } from "../analysis/evidence.js";
import { readBoundedStudyFile } from "../run/study-files.js";
import { shellQuote } from "../substrates/shell.js";

const EXPORT_SCHEMA = "humanish.export-result.v1";
/** Past this the file stops being a thing you attach to an email. Declared, never silent. */
export const DEFAULT_EXPORT_MAX_BYTES = 25 * 1024 * 1024;
// The portable browser loader applies the same per-raster allocation bound.
const MAX_PORTABLE_IMAGE_BYTES = 64 * 1024 * 1024;

const OBSERVER_DATA_SLOT =
  /<script id="observer-data" type="application\/json">([\s\S]*?)<\/script>/;
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface ExportResult {
  schema: typeof EXPORT_SCHEMA;
  ok: true;
  cwd: string;
  runId: string;
  format?: "bundle";
  /** Repo-relative path of the file written. */
  path: string;
  bytes: number;
  embeddedImages: number;
  shareSafety: VerifyResult["shareSafety"];
  /** True when --local-only exported a bundle that is not share_ready; the file carries a banner. */
  watermarked: boolean;
  warnings: string[];
}

export interface ExportFailure {
  schema: typeof EXPORT_SCHEMA;
  ok: false;
  cwd: string;
  run: string;
  shareSafety?: VerifyResult["shareSafety"];
  error: {
    code:
      | "HUMANISH_EXPORT_RUN_NOT_FOUND"
      | "HUMANISH_EXPORT_VERIFY_FAILED"
      | "HUMANISH_EXPORT_SHARE_SAFETY_BLOCKED"
      | "HUMANISH_EXPORT_NO_OBSERVER"
      | "HUMANISH_EXPORT_TOO_LARGE"
      | "HUMANISH_EXPORT_INVALID_OPTIONS"
      | "HUMANISH_EXPORT_OUTPUT_EXISTS"
      | "HUMANISH_EXPORT_BUNDLE_REFUSED";
    message: string;
  };
}

export interface ExportOptions {
  format?: "html" | "bundle";
  redactScreenshots?: boolean;
  out?: string;
  localOnly?: boolean;
  maxBytes?: number;
}

export interface ExportDeps {
  /** Injected in tests: a fake verify with a chosen shareSafety, no full bundle needed. */
  verify?: (cwd: string, run: string) => Promise<VerifyResult>;
  /** Injected in tests: renders observer/index.html for a run that has none. Defaults to renderObserver. */
  render?: (cwd: string, run: string) => Promise<{ ok: boolean }>;
}

/** The banner a --local-only export carries. Plain HTML, before the app root, so it renders with JS off. */
export function localOnlyBanner(reasons: string[]): string {
  const why = reasons.length === 0 ? "" : ` (${reasons.join(", ")})`;
  return (
    `<div id="humanish-local-only" role="alert" tabindex="0" style="position:sticky;top:0;z-index:2147483647;max-height:40vh;overflow:auto;background:#7a1f1f;color:#fff;font:600 14px/1.4 system-ui,sans-serif;padding:10px 16px;text-align:center">` +
    `LOCAL ONLY. This export was made from a bundle that is not share-safe${why}. Do not forward it outside the team that owns the run.` +
    `</div>`
  );
}

async function isInside(root: string, candidate: string): Promise<boolean> {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const MEDIA_OMISSION =
  "Continuous video/audio is excluded from this HTML export. Open the original run in humanish to play it.";

function exportFailure(
  cwd: string,
  run: string,
  code: ExportFailure["error"]["code"],
  message: string,
  shareSafety?: VerifyResult["shareSafety"],
): ExportFailure {
  return {
    schema: EXPORT_SCHEMA,
    ok: false,
    cwd,
    run,
    ...(shareSafety === undefined ? {} : { shareSafety }),
    error: { code, message },
  };
}

type RunPaths = NonNullable<Awaited<ReturnType<typeof resolveRunPath>>>;
type StudyAnalysisState = Awaited<ReturnType<typeof loadStudyAnalysis>>;

export async function exportRun(
  cwdInput: string,
  runInput: string,
  options: ExportOptions = {},
  deps: ExportDeps = {},
): Promise<ExportResult | ExportFailure> {
  if (options.format === "bundle") return exportRedactedBundle(cwdInput, runInput, options);
  const cwd = path.resolve(cwdInput);
  const source = await resolveExportSource(cwd, runInput, options, deps);
  if ("error" in source) return source;
  const { runPaths, runRoot, runId, verified } = source;
  let shareReady = verified.shareSafety.status === "share_ready";

  const warnings: string[] = [];
  const slot = await readObserverSlot(cwd, runInput, runRoot, runId, verified, deps, warnings);
  if (typeof slot !== "string") return slot;

  // Every string in the data that names an image file inside the run becomes an asset reference. Paths are
  // run-root-relative in the data; a path that resolves outside the run is left alone, never read.
  const analysis = await loadStudyAnalysis(runPaths);
  const data = await currentObserverData(runPaths, analysis, slot);
  if (data === undefined)
    return exportFailure(
      cwd,
      runInput,
      "HUMANISH_EXPORT_VERIFY_FAILED",
      "Source evidence changed while preparing the analysis export.",
    );
  const omittedRecording = omitRecordings(data.value);
  if (omittedRecording) warnings.push(MEDIA_OMISSION);
  const images = await inlineImages(runPaths, runRoot, data.value, analysis, options, warnings);
  if (images.failure !== undefined)
    return images.failure === "too_large"
      ? exportFailure(
          cwd,
          runInput,
          "HUMANISH_EXPORT_TOO_LARGE",
          "A captured image exceeds the portable viewer's 64 MiB per-image limit. Export the evidence bundle instead.",
        )
      : exportFailure(
          cwd,
          runInput,
          "HUMANISH_EXPORT_VERIFY_FAILED",
          "Captured evidence changed while assembling the export.",
        );
  const { inlined, assets, embedded, imageBytes } = images;
  makePortable(inlined, verified);

  const analysisCheck = await recheckAnalysis(runPaths, analysis, verified, inlined, options);
  if (analysisCheck === "changed")
    return exportFailure(
      cwd,
      runInput,
      "HUMANISH_EXPORT_VERIFY_FAILED",
      "Analysis evidence changed during export.",
    );
  if (analysisCheck === "blocked")
    return exportFailure(
      cwd,
      runInput,
      "HUMANISH_EXPORT_SHARE_SAFETY_BLOCKED",
      "Analysis changed or contains unverified text. Review the current evidence before sharing.",
      verified.shareSafety,
    );
  if (analysisCheck === "downgraded") shareReady = false;
  warnings.push(...analysis.warnings);
  const watermarked = !shareReady || omittedRecording;
  const output = renderExportHtml(
    inlined,
    analysis,
    assets,
    verified,
    watermarked,
    omittedRecording,
  );

  const bytes = Buffer.byteLength(output, "utf8");
  const maxBytes = options.maxBytes ?? DEFAULT_EXPORT_MAX_BYTES;
  if (bytes > maxBytes) {
    return exportFailure(
      cwd,
      runInput,
      "HUMANISH_EXPORT_TOO_LARGE",
      `Export would be ${bytes} bytes (${embedded} images, ${imageBytes} image bytes), over the ${maxBytes}-byte cap. Raise --max-bytes deliberately, or export a run with fewer frames.`,
      verified.shareSafety,
    );
  }
  const outPath = path.resolve(
    cwd,
    options.out ?? path.join(".humanish", "exports", `${runId}.html`),
  );
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, output, "utf8");
  return {
    schema: EXPORT_SCHEMA,
    ok: true,
    cwd,
    runId,
    path: path.relative(cwd, outPath),
    bytes,
    embeddedImages: embedded,
    shareSafety: verified.shareSafety,
    watermarked,
    warnings,
  };
}

/** Resolves the run and refuses one that does not verify or, without --local-only, is not share_ready. */
async function resolveExportSource(
  cwd: string,
  runInput: string,
  options: ExportOptions,
  deps: ExportDeps,
): Promise<
  ExportFailure | { runPaths: RunPaths; runRoot: string; runId: string; verified: VerifyResult }
> {
  if (options.redactScreenshots === true) {
    return exportFailure(
      cwd,
      runInput,
      "HUMANISH_EXPORT_INVALID_OPTIONS",
      "--redact-screenshots requires --format bundle. HTML export does not transform its source.",
    );
  }
  const runPaths = await resolveRunPath(cwd, runInput).catch(() => null);
  if (runPaths === null) {
    return exportFailure(
      cwd,
      runInput,
      "HUMANISH_EXPORT_RUN_NOT_FOUND",
      `No run resolves from "${runInput}" under ${cwd}.`,
    );
  }
  const runRoot = runPaths.absoluteRunRoot;
  const runId = path.basename(runRoot);

  const verified = await (deps.verify ?? verifyRun)(cwd, runInput);
  if (!verified.ok) {
    return exportFailure(
      cwd,
      runInput,
      "HUMANISH_EXPORT_VERIFY_FAILED",
      `Run ${runId} does not verify; export refuses to package evidence that fails its own checks.`,
      verified.shareSafety,
    );
  }
  if (verified.shareSafety.status !== "share_ready" && options.localOnly !== true) {
    return exportFailure(
      cwd,
      runInput,
      "HUMANISH_EXPORT_SHARE_SAFETY_BLOCKED",
      `Run ${runId} is ${verified.shareSafety.status}, not share_ready: ${verified.shareSafety.reasons.map((r) => r.code).join(", ")}. ${shareSafetyRemedy(verified.shareSafety.reasons.map((r) => r.code))}`,
      verified.shareSafety,
    );
  }
  return { runPaths, runRoot, runId, verified };
}

/** The Observer's inline data slot, rendering observer/index.html first when the run has none. */
async function readObserverSlot(
  cwd: string,
  runInput: string,
  runRoot: string,
  runId: string,
  verified: VerifyResult,
  deps: ExportDeps,
  warnings: string[],
): Promise<string | ExportFailure> {
  const observerPath = path.join(runRoot, "observer", "index.html");
  let html: string;
  try {
    html = await readFile(observerPath, "utf8");
  } catch {
    // `run` writes observer-data.json and no index.html; `watch` writes both (#597). The
    // 0.72.0 dogfood participant hit this on its first export. Render it here, from the same
    // artifact watch uses, so what produced the run never decides whether it can be sent.
    const rendered = await (deps.render ?? ((c, r) => renderObserver(c, r, { open: false })))(
      cwd,
      runInput,
    ).catch(() => ({ ok: false }));
    try {
      if (!rendered.ok) throw new Error("render failed");
      html = await readFile(observerPath, "utf8");
      warnings.push(
        "observer/index.html was missing and has been rendered for this export (a `run` bundle; `watch` writes it)",
      );
    } catch {
      return exportFailure(
        cwd,
        runInput,
        "HUMANISH_EXPORT_NO_OBSERVER",
        `Run ${runId} has no observer/index.html and one could not be rendered from its bundle.`,
        verified.shareSafety,
      );
    }
  }
  const slot = OBSERVER_DATA_SLOT.exec(html);
  if (slot === null) {
    return exportFailure(
      cwd,
      runInput,
      "HUMANISH_EXPORT_NO_OBSERVER",
      `Run ${runId}'s Observer carries no inline data slot; rebuild the run's Observer first.`,
      verified.shareSafety,
    );
  }
  return slot[1]!;
}

/**
 * The Observer data to export. A current report must travel with the current source projection,
 * even if an older saved HTML was never refreshed; old recording-only exports keep the saved slot.
 * Undefined when run.json no longer matches the analysis.
 */
async function currentObserverData(
  runPaths: RunPaths,
  analysis: StudyAnalysisState,
  slot: string,
): Promise<{ value: unknown } | undefined> {
  const saved: unknown = JSON.parse(slot);
  if (analysis.state !== "ready" || !analysis.analysis) return { value: saved };
  const source = await readBoundedStudyFile(
    runPaths,
    "run.json",
    STUDY_EVIDENCE_LIMITS.sourceBytes,
  );
  if (
    !source ||
    createHash("sha256").update(source).digest("hex") !== analysis.analysis.sourceRunSha256
  )
    return undefined;
  return { value: buildObserverData(JSON.parse(source.toString("utf8")) as RunBundle) };
}

/** Portable HTML keeps the lightweight evidence; media remains in the source run. */
function omitRecordings(data: unknown): boolean {
  let omittedRecording = false;
  if (data && typeof data === "object" && "streams" in data && Array.isArray(data.streams)) {
    for (const stream of data.streams) {
      if (stream && typeof stream === "object" && stream.recording) {
        omittedRecording = true;
        delete stream.recording;
        if (Array.isArray(stream.artifacts))
          stream.artifacts = stream.artifacts.filter(
            (artifact: { kind?: string }) => artifact.kind !== "recording",
          );
      }
    }
  }
  return omittedRecording;
}

type InlinedImages =
  | { failure: "too_large" | "changed" }
  | {
      failure?: undefined;
      inlined: Record<string, unknown>;
      assets: ObserverExportAssets;
      embedded: number;
      imageBytes: number;
    };

/** Replaces each image path inside the run with an embedded asset, each unique raster once. */
async function inlineImages(
  runPaths: RunPaths,
  runRoot: string,
  data: unknown,
  analysis: StudyAnalysisState,
  options: ExportOptions,
  warnings: string[],
): Promise<InlinedImages> {
  const cache = new Map<string, Promise<string>>();
  const assets: ObserverExportAssets = {};
  const analysisCaptures = new Map(
    analysis.state === "ready"
      ? (analysis.analysis?.evidence.flatMap((item) =>
          item.capture ? [[item.capture.path, item.capture.sha256] as const] : [],
        ) ?? [])
      : [],
  );
  let embedded = 0;
  let imageBytes = 0;
  let oversizedImage = false;
  const readImage = async (value: string, mime: string): Promise<string> => {
    const candidates = [path.resolve(runRoot, value), path.resolve(runRoot, "observer", value)];
    for (const candidate of candidates) {
      if (!(await isInside(runRoot, candidate))) continue;
      const bytes = await readBoundedStudyFile(
        runPaths,
        path.relative(runRoot, candidate),
        options.maxBytes ?? DEFAULT_EXPORT_MAX_BYTES,
      );
      if (bytes === null) continue;
      if (bytes.byteLength > MAX_PORTABLE_IMAGE_BYTES) {
        oversizedImage = true;
        throw new Error("PORTABLE_IMAGE_TOO_LARGE");
      }
      const expectedHash = analysisCaptures.get(
        path.relative(runRoot, candidate).split(path.sep).join("/"),
      );
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (expectedHash && hash !== expectedHash) {
        throw new Error("ANALYSIS_EXPORT_CAPTURE_CHANGED");
      }
      if (!assets[hash]) {
        imageBytes += bytes.byteLength;
        embedded += 1;
        assets[hash] = { mime, base64: bytes.toString("base64") };
      }
      return `humanish-asset:${hash}`;
    }
    warnings.push(`image not found inside the run, left as a path: ${value}`);
    return value;
  };
  const inline = (value: string): Promise<string> => {
    const mime = IMAGE_MIME[path.extname(value).toLowerCase()];
    if (mime === undefined || value.startsWith("data:") || /^[a-z]+:\/\//i.test(value))
      return Promise.resolve(value);
    const cached = cache.get(value);
    if (cached) return cached;
    // Memoize the in-flight read, too: parallel frame arrays often name the same image.
    const pending = readImage(value, mime);
    cache.set(value, pending);
    return pending;
  };
  const walk = async (node: unknown): Promise<unknown> => {
    if (typeof node === "string") return inline(node);
    if (Array.isArray(node)) return Promise.all(node.map(walk));
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) out[key] = await walk(value);
      return out;
    }
    return node;
  };
  try {
    const inlined = (await walk(data)) as Record<string, unknown>;
    return { inlined, assets, embedded, imageBytes };
  } catch {
    return { failure: oversizedImage ? "too_large" : "changed" };
  }
}

/** Drops live-runtime fields and records what verify said, so the chrome agrees with the result. */
function makePortable(inlined: Record<string, unknown>, verified: VerifyResult): void {
  // Export is a recording, even if a saved input HTML once carried a server observation.
  // Runtime iframe authority and liveness cannot survive into a portable document.
  delete inlined.runtime;
  if (Array.isArray(inlined.streams)) {
    for (const stream of inlined.streams) {
      if (stream === null || typeof stream !== "object" || Array.isArray(stream)) continue;
      const embed: unknown = (stream as Record<string, unknown>).embed;
      if (embed !== null && typeof embed === "object" && !Array.isArray(embed)) {
        delete (embed as Record<string, unknown>).runtimeDesktop;
      }
    }
  }
  // What verify said, in the file, so the chrome can agree with the result envelope (#584).
  const publicSafety = (inlined.publicSafety ?? {}) as Record<string, unknown>;
  inlined.publicSafety = {
    ...publicSafety,
    share: {
      status: verified.shareSafety.status,
      verifiedAt: new Date().toISOString(),
      reasons: verified.shareSafety.reasons.map((r) => r.code),
    },
  };
}

/**
 * Revalidates the analysis against source evidence and its sharing checks. A failed check
 * downgrades share safety, which only --local-only may export.
 */
async function recheckAnalysis(
  runPaths: RunPaths,
  analysis: StudyAnalysisState,
  verified: VerifyResult,
  inlined: Record<string, unknown>,
  options: ExportOptions,
): Promise<"ok" | "changed" | "blocked" | "downgraded"> {
  // Evidence survives upgrades; obsolete renderer code does not. Use this installation
  // of the Observer rather than copying script/style bytes from the saved source HTML.
  // Revalidate the independent interpretation against source evidence. Never trust a
  // saved HTML slot or traverse model-provided strings as image paths.
  if (analysis.state === "ready" && analysis.analysis) {
    const source = await readBoundedStudyFile(
      runPaths,
      "run.json",
      STUDY_EVIDENCE_LIMITS.sourceBytes,
    );
    try {
      if (!source) throw new Error("source unavailable");
      await validateStudyAnalysisEvidence(runPaths, analysis.analysis, source);
    } catch {
      return "changed";
    }
  }
  const analysisSharing = studyAnalysisSharingProblems(analysis);
  if (!analysisSharing.sensitive && !analysisSharing.unverified) return "ok";
  verified.shareSafety = {
    status: analysisSharing.sensitive ? "blocked" : "local_only",
    reasons: [
      ...verified.shareSafety.reasons,
      {
        code: "ANALYSIS_UNVERIFIED",
        message: "The exact analysis snapshot being exported did not pass sharing checks.",
      },
    ],
  };
  if (options.localOnly !== true) return "blocked";
  (inlined.publicSafety as Record<string, unknown>).share = {
    status: verified.shareSafety.status,
    verifiedAt: new Date().toISOString(),
    reasons: verified.shareSafety.reasons.map((reason) => reason.code),
  };
  return "downgraded";
}

/** The portable Observer HTML, with the local-only banner when the export is watermarked. */
function renderExportHtml(
  inlined: Record<string, unknown>,
  analysis: StudyAnalysisState,
  assets: ObserverExportAssets,
  verified: VerifyResult,
  watermarked: boolean,
  omittedRecording: boolean,
): string {
  const output = renderObserverHtml(inlined as unknown as ObserverData, {
    snapshot: true,
    analysis,
    assets,
  });
  if (!watermarked) return output;
  const banner =
    localOnlyBanner(verified.shareSafety.reasons.map((r) => r.code)) +
    (omittedRecording
      ? `<p role="status" style="margin:0;padding:8px 16px;background:#fff4d5;color:#352600;font:13px system-ui">${MEDIA_OMISSION}</p>`
      : "");
  // The warning and app share the viewport. A full-height app beneath an
  // extra banner would scroll the document when recording controls focus.
  const layout = `<style id="humanish-export-layout">body[data-humanish-local-export]{display:grid;grid-template-rows:auto ${omittedRecording ? "auto " : ""}minmax(0,1fr);height:100dvh;overflow:hidden}body[data-humanish-local-export]>#root{min-height:0;overflow:hidden}</style>`;
  return output.includes("<body>")
    ? output
        .replace("</head>", `${layout}</head>`)
        .replace("<body>", `<body data-humanish-local-export>${banner}`)
    : `${banner}${output}`;
}

export function formatExportHuman(result: ExportResult | ExportFailure): string {
  if (!result.ok) return `${result.error.code}: ${result.error.message}\n`;
  if (result.format === "bundle") {
    return [
      `humanish export ${result.runId}`,
      `workspace: ${result.path} (${(result.bytes / 1024).toFixed(0)} KB, ${result.embeddedImages} blurred image(s))`,
      `share safety: ${result.shareSafety.status}`,
      `verify: humanish verify --cwd ${shellQuote(result.path)} --run ${shellQuote(result.runId)}`,
      `feedback: humanish feedback draft --cwd ${shellQuote(result.path)} --run ${shellQuote(result.runId)}`,
      ...result.warnings.map((warning) => `warning: ${warning}`),
      "",
    ].join("\n");
  }
  const lines = [
    `humanish export ${result.runId}`,
    `file: ${result.path} (${(result.bytes / 1024).toFixed(0)} KB, ${result.embeddedImages} image(s) embedded)`,
    `share safety: ${result.shareSafety.status}${result.watermarked ? " — WATERMARKED LOCAL ONLY" : ""}`,
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** What clears each refusal reason, so the advice never names a fix that cannot work. */
function shareSafetyRemedy(codes: string[]): string {
  const steps: string[] = [];
  if (codes.includes("RAW_SCREENSHOTS")) {
    steps.push("Re-run with policies.redactScreenshots: true to blur screenshots at capture.");
  }
  if (codes.includes("UNSCANNED_ARTIFACT")) {
    steps.push(
      "verify cannot read the images or archives that `humanish verify --json` lists under UNSCANNED_ARTIFACT: remove them from the run folder, or keep only images an actor trace references as stream screenshots.",
    );
  }
  steps.push(
    "Or pass --local-only to export a watermarked file for people who may see the evidence as it is.",
  );
  return steps.join(" ");
}
