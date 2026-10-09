import { isActiveStream } from "./live";
import type { ObserverStream } from "./observer-data";

/** Which participants the grid shows. An empty field does not filter. */
export interface GridFilters {
  /** A status label, or `__active` for every running or preparing participant. */
  status: string;
  kind: string;
  /** A persona id. Absent in a preference saved before the persona filter existed. */
  persona?: string;
  query: string;
}

export const NO_FILTERS: GridFilters = { status: "", kind: "", persona: "", query: "" };

const isBoundedText = (value: unknown): boolean => typeof value === "string" && value.length < 256;

/** Whether a stored preference is a set of filters. */
export const isGridFilters = (value: unknown): value is GridFilters => {
  if (!value || typeof value !== "object") return false;
  const filters = value as Record<string, unknown>;
  return (
    ["status", "kind", "query"].every((key) => isBoundedText(filters[key])) &&
    (filters.persona === undefined || isBoundedText(filters.persona))
  );
};

export const activeFilterCount = (filters: GridFilters): number =>
  [filters.status, filters.kind, filters.persona ?? "", filters.query].filter(Boolean).length;

/** The participants the filters keep, in roster order. `labels` are the grid's captions by id. */
export function filterParticipants(
  streams: readonly ObserverStream[],
  filters: GridFilters,
  labels: ReadonlyMap<string, string>,
): ObserverStream[] {
  const words = (text: string) => text.toLowerCase().replace(/[-_]+/g, " ");
  const query = words(filters.query);
  return streams.filter(
    (stream) =>
      (filters.status === "__active"
        ? isActiveStream(stream)
        : !filters.status || stream.statusLabel === filters.status) &&
      (!filters.kind || stream.kindLabel === filters.kind) &&
      (!filters.persona || stream.sim.personaId === filters.persona) &&
      words(
        `${labels.get(stream.id)} ${stream.label} ${stream.id} ${stream.laneId ?? ""} ${stream.sim.personaId}`,
      ).includes(query),
  );
}

/** Each status label with how many participants have it, in the order the roster first shows it. */
export function statusCounts(streams: readonly ObserverStream[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const stream of streams)
    counts.set(stream.statusLabel, (counts.get(stream.statusLabel) ?? 0) + 1);
  return [...counts];
}
