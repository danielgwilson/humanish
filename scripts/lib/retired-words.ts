// Counts identifiers in src/ that still use the retired participant words. The code says
// participant; lane, seat, role and sim survive only as contract spellings, which belong in the
// modules that translate the manifest and the run bundle, and in the Observer that renders them.
// vocabulary:check caps each word's count, and the caps only go down.
import { parseSync } from "oxc-parser";

export const RETIRED_WORDS = ["lane", "seat", "role", "sim"] as const;
export type RetiredWord = (typeof RETIRED_WORDS)[number];

// Paths under src/ whose identifiers may keep the contract spellings. Each translation module
// joins this list in the PR that creates it.
export const EXEMPT_PREFIXES = [
  "src/observer/",
  // Bundle write: the bundle's types and the participant records the route builders call.
  "src/run/bundle.ts",
  "src/run/streams.ts",
  "src/run/participant-records.ts",
  // The deprecated cuaHooks record (CuaLaneSpec), public until the compatibility section goes.
  "src/routes/computer-use/legacy-lane-spec.ts",
];

export function isCounted(path: string): boolean {
  return (
    path.startsWith("src/") &&
    path.endsWith(".ts") &&
    !EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/** The words of an identifier: camelCase humps, runs of capitals, and `_` or digit breaks. */
export function identifierWords(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
}

/** The retired word a single identifier word spells, singular or plural, in any case. */
export function retiredWordOf(word: string): RetiredWord | undefined {
  const lower = word.toLowerCase();
  const singular = lower.endsWith("s") ? lower.slice(0, -1) : lower;
  return (RETIRED_WORDS as readonly string[]).includes(singular)
    ? (singular as RetiredWord)
    : undefined;
}

export interface RetiredWordHit {
  line: number;
  word: RetiredWord;
  identifier: string;
}

/**
 * Every retired word in the file's identifiers, one hit per word per occurrence. Comments and
 * string contents are not identifiers, so they do not count.
 */
export function findRetiredWords(path: string, source: string): RetiredWordHit[] {
  const hits: { start: number; word: RetiredWord; identifier: string }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as { type?: unknown; name?: unknown; start?: unknown };
    if (
      (node.type === "Identifier" || node.type === "PrivateIdentifier") &&
      typeof node.name === "string" &&
      typeof node.start === "number"
    ) {
      for (const part of identifierWords(node.name)) {
        const word = retiredWordOf(part);
        if (word !== undefined) hits.push({ start: node.start, word, identifier: node.name });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "type") visit(child);
    }
  };
  visit(parseSync(path, source).program);
  return hits
    .sort((left, right) => left.start - right.start)
    .map(({ start, ...hit }) => ({ line: source.slice(0, start).split("\n").length, ...hit }));
}
