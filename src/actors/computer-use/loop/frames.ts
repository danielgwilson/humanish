import type { ActorTraceItem } from "../../contract.js";
import type { LoopSession, ScreenshotRef } from "./session.js";
import type { CuaAction, CuaActionResult } from "./types.js";

// The frames a session keeps: the screenshot of each observation and the image of each zoom. Both
// are persisted the same way, so whatever the bundle's rules say of a screenshot (its formats,
// its redaction claim, verify's checks, export's blur) holds for a zoom frame too.

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
 * written as `zoom-NNN` in the order the session took them, or the position a pointer read
 * returned. A zoom frame is not the session's latest screenshot: a notice that cites the screen
 * cites the last full one.
 */
export async function readEvidence(
  session: LoopSession,
  action: CuaAction,
  result: CuaActionResult | undefined,
): Promise<Pick<ActorTraceItem, "region" | "screenshotRef" | "pointer">> {
  if (result?.kind === "pointer") return { pointer: { x: result.x, y: result.y } };
  if (result?.kind !== "frame" || action.kind !== "zoom") return {};
  session.zoomFrames += 1;
  const name = `zoom-${String(session.zoomFrames).padStart(3, "0")}`;
  const screenshotRef = await persistFrame(session, result.screenshot, name);
  return { region: { ...action.region }, screenshotRef };
}
