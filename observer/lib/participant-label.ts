import type { ObserverStream } from "./observer-data";

/**
 * A computer-use participant stream records its participant id as `laneId`; no other route sets
 * it. Those streams display the recorded persona, so the card does not depend on the label's
 * wording, which has changed between releases ("CUA lane <id> — <lab>", then
 * "CUA participant <id>: <lab>"). Every other stream keeps its recorded label.
 */
function displayLabel(stream: ObserverStream): string {
  if (stream.laneId === undefined) return stream.label;
  const persona = stream.sim.personaId.replace(/[-_]+/g, " ");
  return persona.charAt(0).toUpperCase() + persona.slice(1);
}

export function participantLabels(streams: ObserverStream[]): Map<string, string> {
  const labels = streams.map(displayLabel);
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const qualified = streams.map((stream, index) => {
    const label = labels[index]!;
    // Preserve identity when a persona participates in several lanes or streams.
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
