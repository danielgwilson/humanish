// A seeded generator and a runner for property tests, which check one rule on many generated
// inputs. CI runs each property on a fixed seed. HUMANISH_PROPERTY_CASES runs more cases locally,
// and HUMANISH_PROPERTY_SEED with HUMANISH_PROPERTY_CASES=1 replays the case a failure names.

export interface Random {
  /** A number in [0, 1). */
  next(): number;
  /** An integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/** mulberry32: 32 bits of state, so a case is replayed from one number. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!,
    chance: (probability) => next() < probability,
  };
}

const FIXED_SEED = 271_828;

export interface PropertyRun {
  readonly seed: number;
  readonly cases: number;
}

/** The fixed seed and `defaultCases`, unless the environment sets either. */
export function propertyRun(defaultCases: number): PropertyRun {
  const cases = Number(process.env.HUMANISH_PROPERTY_CASES);
  const seed = Number(process.env.HUMANISH_PROPERTY_SEED);
  return {
    cases: Number.isInteger(cases) && cases > 0 ? cases : defaultCases,
    seed: Number.isInteger(seed) ? seed : FIXED_SEED,
  };
}

export interface Property<T> {
  readonly generate: (random: Random) => T;
  /** Why the input breaks the rule, or undefined when the rule holds for it. */
  readonly check: (input: T) => Promise<string | undefined>;
  /** Smaller inputs to try in place of a failing one. */
  readonly shrink: (input: T) => Iterable<T>;
  readonly show: (input: T) => string;
}

// Each shrink step tries candidates until one still fails. The cap bounds a slow check.
const MAX_SHRINK_CHECKS = 20_000;

/**
 * Checks the property on `run.cases` inputs; case `index` is generated from seed `run.seed + index`.
 * Returns undefined when every case holds. Otherwise the first failing input is shrunk while it
 * still fails, and the result names the case's seed and the smallest failing input found.
 */
export async function checkProperty<T>(
  property: Property<T>,
  run: PropertyRun,
): Promise<string | undefined> {
  for (let index = 0; index < run.cases; index += 1) {
    const seed = (run.seed + index) >>> 0;
    const input = property.generate(seededRandom(seed));
    const problem = await property.check(input);
    if (problem === undefined) continue;
    const smallest = await shrinkFailure(property, input, problem);
    return `Case seed ${seed} fails: ${smallest.problem}\nSmallest failing input: ${property.show(smallest.input)}`;
  }
  return undefined;
}

async function shrinkFailure<T>(
  property: Property<T>,
  input: T,
  problem: string,
): Promise<{ input: T; problem: string }> {
  let smallest = { input, problem };
  let checks = 0;
  for (let improved = true; improved && checks < MAX_SHRINK_CHECKS;) {
    improved = false;
    for (const candidate of property.shrink(smallest.input)) {
      checks += 1;
      const candidateProblem = await property.check(candidate);
      if (candidateProblem !== undefined) {
        smallest = { input: candidate, problem: candidateProblem };
        improved = true;
        break;
      }
      if (checks >= MAX_SHRINK_CHECKS) break;
    }
  }
  return smallest;
}

/** The text with one stretch removed, longest stretches first, down to single code units. */
export function* shorterStrings(text: string, minLength = 0): Generator<string> {
  for (let size = Math.max(1, text.length >> 1); size >= 1; size = size >> 1) {
    for (let start = 0; start + size <= text.length; start += size) {
      const shorter = text.slice(0, start) + text.slice(start + size);
      if (shorter.length >= minLength) yield shorter;
    }
  }
}
