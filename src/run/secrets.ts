// The literal values one run scrubs from what it writes: the provider keys and subject env values
// its route reads, and the values the run provisions while it runs, such as the addresses email
// receiving registers. These have no secret shape for pattern redaction to find, so each is
// replaced as written; redactText runs after the scrub and finds secrets by shape.

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
   * Replaces every held value with the marker. It reads the values on each call, so a value added
   * after the scrub was handed to a participant or a subject is scrubbed from then on.
   */
  readonly scrub: (text: string) => string;

  /** `seed` keeps its order; values shorter than the floor are dropped. */
  constructor(seed: readonly string[], options: RunSecretsOptions = {}) {
    // An empty value would match between every character.
    this.#minLength = Math.max(1, options.minLength ?? 4);
    this.#held = seed.filter((value) => value.length >= this.#minLength);
    this.scrub = scrubLiterals(this.#held, options.marker);
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
