// The shared-world route's plan: every configuration refusal the route makes before a run starts,
// in its order and with its codes, then the plan the run uses. What stays in the route reads
// external state: keys and subject env values, the external comms catch, the packed working tree
// and email receiving setup.

import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { studyUrlCredentialReason } from "../../study/url-credentials.js";
import {
  actorRegistry,
  isCuaActorDescriptor,
  type CuaActorDescriptor,
} from "../../actors/registry.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import {
  brainOf,
  planCaps,
  desktopRequirements,
  isNonEmpty,
  planBase,
} from "../../study/plan-base.js";
import { sharedWorldParticipants } from "../../study/plan-participants.js";
import type {
  RoutePlanResult,
  RouteRefusal,
  SharedWorldPlan,
  SharedWorldPlane,
} from "../../study/plan-types.js";
import { PUBLIC_TARGET_OWNER_PATTERN } from "../../study/parse/subject.js";
import { REPO_SLUG_PATTERN } from "../../study/parse/values.js";
import type { StudyConfig, StudySubjectState } from "../../study/types.js";
import {
  concurrentSharedWorldValidationReason,
  desktopMediaValidationReason,
  externalPublicSharedWorldValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  taskProtocolValidationReason,
} from "../../study/validation.js";
import { unpricedCapCheck } from "../../study/requirements.js";
import {
  sandboxDeadlineRefusal,
  sandboxHeadroomMs,
  type SandboxCeiling,
} from "../../substrates/e2b/lifetime.js";
import type { ConcurrentSharedWorldStudyErrorCode } from "./types.js";

/** The error a shared-world study returns before a run starts. */
export interface SharedWorldRefusal extends RouteRefusal<
  "shared-world",
  ConcurrentSharedWorldStudyErrorCode
> {
  /** The registered actor id, once the registry check has passed. */
  readonly actor?: string;
}

export type SharedWorldPlanResult = RoutePlanResult<SharedWorldPlan, SharedWorldRefusal>;

/** The registered descriptor for a planned actor; planSharedWorldStudy checked the registry. */
export function sharedWorldDescriptorOf(actorType: string): CuaActorDescriptor {
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor))
    throw new Error(`actor "${actorType}" is not a registered computer-use actor`);
  return descriptor;
}

/**
 * Plan a shared-world study. It is called for any config handed to the shared-world runner, not only
 * one routeOf sends here, so a config for another route gets this route's refusal.
 */
export function planSharedWorldStudy(
  config: StudyConfig,
  input: {
    readonly dryRun: boolean;
    /** Whether deps.runSession is set: a caller's session runner cannot enforce maxOutputTokens. */
    readonly hasRunSession?: boolean;
    /** The longest sandbox lifetime the operator's E2B plan allows (sandboxCeiling). */
    readonly sandboxCeiling: SandboxCeiling;
  },
): SharedWorldPlanResult {
  const refuse = (
    code: ConcurrentSharedWorldStudyErrorCode,
    message: string,
    actor?: string,
  ): SharedWorldPlanResult => ({
    ok: false,
    refusal: { route: "shared-world", code, message, ...(actor === undefined ? {} : { actor }) },
  });
  const invalid = "HUMANISH_SHARED_WORLD_INVALID";

  const mediaReason = desktopMediaValidationReason(config, false);
  if (mediaReason) return refuse(invalid, mediaReason);
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  if (!analysis.ok) return refuse("HUMANISH_STUDY_ANALYSIS_INVALID", analysis.message);
  const tasksReason = taskProtocolValidationReason(config, false);
  if (tasksReason) return refuse("HUMANISH_STUDY_TASKS_UNSUPPORTED", tasksReason);

  const actorType = config.actor?.type ?? "";
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor))
    return refuse(
      "HUMANISH_SHARED_WORLD_ACTOR_UNSUPPORTED",
      `actor.type "${actorType}" is not a registered computer-use actor.`,
    );
  const actor = descriptor.id;

  // An app-url subject is the external-public plane (a real operator-owned deployment used
  // directly, with no getHost, clone, subject sandbox or seed); every other subject is the
  // provisioned plane. The external-public check never runs the getHost synthetic gate: that gate
  // exists because getHost is internet-reachable and harness-owned, and a public site the harness
  // neither provisioned nor exposed is neither.
  const externalPublic = config.subject.source === "app-url";
  const invalidReason =
    // A library caller's config skips the parser, which refuses these first.
    studyUrlCredentialReason(config) ??
    outputTokenLimitValidationReason(config) ??
    (externalPublic
      ? externalPublicSharedWorldValidationReason(config)
      : concurrentSharedWorldValidationReason(config));
  if (invalidReason) return refuse(invalid, invalidReason, actor);
  if (config.actor?.maxOutputTokens !== undefined && input.hasRunSession === true)
    return refuse(invalid, "maxOutputTokens cannot be enforced by a custom runSession.", actor);

  // A live cap is priced here, at plan time, so its refusal wins over the route's key checks.
  const unpriced = input.dryRun
    ? undefined
    : unpricedCapCheck({
        caps: config.caps ?? {},
        model: (config.actor?.model ?? DEFAULT_OPENAI_CU_MODEL).trim().toLowerCase(),
        code: "HUMANISH_SHARED_WORLD_UNPRICED_CAP",
      });
  if (unpriced) return refuse(unpriced.code, unpriced.message, actor);
  const receivingReason = receivingEmailValidationReason(config);
  if (receivingReason) return refuse(invalid, receivingReason, actor);
  // The parser requires one owner/repo slug; without it the route would clone nothing and fail
  // after the run started.
  const repo = config.subject.repos?.[0] ?? "";
  if (config.subject.source === "clone" && !REPO_SLUG_PATTERN.test(repo))
    return refuse(invalid, `subject.repos[0] must be an owner/repo slug (got "${repo}").`, actor);
  // The owner is recorded in the evidence as the operator's attestation, so it must be declared
  // and public-safe; the parser requires the same.
  const owner = config.subject.publicTarget?.owner;
  if (externalPublic && (!owner || !PUBLIC_TARGET_OWNER_PATTERN.test(owner)))
    return refuse(
      invalid,
      "`subject.publicTarget.owner` must be a public-safe operator/repo label (e.g. owner/repo); it is recorded in evidence, so it must carry no secret.",
      actor,
    );

  // The external-public plane provisions nothing, so it has no env channel. The parser refuses
  // subject.env on an app-url subject for the same reason.
  if (externalPublic && config.subject.env !== undefined)
    return refuse(
      invalid,
      "`subject.env` applies only to clone subjects or local-tree subjects (the served app's environment channel).",
      actor,
    );

  const ceiling = input.sandboxCeiling;
  if (!ceiling.ok) return refuse(invalid, ceiling.message, actor);
  const plane = planeOf(config);
  if (plane === undefined)
    throw new Error("shared-world validation admitted a plane it cannot plan");
  const sessionTimeoutMs =
    config.execution?.timeoutMs ?? defaultSessionTimeoutMs(plane, ceiling.ms);
  // The run's longest deadline: on the provisioned plane the subject sandbox, which serves the app
  // until every participant ends; on the external-public plane each participant's own sandbox.
  const deadlineReason = sandboxDeadlineRefusal(
    plane.kind === "provisioned"
      ? {
          name: "the subject sandbox, which serves the app until every participant ends",
          sessionMs: sessionTimeoutMs,
          sessionDeclared: config.execution?.timeoutMs !== undefined,
          servedSubject: { seed: plane.subject.state.seed ?? [] },
        }
      : {
          name: "each participant's sandbox",
          sessionMs: sessionTimeoutMs,
          sessionDeclared: config.execution?.timeoutMs !== undefined,
        },
    ceiling.ms,
  );
  if (deadlineReason) return refuse(invalid, deadlineReason, actor);
  const brain = brainOf(config, false);
  if (brain.kind === "caller") throw new Error("a shared-world participant has no caller brain");
  const base = planBase(config, {
    dryRun: input.dryRun,
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
      sessionTimeoutMs,
      brain,
      caps: planCaps(config),
      requirements: base.dryRun
        ? []
        : [
            ...desktopRequirements(config, {
              e2b: true,
              brain,
              localVm: false,
              externalCatch: plane.kind === "external-public",
            }),
            // The external-public plane reads the host's lobby code with the OpenAI API, whatever
            // brain drives the participants.
            ...(plane.kind === "external-public" && brain.kind !== "openai"
              ? [{ kind: "key" as const, name: "OPENAI_API_KEY" as const }]
              : []),
          ],
    },
  };
}

// The default per-participant session budget is derived from the plane. On a provisioned plane the
// binding constraint is the subject sandbox (it must outlive every participant: timeoutMs +
// provisioning + seeding + teardown buffer, under the sandbox ceiling), so the derivation hands each
// participant the most the ceiling allows, capped at 15 minutes, floored at the historical 300s so
// a seed-heavy study never gets less room than it always had. App-url participants have no subject
// sandbox and default to 30 minutes (participant sandbox: 30m + 10m buffer stays under the hour).
// An explicit execution.timeoutMs is never adjusted. The handoff latch scales off this (40%).
const MAX_DERIVED_SESSION_MS = 15 * 60_000;

const MIN_DERIVED_SESSION_MS = 300_000;

const DEFAULT_APP_URL_SESSION_MS = 30 * 60_000;

function defaultSessionTimeoutMs(plane: SharedWorldPlane, ceilingMs: number): number {
  if (plane.kind !== "provisioned") return DEFAULT_APP_URL_SESSION_MS;
  const room = ceilingMs - sandboxHeadroomMs({ seed: plane.subject.state.seed ?? [] });
  return Math.max(MIN_DERIVED_SESSION_MS, Math.min(MAX_DERIVED_SESSION_MS, room));
}

/** The provisioned plane's declared subject state. The external-public plane declares none. */
export function planeStateOf(plan: SharedWorldPlan): StudySubjectState | undefined {
  return plan.plane.kind === "provisioned" ? plan.plane.subject.state : undefined;
}

/**
 * The shared plane and its participants. The validation above guarantees two or more, and on the
 * provisioned plane a clone or local tree with `serve` and at least one checkpoint.
 */
function planeOf(config: StudyConfig): SharedWorldPlane | undefined {
  const roster = sharedWorldParticipants(config);
  if (roster.plane === "external-public") {
    const [first, second, ...rest] = roster.participants;
    if (first === undefined || second === undefined) return undefined;
    const owner = config.subject.publicTarget?.owner;
    if (!owner) return undefined;
    return {
      kind: "external-public",
      appUrl: config.subject.appUrl ?? "",
      owner,
      participants: [first, second, ...rest],
    };
  }
  const [first, second, ...rest] = roster.participants;
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
            // planSharedWorldStudy refused a clone without an owner/repo slug.
            repo: config.subject.repos?.[0] ?? "",
            serve,
            env,
            state: checkpointed,
          },
    participants: [first, second, ...rest],
  };
}
