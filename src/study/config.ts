// humanish.lab.v2: a lab is a composition over code primitives. There is no hardcoded lab kind.
// A humanish.study.v3 file is rewritten into this spelling first (parse/study-v3.ts), and then must
// take the route it declares and set no field that route does not read.
//
// Scope (read before trusting field names): the engine routes by
// subject.source × execution.target (disambiguated by the actor's run kind where both axes
// collide) and consumes a deliberately small set of fields:
//   subject.source/repos/appUrl/serve/env/state/clone.{depth,fanout,keep}, actors[0].count,
//   execution.target + execution.desktop.codexAppServer, scenario.mode,
//   policies.redactRepos, defaults.open.
// On the computer-use routes (app-url × e2b-desktop, and clone × e2b-desktop with a
// computer-use actor), `actors[0].type` selects the actor: it must resolve to a registered
// computer-use actor, and that descriptor runs the session. Those routes also consume
// actors[0].{mission,persona,laneFocus.instruction,model,reasoningEffort}, execution.timeoutMs,
// execution.desktop.{browser,resolution,sandboxTimeoutMs}, and (clone)
// subject.{serve,env,state,clone.depth}.
// On the scripted-browser route (app-url × local-or-absent, or clone × e2b-desktop, with a
// registered scripted-browser actor), `actors[0].type` selects the actor too, and the route
// consumes scenario.ref (required there, because the committed scenario's browser steps are what the
// actor executes), actors[0].{persona,count}, and execution.timeoutMs. On the provisioned
// clone slice it also consumes subject.{repos,serve,env,state,exposure,clone.depth} and
// execution.desktop.template. actors[0].{mission,laneFocus,model} are inert on that route
// because no model runs, and most execution.desktop.* fields remain forward-declared (device
// presets belong to the computer-use route; scripted surfaces are the driver's own desktop/mobile
// viewports where isMobile/DSF genuinely render via playwright emulation).
// On the other routes those fields remain forward-declared and are not yet consumed:
// parseStudy emits a warning listing any such field that is set, so `lab inspect` shows
// the truth.
//
// NOTE on actors[0].count: it carries route-specific meanings. Preview route: simCount;
// scripted-browser route: surface roster {1 = desktop, 2 = desktop + mobile}, default 1 (the
// defaults-table single-participant row governs; count: 2 is the declared override); computer-use
// E2B route: the homogeneous fan-out participant count (N identical participants, each its own E2B
// desktop), capped at 16; the in-process/local-app computer-use route stays single-participant (no
// E2B to fan out).
//
// NOTE on actors[0].lanes / actors[0].roster (computer-use E2B route): a
// differentiated fan-out roster: each `{ id?, persona?, device?, instruction?, target? }` becomes one
// independent E2B desktop (`per-lane-worlds`, the default topology). `roster[]` is parser sugar for
// repeated groups and is normalized into `lanes[]` before the engine sees it. `lanes|roster` XOR
// `count` (declare a differentiated roster or a homogeneous count, never both); `lanes|roster`
// XOR `actors[0].laneFocus` (each entry's `instruction` is the roster's steer); `lanes[].device` XOR
// raw `execution.desktop.resolution`. `execution.concurrency` bounds in-flight participants (default:
// the participant count, all at once; env HUMANISH_CUA_MAX_CONCURRENCY may only lower it, per invariant
// 3). On every non-computer-use route normalized `lanes` are inert (warned). subject.clone.fanout
// is rejected on the computer-use route. `lanes[].target` is app-url × computer-use only: an
// absolute browser URL this participant opens instead of `subject.appUrl`; it is the generic
// setup-produced-target handoff, not a service topology primitive.
//
// There is deliberately no v1 compatibility: v1 had zero real users. Breaking schema changes
// bump the version.

import {
  isLocalBrowserStudy,
  localBrowserDefaults,
  localBrowserUnsupportedReason,
} from "../substrates/local/runtime-config.js";
import { isRecord } from "../run/type-guards.js";
import { compositionReason } from "./composition-rules.js";
import { findUnknownV2Key } from "./keys.js";
import { parseActors, rosterOf } from "./parse/actors.js";
import { parseComms, recipientParticipantId } from "./parse/comms.js";
import {
  parseDefaults,
  parseExecution,
  parsePersonas,
  parsePolicies,
  parseReview,
  parseScenario,
} from "./parse/execution.js";
import { studySpelling, studyToV2 } from "./parse/study-v3.js";
import { parseSubject } from "./parse/subject.js";
import { invalid, optionalStr, str } from "./parse/values.js";
import { isComputerUseComposition, isSharedWorldComposition, routeOf } from "./routing.js";
import { declaredParticipantIds } from "./plan-participants.js";
import {
  ID_PATTERN,
  V2_SCHEMA,
  STUDY_SCHEMA,
  type StudyConfig,
  type StudyParseResult,
} from "./types.js";
import {
  automaticAnalysisRouteReason,
  desktopMediaValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  scenarioCapsValidationReason,
  taskProtocolValidationReason,
} from "./validation.js";
import { forwardDeclaredWarnings, inertFieldLabels } from "./warnings.js";

/**
 * Validate a parsed YAML object into a StudyConfig. Pure: the caller owns file IO. Structural
 * validation only. Fields the engine does not yet consume are accepted but reported in
 * `warnings` so `lab inspect` never silently swallows a setting that does nothing.
 */
export function parseStudy(raw: unknown): StudyParseResult {
  if (!isRecord(raw)) {
    return invalid("A study file must be a YAML object.");
  }
  if (raw.schema === STUDY_SCHEMA) return parseV3(raw);
  if (raw.schema !== V2_SCHEMA) {
    return invalid(`The study schema must be ${STUDY_SCHEMA} or ${V2_SCHEMA}.`);
  }
  return parseV2(raw);
}

/**
 * A v3 study parses through the v2 parser, then must take the route it declares and set no field
 * that route does not read. A v2 file gets those fields as a warning instead.
 */
function parseV3(raw: Record<string, unknown>): StudyParseResult {
  const document = studyToV2(raw);
  if (!document.ok) return document;
  const { route, v2, participantSource } = document.value;
  const spell = (message: string) => studySpelling(message, route, participantSource);
  const parsed = parseV2(v2);
  if (!parsed.ok) return invalid(spell(parsed.error.message));
  const taken = routeOf(parsed.config);
  if (taken !== route) {
    return invalid(
      `This study declares route: ${route}, but its subject (source: ${parsed.config.subject.source}) and actor (type: ${parsed.config.actors[0]?.type}) take the ${taken} route. Change \`route\`, or change the subject or actor.`,
    );
  }
  const inert = inertFieldLabels(parsed.config);
  if (inert.length > 0) {
    return invalid(
      spell(
        `route: ${route} does not read ${inert.join(", ")}. Remove ${inert.length === 1 ? "it" : "them"}.`,
      ),
    );
  }
  return {
    ok: true,
    config: { ...parsed.config, schema: STUDY_SCHEMA },
    warnings: parsed.warnings.map(spell),
  };
}

function parseV2(raw: Record<string, unknown>): StudyParseResult {
  const unknownKey = findUnknownV2Key(raw);
  if (unknownKey) return invalid(unknownKey);

  const id = str(raw.id);
  if (!id || !ID_PATTERN.test(id)) {
    return invalid(
      "The study id must be a public-safe token starting with a letter or digit (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).",
    );
  }

  const subjectResult = parseSubject(raw.subject);
  if (!subjectResult.ok) {
    return subjectResult;
  }

  const actorsResult = parseActors(raw.actors);
  if (!actorsResult.ok) {
    return actorsResult;
  }

  const executionResult = parseExecution(raw.execution);
  if (!executionResult.ok) {
    return executionResult;
  }

  const config: StudyConfig = {
    schema: V2_SCHEMA,
    id,
    ...optionalStr("title", raw.title),
    ...optionalStr("description", raw.description),
    subject: subjectResult.value,
    actors: actorsResult.value,
    ...(executionResult.value ? { execution: executionResult.value } : {}),
  };

  const personas = parsePersonas(raw.personas);
  if (personas) config.personas = personas;
  const scenarioResult = parseScenario(raw.scenario);
  if (!scenarioResult.ok) {
    return scenarioResult;
  }
  if (scenarioResult.value) config.scenario = scenarioResult.value;
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
  const policiesResult = parsePolicies(raw.policies);
  if (!policiesResult.ok) return policiesResult;
  if (policiesResult.value) config.policies = policiesResult.value;
  const reviewResult = parseReview(raw.review);
  if (!reviewResult.ok) return reviewResult;
  if (reviewResult.value) config.review = reviewResult.value;
  if (raw.defaults !== undefined && isRecord(raw.defaults) && raw.defaults.open !== undefined) {
    if (typeof raw.defaults.open !== "boolean")
      return invalid("`defaults.open` must be true or false.");
  }
  const defaults = parseDefaults(raw.defaults);
  if (defaults) config.defaults = defaults;
  const commsResult = parseComms(raw.comms);
  if (!commsResult.ok) return commsResult;
  if (commsResult.value) config.comms = commsResult.value;
  if (config.comms?.email?.smtp && config.subject.topology === "shared-world") {
    return invalid(
      "SMTP capture is not supported yet for shared-world studies. Use the default per-lane-worlds topology for SMTP, or configure supported HTTP email capture for concurrent shared-world studies.",
    );
  }

  const mediaReason = desktopMediaValidationReason(config);
  if (mediaReason) return invalid(mediaReason);

  const outputLimitReason = outputTokenLimitValidationReason(config);
  if (outputLimitReason) return invalid(outputLimitReason);
  const scenarioCapsReason = scenarioCapsValidationReason(config);
  if (scenarioCapsReason) return invalid(scenarioCapsReason);

  // All-parallel default: a multi-participant study that does not declare execution.concurrency
  // runs every participant at once; the declared field is a cap the author chose, never a mode.
  // Independent computer-use participants resolve that default from the final participant count
  // when they plan, after any --count override, so the parser leaves it unset for them. A shared
  // world's roster is fixed, so its default is filled here for the envelopes and warnings that read
  // the parsed config.
  {
    const participantCount = rosterOf(config.actors[0])?.length ?? config.actors[0]?.count ?? 1;
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
          `comms.email.recipients name participant(s) that do not exist: ${unknown.map((r) => `"${recipientParticipantId(r)}"`).join(", ")}. This study's participant ids are: ${participantIds.join(", ")}. A recipient's \`lane\` must match one of them exactly: the inbox instruction is injected per participant, and a mismatch disables the email funnel for that participant.`,
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
