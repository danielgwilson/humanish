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
export const OBSERVER_DATA_SCHEMA = "humanish.observer-data.v2";

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
 * participants' items the page carries gzip-compressed. Null for a page with no run, or with data
 * or items that do not hold together, which renders the empty state: participants shown with no
 * steps would say they did nothing.
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
export function observerDataFromFeed(value: unknown): ObserverData | null {
  if (typeof value !== "object" || value === null) return null;
  const feed = value as { data?: unknown; items?: unknown };
  try {
    return isObserverItems(feed.items) ? observerDataFrom(feed.data, feed.items) : null;
  } catch {
    return null;
  }
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
  if (
    element?.tagName !== "SCRIPT" ||
    element.getAttribute("type") !== "application/octet-stream" ||
    element.getAttribute("data-encoding") !== "gzip"
  )
    return null;
  const encoded = element.textContent ?? "";
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const body = new Response(bytes).body;
  if (body === null) return null;
  const parsed: unknown = JSON.parse(
    await new Response(body.pipeThrough(new DecompressionStream("gzip"))).text(),
  );
  // The joined data holds the items now; the page need not keep their base64 text too.
  element.remove();
  return isObserverItems(parsed) ? parsed : null;
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
        }),
    )
  );
}
