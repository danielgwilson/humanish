// A computer-use participant's screenshots: each frame is written and referenced as PNG during the
// session, as the live Observer and a mid-run copy read it, and queued for a lossless WebP copy.
// When the session ends, each frame whose WebP is written is referenced by its WebP instead and
// its PNG removed, so at no point does a reference name a file that is not there.
import path from "node:path";

import type { ActorTrace } from "../../actors/contract.js";
import { assertScreenshotEvidence, stripPngMetadataChunks } from "../../evidence/image.js";
import { webpTranscoder, type WebpTranscoder } from "../../evidence/webp-transcoder.js";
import {
  assertSafeOutputPathSegment,
  removeContainedOutputFile,
  writeContainedOutputFile,
  type PreparedOutputRoot,
} from "../../run/contained-output.js";

/**
 * How long a finished session waits for its frames still queued. Encoding takes about 330 ms a
 * frame, so this covers a short backlog; a frame not done by then stays PNG.
 */
const FINISH_WAIT_MS = 5_000;

/** Build a participant's writeScreenshot closure: writes under screenshots/<screenshotDir>/ and records
 *  the relative path the trace references (screenshots/<name> at N=1; screenshots/<laneId>/<name>
 *  at N>1). */
export function makeParticipantWriteScreenshot(
  artifactRoot: PreparedOutputRoot,
  spec: { screenshotDir: string },
  screenshots: string[],
): (name: string, bytes: Buffer) => Promise<string> {
  if (spec.screenshotDir) {
    assertSafeOutputPathSegment(spec.screenshotDir, "Screenshot participant id");
  }
  const dirParts = spec.screenshotDir ? ["screenshots", spec.screenshotDir] : ["screenshots"];
  const relPrefix = spec.screenshotDir
    ? path.posix.join("screenshots", spec.screenshotDir)
    : "screenshots";
  return async (name: string, bytes: Buffer): Promise<string> => {
    assertSafeOutputPathSegment(name, "Screenshot name");
    const rel = path.posix.join(relPrefix, name);
    // Evidence holds image data only, whatever the executor's frames carried.
    const frame = stripPngMetadataChunks(bytes);
    await assertScreenshotEvidence(rel, frame);
    await writeContainedOutputFile(artifactRoot, path.join(...dirParts, name), frame);
    screenshots.push(rel);
    return rel;
  };
}

export interface ParticipantFrames {
  /** The session's writeScreenshot: writes the PNG, then queues its WebP. */
  write(name: string, bytes: Buffer): Promise<string>;
  /** Every frame written, by the path its trace references names. */
  readonly screenshots: string[];
  /**
   * Waits up to FINISH_WAIT_MS for the frames still queued, then points `trace` and `screenshots`
   * at each frame's WebP. Returns the step that removes those PNGs, to run once the trace that
   * names the WebP is written.
   */
  finish(trace: ActorTrace | undefined): Promise<() => Promise<void>>;
}

/**
 * `blurred` is the study's policies.redactScreenshots: its frames are the redactor's PNG
 * thumbnails, which stay PNG, since only that shape counts as blurred evidence.
 */
export function participantFrames(
  artifactRoot: PreparedOutputRoot,
  spec: { screenshotDir: string },
  options: { blurred: boolean; transcoder?: WebpTranscoder; finishWaitMs?: number },
): ParticipantFrames {
  const transcoder = options.blurred ? undefined : (options.transcoder ?? webpTranscoder());
  const finishWaitMs = options.finishWaitMs ?? FINISH_WAIT_MS;
  const screenshots: string[] = [];
  const writePng = makeParticipantWriteScreenshot(artifactRoot, spec, screenshots);
  const queued: Promise<void>[] = [];
  /** Each frame whose WebP is written: its PNG path and its WebP path. */
  const done = new Map<string, string>();
  // Once the session's references are settled, a late WebP is not written: nothing would name it.
  let finished = false;
  return {
    screenshots,
    async write(name, bytes) {
      const rel = await writePng(name, bytes);
      const webpRel = rel.replace(/\.png$/, ".webp");
      const job = webpRel === rel ? undefined : transcoder?.transcode(bytes);
      // A frame the worker cannot take, or fails to encode, stays PNG.
      if (job !== undefined)
        queued.push(
          job.then(
            async (webp) => {
              if (finished) return;
              await writeContainedOutputFile(artifactRoot, webpRel, webp);
              done.set(rel, webpRel);
            },
            () => undefined,
          ),
        );
      return rel;
    },
    async finish(trace) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(queued),
        new Promise((resolve) => (timer = setTimeout(resolve, finishWaitMs))),
      ]);
      clearTimeout(timer);
      finished = true;
      const replaced = new Map(done);
      if (trace !== undefined)
        trace.items = trace.items.map((item) => {
          const webp = item.screenshotRef && replaced.get(item.screenshotRef.path);
          return webp === undefined || item.screenshotRef === undefined
            ? item
            : { ...item, screenshotRef: { ...item.screenshotRef, path: webp } };
        });
      screenshots.splice(
        0,
        screenshots.length,
        ...screenshots.map((rel) => replaced.get(rel) ?? rel),
      );
      return async () => {
        for (const png of replaced.keys()) await removeContainedOutputFile(artifactRoot, png);
      };
    },
  };
}
