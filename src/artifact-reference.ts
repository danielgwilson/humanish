// Artifact-reference discipline: "never reference an artifact you did not write."
//
// `verifyRun` fails closed when a run bundle references a local evidence artifact
// (a screenshot path, an embed URL, a `ui.screenshotUrl`) that does not exist on
// disk or is zero-byte. That fail-closed behavior is correct and must NOT be
// weakened. The honest fix lives on the PRODUCER side: a step or capture that did
// not write an artifact must not claim one.
//
// A blocked/failed step where the failure itself is the recorded evidence wrote no
// screenshot — so it must omit the reference, keeping its blocked status + reason
// (the failure is the evidence). A step that claims SUCCESS but failed to write its
// screenshot must STILL carry the reference so verify can catch the broken producer:
// this guard never blanket-omits by status, it only lets a producer decline to
// reference a path it knows it never wrote.
//
// The browser lane (src/run.ts + src/scripted-browser-actor.ts) imports this; the
// terminal-product lane (src/e2b-terminal-lab.ts) inherits the same
// discipline so neither path can reintroduce the missing-artifact verify failure.

/**
 * Decide whether to include a recorded artifact path in published evidence.
 *
 * Returns the path only when the producer confirms it actually wrote (or, for a
 * surface that attempts the write inline, attempted to write) the artifact. When
 * `wrote` is false the producer is declaring "I have no artifact here" and the
 * reference is dropped so the bundle never claims evidence that does not exist.
 *
 * This is intentionally producer-driven, not status-driven: a successful step that
 * failed to write its file should pass `wrote: true` (it believes it wrote one) so
 * the strict verifier still catches the broken producer. Only a step whose recorded
 * evidence IS the failure passes `wrote: false`.
 */
export function artifactReferenceIfWritten(path: string | undefined, wrote: boolean): string | undefined {
  if (!wrote) {
    return undefined;
  }
  const trimmed = path?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * True when a captured surface/step recorded a real screenshot artifact that the
 * producer wrote. A blocked capture/step whose evidence is the failure itself wrote
 * no screenshot, so it has no `screenshotPath` to reference.
 */
export function hasWrittenScreenshot(capture: { screenshotPath?: string }): boolean {
  return Boolean(capture.screenshotPath?.trim());
}
