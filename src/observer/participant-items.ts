// The Observer's data in two parts: observer-data.json, the run and every participant without
// their trace items, and the items themselves. A participant working for hours records thousands
// of items, so the items are most of the bytes; apart, the saved observer-data.json stays small
// enough to verify, and the page and the feed carry each participant's items compressed on their
// own. The Observer bundles this module, so it imports types only
// (docs/decisions/0002-observer-is-one-self-contained-file.md).

import type { ActorTraceItem } from "../actors/contract.js";
import type { ObserverData, ObserverStream } from "./data.js";

export const OBSERVER_ITEMS_SCHEMA = "humanish.observer-items.v2";

/** A stream's actor and live actor, each without its items. */
type ObserverShellStream = Omit<ObserverStream, "actor" | "liveActor"> & {
  actor?: Omit<NonNullable<ObserverStream["actor"]>, "items">;
  liveActor?: Omit<NonNullable<ObserverStream["liveActor"]>, "items">;
  /** How many screenshot entries of `artifacts` travel with the items, when any do. */
  screenshotArtifacts?: number;
};

/** observer-data.json: the Observer's data with no participant's trace items. */
export type ObserverShell = Omit<ObserverData, "streams"> & { streams: ObserverShellStream[] };

/**
 * Each participant's trace items by stream id, with the stream's artifact list when it names
 * screenshots: one per turn, so it grows with the items.
 */
export interface ObserverItems {
  schema: typeof OBSERVER_ITEMS_SCHEMA;
  runId: string;
  streams: Record<
    string,
    {
      actor?: ActorTraceItem[];
      liveActor?: ActorTraceItem[];
      artifacts?: ObserverStream["artifacts"];
      /**
       * Where `liveActor` ends in the participant's live file, as a cursor the page sends back
       * (src/observer/feed-cursors.ts). Only on a feed response, for a list read from a live file.
       */
      live?: string;
      /** Set when `liveActor` holds only the items past this cursor, one the page sent. */
      liveAfter?: string;
    }
  >;
}

/**
 * ObserverItems as the page and the feed carry them: each stream's entry with its stream id, as
 * gzip-compressed JSON in base64, so no string holds two participants' items. The id goes inside
 * the entry because the public-safety scan reads the page's plain text: there, `GITHUB_TOKEN`
 * before a long base64 value reads as a credential, and `https://` with a later id shaped like an
 * address at an E2B host reads as one E2B URL across the base64 between them.
 */
export interface PackedObserverItems extends Omit<ObserverItems, "streams"> {
  streams: string[];
}

/** A packed entry once decoded: the stream's entry with its stream id. */
export type PackedObserverEntry = ObserverItems["streams"][string] & { id: string };

/** The data as observer-data.json and the page's items carry it. */
export function splitObserverData(data: ObserverData): {
  shell: ObserverShell;
  items: ObserverItems;
} {
  // No prototype, so a stream id such as `__proto__` is an entry like any other.
  const items: ObserverItems["streams"] = Object.create(null) as ObserverItems["streams"];
  const streams = data.streams.map((stream): ObserverShellStream => {
    const { actor, liveActor, ...rest } = stream;
    const entry: ObserverItems["streams"][string] = {};
    const shell: ObserverShellStream = rest;
    // Saved projections are read unchecked, and one written by an older version may have no list.
    if (
      Array.isArray(stream.artifacts) &&
      stream.artifacts.some((artifact) => artifact.kind === "screenshot")
    ) {
      entry.artifacts = stream.artifacts;
      shell.artifacts = stream.artifacts.filter((artifact) => artifact.kind !== "screenshot");
      shell.screenshotArtifacts = stream.artifacts.length - shell.artifacts.length;
    }
    if (actor !== undefined) {
      const { items: actorItems, ...summary } = actor;
      entry.actor = actorItems;
      shell.actor = summary;
    }
    if (liveActor !== undefined) {
      const { items: liveItems, ...summary } = liveActor;
      entry.liveActor = liveItems;
      shell.liveActor = summary;
    }
    if (Object.keys(entry).length > 0) items[stream.id] = entry;
    return shell;
  });
  return {
    shell: { ...data, streams },
    items: { schema: OBSERVER_ITEMS_SCHEMA, runId: data.run.runId, streams: items },
  };
}

/**
 * Whether `items` are this run's and hold every participant's items that the data leaves out. The
 * page reads nothing short of that: participants shown with no steps would say they did nothing.
 */
export function itemsCoverShell(shell: ObserverShell, items: ObserverItems): boolean {
  if (items.runId !== shell.run.runId) return false;
  return shell.streams.every((stream) => {
    const entry = Object.hasOwn(items.streams, stream.id) ? items.streams[stream.id] : undefined;
    return (
      (stream.actor === undefined || Array.isArray(entry?.actor)) &&
      (stream.liveActor === undefined || Array.isArray(entry?.liveActor)) &&
      (stream.screenshotArtifacts === undefined ||
        (Array.isArray(entry?.artifacts) &&
          entry.artifacts.filter((artifact) => artifact.kind === "screenshot").length ===
            stream.screenshotArtifacts))
    );
  });
}

/** Whether the data leaves out items or screenshot entries that only an items document holds. */
export function shellNeedsItems(shell: ObserverShell): boolean {
  return shell.streams.some(
    (stream) =>
      stream.actor !== undefined ||
      stream.liveActor !== undefined ||
      stream.screenshotArtifacts !== undefined,
  );
}

/**
 * The data with each participant's items back in place. A stream the items do not cover keeps an
 * empty list, so the page shows the participant with no recorded steps.
 */
export function joinObserverData(shell: ObserverShell, items: ObserverItems | null): ObserverData {
  const byStream =
    items !== null && items.runId === shell.run.runId ? items.streams : ({} as const);
  return {
    ...shell,
    streams: shell.streams.map((stream): ObserverStream => {
      const entry = Object.hasOwn(byStream, stream.id) ? byStream[stream.id] : undefined;
      const { actor, liveActor, screenshotArtifacts: _moved, ...rest } = stream;
      return {
        ...rest,
        artifacts: entry?.artifacts ?? stream.artifacts,
        ...(actor === undefined ? {} : { actor: { ...actor, items: entry?.actor ?? [] } }),
        ...(liveActor === undefined
          ? {}
          : { liveActor: { ...liveActor, items: entry?.liveActor ?? [] } }),
      };
    }),
  };
}
