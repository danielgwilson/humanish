// humanish.lab.v2: a lab is a composition over code primitives. There is no hardcoded lab kind.
//
// Scope (read before trusting field names): the engine routes by
// subject.source × execution.target (disambiguated by the actor lane where both axes
// collide) and consumes a deliberately small set of fields:
//   subject.source/repos/appUrl/serve/env/state/clone.{depth,fanout,keep}, actors[0].count,
//   execution.target + execution.desktop.codexAppServer, scenario.mode,
//   policies.redactRepos, defaults.open.
// On the computer-use routes (app-url × e2b-desktop, and clone × e2b-desktop with a
// computer-use actor), `actors[0].type` is load-bearing: it must resolve to a registered
// computer-use actor, and that descriptor runs the session. Those routes also consume
// actors[0].{mission,persona,laneFocus.instruction,model,reasoningEffort}, execution.timeoutMs,
// execution.desktop.{browser,resolution,sandboxTimeoutMs}, and (clone)
// subject.{serve,env,state,clone.depth}.
// On the scripted-browser route (app-url × local-or-absent, or clone × e2b-desktop, with a
// registered scripted-browser actor), `actors[0].type` is equally load-bearing, and the route
// consumes scenario.ref (required there, because the committed scenario's browser steps are what the
// actor executes), actors[0].{persona,count}, and execution.timeoutMs. On the provisioned
// clone slice it also consumes subject.{repos,serve,env,state,exposure,clone.depth} and
// execution.desktop.template. actors[0].{mission,laneFocus,model} are inert on that route
// because no model runs, and most execution.desktop.* fields remain forward-declared (device
// presets belong to the cua route; scripted surfaces are the driver's own desktop/mobile
// viewports where isMobile/DSF genuinely render via playwright emulation).
// On the other routes those fields remain forward-declared and are not yet consumed:
// parseLabConfig emits a warning listing any such field that is set, so `lab inspect` shows
// the truth.
//
// NOTE on actors[0].count: it carries ROUTE-SPECIFIC meanings. Preview route: simCount;
// scripted-browser route: surface roster {1 = desktop, 2 = desktop + mobile}, default 1 (the
// defaults-table single-participant row governs; count: 2 is the declared override); computer-use
// E2B route: the homogeneous fan-out participant count (N identical participants, each its own E2B
// desktop), capped at 16; the in-process/local-app cua route stays single-participant (no E2B to
// fan out).
//
// NOTE on actors[0].lanes / actors[0].roster (computer-use E2B route, this slice): a
// differentiated fan-out roster: each `{ id?, persona?, device?, instruction?, target? }` becomes one
// independent E2B desktop (`per-lane-worlds`, the default topology). `roster[]` is parser sugar for
// repeated groups and is normalized into `lanes[]` before the engine sees it. `lanes|roster` XOR
// `count` (declare a differentiated roster or a homogeneous count, never both); `lanes|roster`
// XOR `actors[0].laneFocus` (each entry's `instruction` is the roster's steer); `lanes[].device` XOR
// raw `execution.desktop.resolution`. `execution.concurrency` bounds in-flight participants (default:
// the participant count, all at once; env HUMANISH_CUA_MAX_CONCURRENCY may only lower it, per invariant
// 3). On every non-cua route normalized `lanes` are inert (warned). subject.clone.fanout is
// rejected on the cua route. `lanes[].target` is app-url × computer-use only: an absolute browser
// URL this participant opens instead of `subject.appUrl`; it is the generic setup-produced-target
// handoff, not a service topology primitive.
//
// There is deliberately no v1 compatibility: v1 had zero real users. Breaking schema changes
// bump the version honestly.

import {
  isLocalBrowserLab,
  localBrowserDefaults,
  localBrowserUnsupportedReason,
} from "../substrates/local/runtime-config.js";
import { isRecord } from "../run/type-guards.js";
import { compositionReason } from "./composition-rules.js";
import { findUnknownLabKey } from "./keys.js";
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
import { parseSubject } from "./parse/subject.js";
import { invalid, optionalStr, str } from "./parse/values.js";
import { isComputerUseComposition, isSharedWorldComposition } from "./routing.js";
import { declaredParticipantIds } from "./plan-participants.js";
import {
  ID_PATTERN,
  LAB_CONFIG_SCHEMA,
  type LabConfig,
  type LabConfigParseResult,
} from "./types.js";
import {
  automaticAnalysisRouteReason,
  desktopMediaValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  scenarioCapsValidationReason,
  taskProtocolValidationReason,
} from "./validation.js";
import { forwardDeclaredWarnings } from "./warnings.js";

/**
 * Validate a parsed YAML object into a LabConfig. Pure: the caller owns file IO. Structural
 * validation only. Fields the engine does not yet consume are accepted but reported in
 * `warnings` so `lab inspect` never silently swallows a setting that does nothing.
 */
export function parseLabConfig(raw: unknown): LabConfigParseResult {
  if (!isRecord(raw)) {
    return invalid("Lab manifest must be a YAML object.");
  }
  if (raw.schema !== LAB_CONFIG_SCHEMA) {
    return invalid(`Lab schema must be ${LAB_CONFIG_SCHEMA}.`);
  }
  const unknownKey = findUnknownLabKey(raw);
  if (unknownKey) return invalid(unknownKey);

  const id = str(raw.id);
  if (!id || !ID_PATTERN.test(id)) {
    return invalid(
      "Lab id must be a public-safe token starting with a letter or digit (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).",
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

  const config: LabConfig = {
    schema: LAB_CONFIG_SCHEMA,
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
      "SMTP capture is not yet wired for shared-world labs. Use the default per-lane-worlds topology for SMTP, or configure supported HTTP email capture for concurrent shared-world labs.",
    );
  }

  const mediaReason = desktopMediaValidationReason(config);
  if (mediaReason) return invalid(mediaReason);

  const outputLimitReason = outputTokenLimitValidationReason(config);
  if (outputLimitReason) return invalid(outputLimitReason);
  const scenarioCapsReason = scenarioCapsValidationReason(config);
  if (scenarioCapsReason) return invalid(scenarioCapsReason);

  // All-parallel default: a multi-seat lab that does not declare execution.concurrency runs
  // every seat at once; the declared field is a cap the author chose, never a mode. Independent
  // computer-use participants resolve that default from the final participant count when they plan, after any
  // --count override, so the parser leaves it unset for them. A shared world's roster is fixed, so
  // its default is filled here for the envelopes and warnings that read the parsed config.
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
          `comms.email.recipients name participant(s) that do not exist: ${unknown.map((r) => `"${recipientParticipantId(r)}"`).join(", ")}. This lab's participant ids are: ${participantIds.join(", ")}. A recipient's \`lane\` must match one of them exactly: the inbox instruction is injected per participant, and a mismatch disables the email funnel for that participant.`,
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
  if (isLocalBrowserLab(normalized)) {
    const reason = localBrowserUnsupportedReason(normalized);
    if (reason) return invalid(reason);
  }
  return { ok: true, config: normalized, warnings: forwardDeclaredWarnings(normalized) };
}
