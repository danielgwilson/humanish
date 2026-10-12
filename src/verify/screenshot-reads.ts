import { isRedactedFrameShape, screenshotEvidenceError } from "../evidence/image.js";
import { RUN_ARTIFACT_MAX_BYTES } from "../run/contained-output.js";
import { isUnchangedFile, readUnchangedFile, type FileStamp } from "../run/evidence-files.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";

/** What verify needs from a registered screenshot, from one read of its bytes. */
type ScreenshotRead =
  | {
      state: "read";
      size: number;
      /** screenshotEvidenceError for the path the caller gave. */
      error: string | null;
      redactedShape: boolean;
    }
  | { state: "limit" }
  | { state: "unavailable" };

type Facts = Extract<ScreenshotRead, { state: "read" }>;

// A stamp from a read that started within this long of the file's last change may not show a
// later write: a filesystem with coarse timestamps gives both writes the same times.
const RACY_WINDOW_NS = 2_000_000_000n;

/**
 * Facts per prepared run, by the path the caller gave. A finished study verifies its run up to five
 * times through one prepared object (the Observer render, the analysis gate, the analysis and two
 * refreshes), and decoding every frame each time took most of each verify on a long run. The
 * entries live as long as the prepared object.
 */
const known = new WeakMap<
  PreparedRunArtifactPaths,
  Map<string, { stamp: FileStamp; facts: Facts }>
>();

/**
 * A registered screenshot's facts: its size, why it is not PNG evidence (null when it is), and
 * whether it has the redactor's output shape. `relativePath` may use `\`, read as `/`. A frame read
 * before through the same `runPaths` is not read again while it is still the same file with the
 * same size and times, and its last change was at least 2 s before that read started.
 */
export async function readScreenshot(
  runPaths: PreparedRunArtifactPaths,
  relativePath: string,
): Promise<ScreenshotRead> {
  const filePath = relativePath.replace(/\\/g, "/");
  let entries = known.get(runPaths);
  const entry = entries?.get(relativePath);
  if (entry !== undefined && (await isUnchangedFile(runPaths, filePath, entry.stamp)))
    return entry.facts;
  const startedNs = BigInt(Date.now()) * 1_000_000n;
  const read = await readUnchangedFile(runPaths, filePath, RUN_ARTIFACT_MAX_BYTES);
  if (read.state !== "read") {
    entries?.delete(relativePath);
    return read.state === "limit" ? { state: "limit" } : read;
  }
  const facts: Facts = {
    state: "read",
    size: read.bytes.length,
    error: screenshotEvidenceError(relativePath, read.bytes),
    redactedShape: isRedactedFrameShape(read.bytes),
  };
  if (read.stamp.ctimeNs <= startedNs - RACY_WINDOW_NS) {
    if (entries === undefined) known.set(runPaths, (entries = new Map()));
    entries.set(relativePath, { stamp: read.stamp, facts });
  } else entries?.delete(relativePath);
  return facts;
}
