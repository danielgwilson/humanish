import type { ActorTraceItem } from "../../contract.js";
import type { LoopSession, ScreenshotRef } from "./session.js";
import type { CuaAction, CuaActionResult } from "./types.js";

// The frames a session keeps: the screenshot of each observation, the image of each zoom and the
// screen each screenshot within a batch captured. All are persisted the same way, so whatever the
// bundle's rules say of a screenshot (its formats, its redaction claim, verify's checks, export's
// blur) holds for every frame the participant was shown.

/**
 * Persist `frame` as `name`: the frame itself, or the redactor's blurred thumbnail when the study
 * blurs its screenshots. Either way the participant was given the frame itself.
 */
export async function persistFrame(
  session: LoopSession,
  frame: Buffer,
  name: string,
): Promise<ScreenshotRef> {
  session.phase = `writing screenshot ${name}`;
  const { bytes, method } = session.redactScreenshots
    ? await session.settings.redaction
        .redactScreenshot(frame, { label: name })
        .then((r) => ({ bytes: r.buffer, method: r.method }))
    : { bytes: frame, method: "none" as const };
  return { path: await session.writeScreenshot(`${name}.png`, bytes), redaction: method };
}

/**
 * What a completed read adds to its action's trace item: a zoom's region and the frame it showed,
 * written as `zoom-NNN`; the screen a screenshot within a batch captured, written as
 * `screenshot-NNN`; or the position a pointer read returned. Each kind of frame is numbered in the
 * order the session took them. A zoom frame is not the session's latest screenshot: a notice that
 * cites the screen cites the last full one, which a batch's screenshot is.
 */
export async function readEvidence(
  session: LoopSession,
  action: CuaAction,
  result: CuaActionResult | undefined,
): Promise<Pick<ActorTraceItem, "region" | "screenshotRef" | "pointer">> {
  if (result?.kind === "pointer") return { pointer: { x: result.x, y: result.y } };
  if (result?.kind !== "frame") return {};
  if (action.kind === "screenshot") {
    session.screenshotFrames += 1;
    const screenshotRef = await persistFrame(
      session,
      result.screenshot,
      `screenshot-${String(session.screenshotFrames).padStart(3, "0")}`,
    );
    session.lastScreenshotRef = screenshotRef;
    return { screenshotRef };
  }
  if (action.kind !== "zoom") return {};
  session.zoomFrames += 1;
  const name = `zoom-${String(session.zoomFrames).padStart(3, "0")}`;
  const screenshotRef = await persistFrame(session, result.screenshot, name);
  return { region: { ...action.region }, screenshotRef };
}
