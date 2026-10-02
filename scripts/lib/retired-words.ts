// Counts identifiers and file names in src/ that still use the retired words. The code says
// participant; lane, seat, role and sim survive only as contract spellings, which belong in the
// modules that translate the manifest and the run bundle, and in the Observer that renders them.
// Lab gives way to study: a study is what a user designs and runs, and a run is one execution of
// it. What remains spells the lab paths, commands, codes and types that the study rename replaces.
// vocabulary:check holds each word's count to its cap.
import { parseSync } from "oxc-parser";

export const RETIRED_WORDS = ["lane", "seat", "role", "sim", "lab"] as const;
export type RetiredWord = (typeof RETIRED_WORDS)[number];

// Paths under src/ whose identifiers may keep the contract spellings. A path ending in / exempts
// every file under it; any other path exempts that file only. Each translation module joins this
// list in the PR that creates it.
export const EXEMPT_PATHS = [
  "src/observer/",
  // Bundle write: the bundle's types and the participant records the route builders call.
  "src/run/bundle.ts",
  "src/run/streams.ts",
  "src/run/participant-records.ts",
  // The saved sharedWorld block (roleId, laneWindows) and cost lines (laneId).
  "src/run/shared-world-evidence.ts",
  "src/run/cost-summary.ts",
  // The manifest's actors[0].lanes and laneFocus keys, which the parser reads.
  "src/lab/parse/actors.ts",
  // The manifest's comms recipient key, `lane`, which the parser reads.
  "src/lab/parse/comms.ts",
  // Every manifest key the parser accepts, including lanes, laneFocus and a recipient's lane.
  "src/lab/keys.ts",
  // The manifest's types, whose keys keep lanes, laneFocus and lane.
  "src/lab/types.ts",
  // The saved run bundle's fields (laneId, simId, simIds), checked when a bundle is read.
  "src/run/bundle-shape.ts",
  // The saved sharedWorld block (roleId, laneWindows, simId), checked when a bundle is read.
  "src/run/shared-world-shape.ts",
  // The saved stream record's simId, checked when a bundle is read.
  "src/run/stream-shape.ts",
];

export function isCounted(path: string): boolean {
  return (
    path.startsWith("src/") &&
    path.endsWith(".ts") &&
    !EXEMPT_PATHS.some((exempt) =>
      exempt.endsWith("/") ? path.startsWith(exempt) : path === exempt,
    )
  );
}

/** The words of an identifier: camelCase humps, runs of capitals, and `_` or digit breaks. */
export function identifierWords(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
}

/** The retired word a single identifier word spells, singular or plural, in any case. */
export function retiredWordOf(word: string): RetiredWord | undefined {
  const lower = word.toLowerCase();
  // Every retired word forms its plural with a plain s.
  const singular = lower.endsWith("s") ? lower.slice(0, -1) : lower;
  return (RETIRED_WORDS as readonly string[]).includes(singular)
    ? (singular as RetiredWord)
    : undefined;
}

/**
 * Every retired word in a path's own name: each directory below src/ and the file name without
 * `.ts`, split on `-`, `_` and `.` and then into identifier words. A hit's line is 0, and its
 * identifier is the path segment that spells it.
 */
export function findRetiredPathWords(path: string): RetiredWordHit[] {
  const hits: RetiredWordHit[] = [];
  for (const segment of path
    .replace(/^src\//, "")
    .replace(/\.ts$/, "")
    .split("/")) {
    for (const piece of segment.split(/[-_.]/)) {
      for (const part of identifierWords(piece)) {
        const word = retiredWordOf(part);
        if (word !== undefined) hits.push({ line: 0, word, identifier: segment });
      }
    }
  }
  return hits;
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

// Removed API names that checked docs keep only in migration notes: `backend`, the old name for a
// route (`LabOutcome.backend`, `LabBackend`, `selectLabBackend` and the scoring context's
// deprecated field), and the `routesTo*` predicates. vocabulary:check holds their count in
// isCheckedDoc pages to `vocabulary.doc-backend` in scripts/caps.json.
const DOC_BACKEND_WORD = /\b\w*backends?\b|\broutesTo\w*/gi;

/** Every `backend` or `routesTo` word in a doc's text, with its 1-based line. */
export function findDocBackendWords(text: string): { line: number; word: string }[] {
  const hits: { line: number; word: string }[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(DOC_BACKEND_WORD)) {
      hits.push({ line: index + 1, word: match[0] });
    }
  });
  return hits;
}
