// What a run reports through RunLabOptions.onEvent, and how a callback failure becomes a run
// warning. normalizeRunStudyOptions (run-study-options.ts) builds the emitter and hands it to the
// route hook bags it maps; the event values are built here.

import { redactText, scrubLiterals, toErrorMessage } from "../evidence/redaction.js";
import type { CuaParticipantPlan } from "../routes/computer-use/types.js";
import type { SubjectPhaseEvent } from "../subject/steps.js";
import type { InternalRunLabOptions } from "../run-lab.js";
import type { StudyRoute } from "./plan.js";
import type { StudyConfig } from "./types.js";

/** One participant, as the options' callbacks see it. */
export interface ParticipantRef {
  readonly id: string;
  /** 0-based position in the roster. */
  readonly index: number;
  readonly count: number;
}

/** Provisioned shared world and scripted clone labs prepare the shared subject sandbox first. */
export type SetupTarget =
  | { readonly kind: "subject" }
  | { readonly kind: "participant"; readonly participant: ParticipantRef };

/**
 * What a run reports while it runs. `plan` comes from computer use only; the other routes run from
 * the lab plan but do not emit it. `subject-phase` comes from computer use (participant target)
 * and shared world (subject target).
 */
export type StudyEvent =
  | {
      type: "plan";
      route: StudyRoute;
      participants: readonly {
        id: string;
        persona: string;
        device?: string;
        instructionDigest: string;
      }[];
    }
  | {
      type: "subject-phase";
      target: SetupTarget;
      name: string;
      message: string;
      at: string;
      ok?: boolean;
      durationMs?: number;
    }
  | { type: "analysis-started" }
  | { type: "analysis-finished" };

/**
 * The literal values to scrub from an onEvent warning: the provider keys and the declared subject
 * env from every env the run could read (the `env` option and process.env), and the
 * analysis API key. A callback can hold any of them, and its warning is appended after the route
 * sanitized its own.
 */
export function knownSecretValues(
  config: StudyConfig,
  options: InternalRunLabOptions,
  forwardedEnv: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  const sources = [forwardedEnv, options.env, process.env];
  const names = ["OPENAI_API_KEY", "E2B_API_KEY", "CODEX_API_KEY", ...(config.subject.env ?? [])];
  const values = new Set<string>();
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length >= 4) values.add(trimmed);
  };
  for (const env of sources) for (const name of names) add(env?.[name]);
  return [...values];
}

/**
 * The emitter the route hook bags call, or undefined without onEvent. It calls onEvent and never
 * waits for it: a throw or a rejected promise becomes a run warning, scrubbed of `secretValues`.
 */
export function studyEventEmitter(
  onEvent: ((event: StudyEvent) => void | Promise<void>) | undefined,
  warnings: string[],
  secretValues: () => string[],
): ((event: StudyEvent) => void) | undefined {
  if (onEvent === undefined) return undefined;
  return (event: StudyEvent): void => {
    // Read before the callback runs: the callback can redefine anything on the event.
    const type = event.type;
    // Total: a thrown value can refuse to become a string, and nothing may escape from here.
    const report = (error: unknown): void => {
      let detail: string;
      try {
        // Read here, not up front: a run with no failing callback never touches the env.
        const scrub = scrubLiterals(secretValues());
        detail = redactText(scrub(toErrorMessage(error)));
      } catch {
        detail = "the thrown value has no message";
      }
      warnings.push(`RunLabOptions.onEvent failed on ${type}: ${detail}`);
    };
    try {
      const returned = onEvent(event);
      if (returned !== undefined) Promise.resolve(returned).then(undefined, report);
    } catch (error) {
      report(error);
    }
  };
}

/** The computer-use participant plan as a `plan` event: ids, personas, devices and digests. */
export function planEvent(plan: CuaParticipantPlan): StudyEvent {
  return {
    type: "plan",
    route: "computer-use",
    participants: plan.lanes.map((participant) => ({
      id: participant.id,
      persona: participant.persona,
      device: participant.device,
      instructionDigest: participant.instructionDigest,
    })),
  };
}

export function phaseEvent(event: SubjectPhaseEvent, target: SetupTarget): StudyEvent {
  return {
    type: "subject-phase",
    target,
    name: event.type,
    message: event.message,
    at: event.at,
    ...(event.ok === undefined ? {} : { ok: event.ok }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
  };
}
