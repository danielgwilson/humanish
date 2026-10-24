// How a redacted copy rewrites a run's text: screenshots declared blurred, sandbox ids redacted,
// inline images and secret-shaped text refused. src/feedback/export-bundle.ts copies the files.
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { ACTOR_TRACE_SCHEMA } from "../actors/contract.js";
import { containsSensitive, redactSandboxIds } from "../evidence/redaction.js";
import { decodeEscapes, readingsOf } from "../evidence/encoded-text.js";
import { readPlainText } from "../evidence/plain-text.js";
import type { RunBundle } from "../run/bundle.js";

/** A source file's path and bytes. */
interface TextFile {
  path: string;
  bytes: Buffer;
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function assertNoInlineRaster(text: string): void {
  // Decode the escapes verify decodes (decodeEscapes) before checking. Unknown embedded bytes are
  // refused: copying a text extension must not smuggle untransformed pixels.
  if (readingsOf(text).some(containsSensitive))
    throw new Error("Decoded text contains a secret-shaped value or private path; export refused.");
  const decoded = decodeEscapes(text);
  if (
    /data\s*:\s*(?:image\/|application\/|text\/|[^,\s]*;base64,|,)/i.test(decoded) ||
    /iVBORw0KGgo|\/9j\/[A-Za-z0-9+/]|R0lGOD|UklGR[A-Za-z0-9+/]{4}|<svg\b/i.test(decoded)
  ) {
    throw new Error(
      "Text contains an inline image/data payload; embedded raster redaction is unsupported.",
    );
  }
}

function decodeText(file: TextFile): string {
  const decoded = readPlainText(file.bytes);
  if (!decoded.ok)
    throw new Error(
      decoded.reason === "invalid-utf8"
        ? "Source text contains invalid UTF-8 or binary bytes."
        : "Source text contains binary control bytes.",
    );
  assertNoInlineRaster(decoded.text);
  return decoded.text;
}

/**
 * Each kept image's source path and the path the copy holds it at; they differ for a WebP frame,
 * which the copy holds as a blurred PNG.
 */
type ImagePaths = ReadonlyMap<string, string>;

function updateScreenshotDeclarations(value: unknown, imagePaths: ImagePaths): unknown {
  if (Array.isArray(value))
    return value.map((entry) => updateScreenshotDeclarations(entry, imagePaths));
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(object))
    result[key] = updateScreenshotDeclarations(entry, imagePaths);
  if (
    object.schema === ACTOR_TRACE_SCHEMA &&
    object.redaction !== null &&
    typeof object.redaction === "object"
  ) {
    const original = object.redaction as Record<string, unknown>;
    if (original.screenshots === "raw" || original.screenshots === "blurred") {
      result.redaction = {
        ...original,
        screenshots: "blurred",
        notes: `${typeof original.notes === "string" ? original.notes : ""} Exported copy: screenshots blurred during export; original capture posture: ${original.screenshots}. See derivation.json.`,
      };
    }
    if (Array.isArray(result.items)) {
      result.items = result.items.map((item: unknown) => {
        if (item === null || typeof item !== "object") return item;
        const entry = item as Record<string, unknown>;
        if (entry.screenshotRef === undefined) return item;
        if (entry.screenshotRef === null || typeof entry.screenshotRef !== "object")
          throw new Error("Actor screenshot reference is malformed.");
        const ref = entry.screenshotRef as Record<string, unknown>;
        if (typeof ref.path !== "string" || !imagePaths.has(ref.path)) {
          throw new Error(
            "Actor screenshot reference must resolve to a PNG transformed from this run's inventory.",
          );
        }
        return {
          ...entry,
          screenshotRef: { ...ref, path: imagePaths.get(ref.path), redaction: "blurred" },
        };
      });
    }
  }
  return result;
}

export function transformText(file: TextFile, imagePaths: ImagePaths): Buffer {
  const text = decodeText(file);
  const extension = path.extname(file.path).toLowerCase();
  if (extension === ".json") {
    const parsed: unknown = JSON.parse(text);
    // Parsing also resolves escape sequences in string values before inspection.
    assertNoInlineRaster(JSON.stringify(parsed));
    // The copy names no sandbox: an id is local operational evidence, and the copy is shared.
    const transformed = redactSandboxIds(updateScreenshotDeclarations(parsed, imagePaths));
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
      const updated = JSON.stringify(
        redactSandboxIds(updateScreenshotDeclarations(parsed, imagePaths)),
      );
      if (updated === JSON.stringify(parsed)) return line;
      assertRewritableNumbers(line);
      return updated;
    });
    return Buffer.from(transformed.join("\n"));
  }
  if (extension === ".yaml" || extension === ".yml") {
    assertNoInlineRaster(
      JSON.stringify(parseYaml(text, { maxAliasCount: 100, logLevel: "silent" })) ?? "",
    );
  }
  return file.bytes;
}

export function assertRewritableNumbers(json: string): void {
  // Opaque adapter JSON stays byte-identical. A known trace that actually needs
  // rewriting must not silently round an identifier outside JS's integer range.
  const unquoted = json.replace(/"(?:\\.|[^"\\])*"/g, '""');
  for (const match of unquoted.matchAll(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const number = Number(match[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
      throw new Error(
        "A trace requiring redaction contains an unsafe numeric value; represent large identifiers as strings before capture.",
      );
    }
  }
}

/** The loaded source bundle as the copy records it: screenshots declared and labelled blurred. */
export function derivedBundle(bundle: RunBundle, imagePaths: ImagePaths): RunBundle {
  const transformed = redactSandboxIds(
    updateScreenshotDeclarations(bundle, imagePaths),
  ) as RunBundle;
  transformed.redaction = {
    status: "passed",
    notes: `${bundle.redaction.notes} Exported copy: screenshots were blurred during export; the original capture is retained separately. See derivation.json.`,
  };
  // Only a path whose output differs is rewritten; every other cite keeps its exact spelling.
  const renamed = (cite: string): string => {
    const output = imagePaths.get(path.posix.normalize(cite));
    return output !== undefined && output !== path.posix.normalize(cite) ? output : cite;
  };
  for (const stream of transformed.streams) {
    for (const artifact of stream.artifacts) {
      artifact.path = renamed(artifact.path);
      if (artifact.kind === "screenshot")
        artifact.label = artifact.label.replace(/\((raw|blurred)\)/g, "(blurred at export)");
    }
  }
  for (const candidate of transformed.feedbackCandidates)
    for (const evidence of candidate.evidence) evidence.path = renamed(evidence.path);
  for (const artifact of transformed.adapterArtifacts ?? []) artifact.path = renamed(artifact.path);
  return transformed;
}
