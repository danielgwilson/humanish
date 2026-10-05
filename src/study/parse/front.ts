// What a humanish.study.v3 document declares before its sections parse: its route, one `actor`,
// its `participants` or `surfaces`, and the `caps` keys the route reads. config.ts parses the
// sections after these checks pass.

import { isRecord } from "../../run/type-guards.js";
import { findUnknownStudyKey } from "../keys.js";
import { movedV2KeyReason } from "../migrate/v2.js";
import type { StudyRoute } from "../routing.js";
import type { StudyParseFailure, StudySurfaces } from "../types.js";
import { PARTICIPANT_ID_MAX_CHARS, PARTICIPANT_ID_PATTERN } from "./actors.js";
import { invalid, posInt } from "./values.js";

// The values `route:` takes: every route routeOf can return.
const ROUTES = [
  "preview",
  "computer-use",
  "shared-world",
  "terminal",
  "scripted",
] as const satisfies readonly StudyRoute[];

// The caps keys each route reads. Computer use and shared world stop on estimated model spend;
// the terminal route checks its spend ledger, product jobs and the command deadline.
const CAPS_KEYS: Readonly<Record<StudyRoute, readonly string[]>> = {
  preview: [],
  "computer-use": ["maxUsd", "maxTotalUsd"],
  "shared-world": ["maxUsd", "maxTotalUsd"],
  terminal: ["maxUsd", "maxJobs", "maxMinutes"],
  scripted: [],
};

/** A document's `participants`, read before the participant entries parse. */
export interface Participants {
  count?: number;
  instruction?: unknown;
  /** The list entries, with each entry that has a count expanded into its participants. */
  entries?: unknown[];
  /** For each expanded entry, the index of the `participants` entry it came from. */
  source: number[];
}

/** What a v3 document declares before its sections parse. */
export interface StudyFront {
  readonly route: StudyRoute;
  readonly actor: Record<string, unknown>;
  readonly participants: Participants;
  readonly surfaces: StudySurfaces | undefined;
}

type Parsed<T> = { ok: true; value: T } | StudyParseFailure;

/** The refusal for a study with no `actor` object. */
export const ACTOR_REQUIRED = "A study needs `actor:`, an object with at least `type`.";

/** Why `route` is not a route a study can declare, or undefined when it is one. */
export function routeNameReason(route: unknown): string | undefined {
  return ROUTES.some((name) => name === route)
    ? undefined
    : `A study needs \`route:\`, one of ${ROUTES.join(", ")}.`;
}

/**
 * The checks a v3 document passes before its sections parse: no v2 key and no unknown key, a
 * route, a mode, an `actor` object, a scenario string, and the `participants`, `surfaces` and
 * `caps` keys its route takes. `anySharedWorldParticipants`, for migrate's v3 form of a v2 file:
 * a shared world takes `participants` in every form computer use takes, or none, because a v2
 * shared world could declare a count or no list. The shared-world checks then refuse it, as the v2
 * parser does.
 */
export function readStudyFront(
  raw: Record<string, unknown>,
  anySharedWorldParticipants = false,
): Parsed<StudyFront> {
  const moved = movedV2KeyReason(raw);
  if (moved) return invalid(moved);
  const unknownKey = findUnknownStudyKey(raw);
  if (unknownKey) return invalid(unknownKey);

  const route = ROUTES.find((name) => name === raw.route);
  if (route === undefined) return invalid(routeNameReason(raw.route)!);
  if (raw.mode !== undefined && raw.mode !== "dry-run" && raw.mode !== "live") {
    return invalid("`mode` must be `dry-run` or `live`. Leave it out for a dry run.");
  }
  if (!isRecord(raw.actor)) return invalid(ACTOR_REQUIRED);
  if (raw.scenario !== undefined && typeof raw.scenario !== "string") {
    return invalid("`scenario` is a scenario id or a path to one, as a string.");
  }

  const participants = participantsOf(
    anySharedWorldParticipants && route === "shared-world" ? "computer-use" : route,
    raw.participants,
  );
  if (!participants.ok) return participants;
  const surfaces = surfacesOf(route, raw.surfaces);
  if (!surfaces.ok) return surfaces;
  const capsReason = capsKeysReason(route, raw.caps);
  if (capsReason) return invalid(capsReason);
  // The inert-field rows (warnings.ts) do not list this one; the terminal planner never reads it.
  if (route === "terminal" && isRecord(raw.execution) && raw.execution.timeoutMs !== undefined) {
    return invalid(
      "route: terminal does not read `execution.timeoutMs`: `caps.maxMinutes` is the command deadline. Remove it.",
    );
  }
  return {
    ok: true,
    value: { route, actor: raw.actor, participants: participants.value, surfaces: surfaces.value },
  };
}

function participantsOf(route: StudyRoute, raw: unknown): Parsed<Participants> {
  if (raw === undefined) {
    if (route === "shared-world") return invalid(listOnly(route));
    return { ok: true, value: { source: [] } };
  }
  switch (route) {
    case "scripted":
      return invalid(
        "route: scripted takes no `participants`. It replays committed steps on `surfaces`: [desktop] or [desktop, mobile].",
      );
    case "terminal":
      return invalid("route: terminal takes no `participants`. It runs one agent.");
    case "preview":
      return typeof raw === "number"
        ? countOf(raw)
        : invalid("route: preview takes `participants` as a count, such as `participants: 4`.");
    case "shared-world":
      return Array.isArray(raw) ? entriesOf(raw) : invalid(listOnly(route));
    case "computer-use":
      if (typeof raw === "number") return countOf(raw);
      if (Array.isArray(raw)) return entriesOf(raw);
      return homogeneousOf(raw);
  }
}

function listOnly(route: StudyRoute): string {
  return `route: ${route} takes \`participants\` as a list of at least two entries, one per participant in the shared world.`;
}

function countOf(raw: number): Parsed<Participants> {
  const count = posInt(raw);
  if (count === undefined) return invalid("`participants` must be a positive integer.");
  return { ok: true, value: { count, source: [] } };
}

// `{ count, instruction }`: participants that share one instruction. The count stays a count, so
// `--count` still overrides it.
function homogeneousOf(raw: unknown): Parsed<Participants> {
  if (!isRecord(raw)) {
    return invalid(
      "`participants` is a count, an object `{ count, instruction }`, or a list of participants.",
    );
  }
  const extra = Object.keys(raw).filter((key) => key !== "count" && key !== "instruction");
  if (extra.length > 0) {
    return invalid(
      `\`participants\` as an object takes only \`count\` and \`instruction\`, and every participant gets them. To set ${extra.map((key) => `\`${key}\``).join(", ")}, write participants as a list.`,
    );
  }
  const participants: Participants = { source: [] };
  if (raw.count !== undefined) {
    const count = typeof raw.count === "number" ? posInt(raw.count) : undefined;
    if (count === undefined) return invalid("`participants.count` must be a positive integer.");
    participants.count = count;
  }
  if (raw.instruction !== undefined) participants.instruction = raw.instruction;
  return { ok: true, value: participants };
}

// A list entry with `count: n` is a group: n participants `<id>-01` to `<id>-NN`, even when n is 1.
// config.ts then checks every entry and the expanded ids for collisions.
function entriesOf(raw: unknown[]): Parsed<Participants> {
  const entries: unknown[] = [];
  const source: number[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry) || entry.count === undefined) {
      entries.push(entry);
      source.push(index);
      continue;
    }
    const count = typeof entry.count === "number" ? posInt(entry.count) : undefined;
    if (count === undefined) {
      return invalid(`participants[${index}].count must be a positive integer.`);
    }
    const id = entry.id;
    if (
      typeof id !== "string" ||
      !PARTICIPANT_ID_PATTERN.test(id) ||
      id.length > PARTICIPANT_ID_MAX_CHARS - 3
    ) {
      return invalid(
        `participants[${index}] has a count, so it needs an \`id\` matching ${PARTICIPANT_ID_PATTERN} of at most ${PARTICIPANT_ID_MAX_CHARS - 3} characters. Its participants are <id>-01 to <id>-${String(count).padStart(2, "0")}.`,
      );
    }
    const shared: Record<string, unknown> = { ...entry };
    delete shared.count;
    for (let n = 1; n <= count; n += 1) {
      entries.push({ ...shared, id: `${id}-${String(n).padStart(2, "0")}` });
      source.push(index);
    }
  }
  return { ok: true, value: { entries, source } };
}

function surfacesOf(route: StudyRoute, raw: unknown): Parsed<StudySurfaces | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (route !== "scripted") {
    return invalid(
      `\`surfaces\` belongs to route: scripted. This study's route is ${route}; remove it.`,
    );
  }
  if (Array.isArray(raw) && raw.length === 1 && raw[0] === "desktop") {
    return { ok: true, value: ["desktop"] };
  }
  if (Array.isArray(raw) && raw.length === 2 && raw[0] === "desktop" && raw[1] === "mobile") {
    return { ok: true, value: ["desktop", "mobile"] };
  }
  return invalid("`surfaces` must be [desktop] or [desktop, mobile].");
}

function capsKeysReason(route: StudyRoute, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const read = CAPS_KEYS[route];
  if (read.length === 0) return `route: ${route} reads no \`caps\`; remove the block.`;
  if (!isRecord(raw)) return undefined;
  const unread = Object.keys(raw).filter((key) => !read.includes(key));
  if (unread.length === 0) return undefined;
  return `route: ${route} reads only ${read.map((key) => `caps.${key}`).join(", ")}. Remove ${unread.map((key) => `caps.${key}`).join(", ")}.`;
}
