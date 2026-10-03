// Finds values at the keys humanish's run writers use for an E2B sandbox id: `sandboxId`,
// `subjectSandboxId`, and the `id` of each `providerResources` entry in run.json. Matched by key,
// not by the id's shape, so an id in any format is caught; the redaction marker is the only value
// that passes. A run bundle keeps raw ids as local evidence; a committed or published copy must
// carry the marker.

export const SANDBOX_ID_MARKER = "[redacted-sandbox-id]";

/** A quoted value at either key, in JSON, NDJSON, inline page data or source. */
const KEYED_VALUE =
  /(["'`]?)\b(sandboxId|subjectSandboxId)\1\s*[:=]\s*(["'`])((?:(?!\3)[^\n\\])*)\3/g;

/** Where each `"providerResources": [` array closes, skipping brackets inside strings. */
function providerResourceArrays(text) {
  const spans = [];
  const opener = /(["']?)providerResources\1\s*:\s*\[/g;
  for (const match of text.matchAll(opener)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let quote = null;
    let index = start;
    for (; index < text.length && depth > 0; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "[" || char === "{") depth += 1;
      else if (char === "]" || char === "}") depth -= 1;
    }
    spans.push([start, index]);
  }
  return spans;
}

/** The quoted id values inside providerResources arrays. */
const RESOURCE_ID = /(["']?)\bid\1\s*:\s*(["'`])((?:(?!\2)[^\n\\])*)\2/g;

/**
 * Every value at a sandbox-id key that is not the redaction marker, with its offset in `text`.
 * `allowed` holds values a caller accepts as synthetic, such as test fixtures' fake ids.
 */
export function sandboxIdValues(text, allowed = new Set()) {
  const found = [];
  const keep = (key, value, index) => {
    if (value === SANDBOX_ID_MARKER || allowed.has(value)) return;
    found.push({ key, value, index });
  };
  for (const match of text.matchAll(KEYED_VALUE))
    keep(match[2], match[4], (match.index ?? 0) + match[0].indexOf(match[4]));
  for (const [start, end] of providerResourceArrays(text)) {
    const span = text.slice(start, end);
    for (const match of span.matchAll(RESOURCE_ID))
      keep(
        "providerResources[].id",
        match[3],
        start + (match.index ?? 0) + match[0].indexOf(match[3]),
      );
  }
  return found;
}

/**
 * The sandbox-id values `file` may not commit. Outside tests/ only the marker passes; tests name
 * synthetic sandboxes and say so with a fake- or synthetic- prefix.
 */
export function sandboxIdFindings(file, text) {
  return sandboxIdValues(text).filter(
    ({ value }) => !(file.startsWith("tests/") && /^(?:fake|synthetic)-/.test(value)),
  );
}
