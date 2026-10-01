import type { LabTask } from "../tasks.js";
import { DEVICE_PRESET_NAMES, isDevicePresetName } from "../device-presets.js";
import type {
  DwellWindow,
  StopConditionPrimitive,
  StopWhen,
  StopWhenRule,
} from "../../actors/stop-conditions.js";
import { isReasoningEffort, reasoningEffortNames } from "../../actors/reasoning-effort.js";
import { isMaxOutputTokens } from "../../actors/output-token-limit.js";
import { isHttpUrl } from "./subject.js";
import {
  registeredComputerUseActors,
  registeredScriptedBrowserActors,
  registeredTerminalActors,
} from "../routing.js";
import { invalid, isRecord, posInt, str } from "./values.js";
import type {
  LabActor,
  LabParticipantEntry,
  LabParticipantFocus,
  LabConfigParseFailure,
} from "../types.js";

// A lane id interpolates into per-lane evidence paths (screenshots/<id>/, actors/<id>.json), so
// it must be a public-safe path token, same shape as a lab id.
export const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const PARTICIPANT_ID_MAX_CHARS = 40;

const METADATA_MAX_CHARS = 80;

/** The participant entries an actor declares, after roster groups expand into them. The manifest
 *  spells them `actors[].lanes`. Undefined when the actor declares none. */
export function rosterOf<Entry = LabParticipantEntry>(
  actor: { readonly lanes?: readonly Entry[] } | undefined,
): readonly Entry[] | undefined {
  return actor?.lanes;
}

/** An actor's per-participant focus on the app-url route. The manifest spells it `laneFocus`. */
export function focusOf(
  actor: Pick<LabActor, "laneFocus"> | undefined,
): LabParticipantFocus | undefined {
  return actor?.laneFocus;
}

// Actor ids humanish no longer registers. Rejecting them at parse keeps a lab that names one
// from running on a route that ignores actors[0].type, such as a this-repo dry run.
const REMOVED_ACTOR_TYPES: ReadonlySet<string> = new Set(["pi-agent-core", "claude-agent-sdk"]);

// Only actors on a lane a route dispatches. codex-app-server is registered but declares only the
// "code" lane, which no lab route runs, so naming it would lead to the same dead end.
function routableActorTypes(): string[] {
  return [
    ...registeredComputerUseActors(),
    ...registeredScriptedBrowserActors(),
    ...registeredTerminalActors(),
  ];
}

export function parseActors(raw: unknown): { ok: true; value: LabActor[] } | LabConfigParseFailure {
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid("Lab `actors` must be a non-empty array.");
  }
  // Multi-actor fan-out is not wired yet (only actors[0] is consumed). Fail closed rather than
  // silently ignore actors[1..]; multi-actor support lands in a later slice.
  if (raw.length > 1) {
    return invalid(
      "Multiple actors are not supported yet (only the first actor runs); declare a single actor.",
    );
  }
  const actors: LabActor[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return invalid(`actors[${index}] must be an object.`);
    }
    const type = str(entry.type);
    if (!type) {
      return invalid(`actors[${index}].type is required.`);
    }
    if (REMOVED_ACTOR_TYPES.has(type)) {
      return invalid(
        `actors[${index}].type "${type}" is no longer a humanish actor. Use an actor a lab route runs (one of: ${routableActorTypes().join(", ")}). To drive a study with a signed-in Claude Code, use type: local-agent with localAgent: claude.`,
      );
    }
    const actor: LabActor = { type };
    const count = posInt(entry.count);
    if (count !== undefined) actor.count = count;
    if (entry.lanes !== undefined && entry.roster !== undefined) {
      return invalid(
        `actors[${index}].lanes and actors[${index}].roster are mutually exclusive: declare participants in \`lanes\` OR in compact \`roster\` groups, not both.`,
      );
    }
    if (entry.roster !== undefined && count !== undefined) {
      return invalid(
        `actors[${index}].roster and actors[${index}].count are mutually exclusive — use compact differentiated groups OR a homogeneous count, not both.`,
      );
    }
    if (entry.roster !== undefined && entry.laneFocus !== undefined) {
      return invalid(
        `actors[${index}].roster and actors[${index}].laneFocus are mutually exclusive: a roster group's instruction is each participant's steer.`,
      );
    }
    const rosterResult =
      entry.roster !== undefined
        ? parseRosterGroups(entry.roster, index)
        : parseParticipantEntries(entry.lanes, index);
    if (!rosterResult.ok) {
      return rosterResult;
    }
    if (rosterResult.value) actor.lanes = rosterResult.value;
    const persona = str(entry.persona);
    if (persona) actor.persona = persona;
    const mission = str(entry.mission);
    if (mission) actor.mission = mission;
    const model = str(entry.model);
    if (model) actor.model = model;
    if (entry.maxOutputTokens !== undefined) {
      if (!isMaxOutputTokens(entry.maxOutputTokens))
        return invalid(`actors[${index}].maxOutputTokens must be a positive safe integer.`);
      actor.maxOutputTokens = entry.maxOutputTokens;
    }
    const localAgent = str(entry.localAgent);
    if (entry.localAgent !== undefined) {
      if (localAgent !== "codex" && localAgent !== "claude") {
        return invalid(
          `actors[${index}].localAgent must be "codex" or "claude" (the locally signed-in CLI that drives the study).`,
        );
      }
      actor.localAgent = localAgent;
    }
    if (entry.reasoningEffort !== undefined) {
      if (!isReasoningEffort(entry.reasoningEffort)) {
        return invalid(
          `actors[${index}].reasoningEffort must be one of: ${reasoningEffortNames()}. Support is model-dependent, so a level this model does not accept fails on the first turn rather than being silently downgraded.`,
        );
      }
      actor.reasoningEffort = entry.reasoningEffort;
    }
    const stopWhenResult = parseStopWhen(entry.stopWhen, `actors[${index}].stopWhen`);
    if (!stopWhenResult.ok) return stopWhenResult;
    if (stopWhenResult.value !== undefined) actor.stopWhen = stopWhenResult.value;
    const dwellResult = parseDwell(entry.dwell, `actors[${index}].dwell`);
    if (!dwellResult.ok) return dwellResult;
    if (dwellResult.value !== undefined) actor.dwell = dwellResult.value;
    const tasksResult = parseTasks(entry.tasks, `actors[${index}].tasks`);
    if (!tasksResult.ok) return tasksResult;
    if (tasksResult.value !== undefined) actor.tasks = tasksResult.value;
    const focus = parseFocus(entry.laneFocus);
    if (focus) actor.laneFocus = focus;
    actors.push(actor);
  }
  return { ok: true, value: actors };
}

function parseFocus(raw: unknown): LabParticipantFocus | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const focus: LabParticipantFocus = {};
  const id = str(raw.id);
  if (id) focus.id = id;
  const label = str(raw.label);
  if (label) focus.label = label;
  const instruction = str(raw.instruction);
  if (instruction) focus.instruction = instruction;
  return Object.keys(focus).length > 0 ? focus : undefined;
}

/**
 * Parse `actors[index].roster` compact groups into concrete lanes. This is authoring sugar for
 * "N users of M adapter-owned types across S surfaces"; the runtime receives only `lanes[]`.
 */
function parseRosterGroups(
  raw: unknown,
  actorIndex: number,
): { ok: true; value: LabParticipantEntry[] | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid(
      `actors[${actorIndex}].roster must be a non-empty array of group objects ({ id, count, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry?, host?, reasoningEffort?, stopWhen?, dwell? }) when set.`,
    );
  }

  const expanded: LabParticipantEntry[] = [];
  const seenGroupIds = new Set<string>();
  for (const [groupIndex, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return invalid(
        `actors[${actorIndex}].roster[${groupIndex}] must be an object ({ id, count, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry?, host?, reasoningEffort?, stopWhen?, dwell? }).`,
      );
    }
    const groupId = str(entry.id);
    if (groupId === undefined) {
      return invalid(
        `actors[${actorIndex}].roster[${groupIndex}].id is required and must be a public-safe token matching ${PARTICIPANT_ID_PATTERN}.`,
      );
    }
    if (!PARTICIPANT_ID_PATTERN.test(groupId) || groupId.length > PARTICIPANT_ID_MAX_CHARS - 3) {
      return invalid(
        `actors[${actorIndex}].roster[${groupIndex}].id must be a public-safe token matching ${PARTICIPANT_ID_PATTERN} and at most ${PARTICIPANT_ID_MAX_CHARS - 3} chars (generated participant ids use <id>-NN); got "${groupId}".`,
      );
    }
    if (seenGroupIds.has(groupId)) {
      return invalid(
        `actors[${actorIndex}].roster group ids must be unique (duplicate "${groupId}").`,
      );
    }
    seenGroupIds.add(groupId);
    const count = posInt(entry.count);
    if (count === undefined) {
      return invalid(
        `actors[${actorIndex}].roster[${groupIndex}].count is required and must be a positive integer.`,
      );
    }
    const groupEntryInput: Record<string, unknown> = { ...entry };
    delete groupEntryInput.id;
    delete groupEntryInput.count;
    for (let i = 1; i <= count; i += 1) {
      expanded.push({
        ...groupEntryInput,
        id: `${groupId}-${String(i).padStart(2, "0")}`,
      });
    }
  }

  return parseParticipantEntries(expanded, actorIndex);
}

/**
 * Parse `actors[index].lanes` into a fan-out roster (computer-use E2B route). Structural only:
 * each lane is `{ id?, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?,
 * entry?, host?, reasoningEffort?, stopWhen?, dwell? }`.
 * Lane ids (when declared) must be public-safe path tokens and unique; lane grouping metadata
 * must be public-safe tokens; a lane device must be a known preset name. The
 * route-scoped cross-validation (lanes XOR count/laneFocus, device XOR raw resolution, cap 16)
 * runs in parseLabConfig where the route is known.
 */
function parseParticipantEntries(
  raw: unknown,
  actorIndex: number,
): { ok: true; value: LabParticipantEntry[] | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid(
      `actors[${actorIndex}].lanes must be a non-empty array of participant objects ({ id?, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry?, host?, reasoningEffort?, stopWhen?, dwell? }) when set.`,
    );
  }
  const entries: LabParticipantEntry[] = [];
  const seenIds = new Set<string>();
  for (const [entryIndex, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return invalid(
        `actors[${actorIndex}].lanes[${entryIndex}] must be an object ({ id?, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry?, host?, reasoningEffort?, stopWhen?, dwell? }).`,
      );
    }
    const parsedEntry: LabParticipantEntry = {};
    const id = str(entry.id);
    if (id !== undefined) {
      if (!PARTICIPANT_ID_PATTERN.test(id) || id.length > PARTICIPANT_ID_MAX_CHARS) {
        return invalid(
          `actors[${actorIndex}].lanes[${entryIndex}].id must be a public-safe token matching ${PARTICIPANT_ID_PATTERN} and at most ${PARTICIPANT_ID_MAX_CHARS} chars (it names the participant's evidence paths); got "${id}".`,
        );
      }
      if (seenIds.has(id)) {
        return invalid(`actors[${actorIndex}].lanes ids must be unique (duplicate "${id}").`);
      }
      seenIds.add(id);
      parsedEntry.id = id;
    }
    const device = str(entry.device);
    if (device !== undefined) {
      if (!isDevicePresetName(device)) {
        return invalid(
          `actors[${actorIndex}].lanes[${entryIndex}].device must be one of: ${DEVICE_PRESET_NAMES.join(", ")}.`,
        );
      }
      parsedEntry.device = device;
    }
    const persona = str(entry.persona);
    if (persona !== undefined) parsedEntry.persona = persona;
    const actorType = parseEntryMetadata(
      entry.actorType,
      `actors[${actorIndex}].lanes[${entryIndex}].actorType`,
    );
    if (!actorType.ok) return actorType;
    if (actorType.value !== undefined) parsedEntry.actorType = actorType.value;
    const surface = parseEntryMetadata(
      entry.surface,
      `actors[${actorIndex}].lanes[${entryIndex}].surface`,
    );
    if (!surface.ok) return surface;
    if (surface.value !== undefined) parsedEntry.surface = surface.value;
    const caseGroup = parseEntryMetadata(
      entry.caseGroup,
      `actors[${actorIndex}].lanes[${entryIndex}].caseGroup`,
    );
    if (!caseGroup.ok) return caseGroup;
    if (caseGroup.value !== undefined) parsedEntry.caseGroup = caseGroup.value;
    const instruction = str(entry.instruction);
    if (instruction !== undefined) parsedEntry.instruction = instruction;
    const stopWhenResult = parseStopWhen(
      entry.stopWhen,
      `actors[${actorIndex}].lanes[${entryIndex}].stopWhen`,
    );
    if (!stopWhenResult.ok) return stopWhenResult;
    if (stopWhenResult.value !== undefined) parsedEntry.stopWhen = stopWhenResult.value;
    const dwellResult = parseDwell(entry.dwell, `actors[${actorIndex}].lanes[${entryIndex}].dwell`);
    if (!dwellResult.ok) return dwellResult;
    if (dwellResult.value !== undefined) parsedEntry.dwell = dwellResult.value;
    if (entry.reasoningEffort !== undefined) {
      if (!isReasoningEffort(entry.reasoningEffort)) {
        return invalid(
          `actors[${actorIndex}].lanes[${entryIndex}].reasoningEffort must be one of: ${reasoningEffortNames()}. Support is model-dependent, so a level this model does not accept fails on the first turn rather than being silently downgraded.`,
        );
      }
      parsedEntry.reasoningEffort = entry.reasoningEffort;
    }
    const target = str(entry.target);
    if (target !== undefined) {
      if (!isHttpUrl(target)) {
        return invalid(
          `actors[${actorIndex}].lanes[${entryIndex}].target must be an absolute http(s) URL.`,
        );
      }
      parsedEntry.target = target;
    }
    // `entry` is shape-captured here; the same-origin-with-serve.url check needs serve context, so
    // it runs in sharedWorldValidationReason (where the route + serve.url are known).
    const entryPath = str(entry.entry);
    if (entryPath !== undefined) parsedEntry.entry = entryPath;
    // `host` marks the designated host seat on the external-public shared-world route; the
    // exactly-one-host check runs in externalPublicSharedWorldValidationReason (route context).
    if (entry.host !== undefined) {
      if (typeof entry.host !== "boolean") {
        return invalid(
          `actors[${actorIndex}].lanes[${entryIndex}].host must be a boolean (marks the designated host seat on the external-public shared-world route).`,
        );
      }
      if (entry.host) parsedEntry.host = true;
    }
    entries.push(parsedEntry);
  }
  return { ok: true, value: entries };
}

/**
 * The researcher's protocol. Each task carries what the participant is asked to do and, optionally,
 * the observation that proves it happened — reusing `stopWhen`, so a criterion is exactly as
 * expressive as a stop condition and an author who knows one knows the other.
 *
 * A task with no `success` is allowed on purpose: some things you ask a participant to do (think
 * aloud, say what confused you) are not observable, and the funnel reports them as unmeasurable
 * rather than quietly counting them failed.
 */
function parseTasks(
  raw: unknown,
  field: string,
): { ok: true; value: LabTask[] | undefined } | LabConfigParseFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid(`\`${field}\` must be a non-empty list of tasks when set.`);
  }
  const tasks: LabTask[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return invalid(`each \`${field}\` entry must be a mapping.`);
    const id = str(entry.id);
    if (id === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
      return invalid(`\`${field}[${index}].id\` must be a short id like "sign-up".`);
    }
    if (seen.has(id))
      return invalid(
        `\`${field}\` has a duplicate task id "${id}"; ids appear in evidence and must be unique.`,
      );
    seen.add(id);
    const goal = str(entry.goal);
    if (goal === undefined) {
      return invalid(
        `\`${field}[${index}].goal\` is required — what the PARTICIPANT is asked to do, in their language.`,
      );
    }
    const successResult = parseStopWhen(entry.success, `${field}[${index}].success`);
    if (!successResult.ok) return successResult;
    tasks.push({
      id,
      goal,
      ...(successResult.value === undefined ? {} : { success: successResult.value }),
    });
  }
  return { ok: true, value: tasks };
}

/** The bounds a dwell window (#510) must sit inside: at least one frame, at most an hour. */
const DWELL_MIN_MS = 1_000;

const DWELL_MAX_MS = 3_600_000;

const DWELL_DEFAULT_EVERY_MS = 10_000;

function parseDwell(
  raw: unknown,
  field: string,
): { ok: true; value: DwellWindow | undefined } | LabConfigParseFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return invalid(`${field} must be an object with ms (and optional when, everyMs, then).`);
  const entry = raw as Record<string, unknown>;
  const ms = entry.ms;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < DWELL_MIN_MS || ms > DWELL_MAX_MS) {
    return invalid(
      `${field}.ms must be an integer between ${DWELL_MIN_MS} and ${DWELL_MAX_MS} milliseconds.`,
    );
  }
  const everyMs = entry.everyMs === undefined ? DWELL_DEFAULT_EVERY_MS : entry.everyMs;
  if (
    typeof everyMs !== "number" ||
    !Number.isInteger(everyMs) ||
    everyMs < DWELL_MIN_MS ||
    everyMs > ms
  ) {
    return invalid(`${field}.everyMs must be an integer between ${DWELL_MIN_MS} and ${field}.ms.`);
  }
  const then = entry.then === undefined ? "continue" : entry.then;
  if (then !== "continue" && then !== "stop")
    return invalid(`${field}.then must be "continue" or "stop".`);
  const whenResult = parseStopWhen(entry.when, `${field}.when`);
  if (!whenResult.ok) return whenResult;
  return {
    ok: true,
    value: {
      ...(whenResult.value === undefined ? {} : { when: whenResult.value }),
      ms,
      everyMs,
      // oxlint-disable-next-line unicorn/no-thenable -- `then` is the documented dwell field of humanish.lab.v2
      then,
    },
  };
}

function parseStopWhen(
  raw: unknown,
  field: string,
): { ok: true; value: StopWhen | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid(
      `${field} must be an object ({ any: [{ id?, urlIncludes?, urlPathEquals?, textIncludes?, appStatePathEquals? }] }).`,
    );
  }
  if (!Array.isArray(raw.any) || raw.any.length === 0) {
    return invalid(`${field}.any must be a non-empty array of stop condition rules.`);
  }
  const any: StopWhenRule[] = [];
  for (const [index, entry] of raw.any.entries()) {
    if (!isRecord(entry)) {
      return invalid(
        `${field}.any[${index}] must be an object ({ id?, urlIncludes?, urlPathEquals?, textIncludes?, appStatePathEquals? }).`,
      );
    }
    const rule: StopWhenRule = {};
    const id = str(entry.id);
    if (id !== undefined) {
      if (!PARTICIPANT_ID_PATTERN.test(id) || id.length > METADATA_MAX_CHARS) {
        return invalid(
          `${field}.any[${index}].id must be a public-safe token matching ${PARTICIPANT_ID_PATTERN} and at most ${METADATA_MAX_CHARS} chars; got "${id}".`,
        );
      }
      rule.id = id;
    }
    const urlIncludes = str(entry.urlIncludes);
    if (urlIncludes !== undefined) {
      rule.urlIncludes = urlIncludes;
    }
    const urlPathEquals = str(entry.urlPathEquals);
    if (urlPathEquals !== undefined) {
      if (!urlPathEquals.startsWith("/") || urlPathEquals.startsWith("//")) {
        return invalid(
          `${field}.any[${index}].urlPathEquals must be an absolute URL path starting with one slash.`,
        );
      }
      rule.urlPathEquals = urlPathEquals;
    }
    const textIncludes = str(entry.textIncludes);
    if (textIncludes !== undefined) {
      rule.textIncludes = textIncludes;
    }
    if (entry.appStatePathEquals !== undefined) {
      const parsed = parseStopWhenAppStatePathEquals(
        entry.appStatePathEquals,
        `${field}.any[${index}].appStatePathEquals`,
      );
      if (!parsed.ok) return parsed;
      rule.appStatePathEquals = parsed.value;
    }
    if (
      rule.urlIncludes === undefined &&
      rule.urlPathEquals === undefined &&
      rule.textIncludes === undefined &&
      rule.appStatePathEquals === undefined
    ) {
      return invalid(
        `${field}.any[${index}] must declare at least one condition: urlIncludes, urlPathEquals, textIncludes, or appStatePathEquals.`,
      );
    }
    any.push(rule);
  }
  return { ok: true, value: { any } };
}

function parseStopWhenAppStatePathEquals(
  raw: unknown,
  field: string,
): { ok: true; value: { path: string; equals: StopConditionPrimitive } } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid(`${field} must be an object ({ path, equals }).`);
  }
  const pathValue = str(raw.path);
  if (pathValue === undefined) {
    return invalid(`${field}.path is required and must be a dot-separated public-safe path.`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(pathValue)) {
    return invalid(`${field}.path must contain only letters, digits, underscore, dash, and dot.`);
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "equals")) {
    return invalid(`${field}.equals is required.`);
  }
  const equals = raw.equals;
  if (
    equals !== null &&
    typeof equals !== "string" &&
    typeof equals !== "number" &&
    typeof equals !== "boolean"
  ) {
    return invalid(`${field}.equals must be a string, number, boolean, or null.`);
  }
  return { ok: true, value: { path: pathValue, equals } };
}

function parseEntryMetadata(
  raw: unknown,
  field: string,
): { ok: true; value: string | undefined } | LabConfigParseFailure {
  const value = str(raw);
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!PARTICIPANT_ID_PATTERN.test(value) || value.length > METADATA_MAX_CHARS) {
    return invalid(
      `${field} must be a public-safe token matching ${PARTICIPANT_ID_PATTERN} and at most ${METADATA_MAX_CHARS} chars; got "${value}".`,
    );
  }
  return { ok: true, value };
}
