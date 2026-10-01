// A run folder holds copies of its bundle: events.ndjson repeats run.json's events, and
// observer/observer-data.json repeats the events, the cost, each stream's bundle fields, its
// simulation and the events of that stream (src/observer/data.ts). A run-directory golden pins a
// copy that exactly equals its source as a marker naming the source, so one change to the bundle
// shows once in a golden diff. A copy that differs from its source in any way is pinned in full.
// inflateProjections rebuilds the full snapshot from the markers; runDirSnapshot checks that it
// does, so the markers never hide a value.

import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../src/run/type-guards.js";

const RUN = "run.json";
const EVENTS_FILE = "events.ndjson";
const OBSERVER_DATA = "observer/observer-data.json";

const SAME_AS_RUN_EVENTS = "[same as run.json events]";
const SAME_AS_RUN_COST = "[same as run.json cost]";
const SAME_AS_STREAM_EVENTS = "[same as run.json events for this stream]";
/** Its value lists, space-separated, the fields this stream copies unchanged from run.json. */
const BUNDLE_FIELDS = "[same as the run.json stream]";
const SIMULATION_MARKER = /^\[same as run\.json simulation (.+)\]$/;
const sameAsSimulation = (id: string) => `[same as run.json simulation ${id}]`;

type Json = Record<string, unknown>;

interface Bundle {
  events: unknown[];
  streams: unknown[];
  simulations: unknown[];
  cost?: unknown;
}

function bundleOf(snapshot: Json): Bundle | undefined {
  const run = snapshot[RUN];
  if (
    !isRecord(run) ||
    !Array.isArray(run.events) ||
    !Array.isArray(run.streams) ||
    !Array.isArray(run.simulations)
  )
    return undefined;
  return run as unknown as Bundle;
}

/** The one entry with this id, or undefined when there is none or more than one. */
function uniqueById(entries: readonly unknown[], id: unknown): Json | undefined {
  const matches = entries.filter((entry) => isRecord(entry) && entry.id === id);
  return matches.length === 1 ? (matches[0] as Json) : undefined;
}

/** The events the Observer shows on a stream's timeline (src/observer/data.ts). */
function streamEvents(bundle: Bundle, simId: unknown, streamId: unknown): unknown[] {
  return bundle.events.filter(
    (event) => isRecord(event) && (event.simId === simId || event.streamId === streamId),
  );
}

function dedupeStream(stream: Json, bundle: Bundle): Json {
  const source = uniqueById(bundle.streams, stream.id);
  if (source === undefined) return stream;
  // The id stays, so inflateStream can find the source.
  const same = Object.keys(stream).filter(
    (key) => key !== "id" && key in source && isDeepStrictEqual(stream[key], source[key]),
  );
  const out: Json = same.length > 0 ? { [BUNDLE_FIELDS]: same.join(" ") } : {};
  for (const [key, value] of Object.entries(stream)) {
    if (!same.includes(key)) out[key] = value;
  }
  const sim = isRecord(stream.sim) ? stream.sim : undefined;
  const sourceSim = sim === undefined ? undefined : uniqueById(bundle.simulations, sim.id);
  if (sim !== undefined && sourceSim !== undefined && isDeepStrictEqual(sim, sourceSim))
    out.sim = sameAsSimulation(String(sim.id));
  if (
    sim !== undefined &&
    Array.isArray(stream.timeline) &&
    isDeepStrictEqual(stream.timeline, streamEvents(bundle, sim.id, stream.id))
  )
    out.timeline = SAME_AS_STREAM_EVENTS;
  return out;
}

function inflateStream(stream: Json, bundle: Bundle): Json {
  const fields = stream[BUNDLE_FIELDS];
  const source = uniqueById(bundle.streams, stream.id);
  const out: Json = {};
  if (typeof fields === "string" && source !== undefined)
    for (const key of fields.split(" ")) out[key] = source[key];
  for (const [key, value] of Object.entries(stream)) {
    if (key !== BUNDLE_FIELDS) out[key] = value;
  }
  const simId = typeof out.sim === "string" ? SIMULATION_MARKER.exec(out.sim)?.[1] : undefined;
  if (simId !== undefined) out.sim = uniqueById(bundle.simulations, simId);
  if (out.timeline === SAME_AS_STREAM_EVENTS && isRecord(out.sim))
    out.timeline = streamEvents(bundle, out.sim.id, out.id);
  return out;
}

/** The snapshot with each copy that equals its source replaced by a marker. */
export function dedupeProjections(snapshot: Json): Json {
  const bundle = bundleOf(snapshot);
  if (bundle === undefined) return snapshot;
  const out = { ...snapshot };
  if (isDeepStrictEqual(out[EVENTS_FILE], bundle.events)) out[EVENTS_FILE] = SAME_AS_RUN_EVENTS;
  const data = out[OBSERVER_DATA];
  if (isRecord(data)) {
    const projected = { ...data };
    if (isDeepStrictEqual(projected.events, bundle.events)) projected.events = SAME_AS_RUN_EVENTS;
    if (bundle.cost !== undefined && isDeepStrictEqual(projected.cost, bundle.cost))
      projected.cost = SAME_AS_RUN_COST;
    if (Array.isArray(projected.streams))
      projected.streams = projected.streams.map((stream) =>
        isRecord(stream) ? dedupeStream(stream, bundle) : stream,
      );
    out[OBSERVER_DATA] = projected;
  }
  return out;
}

/** The full snapshot that dedupeProjections replaced with markers. */
export function inflateProjections(snapshot: Json): Json {
  const bundle = bundleOf(snapshot);
  if (bundle === undefined) return snapshot;
  const out = { ...snapshot };
  if (out[EVENTS_FILE] === SAME_AS_RUN_EVENTS) out[EVENTS_FILE] = bundle.events;
  const data = out[OBSERVER_DATA];
  if (isRecord(data)) {
    const projected = { ...data };
    if (projected.events === SAME_AS_RUN_EVENTS) projected.events = bundle.events;
    if (projected.cost === SAME_AS_RUN_COST) projected.cost = bundle.cost;
    if (Array.isArray(projected.streams))
      projected.streams = projected.streams.map((stream) =>
        isRecord(stream) ? inflateStream(stream, bundle) : stream,
      );
    out[OBSERVER_DATA] = projected;
  }
  return out;
}
