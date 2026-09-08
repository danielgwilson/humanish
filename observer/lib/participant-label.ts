import type { ObserverStream } from "./observer-data";

export function participantLabels(streams: ObserverStream[]): Map<string, string> {
  const labels = streams.map((stream) => {
    if (!stream.label.startsWith("CUA lane ")) return stream.label;
    const persona = stream.sim.personaId.replace(/[-_]+/g, " ");
    return persona.charAt(0).toUpperCase() + persona.slice(1);
  });
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const qualified = streams.map((stream, index) => {
    const label = labels[index]!;
    // Preserve identity when a persona participates in several lanes or streams.
    return counts.get(label)! > 1 ? `${label} · ${stream.laneId ?? stream.id}` : label;
  });
  counts.clear();
  for (const label of qualified) counts.set(label, (counts.get(label) ?? 0) + 1);
  return new Map(streams.map((stream, index) => {
    const label = qualified[index]!;
    return [stream.id, counts.get(label)! > 1 ? `${label} · ${stream.id}` : label];
  }));
}
