// The literal values one run scrubs from what it writes: the provider keys and subject env values
// its route reads, and the values the run provisions while it runs, such as the addresses email
// receiving registers. These have no secret shape for pattern redaction to find, so each is
// replaced as written, and again where a URL carries it percent-encoded; redactText runs after the
// scrub and finds secrets by shape.

import { scrubLiterals } from "../evidence/redaction.js";

/** Each route's seed list, marker and floor are its own; the defaults are what most routes use. */
interface RunSecretsOptions {
  /** The text that replaces each value. */
  readonly marker?: string;
  /** The shortest value scrubbed. A shorter value is ordinary text often enough to leave alone. */
  readonly minLength?: number;
}

export class RunSecrets {
  // Private fields stay out of JSON.stringify and object spread, so a Run that reaches a writer
  // whole cannot carry the values with it.
  readonly #held: string[];
  readonly #minLength: number;
  /**
   * Replaces every held value with the marker, as written and percent-encoded. It reads the values
   * on each call, so a value added after the scrub was handed to a participant or a subject is
   * scrubbed from then on.
   */
  readonly scrub: (text: string) => string;

  /** `seed` keeps its order; values shorter than the floor are dropped. */
  constructor(seed: readonly string[], options: RunSecretsOptions = {}) {
    // An empty value would match between every character.
    this.#minLength = Math.max(1, options.minLength ?? 4);
    this.#held = seed.filter((value) => value.length >= this.#minLength);
    const marker = options.marker ?? "[REDACTED_SECRET]";
    const literal = scrubLiterals(this.#held, marker);
    this.scrub = (text) => scrubPercentEncoded(literal(text), this.#held, marker);
  }

  /** Holds each value the run learns while it runs, unless it is under the floor or already held. */
  add(values: readonly string[]): void {
    for (const value of values)
      if (value.length >= this.#minLength && !this.#held.includes(value)) this.#held.push(value);
  }

  /** The held values, seed first, in one array that later `add` calls extend. */
  values(): readonly string[] {
    return this.#held;
  }
}

const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * Replaces each value the text carries percent-encoded. A value with a character a URL encodes,
 * such as a space, a quote or an `@`, reaches a page URL or a link a participant quotes as `%20`,
 * `%22` or `%40`, where the literal scrub never matches. Escape runs are decoded only to find the
 * values: the span of the text each one came from is replaced, and every other character stays as
 * written, so text that is parsed after the scrub, such as JSON, keeps its shape.
 */
function scrubPercentEncoded(text: string, values: readonly string[], marker: string): string {
  if (!text.includes("%")) return text;
  // The decoded text, and for each of its characters the span of `text` it came from. A character
  // decoded from an escape run maps to the whole run.
  let decoded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const copy = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) {
      starts.push(at);
      ends.push(at + 1);
    }
    decoded += text.slice(from, to);
  };
  let cursor = 0;
  let anyDecoded = false;
  for (const run of text.matchAll(ESCAPE_RUN)) {
    let plain: string;
    try {
      plain = decodeURIComponent(run[0]);
    } catch {
      // Not UTF-8: the run stays as written and is copied with the text after it.
      continue;
    }
    copy(cursor, run.index);
    cursor = run.index + run[0].length;
    for (let unit = 0; unit < plain.length; unit += 1) {
      starts.push(run.index);
      ends.push(cursor);
    }
    decoded += plain;
    anyDecoded = true;
  }
  if (!anyDecoded) return text;
  copy(cursor, text.length);

  const spans: Array<[number, number]> = [];
  for (const value of values) {
    for (let at = decoded.indexOf(value); at !== -1; at = decoded.indexOf(value, at + value.length))
      spans.push([starts[at] ?? 0, ends[at + value.length - 1] ?? text.length]);
  }
  if (spans.length === 0) return text;
  spans.sort((left, right) => left[0] - right[0]);
  let scrubbed = "";
  let written = 0;
  for (const [from, to] of spans) {
    if (to <= written) continue;
    scrubbed += from >= written ? `${text.slice(written, from)}${marker}` : "";
    written = to;
  }
  return `${scrubbed}${text.slice(written)}`;
}
