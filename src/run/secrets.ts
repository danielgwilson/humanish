// The literal values one run scrubs from what it writes: the provider keys and subject env values
// its route reads, and the values the run provisions while it runs, such as the addresses email
// receiving registers. These have no secret shape for pattern redaction to find, so each is
// replaced as written and in the encoded forms a URL, a JSON body or a log line gives it;
// redactText runs after the scrub and finds secrets by shape.

import { scrubLiterals } from "../evidence/redaction.js";
import { encodedForms, holdsSecretValue } from "../evidence/secret-scrub.js";
import { escapeSequences } from "./escape-sequences.js";

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
  readonly #held: string[] = [];
  /** Every held value as written and encoded, longest first. */
  readonly #forms: string[] = [];
  readonly #minLength: number;
  /** holdsSecretValue of the held values, built at its first use after `add` holds a new one. */
  #holds: ((text: string) => boolean) | undefined;
  /**
   * Replaces every held value with the marker, as written, in each encoded form, and where a URL
   * carries it partly percent-encoded or a terminal escape sequence splits it. It reads the values
   * on each call, so a value added after the scrub was handed to a participant or a subject is
   * scrubbed from then on. If the result still holds a value in any readingsOf, as when a marker
   * written before `x` spells the value `SECRET]x`, the whole text becomes the marker.
   */
  readonly scrub: (text: string) => string;

  /** `seed` keeps its order; values shorter than the floor are dropped. */
  constructor(seed: readonly string[], options: RunSecretsOptions = {}) {
    // An empty value would match between every character.
    this.#minLength = Math.max(1, options.minLength ?? 4);
    this.add(seed);
    const marker = options.marker ?? "[REDACTED_SECRET]";
    // Longest first, so a form that holds a shorter one, such as a JSON-escaped value ending in a
    // backslash, is replaced whole and leaves no stray escape behind.
    const literal = scrubLiterals(this.#forms, marker);
    this.scrub = (text) => {
      const scrubbed = literal(text);
      const result = replaceSpans(scrubbed, viewSpans(scrubbed, this.#forms), marker);
      this.#holds ??= holdsSecretValue(this.#held);
      return this.#holds(result) ? marker : result;
    };
  }

  /** Holds each value the run learns while it runs, unless it is under the floor or already held. */
  add(values: readonly string[]): void {
    for (const value of values) {
      if (value.length < this.#minLength || this.#held.includes(value)) continue;
      this.#held.push(value);
      this.#holds = undefined;
      for (const form of encodedForms(value))
        if (!this.#forms.includes(form)) this.#forms.push(form);
    }
    this.#forms.sort((left, right) => right.length - left.length);
  }

  /** The held values, seed first, in one array that later `add` calls extend. */
  values(): readonly string[] {
    return this.#held;
  }

  /**
   * Every held value as written and in each encoded form, longest first, in one array that later
   * `add` calls extend. The terminal recorder sizes the output it keeps past its cap from these.
   */
  forms(): readonly string[] {
    return this.#forms;
  }

  /**
   * Where `text` holds a held value: each encoded form as written, and each form in the text's
   * view without terminal escape sequences and with percent escapes decoded. Sorted, with
   * overlapping spans merged. A scrub that replaces across chunk boundaries reads these.
   */
  spans(text: string): Array<[number, number]> {
    const found: Array<[number, number]> = viewSpans(text, this.#forms);
    for (const form of this.#forms)
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + form.length))
        found.push([at, at + form.length]);
    return mergeSpans(found);
  }
}

/**
 * Where a value is found in the text's view, which drops terminal escape sequences and decodes
 * percent escapes (escapeSequences). A browser encodes a space or a quote in a URL path
 * and leaves a `/` or a `:` as written, so a value with both matches no single encoded form, and a
 * color code inside a value splits it. Each found value maps back to the span of `text` it came
 * from, so the text keeps every other character as written.
 */
function viewSpans(text: string, values: readonly string[]): Array<[number, number]> {
  if (!text.includes("%") && !text.includes("\x1b") && !text.includes("\\u001b")) return [];
  // The view, and for each of its characters the span of `text` it came from. A character decoded
  // from an escape run maps to the whole run.
  let view = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const copy = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) {
      starts.push(at);
      ends.push(at + 1);
    }
    view += text.slice(from, to);
  };
  let cursor = 0;
  let changed = false;
  for (const [start, end] of escapeSequences(text)) {
    let plain = "";
    if (text[start] === "%") {
      try {
        plain = decodeURIComponent(text.slice(start, end));
      } catch {
        // Not UTF-8: the run stays as written and is copied with the text after it.
        continue;
      }
    }
    copy(cursor, start);
    cursor = end;
    for (let unit = 0; unit < plain.length; unit += 1) {
      starts.push(start);
      ends.push(cursor);
    }
    view += plain;
    changed = true;
  }
  if (!changed) return [];
  copy(cursor, text.length);

  const spans: Array<[number, number]> = [];
  for (const value of values)
    for (let at = view.indexOf(value); at !== -1; at = view.indexOf(value, at + value.length))
      spans.push([starts[at] ?? 0, ends[at + value.length - 1] ?? text.length]);
  return spans;
}

/** Sorted, with overlapping spans merged; spans that only touch stay apart. */
function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [from, to] of [...spans].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last !== undefined && from < last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function replaceSpans(text: string, spans: Array<[number, number]>, marker: string): string {
  if (spans.length === 0) return text;
  let replaced = "";
  let written = 0;
  for (const [from, to] of mergeSpans(spans)) {
    replaced += `${text.slice(written, from)}${marker}`;
    written = to;
  }
  return `${replaced}${text.slice(written)}`;
}
