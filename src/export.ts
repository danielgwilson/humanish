// `humanish export`: one file a coworker can open (#471).
//
// A run is a directory. Sharing it meant a tunnel (`serve --expose`) or a hand-zipped bundle,
// neither of which is "send one thing". The Observer is already a single-file artifact with the
// run's data inlined; what keeps it from travelling is the screenshots it references by path.
// Export inlines those as data URIs and writes ONE .html that opens from a mail attachment.
//
// Share safety is the point, not a step: export runs verify inside the flow and refuses a bundle
// that is not share_ready. A local_only bundle (raw screenshots) exports only with an explicit
// --local-only, and the file it writes says so in a banner nothing can miss.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveRunPath, verifyRun, type VerifyResult } from "./run.js";

export const EXPORT_SCHEMA = "humanish.export-result.v1";
/** Past this the file stops being a thing you attach to an email. Declared, never silent. */
export const DEFAULT_EXPORT_MAX_BYTES = 25 * 1024 * 1024;

const OBSERVER_DATA_SLOT = /<script id="observer-data" type="application\/json">([\s\S]*?)<\/script>/;
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

export interface ExportResult {
  schema: typeof EXPORT_SCHEMA;
  ok: true;
  cwd: string;
  runId: string;
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
      | "HUMANISH_EXPORT_TOO_LARGE";
    message: string;
  };
}

export interface ExportOptions {
  out?: string;
  localOnly?: boolean;
  maxBytes?: number;
}

export interface ExportDeps {
  /** Injected in tests: a fake verify with a chosen shareSafety, no full bundle needed. */
  verify?: (cwd: string, run: string) => Promise<VerifyResult>;
}

function escapeJsonScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The banner a --local-only export carries. Plain HTML, before the app root, so it renders with JS off. */
export function localOnlyBanner(reasons: string[]): string {
  const why = reasons.length === 0 ? "" : ` (${reasons.join(", ")})`;
  return `<div id="humanish-local-only" role="alert" style="position:sticky;top:0;z-index:2147483647;background:#7a1f1f;color:#fff;font:600 14px/1.4 system-ui,sans-serif;padding:10px 16px;text-align:center">`
    + `LOCAL ONLY. This export was made from a bundle that is not share-safe${why}. Do not forward it outside the team that owns the run.`
    + `</div>`;
}

async function isInside(root: string, candidate: string): Promise<boolean> {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function exportRun(
  cwdInput: string,
  runInput: string,
  options: ExportOptions = {},
  deps: ExportDeps = {}
): Promise<ExportResult | ExportFailure> {
  const cwd = path.resolve(cwdInput);
  const runPaths = await resolveRunPath(cwd, runInput).catch(() => null);
  if (runPaths === null) {
    return { schema: EXPORT_SCHEMA, ok: false, cwd, run: runInput, error: { code: "HUMANISH_EXPORT_RUN_NOT_FOUND", message: `No run resolves from "${runInput}" under ${cwd}.` } };
  }
  const runRoot = runPaths.absoluteRunRoot;
  const runId = path.basename(runRoot);

  const verified = await (deps.verify ?? verifyRun)(cwd, runInput);
  if (!verified.ok) {
    return {
      schema: EXPORT_SCHEMA, ok: false, cwd, run: runInput, shareSafety: verified.shareSafety,
      error: { code: "HUMANISH_EXPORT_VERIFY_FAILED", message: `Run ${runId} does not verify; export refuses to package evidence that fails its own checks.` }
    };
  }
  const shareReady = verified.shareSafety.status === "share_ready";
  if (!shareReady && options.localOnly !== true) {
    return {
      schema: EXPORT_SCHEMA, ok: false, cwd, run: runInput, shareSafety: verified.shareSafety,
      error: {
        code: "HUMANISH_EXPORT_SHARE_SAFETY_BLOCKED",
        message: `Run ${runId} is ${verified.shareSafety.status}, not share_ready: ${verified.shareSafety.reasons.map((r) => r.code).join(", ")}. Re-run with policies.redactScreenshots: true, or pass --local-only to export a watermarked file for people who may see raw screenshots.`
      }
    };
  }

  const observerPath = path.join(runRoot, "observer", "index.html");
  let html: string;
  try {
    html = await readFile(observerPath, "utf8");
  } catch {
    return { schema: EXPORT_SCHEMA, ok: false, cwd, run: runInput, shareSafety: verified.shareSafety, error: { code: "HUMANISH_EXPORT_NO_OBSERVER", message: `Run ${runId} has no observer/index.html to export.` } };
  }
  const slot = OBSERVER_DATA_SLOT.exec(html);
  if (slot === null) {
    return { schema: EXPORT_SCHEMA, ok: false, cwd, run: runInput, shareSafety: verified.shareSafety, error: { code: "HUMANISH_EXPORT_NO_OBSERVER", message: `Run ${runId}'s Observer carries no inline data slot; rebuild the run's Observer first.` } };
  }

  // Every string in the data that names an image file inside the run becomes a data URI. Paths are
  // run-root-relative in the data; a path that resolves outside the run is left alone, never read.
  const data: unknown = JSON.parse(slot[1]!);
  const cache = new Map<string, string | null>();
  let embedded = 0;
  let imageBytes = 0;
  const warnings: string[] = [];
  const inline = async (value: string): Promise<string> => {
    const ext = path.extname(value).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (mime === undefined || value.startsWith("data:") || /^[a-z]+:\/\//i.test(value)) return value;
    const cached = cache.get(value);
    if (cached !== undefined) return cached ?? value;
    const candidates = [path.resolve(runRoot, value), path.resolve(runRoot, "observer", value)];
    for (const candidate of candidates) {
      if (!(await isInside(runRoot, candidate))) continue;
      const info = await stat(candidate).catch(() => null);
      if (info === null || !info.isFile()) continue;
      const bytes = await readFile(candidate);
      imageBytes += bytes.byteLength;
      embedded += 1;
      const uri = `data:${mime};base64,${bytes.toString("base64")}`;
      cache.set(value, uri);
      return uri;
    }
    cache.set(value, null);
    warnings.push(`image not found inside the run, left as a path: ${value}`);
    return value;
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
  const inlined = await walk(data) as Record<string, unknown>;
  // What verify said, in the file, so the chrome can agree with the result envelope (#584).
  const publicSafety = (inlined.publicSafety ?? {}) as Record<string, unknown>;
  inlined.publicSafety = {
    ...publicSafety,
    share: {
      status: verified.shareSafety.status,
      verifiedAt: new Date().toISOString(),
      reasons: verified.shareSafety.reasons.map((r) => r.code)
    }
  };

  let output = html.replace(OBSERVER_DATA_SLOT, () => `<script id="observer-data" type="application/json">${escapeJsonScript(JSON.stringify(inlined))}</script>`);
  const watermarked = !shareReady;
  if (watermarked) {
    const banner = localOnlyBanner(verified.shareSafety.reasons.map((r) => r.code));
    output = output.includes("<body>") ? output.replace("<body>", `<body>${banner}`) : `${banner}${output}`;
  }
  const bytes = Buffer.byteLength(output, "utf8");
  const maxBytes = options.maxBytes ?? DEFAULT_EXPORT_MAX_BYTES;
  if (bytes > maxBytes) {
    return {
      schema: EXPORT_SCHEMA, ok: false, cwd, run: runInput, shareSafety: verified.shareSafety,
      error: { code: "HUMANISH_EXPORT_TOO_LARGE", message: `Export would be ${bytes} bytes (${embedded} images, ${imageBytes} image bytes), over the ${maxBytes}-byte cap. Raise --max-bytes deliberately, or export a run with fewer frames.` }
    };
  }

  const outPath = path.resolve(cwd, options.out ?? path.join(".humanish", "exports", `${runId}.html`));
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
    warnings
  };
}

export function formatExportHuman(result: ExportResult | ExportFailure): string {
  if (!result.ok) return `${result.error.code}: ${result.error.message}\n`;
  const lines = [
    `humanish export ${result.runId}`,
    `file: ${result.path} (${(result.bytes / 1024).toFixed(0)} KB, ${result.embeddedImages} image(s) embedded)`,
    `share safety: ${result.shareSafety.status}${result.watermarked ? " — WATERMARKED LOCAL ONLY" : ""}`,
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ];
  return `${lines.join("\n")}\n`;
}
