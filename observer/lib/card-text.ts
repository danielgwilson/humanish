import { formatRunTime } from "../../src/run/run-clock.js";
import type { GridMoment } from "./grid-recording";
import { ageLabel, frameUpdatedAt, isActiveStream } from "./live";
import type { ObserverStream } from "./observer-data";
import { completionLabel, signalFor, type SignalLine } from "./signal";

/** What a participant card says, in its caption, its preview and its details. */
export interface CardText {
  signal: SignalLine;
  /** The run status, or "Captured while …" for a participant this page no longer follows. */
  statusLabel: string;
  flagged: boolean;
  /** The caption's word outside replay: the status, a notable completion or the signal. */
  outcome: string;
  /** Where the preview comes from: Live, Capture, Snapshot, or nothing to say. */
  sourceLabel: string | null;
  previewLabel: string | null;
  /** The replay moment: the capture's age at the cursor, or why there is none. */
  captureLabel: string;
  openLabel: string;
}

export function cardText(
  stream: ObserverStream,
  {
    name,
    replay,
    canUpdate,
    active,
    liveView,
    now,
  }: {
    name: string;
    replay: GridMoment | undefined;
    /** Not replaying, and the served page still updates. */
    canUpdate: boolean;
    active: boolean;
    liveView: boolean;
    now: number | undefined;
  },
): CardText {
  const signal = signalFor(stream);
  const statusLabel =
    !replay && !canUpdate && isActiveStream(stream)
      ? `Captured while ${stream.status}`
      : stream.statusLabel;
  const notable = completionLabel(stream);
  const fromStart = replay?.kind === "timing-unavailable";
  return {
    signal,
    statusLabel,
    flagged: !!notable || signal.flagged,
    outcome: isActiveStream(stream)
      ? statusLabel
      : (notable ?? (signal.flagged ? signal.label : statusLabel)),
    sourceLabel: liveView
      ? "Live"
      : active
        ? "Capture"
        : !canUpdate && isActiveStream(stream)
          ? "Snapshot"
          : null,
    previewLabel: liveView
      ? "Live desktop preview"
      : active
        ? `Latest capture · ${ageLabel(frameUpdatedAt(stream), now)}`
        : null,
    captureLabel:
      replay?.kind === "capture"
        ? `${replay.coverage === "after-last" ? "Last capture" : "Capture"} · ${formatRunTime(replay.ageMs)} before cursor`
        : replay?.kind === "before-first"
          ? "No capture yet"
          : replay?.kind === "timing-unavailable"
            ? "Capture timing unavailable"
            : "No captured screens",
    openLabel: fromStart ? `Open recording from start for ${name}` : `Open participant ${name}`,
  };
}
