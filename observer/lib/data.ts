import type { ObserverData } from "./observer-data";
import { isObserverData } from "./validate";

// Kept as a literal (not imported as a value) so the artifact never bundles CLI code.
// tests/contract-lock.test.ts asserts it equals src/observer-data.ts's exported const.
export const OBSERVER_DATA_SCHEMA = "humanish.observer-data.v1";

// The slot the CLI fills when it writes observer/index.html for a run. Static mode
// inlines the snapshot this way because a file:// page cannot fetch() sibling files;
// scripts/inject.mjs performs the replacement and tests prove the round trip.
// Assembled at runtime so the literal appears EXACTLY ONCE in the built artifact
// (the index.html slot) — an injector can then treat the marker as unique. The
// smoke test pins that count.
export const OBSERVER_DATA_PLACEHOLDER = ["__HUMANISH", "OBSERVER_DATA__"].join("_");

/** Export renderer metadata, never inferred from a run's status or JSON fields. */
export function isSnapshotArtifact(doc: Document): boolean {
  return doc.querySelector('meta[name="humanish-observer-mode"]')?.getAttribute("content") === "snapshot";
}

export function readInlineObserverData(doc: Document): ObserverData | null {
  const text = doc.getElementById("observer-data")?.textContent ?? "";
  if (!text.trim() || text.includes(OBSERVER_DATA_PLACEHOLDER)) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObserverData(parsed)) return parsed;
  } catch {
    // Malformed inline data renders the honest empty state instead of crashing.
  }
  return null;
}
