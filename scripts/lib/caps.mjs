// The caps prose:check and vocabulary:check hold their counts to live in scripts/caps.json:
// { "prose": { "<root>": { "<kind>": n } }, "vocabulary": { "<word>": n } }. A count above its cap
// fails, and so does one below it, so the PR that removes the prose lowers the cap. A count with no
// cap fails, and so does a cap with no count, so a merge cannot leave a count unchecked or keep a
// cap for a count that is gone. check-cap-direction.mjs reads the same file to keep caps moving down.
import { readFileSync } from "node:fs";

export const CAPS_FILE = "scripts/caps.json";

/** The parsed caps file; exits 2 with a message when it is missing or not an object of objects. */
export function readCaps(file = CAPS_FILE) {
  let caps;
  try {
    caps = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    process.stderr.write(`${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  if (caps === null || typeof caps !== "object" || Array.isArray(caps)) {
    process.stderr.write(`${file}: expected a JSON object.\n`);
    process.exit(2);
  }
  return caps;
}

/**
 * Every cap as a flat map keyed by its path, such as `prose.tests.caps` or `vocabulary.lane`.
 * A value that is not a whole number is reported, keyed by its path, in `invalid`.
 */
export function flattenCaps(caps, prefix = "") {
  const flat = new Map();
  const invalid = [];
  for (const [key, value] of Object.entries(caps)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = flattenCaps(value, path);
      for (const [nestedPath, nestedValue] of nested.flat) flat.set(nestedPath, nestedValue);
      invalid.push(...nested.invalid);
    } else if (Number.isSafeInteger(value) && value >= 0) {
      flat.set(path, value);
    } else {
      invalid.push(path);
    }
  }
  return { flat, invalid };
}

/**
 * Compares counts with their caps and writes one line per count. `counts` maps a cap path
 * (`prose.src.caps`) to the hits behind it.
 * Returns true when every count equals its cap and every cap has a count.
 */
export function holdToCaps({ caps, counts, list, file = CAPS_FILE, write }) {
  const rose = [];
  const fell = [];
  const uncapped = [];
  for (const [path, hits] of counts) {
    const cap = caps.get(path);
    const count = hits.length;
    if (cap === undefined) uncapped.push(`${path}: ${count}`);
    else if (count > cap) rose.push(path);
    else if (count < cap) fell.push(`${path}: ${cap} -> ${count}`);
    const status =
      cap === undefined
        ? " (no cap)"
        : count > cap
          ? ` (cap ${cap}, over by ${count - cap})`
          : count < cap
            ? ` (cap ${cap}, under by ${cap - count})`
            : ` (cap ${cap})`;
    write(`${path}: ${count}${status}\n`);
    if (list) write(hits.map((hit) => `  ${hit}\n`).join(""));
  }
  const stale = [...caps.keys()].filter((path) => !counts.has(path));
  if (fell.length > 0) {
    write(`A count fell. Lower its cap in ${file} in this PR: ${fell.join(", ")}.\n`);
  }
  if (uncapped.length > 0) {
    write(`A count has no cap. Add it to ${file}: ${uncapped.join(", ")}.\n`);
  }
  if (stale.length > 0) {
    write(`${file} caps a count the checker no longer makes. Remove: ${stale.join(", ")}.\n`);
  }
  return {
    ok: rose.length === 0 && fell.length === 0 && uncapped.length === 0 && stale.length === 0,
    rose,
  };
}
