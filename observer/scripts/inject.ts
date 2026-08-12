// Injection helper for the observer artifact's humanish.observer-data.v1 slot.
//
// The built dist/index.html carries one placeholder slot; static mode fills it with
// the run's snapshot at write time (a file:// page cannot fetch() sibling files, so
// inlining is what makes the artifact durable). This is the reference implementation
// the CLI adopts at cutover (#426 stage 5); tests/artifact-smoke.test.ts proves the
// round trip against the built artifact and the frozen goldens.

export const OBSERVER_DATA_PLACEHOLDER = "__HUMANISH_OBSERVER_DATA__";

const SLOT = `<script id="observer-data" type="application/json">${OBSERVER_DATA_PLACEHOLDER}</script>`;

/** Same escaping policy as src/observer.ts escapeJsonScript: keep the JSON inert
 *  inside a script element (no </script> breakout, no HTML entity surprises). */
export function escapeJsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

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
    throw new Error("observer artifact: observer-data slot not found (placeholder missing or already filled)");
  }
  let out = html.replace(SLOT, `<script id="observer-data" type="application/json">${escapeJsonScript(data)}</script>`);
  const runId = (data as { run?: { runId?: unknown } } | null)?.run?.runId;
  if (typeof runId === "string" && runId !== "") {
    out = out.replace(/<title>[^<]*<\/title>/, `<title>Humanish Observer — ${escapeHtml(runId)}</title>`);
  }
  return out;
}
