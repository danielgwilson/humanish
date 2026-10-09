// The study parser: a humanish.study.v3 document into a StudyConfig with the file's own keys.
// parse/front.ts checks what the document declares before its sections parse (the route, the
// actor object, the participants or surfaces form the route takes, and the caps keys it reads). The
// sections parse here, checkStudyConfig runs the checks that read more than one section, and the
// study must then take the route it declares and set no field that route does not read
// (warnings.ts). A humanish.lab.v2 document is refused; `humanish migrate` reads it
// (migrate/v2.ts).
//
// Scope (read before trusting field names): routeOf derives the route from
// subject.source × execution.target × the actor's run kind, with `route: shared-world` as the
// declaration that turns a computer-use composition into a shared world. On the computer-use
// routes (app-url × e2b-desktop or local, and clone, local-tree or desktop-cli on e2b-desktop with a
// computer-use actor), `actor.type` must resolve to a registered computer-use actor, and that
// descriptor runs the session. Those routes consume actor.{mission,persona,model,reasoningEffort},
// `participants`, `caps`, execution.timeoutMs and execution.desktop.*. The scripted route
// (app-url × local, or clone × e2b-desktop, with a registered scripted-browser actor) consumes
// `scenario` (required: its browser steps are what the actor runs), actor.persona and `surfaces`.
// The terminal route consumes subject.product, `caps` and execution.{terminal,runtimeAuth}.
//
// NOTE on `participants`: a count (preview: the simulated count; computer use: N identical
// participants, each its own desktop, capped at 16), `{ count, instruction }` (identical
// participants with one steer), or a list of `{ id?, persona?, device?, instruction?, target? ... }`
// entries, each its own desktop. A list entry with a `count` is a group that expands into
// `<id>-01` to `<id>-NN`. A shared world takes a list of at least two. `participants[].device`
// excludes a raw `execution.desktop.resolution`, and `participants[].target` is app-url computer
// use only: an absolute browser URL this participant opens in place of `subject.appUrl`.
// `execution.concurrency` bounds in-flight participants (default: all at once; env
// HUMANISH_CUA_MAX_CONCURRENCY may only lower it).

import {
  isLocalBrowserStudy,
  localBrowserDefaults,
  localBrowserUnsupportedReason,
} from "../substrates/local/runtime-config.js";
import { isRecord } from "../run/type-guards.js";
import { compositionReason } from "./composition-rules.js";
import { V2_SCHEMA, V2_UNSUPPORTED_MESSAGE, v2FieldMoves } from "./migrate/v2.js";
import { parseActorFields, parseActorType, parseParticipantEntries } from "./parse/actors.js";
import { parseComms, recipientParticipantId } from "./parse/comms.js";
import {
  parseCaps,
  parseDefaults,
  parseExecution,
  parsePolicies,
  parseReview,
} from "./parse/execution.js";
import {
  ACTOR_REQUIRED,
  readStudyFront,
  routeNameReason,
  type Participants,
  type StudyFront,
} from "./parse/front.js";
import { parseSubject } from "./parse/subject.js";
import { invalid, optionalStr, str } from "./parse/values.js";
import { isComputerUseComposition, isSharedWorldComposition, routeOf } from "./routing.js";
import { declaredParticipantIds } from "./plan-participants.js";
import { declaredParticipantCount, participantList } from "./study-fields.js";
import {
  ID_PATTERN,
  STUDY_SCHEMA,
  type StudyConfig,
  type StudyParseFailure,
  type StudyParseResult,
} from "./types.js";
import {
  automaticAnalysisRouteReason,
  desktopMediaValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  smtpValidationReason,
  taskProtocolValidationReason,
  waitLimitValidationReason,
} from "./validation.js";
import { forwardDeclaredWarnings, inertFieldLabels, inertFieldPaths } from "./warnings.js";
import { plural } from "../run/text.js";

/**
 * The package's study parser (src/index.ts) and the one discovery uses: a humanish.study.v3
 * document. It refuses a humanish.lab.v2 one with HUMANISH_STUDY_V2_UNSUPPORTED.
 */
export function parseStudy(raw: unknown): StudyParseResult {
  if (!isRecord(raw)) return invalid("A study file must be a YAML object.");
  if (raw.schema === V2_SCHEMA)
    return {
      ok: false,
      error: { code: "HUMANISH_STUDY_V2_UNSUPPORTED", message: V2_UNSUPPORTED_MESSAGE },
    };
  if (raw.schema !== STUDY_SCHEMA) {
    return invalid(`The study schema must be ${STUDY_SCHEMA} or ${V2_SCHEMA}.`);
  }
  return parseStudyV3(raw);
}

interface StudyV3Options {
  /**
   * `report`, for `humanish migrate`: list the fields the route does not read in `inert`, in place
   * of refusing the study for them. A shared world may then give `participants` as a count or
   * leave it out, as a v2 file could (readStudyFront).
   */
  readonly inert?: "refuse" | "report";
}

type StudyV3ParseResult =
  | { ok: true; config: StudyConfig; warnings: string[]; inert?: string[] }
  | StudyParseFailure;

type Parsed<T> = { ok: true; value: T } | StudyParseFailure;

/**
 * Validate a humanish.study.v3 document into a StudyConfig. Pure: the caller owns file IO. Fields the
 * route does not read refuse the study; migrate's report mode lists them in `inert` instead.
 */
export function parseStudyV3(
  raw: Record<string, unknown>,
  options: StudyV3Options = {},
): StudyV3ParseResult {
  const front = readStudyFront(raw, options.inert === "report");
  if (!front.ok) return front;
  const study = parseSections(raw, front.value);
  if (!study.ok) return study;

  const checked = checkStudyConfig(study.value);
  if (!checked.ok) return checked;
  const { config, warnings } = checked;
  const { route } = config;
  const mismatch = routeMismatchReason(config);
  if (mismatch) return invalid(mismatch);
  if (options.inert === "report") {
    return { ok: true, config, warnings, inert: inertFieldPaths(config) };
  }
  const inert = inertFieldLabels(config);
  if (inert.length > 0) {
    return invalid(
      `route: ${route} does not read ${inert.join(", ")}. Remove ${inert.length === 1 ? "it" : "them"}.`,
    );
  }
  return { ok: true, config, warnings };
}

/** Why a config's declared route is not the one its subject and actor take, or undefined. */
function routeMismatchReason(config: StudyConfig): string | undefined {
  const taken = routeOf(config);
  if (taken === config.route) return undefined;
  return `This study declares route: ${config.route}, but its subject (source: ${config.subject.source}) and actor (type: ${config.actor.type}) take the ${taken} route. Change \`route\`, or change the subject or actor.`;
}

/** Why runStudy refuses a config before anything runs. */
interface ConfigRefusal {
  readonly code: "HUMANISH_STUDY_V2_UNSUPPORTED" | "HUMANISH_STUDY_INVALID";
  readonly message: string;
}

/**
 * Why runStudy refuses a config a library caller passes, or undefined: a humanish.lab.v2 config,
 * one that still sets a StudyConfig field of humanish 0.110, one with no `actor` object, and one
 * whose `route` is not the route its subject and actor take, with parseStudy's message. A planner
 * reads only the v3 fields, so a budget left in `execution.caps` would otherwise run uncapped.
 */
export function libraryConfigRefusal(config: StudyConfig): ConfigRefusal | undefined {
  const raw: unknown = config;
  if (!isRecord(raw)) return undefined;
  if (raw.schema === V2_SCHEMA)
    return { code: "HUMANISH_STUDY_V2_UNSUPPORTED", message: V2_UNSUPPORTED_MESSAGE };
  const moves = v2FieldMoves(raw);
  if (moves.length > 0)
    return {
      code: "HUMANISH_STUDY_V2_UNSUPPORTED",
      message: `This StudyConfig sets fields that humanish 0.111.0 renamed: ${moves.join("; ")}. Set the humanish.study.v3 fields, or parse the study file with parseStudy. The 0.111.0 release notes list each renamed field.`,
    };
  if (!isRecord(raw.actor)) return { code: "HUMANISH_STUDY_INVALID", message: ACTOR_REQUIRED };
  const message = routeNameReason(raw.route) ?? routeMismatchReason(config);
  return message === undefined ? undefined : { code: "HUMANISH_STUDY_INVALID", message };
}

// Each section in a fixed order, so a file with more than one error always reports the same one
// first. migrate's checkV2 reads a v2 file's sections in this order too.
function parseSections(raw: Record<string, unknown>, front: StudyFront): Parsed<StudyConfig> {
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
  const { surfaces } = front;
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
function parseParticipants(raw: unknown, read: Participants): Parsed<StudyConfig["participants"]> {
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

/**
 * The checks that read more than one section of a parsed config, and the defaults they fill:
 * shared-world `execution.concurrency`, `comms.email.recipients` and the local browser's defaults.
 */
function checkStudyConfig(config: StudyConfig): StudyParseResult {
  const smtpReason = smtpValidationReason(config);
  if (smtpReason) return invalid(smtpReason);

  const mediaReason = desktopMediaValidationReason(config);
  if (mediaReason) return invalid(mediaReason);

  const outputLimitReason = outputTokenLimitValidationReason(config);
  if (outputLimitReason) return invalid(outputLimitReason);

  const waitLimitReason = waitLimitValidationReason(config);
  if (waitLimitReason) return invalid(waitLimitReason);

  // All-parallel default: a multi-participant study that does not declare execution.concurrency
  // runs every participant at once; the declared field is a cap the author chose, never a mode.
  // Independent computer-use participants resolve that default from the final participant count
  // when they plan, after any --count override, so the parser leaves it unset for them. A shared
  // world's roster is fixed, so its default is filled here for the envelopes and warnings that read
  // the parsed config.
  {
    const participantCount =
      participantList(config)?.length ?? declaredParticipantCount(config) ?? 1;
    if (
      participantCount > 1 &&
      config.execution?.concurrency === undefined &&
      isSharedWorldComposition(config)
    ) {
      config.execution = { ...config.execution, concurrency: participantCount };
    }
  }

  // Email that just works: the funnel's only handoff to an actor is the per-participant
  // inbox instruction, gated on recipients[]. Guessed participant ids broke a field run:
  // recipients copied from a single-participant example matched nothing, so every actor was left inbox-blind with zero
  // signal. Omitted recipients are therefore filled (one deterministic address per participant);
  // a recipient naming an unknown participant is a hard error listing the real ids; declared
  // recipients covering zero participants are a hard error (a guaranteed-dead funnel).
  const receivingReason = receivingEmailValidationReason(config);
  if (receivingReason) return invalid(receivingReason);
  if (config.comms?.email?.kind === "fake" && isComputerUseComposition(config)) {
    const participantIds = declaredParticipantIds(config);
    const email = config.comms.email;
    if (email.recipients === undefined) {
      email.recipients = participantIds.map((id) => ({
        lane: id,
        address: `${id.toLowerCase()}@example.test`,
      }));
    } else {
      const unknown = email.recipients.filter(
        (recipient) => !participantIds.includes(recipientParticipantId(recipient)),
      );
      if (unknown.length > 0) {
        return invalid(
          `comms.email.recipients name ${plural(unknown.length, "participant")} that ${unknown.length === 1 ? "does" : "do"} not exist: ${unknown.map((r) => `"${recipientParticipantId(r)}"`).join(", ")}. This study's participant ids are: ${participantIds.join(", ")}. A recipient's \`lane\` must match one of them exactly: the inbox instruction is injected per participant, and a mismatch disables the email funnel for that participant.`,
        );
      }
      if (!email.recipients.some((recipient) => recipient.address !== undefined)) {
        return invalid(
          "comms.email.recipients cover no participant with an address, so no actor would be told an inbox exists and no captured mail could match. Give at least one recipient an address, or omit `recipients` entirely (every participant then gets a deterministic address automatically).",
        );
      }
    }
  }

  const compositionFailure = compositionReason(config);
  if (compositionFailure) return invalid(compositionFailure);

  const tasksReason = taskProtocolValidationReason(config);
  if (tasksReason) return invalid(tasksReason);

  const analysisReason = automaticAnalysisRouteReason(config);
  if (analysisReason) return invalid(analysisReason);
  const normalized = localBrowserDefaults(config);
  if (isLocalBrowserStudy(normalized)) {
    const reason = localBrowserUnsupportedReason(normalized);
    if (reason) return invalid(reason);
  }
  return {
    ok: true,
    config: normalized,
    warnings: forwardDeclaredWarnings(normalized),
  };
}
