// Injection helper for the observer artifact's data slot, filled the way the CLI fills it.
//
// The built dist/index.html carries one placeholder slot; static mode fills it with
// the run's snapshot at write time (a file:// page cannot fetch() sibling files, so
// inlining is what makes the artifact durable). The elements come from
// src/observer/page-data.ts, as in the CLI; tests/artifact-smoke.test.ts proves the round
// trip against the built artifact and the frozen goldens.

import type { ObserverData } from "../../src/observer/data";
import { observerDataElements } from "../../src/observer/page-data";

export const OBSERVER_DATA_PLACEHOLDER = "__HUMANISH_OBSERVER_DATA__";

const SLOT = `<script id="observer-data" type="application/json">${OBSERVER_DATA_PLACEHOLDER}</script>`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function injectObserverData(html: string, data: unknown): string {
  if (!html.includes(SLOT)) {
    throw new Error(
      "observer artifact: observer-data slot not found (placeholder missing or already filled)",
    );
  }
  let out = html.replace(SLOT, () => observerDataElements(data as ObserverData));
  const runId = (data as { run?: { runId?: unknown } } | null)?.run?.runId;
  if (typeof runId === "string" && runId !== "") {
    out = out.replace(
      /<title>[^<]*<\/title>/,
      `<title>humanish Observer · ${escapeHtml(runId)}</title>`,
    );
  }
  return out;
}
