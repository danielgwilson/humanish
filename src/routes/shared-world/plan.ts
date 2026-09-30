// The shared-world route's plan: every configuration refusal the route makes before a run starts,
// in its order and with its codes, then the plan the run uses. What stays in the route reads
// external state: keys and subject env values, the external comms catch, the packed working tree
// and email receiving setup.

import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import {
  actorRegistry,
  isCuaActorDescriptor,
  type CuaActorDescriptor,
} from "../../actors/registry.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { brainOf, capsOf, desktopRequirements, isNonEmpty, planBase } from "../../lab/plan-base.js";
import { sharedWorldSeats } from "../../lab/plan-participants.js";
import type { SharedWorldPlan, SharedWorldPlane } from "../../lab/plan-types.js";
import type { LabConfig } from "../../lab/types.js";
import {
  concurrentSharedWorldValidationReason,
  desktopMediaValidationReason,
  externalPublicSharedWorldValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  scenarioCapsValidationReason,
  taskProtocolValidationReason,
} from "../../lab/validation.js";
import { MODEL_RATES } from "../../run/pricing.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { ConcurrentSharedWorldLabErrorCode } from "./types.js";

/** The error a shared-world lab returns before a run starts. */
export interface SharedWorldRefusal {
  readonly route: "shared-world";
  readonly code: ConcurrentSharedWorldLabErrorCode;
  readonly message: string;
  /** The registered actor id, once the registry check has passed. */
  readonly actor?: string;
}

export type SharedWorldPlanResult =
  | { readonly ok: true; readonly plan: SharedWorldPlan }
  | { readonly ok: false; readonly refusal: SharedWorldRefusal };

/** The registered descriptor for a planned actor; planSharedWorldLab checked the registry. */
export function sharedWorldDescriptorOf(actorType: string): CuaActorDescriptor {
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor))
    throw new Error(`actor "${actorType}" is not a registered computer-use actor`);
  return descriptor;
}

/**
 * Plan a shared-world lab. It is called for any config handed to the shared-world runner, not only
 * one routeOf sends here, so a config for another route gets this route's refusal.
 */
export function planSharedWorldLab(
  config: LabConfig,
  input: {
    readonly dryRun: boolean;
    readonly lab?: RunLabProvenance;
    /** A caller's session runner cannot enforce maxOutputTokens. */
    readonly hooks?: { readonly runSession?: unknown };
  },
): SharedWorldPlanResult {
  const refuse = (
    code: ConcurrentSharedWorldLabErrorCode,
    message: string,
    actor?: string,
  ): SharedWorldPlanResult => ({
    ok: false,
    refusal: { route: "shared-world", code, message, ...(actor === undefined ? {} : { actor }) },
  });
  const invalid = "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID";

  const mediaReason = desktopMediaValidationReason(config, false);
  if (mediaReason) return refuse(invalid, mediaReason);
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  if (!analysis.ok) return refuse("HUMANISH_LAB_ANALYSIS_INVALID", analysis.message);
  const tasksReason = taskProtocolValidationReason(config, false);
  if (tasksReason) return refuse("HUMANISH_LAB_TASKS_UNSUPPORTED", tasksReason);

  const actorType = config.actors[0]?.type ?? "";
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor))
    return refuse(
      "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered computer-use actor.`,
    );
  const actor = descriptor.id;

  // An app-url subject is the external-public plane (a real operator-owned deployment used
  // directly, with no getHost, clone, subject sandbox or seed); every other subject is the
  // provisioned plane. The external-public check never runs the getHost synthetic gate: that gate
  // exists because getHost is internet-reachable and harness-owned, and a public site the harness
  // neither provisioned nor exposed is neither.
  const externalPublic = config.subject.source === "app-url";
  const invalidReason =
    outputTokenLimitValidationReason(config) ??
    scenarioCapsValidationReason(config) ??
    (externalPublic
      ? externalPublicSharedWorldValidationReason(config)
      : concurrentSharedWorldValidationReason(config));
  if (invalidReason) return refuse(invalid, invalidReason, actor);
  if (config.actors[0]?.maxOutputTokens !== undefined && input.hooks?.runSession)
    return refuse(invalid, "maxOutputTokens cannot be enforced by a custom runSession.", actor);

  const caps = config.execution?.caps;
  if (!input.dryRun && (caps?.maxUsd !== undefined || caps?.maxTotalUsd !== undefined)) {
    const model = (config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL).trim().toLowerCase();
    if (!MODEL_RATES[model])
      return refuse(
        invalid,
        `The declared spend cap cannot be enforced for unpriced model "${model}".`,
        actor,
      );
  }
  const receivingReason = receivingEmailValidationReason(config);
  if (receivingReason) return refuse(invalid, receivingReason, actor);

  const plane = planeOf(config);
  if (plane === undefined)
    throw new Error("shared-world validation admitted a plane it cannot plan");
  const brain = brainOf(config, false);
  if (brain.kind === "caller") throw new Error("a shared-world seat has no caller brain");
  const base = planBase(config, {
    dryRun: input.dryRun,
    ...(input.lab === undefined ? {} : { lab: input.lab }),
    analysis,
  });
  return {
    ok: true,
    plan: {
      ...base,
      route: "shared-world",
      actor,
      plane,
      concurrency: config.execution?.concurrency ?? plane.participants.length,
      brain,
      caps: capsOf(config),
      requirements: base.dryRun
        ? []
        : desktopRequirements(config, {
            e2b: true,
            brain,
            localVm: false,
            externalCatch: plane.kind === "external-public",
          }),
    },
  };
}

/**
 * The shared plane and its seats. The validation above guarantees two or more seats, and on the
 * provisioned plane a clone or local tree with `serve` and at least one checkpoint.
 */
function planeOf(config: LabConfig): SharedWorldPlane | undefined {
  const seats = sharedWorldSeats(config);
  if (seats.plane === "external-public") {
    const [first, second, ...rest] = seats.seats;
    if (first === undefined || second === undefined) return undefined;
    const owner = config.subject.publicTarget?.owner;
    return {
      kind: "external-public",
      appUrl: config.subject.appUrl ?? "",
      ...(owner === undefined ? {} : { owner }),
      participants: [first, second, ...rest],
    };
  }
  const [first, second, ...rest] = seats.seats;
  const { serve, state } = config.subject;
  const checkpoint = state?.checkpoint ?? [];
  if (
    first === undefined ||
    second === undefined ||
    serve === undefined ||
    state === undefined ||
    !isNonEmpty(checkpoint)
  )
    return undefined;
  const env = config.subject.env ?? [];
  const checkpointed = { ...state, checkpoint };
  return {
    kind: "provisioned",
    subject:
      config.subject.source === "local-tree"
        ? { kind: "local-tree", serve, env, state: checkpointed }
        : {
            kind: "clone",
            // The route clones whatever repos[0] names, so the plan keeps an empty name too.
            repo: config.subject.repos?.[0] ?? "",
            serve,
            env,
            state: checkpointed,
          },
    participants: [first, second, ...rest],
  };
}
