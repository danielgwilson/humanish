import {
  itemsCoverShell,
  joinObserverData,
  OBSERVER_ITEMS_SCHEMA,
  type ObserverItems,
  type ObserverShell,
} from "../../src/observer/participant-items.js";
import type { ObserverData } from "./observer-data";
import { isObserverData } from "./validate";

// Kept as a literal (not imported as a value) so the artifact never bundles CLI code.
// tests/contract-lock.test.ts asserts it equals src/observer/data.ts's exported const.
export const OBSERVER_DATA_SCHEMA = "humanish.observer-data.v3";

// The slot the CLI fills when it writes observer/index.html for a run. Static mode
// inlines the snapshot this way because a file:// page cannot fetch() sibling files;
// scripts/inject.mjs performs the replacement and tests prove the round trip.
// Assembled at runtime so the literal appears exactly once in the built artifact
// (the index.html slot), so an injector can treat the marker as unique. The
// smoke test pins that count.
export const OBSERVER_DATA_PLACEHOLDER = ["__HUMANISH", "OBSERVER_DATA__"].join("_");

/** Export renderer metadata, never inferred from a run's status or JSON fields. */
export function isSnapshotArtifact(doc: Document): boolean {
  return (
    doc.querySelector('meta[name="humanish-observer-mode"]')?.getAttribute("content") === "snapshot"
  );
}

/**
 * The run's data from the page: observer-data.json's content in the data slot, joined with the
 * participants' items the page carries packed. Null for a page with no run, or with data or items
 * that do not hold together, which renders the empty state: participants shown with no steps would
 * say they did nothing.
 */
export async function readInlineObserverData(doc: Document): Promise<ObserverData | null> {
  const text = doc.getElementById("observer-data")?.textContent ?? "";
  if (!text.trim() || text.includes(OBSERVER_DATA_PLACEHOLDER)) return null;
  try {
    const items = await readInlineItems(doc);
    return items === null ? null : observerDataFrom(JSON.parse(text), items);
  } catch {
    // Malformed inline data renders the empty state instead of crashing.
    return null;
  }
}

/** Data the served page polls: observer-feed.json's run data and items, joined. */
export async function observerDataFromFeed(value: unknown): Promise<ObserverData | null> {
  return (await observerFeedFrom(value, null))?.data ?? null;
}

/**
 * A cursor the page can send back as it came: digits and dots, as the server spells them. The page
 * holds no other, so its next poll asks for that participant's full list.
 */
const SENDABLE_CURSOR = /^[0-9.]{1,80}$/;

/**
 * What the page holds from its feed: the run's data and, by stream id, the live cursor each
 * running participant's list ends at. The page sends the cursors back with its next poll.
 */
export interface ObserverFeed {
  data: ObserverData;
  live: ReadonlyMap<string, string>;
}

/**
 * The feed after a poll's body. An entry with `liveAfter` holds only the participant's items past
 * that cursor, and they follow the list `held` has for that stream when `held` holds exactly that
 * cursor for this run. Null when an entry follows a list `held` does not have, or the joined data
 * does not hold together.
 */
export async function observerFeedFrom(
  value: unknown,
  held: ObserverFeed | null,
): Promise<ObserverFeed | null> {
  if (typeof value !== "object" || value === null) return null;
  const feed = value as { data?: unknown; items?: unknown };
  try {
    const unpacked = await unpackItems(feed.items);
    if (unpacked === null) return null;
    const items = joinedItems(unpacked, held);
    const data = items === null ? null : observerDataFrom(feed.data, items);
    if (data === null) return null;
    const live = new Map<string, string>();
    for (const [id, entry] of Object.entries(unpacked.streams))
      if (entry.live !== undefined && SENDABLE_CURSOR.test(entry.live)) live.set(id, entry.live);
    return { data, live };
  } catch {
    return null;
  }
}

/** `items` with each tail joined onto the list `held` has at its cursor; null for a tail it has not. */
function joinedItems(items: ObserverItems, held: ObserverFeed | null): ObserverItems | null {
  const streams: ObserverItems["streams"] = Object.create(null) as ObserverItems["streams"];
  for (const [id, entry] of Object.entries(items.streams)) {
    if (entry.liveAfter === undefined) {
      streams[id] = entry;
      continue;
    }
    const before =
      held !== null && held.data.run.runId === items.runId && held.live.get(id) === entry.liveAfter
        ? held.data.streams.find((stream) => stream.id === id)?.liveActor?.items
        : undefined;
    if (!Array.isArray(before) || !Array.isArray(entry.liveActor)) return null;
    streams[id] = { ...entry, liveActor: [...before, ...entry.liveActor] };
  }
  return { ...items, streams };
}

function observerDataFrom(shell: unknown, items: ObserverItems): ObserverData | null {
  const value = shell as { schema?: unknown; streams?: unknown };
  if (value?.schema !== OBSERVER_DATA_SCHEMA || !Array.isArray(value.streams)) return null;
  if (!itemsCoverShell(shell as ObserverShell, items)) return null;
  const joined = joinObserverData(shell as ObserverShell, items);
  return isObserverData(joined) ? joined : null;
}

async function readInlineItems(doc: Document): Promise<ObserverItems | null> {
  const element = doc.getElementById("observer-items");
  if (element?.tagName !== "SCRIPT" || element.getAttribute("type") !== "application/json")
    return null;
  const packed: unknown = JSON.parse(element.textContent ?? "");
  // The joined data holds the items now; the page need not keep their packed text too.
  element.remove();
  return unpackItems(packed);
}

/**
 * Items as the page and the feed carry them, with each participant's entry decoded on its own: no
 * string holds two participants' items, so a run whose items together pass the longest string a
 * browser holds still opens. Null when they are malformed.
 */
async function unpackItems(value: unknown): Promise<ObserverItems | null> {
  if (typeof value !== "object" || value === null) return null;
  const packed = value as { schema?: unknown; runId?: unknown; streams?: unknown };
  if (!Array.isArray(packed.streams)) return null;
  // No prototype, so a stream id such as `__proto__` is an entry like any other.
  const streams = Object.create(null) as Record<string, unknown>;
  // One at a time, so the page holds one participant's decoded text at once.
  for (const pair of packed.streams as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [id, entry] = pair as unknown[];
    if (typeof id !== "string" || typeof entry !== "string") return null;
    const text = await gunzipBase64(entry);
    if (text === null) return null;
    streams[id] = JSON.parse(text);
  }
  const items = { schema: packed.schema, runId: packed.runId, streams };
  return isObserverItems(items) ? items : null;
}

async function gunzipBase64(encoded: string): Promise<string | null> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const body = new Response(bytes).body;
  if (body === null) return null;
  return new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
}

function isObserverItems(value: unknown): value is ObserverItems {
  if (typeof value !== "object" || value === null) return false;
  const items = value as { schema?: unknown; runId?: unknown; streams?: unknown };
  return (
    items.schema === OBSERVER_ITEMS_SCHEMA &&
    typeof items.runId === "string" &&
    typeof items.streams === "object" &&
    items.streams !== null &&
    !Array.isArray(items.streams) &&
    Object.values(items.streams).every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        ["actor", "liveActor", "artifacts"].every((key) => {
          const list = (entry as Record<string, unknown>)[key];
          return list === undefined || Array.isArray(list);
        }) &&
        ["live", "liveAfter"].every((key) => {
          const cursor = (entry as Record<string, unknown>)[key];
          return cursor === undefined || typeof cursor === "string";
        }),
    )
  );
}
