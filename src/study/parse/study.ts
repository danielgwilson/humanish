// humanish.study.v3, parsed into a config with the file's own keys (StudyV3). parseStudy still
// rewrites a v3 file into the v2 spelling and parses that (parse/study-v3.ts).
// tests/study/parse-differential.test.ts holds the two to the same result. The checks that read
// more than one section still take the v2 shape, so they run on toLegacy's view of the study.

import { isRecord } from "../../run/type-guards.js";
import { checkStudyConfig } from "../config.js";
import { routeOf } from "../routing.js";
import {
  ID_PATTERN,
  STUDY_SCHEMA,
  V2_SCHEMA,
  type StudyConfig,
  type StudyParseFailure,
  type StudyScenarioCaps,
  type StudyV3,
} from "../types.js";
import { inertFieldLabels, inertFieldPaths } from "../warnings.js";
import {
  parseActorFields,
  parseActorType,
  parseParticipantEntries,
  withoutParticipants,
  withParticipants,
} from "./actors.js";
import { parseComms } from "./comms.js";
import { parseDefaults, parseExecution, parsePolicies, parseReview } from "./execution.js";
import { readStudyFront, studySpelling, type Participants, type StudyFront } from "./study-v3.js";
import { parseSubject } from "./subject.js";
import { invalid, nonNegNumber, optionalStr, str } from "./values.js";

interface StudyV3Options {
  /**
   * `report`, for `humanish migrate`: list the fields the route does not read in `inert`, as v2
   * paths, in place of refusing the study for them.
   */
  readonly inert?: "refuse" | "report";
}

type StudyV3ParseResult =
  | { ok: true; config: StudyV3; warnings: string[]; inert?: string[] }
  | StudyParseFailure;

type Parsed<T> = { ok: true; value: T } | StudyParseFailure;

/**
 * Validate a parsed humanish.study.v3 document into a StudyV3, with the messages parseStudy gives.
 * Pure: the caller owns file IO. parseStudy refuses a humanish.lab.v2 document before this runs.
 */
export function parseStudyV3(raw: unknown, options: StudyV3Options = {}): StudyV3ParseResult {
  if (!isRecord(raw)) return invalid("A study file must be a YAML object.");
  if (raw.schema !== STUDY_SCHEMA) {
    return invalid(`The study schema must be ${STUDY_SCHEMA} or ${V2_SCHEMA}.`);
  }
  const front = readStudyFront(raw);
  if (!front.ok) return front;
  const study = parseSections(raw, front.value);
  if (!study.ok) return study;

  const spell = (message: string) =>
    studySpelling(message, front.value.route, front.value.participants.source);
  const checked = checkStudyConfig(toLegacy(study.value));
  if (!checked.ok) return invalid(spell(checked.error.message));
  const { route } = study.value;
  const taken = routeOf(checked.config);
  if (taken !== route) {
    return invalid(
      `This study declares route: ${route}, but its subject (source: ${checked.config.subject.source}) and actor (type: ${checked.config.actors[0]?.type}) take the ${taken} route. Change \`route\`, or change the subject or actor.`,
    );
  }
  const config = withFilledDefaults(study.value, checked.config);
  const warnings = checked.warnings.map(spell);
  if (options.inert === "report") {
    return { ok: true, config, warnings, inert: inertFieldPaths(checked.config) };
  }
  const inert = inertFieldLabels(checked.config);
  if (inert.length > 0) {
    return invalid(
      spell(
        `route: ${route} does not read ${inert.join(", ")}. Remove ${inert.length === 1 ? "it" : "them"}.`,
      ),
    );
  }
  return { ok: true, config, warnings };
}

/**
 * A v3 study in the v2 spelling: the actor holds its participants, `caps` moves under `execution`
 * or `scenario`, and a shared world is `subject.topology: shared-world`. The checks that read more
 * than one section run on this view until StudyConfig has the v3 shape.
 */
export function toLegacy(study: StudyV3): StudyConfig {
  const { route, participants, caps } = study;
  const group =
    typeof participants === "object" && !Array.isArray(participants) ? participants : undefined;
  const actor = withParticipants(study.actor, {
    count:
      typeof participants === "number" ? participants : (group?.count ?? study.surfaces?.length),
    entries: Array.isArray(participants) ? participants : undefined,
    instruction: group?.instruction,
  });
  const { source, ...subject } = study.subject;
  const execution =
    caps !== undefined && route !== "terminal" ? { ...study.execution, caps } : study.execution;
  const scenario = {
    ...(study.scenario === undefined ? {} : { ref: study.scenario }),
    ...(study.mode === undefined ? {} : { mode: study.mode }),
    ...(caps !== undefined && route === "terminal" ? { caps } : {}),
  };
  return {
    schema: study.schema,
    id: study.id,
    ...(study.title === undefined ? {} : { title: study.title }),
    ...(study.description === undefined ? {} : { description: study.description }),
    subject:
      route === "shared-world" ? { source, topology: "shared-world", ...subject } : study.subject,
    actors: [actor],
    ...(execution === undefined ? {} : { execution }),
    ...(Object.keys(scenario).length > 0 ? { scenario } : {}),
    ...(study.policies === undefined ? {} : { policies: study.policies }),
    ...(study.review === undefined ? {} : { review: study.review }),
    ...(study.defaults === undefined ? {} : { defaults: study.defaults }),
    ...(study.comms === undefined ? {} : { comms: study.comms }),
  };
}

// Each section in the order the v2 parser reads it, so a file with more than one error reports the
// same one first.
function parseSections(raw: Record<string, unknown>, front: StudyFront): Parsed<StudyV3> {
  const id = str(raw.id);
  if (!id || !ID_PATTERN.test(id)) {
    return invalid(
      "The study id must be a public-safe token starting with a letter or digit (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).",
    );
  }
  const subject = parseSubject(raw.subject);
  if (!subject.ok) return subject;
  const type = parseActorType(front.actor, "actor");
  if (!type.ok) return type;
  const participants = parseParticipants(raw.participants, front.participants);
  if (!participants.ok) return participants;
  const fields = parseActorFields(front.actor, "actor");
  if (!fields.ok) return fields;
  const execution = parseExecution(raw.execution);
  if (!execution.ok) return execution;
  const caps = parseCaps(raw.caps);
  if (!caps.ok) return caps;
  if (
    isRecord(raw.policies) &&
    raw.policies.mediaPermission !== undefined &&
    raw.policies.mediaPermission !== "prompt" &&
    raw.policies.mediaPermission !== "granted"
  ) {
    return invalid(
      "`policies.mediaPermission` must be `prompt` (the participant answers the browser's own dialog) or `granted`.",
    );
  }
  const policies = parsePolicies(raw.policies);
  if (!policies.ok) return policies;
  const review = parseReview(raw.review);
  if (!review.ok) return review;
  if (isRecord(raw.defaults) && raw.defaults.open !== undefined) {
    if (typeof raw.defaults.open !== "boolean")
      return invalid("`defaults.open` must be true or false.");
  }
  const defaults = parseDefaults(raw.defaults);
  const comms = parseComms(raw.comms);
  if (!comms.ok) return comms;

  const mode = raw.mode === "dry-run" || raw.mode === "live" ? raw.mode : undefined;
  const surfaces =
    front.surfaces === 2
      ? (["desktop", "mobile"] as const)
      : front.surfaces === 1
        ? (["desktop"] as const)
        : undefined;
  const scenario = str(raw.scenario);
  return {
    ok: true,
    value: {
      schema: STUDY_SCHEMA,
      id,
      ...optionalStr("title", raw.title),
      ...optionalStr("description", raw.description),
      route: front.route,
      ...(mode === undefined ? {} : { mode }),
      subject: subject.value,
      actor: { type: type.value, ...fields.value },
      ...(participants.value === undefined ? {} : { participants: participants.value }),
      ...(surfaces === undefined ? {} : { surfaces }),
      ...(caps.value === undefined ? {} : { caps: caps.value }),
      ...(execution.value === undefined ? {} : { execution: execution.value }),
      ...(scenario === undefined ? {} : { scenario }),
      ...(policies.value === undefined ? {} : { policies: policies.value }),
      ...(review.value === undefined ? {} : { review: review.value }),
      ...(defaults === undefined ? {} : { defaults }),
      ...(comms.value === undefined ? {} : { comms: comms.value }),
    },
  };
}

// `participants` in the form the file wrote it. readStudyFront has checked the form against the
// route and expanded each list entry that has a count; the entries parse here, each named by the
// `participants` entry it came from. An instruction that is not a non-empty string is dropped, as
// the v2 parser drops it.
function parseParticipants(
  raw: unknown,
  read: Participants,
): Parsed<StudyV3["participants"] | undefined> {
  if (read.entries !== undefined) {
    const { source } = read;
    return parseParticipantEntries(read.entries, {
      list: "participants",
      entry: (index) => `participants[${source[index] ?? index}]`,
    });
  }
  if (typeof raw === "number") return { ok: true, value: read.count };
  if (!isRecord(raw)) return { ok: true, value: undefined };
  const instruction = str(read.instruction);
  return {
    ok: true,
    value: {
      ...(read.count === undefined ? {} : { count: read.count }),
      ...(instruction === undefined ? {} : { instruction }),
    },
  };
}

// readStudyFront has checked the keys against the route. A value that is not a non-negative number
// refuses the study: a cap that does nothing must not look like one that holds.
function parseCaps(raw: unknown): Parsed<StudyScenarioCaps | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) {
    return invalid("`caps` must be an object ({ maxUsd?, maxTotalUsd?, maxJobs?, maxMinutes? }).");
  }
  const caps: StudyScenarioCaps = {};
  for (const key of ["maxUsd", "maxTotalUsd", "maxJobs", "maxMinutes"] as const) {
    if (raw[key] === undefined) continue;
    const value = nonNegNumber(raw[key]);
    if (value === undefined) return invalid(`\`caps.${key}\` must be a non-negative number.`);
    caps[key] = value;
  }
  return { ok: true, value: Object.keys(caps).length > 0 ? caps : undefined };
}

// checkStudyConfig fills defaults in the v2 view: a shared world's `execution.concurrency`,
// `comms.email.recipients`, and the local browser's actor model and effort, execution timeout and
// resolution and `review.analysis`. Each has the same path in both shapes, so it is copied back.
function withFilledDefaults(study: StudyV3, checked: StudyConfig): StudyV3 {
  const [actor] = checked.actors;
  const execution = { ...checked.execution };
  delete execution.caps;
  return {
    ...study,
    actor: actor === undefined ? study.actor : withoutParticipants(actor),
    ...(Object.keys(execution).length > 0 ? { execution } : {}),
    ...(checked.review === undefined ? {} : { review: checked.review }),
    ...(checked.comms === undefined ? {} : { comms: checked.comms }),
  };
}
