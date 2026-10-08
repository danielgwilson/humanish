import type { ObserverStream } from "./observer-data";
import { streamCaptions } from "../../src/run/participant-caption.js";

/**
 * Each stream's caption, by stream id: the recorded caption the TUI, notes and feedback drafts
 * show, with the participant id or the stream id added where two streams would read the same.
 */
export function participantLabels(streams: readonly ObserverStream[]): Map<string, string> {
  return streamCaptions(
    streams.map((stream) => ({
      id: stream.id,
      label: stream.label,
      ...(stream.laneId === undefined ? {} : { participantId: stream.laneId }),
      personaId: stream.sim.personaId,
    })),
  );
}
