// The scripted route's plan: every configuration refusal the route makes before a run starts, in
// its order and with its codes, then the plan the run uses. What stays in the route reads external
// state: the scenario file, the E2B key, subject env values and the host browser.

import { actorRegistry, isScriptedBrowserActorDescriptor } from "../../actors/registry.js";
import { normalizeLocalAppUrl } from "../../actors/scripted-browser/steps.js";
import { browserSurfaces } from "../../actors/scripted-browser/types.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { isNonEmpty, planBase, provisionedSubject } from "../../lab/plan-base.js";
import type { Requirement, ScriptedPlan } from "../../lab/plan-types.js";
import type { LabConfig } from "../../lab/types.js";
import {
  cloneTargetValidationReason,
  desktopMediaValidationReason,
  taskProtocolValidationReason,
} from "../../lab/validation.js";
import type { RunLabProvenance } from "../../run/status.js";

// Default surface roster is 1 (desktop only): the defaults-table single-lane row governs;
// `count: 2` is the declared override that adds the mobile surface.
const DEFAULT_SURFACE_COUNT = 1;

/** The error a scripted lab returns before a run starts. */
export interface ScriptedRefusal {
  readonly route: "scripted";
  readonly code:
    | "HUMANISH_LAB_ANALYSIS_INVALID"
    | "HUMANISH_LAB_TASKS_UNSUPPORTED"
    | "HUMANISH_SCRIPTED_LAB_ACTOR_UNSUPPORTED"
    | "HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID"
    | "HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE";
  readonly message: string;
  /**
   * Set on the receiving, analysis and tasks refusals. The route returns those before it opens its
   * run scope, so their result has its own field order and no automatic-analysis record.
   */
  readonly beforeScope?: true;
  /** The registered actor id and the app URL the evidence names, once the chain has them. */
  readonly actor?: string;
  readonly appUrl?: string;
}

export type ScriptedPlanResult =
  | { readonly ok: true; readonly plan: ScriptedPlan }
  | { readonly ok: false; readonly refusal: ScriptedRefusal };

/** The app URL a run's evidence names: a provisioned subject's getHost URL is never persisted. */
export function evidenceAppUrlOf(subject: ScriptedPlan["subject"]): string {
  return subject.kind === "clone" ? "[provisioned-subject]" : subject.appUrl;
}

/**
 * Plan a scripted-browser lab. It is called for any config handed to the scripted runner, not only
 * one routeOf sends here, so a config for another route gets this route's refusal.
 */
export function planScriptedLab(
  config: LabConfig,
  input: {
    readonly dryRun: boolean;
    readonly lab?: RunLabProvenance;
    /** An injected browser means a live run needs no host browser. */
    readonly hooks?: { readonly launchBrowser?: unknown; readonly browserCommand?: string };
  },
): ScriptedPlanResult {
  const refuse = (
    code: ScriptedRefusal["code"],
    message: string,
    extras: Pick<ScriptedRefusal, "beforeScope" | "actor" | "appUrl"> = {},
  ): ScriptedPlanResult => ({
    ok: false,
    refusal: { route: "scripted", code, message, ...extras },
  });
  const beforeScope = { beforeScope: true } as const;

  if (String(config.comms?.email?.kind) === "real")
    return refuse(
      "HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID",
      "Real email receiving is unsupported on the scripted-browser backend. Use a supported hosted computer-use browser study.",
      beforeScope,
    );
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  if (!analysis.ok) return refuse("HUMANISH_LAB_ANALYSIS_INVALID", analysis.message, beforeScope);
  const tasksReason = taskProtocolValidationReason(config, false);
  if (tasksReason) return refuse("HUMANISH_LAB_TASKS_UNSUPPORTED", tasksReason, beforeScope);

  const mediaReason = desktopMediaValidationReason(config);
  if (mediaReason) return refuse("HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID", mediaReason);
  const cloneTargetReason = cloneTargetValidationReason(config);
  if (cloneTargetReason) return refuse("HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE", cloneTargetReason);
  const actorType = config.actors[0]?.type ?? "";
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isScriptedBrowserActorDescriptor(descriptor))
    return refuse(
      "HUMANISH_SCRIPTED_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered scripted-browser actor.`,
    );
  const actor = descriptor.id;

  // The parser checks the loopback entry too; a library caller skips the parser. A clone's URL is
  // minted by getHost during the run, and its evidence names only the placeholder.
  let subject: ScriptedPlan["subject"];
  if (config.subject.source === "clone") {
    const provisioned = provisionedSubject(config);
    if (provisioned?.kind !== "clone" || !provisioned.repo)
      return refuse(
        "HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE",
        "clone scripted-browser labs require one subject repo plus subject.serve; parseLabConfig should have rejected this config.",
        { actor, appUrl: "[provisioned-subject]" },
      );
    subject = provisioned;
  } else {
    const appUrl = normalizeLocalAppUrl(config.subject.appUrl ?? "");
    if (!appUrl)
      return refuse(
        "HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE",
        "subject.appUrl must be a loopback http(s) URL (127.0.0.1 or localhost) on the scripted-browser route.",
        { actor },
      );
    subject = { kind: "loopback", appUrl };
  }

  // The steps are the actor, so there is no built-in journey to fall back on.
  const scenarioRef = config.scenario?.ref;
  if (!scenarioRef?.trim())
    return refuse(
      "HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID",
      "scripted-browser labs require `scenario.ref` — the committed scenario's browser steps are what this actor executes.",
      { actor, appUrl: evidenceAppUrlOf(subject) },
    );

  const hooks = input.hooks ?? {};
  const requirements: Requirement[] = [];
  if (!input.dryRun && subject.kind === "clone") {
    requirements.push({ kind: "key", name: "E2B_API_KEY" });
    if (isNonEmpty(subject.env)) requirements.push({ kind: "subject-env", names: subject.env });
  }
  // The browser runs on this machine on both subjects; a clone's is pointed at its getHost URL.
  if (!input.dryRun && !hooks.launchBrowser && !hooks.browserCommand)
    requirements.push({ kind: "host-browser" });
  const persona = config.actors[0]?.persona;
  const timeoutMs = config.execution?.timeoutMs;
  return {
    ok: true,
    plan: {
      ...planBase(config, {
        dryRun: input.dryRun,
        ...(input.lab === undefined ? {} : { lab: input.lab }),
        analysis,
      }),
      route: "scripted",
      actor,
      subject,
      scenarioRef,
      surfaces: browserSurfaces.slice(0, config.actors[0]?.count ?? DEFAULT_SURFACE_COUNT),
      ...(persona === undefined ? {} : { personaId: persona }),
      ...(timeoutMs === undefined ? {} : { sessionTimeoutMs: timeoutMs }),
      requirements,
    },
  };
}
