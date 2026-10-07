import type { ObserverStream } from "./observer-data";
import { savedCaption } from "../../src/run/participant-caption.js";

/** The recorded caption, the same words the TUI shows for the participant. */
function displayLabel(stream: ObserverStream): string {
  return savedCaption({
    label: stream.label,
    ...(stream.laneId === undefined ? {} : { participantId: stream.laneId }),
    personaId: stream.sim.personaId,
  });
}

export function participantLabels(streams: ObserverStream[]): Map<string, string> {
  const labels = streams.map(displayLabel);
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const qualified = streams.map((stream, index) => {
    const label = labels[index]!;
    // Preserve identity when a persona participates in several streams.
    return counts.get(label)! > 1 ? `${label} · ${stream.laneId ?? stream.id}` : label;
  });
  counts.clear();
  for (const label of qualified) counts.set(label, (counts.get(label) ?? 0) + 1);
  return new Map(
    streams.map((stream, index) => {
      const label = qualified[index]!;
      return [stream.id, counts.get(label)! > 1 ? `${label} · ${stream.id}` : label];
    }),
  );
}
