// The computer-use route's plan: every configuration refusal the route makes before a run starts,
// in its order and with its codes, then the plan the run uses. What stays in the route reads
// external state: committed personas, a rerun's source run, keys, the local agent, subject env
// values, spend-cap prices and the comms catch.

import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import {
  actorRegistry,
  isCuaActorDescriptor,
  type CuaActorDescriptor,
} from "../../actors/registry.js";
import { isHttpUrl, isLoopbackUrl } from "../../lab/parse/subject.js";
import { subjectStateInvalidReason } from "../../lab/parse/subject-state.js";
import {
  brainOf,
  capsOf,
  desktopRequirements,
  planBase,
  provisionedSubject,
} from "../../lab/plan-base.js";
import { computerUseParticipants } from "../../lab/plan-participants.js";
import type { AppUrlSubject, ComputerUsePlan, ComputerUseRunner } from "../../lab/plan-types.js";
import { MAX_CUA_LANES } from "../../lab/routing.js";
import type { LabConfig, LabSubjectServe, LabSubjectState } from "../../lab/types.js";
import {
  cloneTargetValidationReason,
  cuaLaneValidationReason,
  desktopMediaValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  scenarioCapsValidationReason,
  taskProtocolValidationReason,
} from "../../lab/validation.js";
import type { RunLabProvenance } from "../../run/status.js";
import { isLocalBrowserLab } from "../../substrates/local/runtime-config.js";
import { defaultSessionTimeoutMs, resolvePerLaneSandboxMs } from "./lane-plan.js";
import {
  MAX_SANDBOX_MS,
  type CuaActorLabErrorCode,
  type CuaActorLabHooks,
  type RunCuaActorLabOptions,
} from "./types.js";

/** The error a computer-use lab returns before a run starts. */
export interface ComputerUseRefusal {
  readonly route: "computer-use";
  readonly code: CuaActorLabErrorCode;
  readonly message: string;
  /**
   * Where the route returns it. "before-scope": analysis and tasks, returned before the run scope
   * with no automatic-analysis record. "in-scope": after the cwd checks. "after-personas": after
   * the route reads committed persona files, so a persona-file error still wins over the lane cap
   * and in-process fan-out.
   */
  readonly stage: "before-scope" | "in-scope" | "after-personas";
  /** The registered actor id, once the registry check has passed. */
  readonly actor?: string;
}

export type ComputerUsePlanResult =
  | { readonly ok: true; readonly plan: ComputerUsePlan }
  | { readonly ok: false; readonly refusal: ComputerUseRefusal };

/** The registered descriptor for a planned actor id; planComputerUseLab checked the registry. */
export function cuaDescriptorOf(actor: string): CuaActorDescriptor {
  const descriptor = actorRegistry[actor as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor))
    throw new Error(`planned actor "${actor}" is not a registered computer-use actor`);
  return descriptor;
}

/** Which subject route a computer-use lab takes, derived once from its config and hooks. */
export interface CuaRoute {
  cloneRoute: boolean;
  /** A CLI studied at a desktop: nothing cloned, no browser, a terminal instead. */
  desktopCliRoute: boolean;
  localTreeRoute: boolean;
  /**
   * Clone and local-tree both provision the subject in-sandbox (clone via git, local-tree via
   * pack+upload) and share the install/build/state/start/probe pipeline, so every seam that gates
   * on "does this route provision a subject" is keyed on this union.
   */
  provisionedRoute: boolean;
  localAppSubject: boolean;
  /** A caller-supplied executor drives the subject in-process; no desktop is created. */
  inProcessRoute: boolean;
  serve: LabSubjectServe | undefined;
  appUrl: string;
  subjectRepo: string | undefined;
  subjectEnvNames: string[];
}

export function cuaRoute(config: LabConfig, hooks: CuaActorLabHooks): CuaRoute {
  const cloneRoute = config.subject.source === "clone";
  const localTreeRoute = config.subject.source === "local-tree";
  const provisionedRoute = cloneRoute || localTreeRoute;
  const serve = config.subject.serve;
  return {
    cloneRoute,
    desktopCliRoute: config.subject.source === "desktop-cli",
    localTreeRoute,
    provisionedRoute,
    localAppSubject: config.subject.source === "local-app",
    inProcessRoute: hooks.buildExecutor !== undefined,
    serve,
    appUrl: (provisionedRoute ? serve?.url : config.subject.appUrl) ?? "",
    subjectRepo: cloneRoute ? (config.subject.repos?.[0] ?? "") : undefined,
    subjectEnvNames: provisionedRoute ? (config.subject.env ?? []) : [],
  };
}

/** The state a planned run's provisioned subject declares. Other subjects declare none. */
export function cuaDeclaredState(plan: ComputerUsePlan): LabSubjectState | undefined {
  const { subject } = plan.runner;
  return subject.kind === "clone" || subject.kind === "local-tree" ? subject.state : undefined;
}

/** The route facts a planned run takes: its runner's desktop and subject. */
export function cuaRouteOf(plan: ComputerUsePlan): CuaRoute {
  const { desktop, subject } = plan.runner;
  const provisioned =
    subject.kind === "clone" || subject.kind === "local-tree" ? subject : undefined;
  return {
    cloneRoute: subject.kind === "clone",
    desktopCliRoute: subject.kind === "desktop-cli",
    localTreeRoute: subject.kind === "local-tree",
    provisionedRoute: provisioned !== undefined,
    localAppSubject: subject.kind === "local-app",
    inProcessRoute: desktop === "in-process",
    serve: provisioned?.serve,
    appUrl: provisioned?.serve.url ?? ("appUrl" in subject ? subject.appUrl : ""),
    subjectRepo: subject.kind === "clone" ? subject.repo : undefined,
    subjectEnvNames: [...(provisioned?.env ?? [])],
  };
}

type Rejection = { code: CuaActorLabErrorCode; message: string } | undefined;

const invalid = (message: string): Rejection => ({
  code: "HUMANISH_CUA_LAB_SUBJECT_INVALID",
  message,
});

/**
 * The first reason a computer-use lab cannot start, checked before any sandbox, key or provider
 * is touched. The parser enforces most of these too; the engine repeats them for library callers
 * that hand it a config directly. The groups run in this order, and each returns its first reason.
 */
function cuaLabRejection(config: LabConfig, hooks: CuaActorLabHooks, route: CuaRoute): Rejection {
  return (
    unsupportedDeclarationReason(config, hooks, route) ??
    subjectStructureReason(config, route) ??
    entryTargetReason(config, route) ??
    driverReason(config, hooks, route) ??
    laneShapeReason(config)
  );
}

/** A declaration this route cannot honor, for any subject or with the caller's own driver. */
function unsupportedDeclarationReason(
  config: LabConfig,
  hooks: CuaActorLabHooks,
  { inProcessRoute }: CuaRoute,
): Rejection {
  const reason =
    desktopMediaValidationReason(config) ||
    outputTokenLimitValidationReason(config) ||
    scenarioCapsValidationReason(config);
  if (reason) return invalid(reason);
  if (
    config.actors[0]?.maxOutputTokens !== undefined &&
    (hooks.runSession || hooks.buildProvider || hooks.buildExecutor)
  )
    return invalid(
      "maxOutputTokens cannot be enforced by a custom runSession/provider/executor route.",
    );
  const receivingReason = receivingEmailValidationReason(config);
  if (receivingReason) return invalid(receivingReason);
  if (inProcessRoute && config.comms?.email?.kind === "real")
    return invalid("Real email receiving requires hosted participant desktops.");
  if (inProcessRoute && config.execution?.desktop?.media !== undefined)
    return invalid(
      "execution.desktop.media is not provisioned by a caller-supplied executor. Remove the declaration or use a hosted computer-use browser lane.",
    );
  if (inProcessRoute && config.execution?.desktop?.recording !== undefined)
    return invalid("execution.desktop.recording is not provisioned by a caller-supplied executor.");
  return undefined;
}

/** The subject's own shape: the clone target and repo, the local tree, and declared state. */
function subjectStructureReason(config: LabConfig, route: CuaRoute): Rejection {
  const { cloneRoute, localTreeRoute, provisionedRoute, serve, subjectRepo } = route;
  const cloneTargetReason = cloneTargetValidationReason(config);
  if (cloneTargetReason) return invalid(cloneTargetReason);
  if (
    cloneRoute &&
    (!serve || !subjectRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(subjectRepo))
  )
    return invalid(
      !serve
        ? "clone subjects on the computer-use route require `subject.serve` (start + url) — the lab serves the app in-sandbox."
        : `subject.repos[0] must be an owner/repo slug (got "${subjectRepo ?? ""}").`,
    );
  // A library caller that skips parseLabConfig gets the same fail-closed shape the parser
  // enforces, naming which requirement is missing.
  if (localTreeRoute && (!serve || config.execution?.target !== "e2b-desktop"))
    return invalid(
      !serve
        ? "local-tree subjects on the computer-use route require `subject.serve` (start + url): the lab packs and serves the working tree in-sandbox."
        : "local-tree subjects require `execution.target: e2b-desktop`: the packed working tree is provisioned and served inside a hosted desktop sandbox.",
    );
  if (config.subject.state) {
    const stateReason = !provisionedRoute
      ? "`subject.state` applies only to clone subjects or local-tree subjects (the lab seeds the state it serves)."
      : subjectStateInvalidReason(config.subject.state, config.subject.env);
    if (stateReason) return invalid(stateReason);
  }
  return undefined;
}

/**
 * Every URL a participant opens is loopback, unless an app-url subject allows public targets. A
 * desktop-cli study has no entry target at all (the subject is a program on the machine, not an
 * address), so the boundary is vacuous there rather than violated by an empty string.
 */
function entryTargetReason(config: LabConfig, route: CuaRoute): Rejection {
  const { desktopCliRoute, provisionedRoute, localAppSubject, appUrl } = route;
  if (desktopCliRoute) return undefined;
  const allowPublicTargets = config.policies?.allowPublicTargets === true;
  const declaredTargets = [
    appUrl,
    ...(config.actors[0]?.lanes ?? [])
      .map((lane) => lane.target)
      .filter((target): target is string => target !== undefined),
  ];
  const entryTargetSafe = declaredTargets.every((target) =>
    provisionedRoute || localAppSubject
      ? isLoopbackUrl(target)
      : allowPublicTargets
        ? isHttpUrl(target)
        : isLoopbackUrl(target),
  );
  if (entryTargetSafe) return undefined;
  return {
    code: "HUMANISH_CUA_LAB_SUBJECT_UNSAFE",
    message:
      provisionedRoute || localAppSubject || !allowPublicTargets
        ? "subject.appUrl and any actors[0].lanes[].target entries must be loopback (127.0.0.1 or localhost) unless policies.allowPublicTargets is set for an app-url subject."
        : "subject.appUrl and actors[0].lanes[].target entries must be valid http(s) URLs.",
  };
}

/** Something to drive the subject: the caller's executor with its provider, or a local desktop. */
function driverReason(
  config: LabConfig,
  hooks: CuaActorLabHooks,
  { localAppSubject, inProcessRoute }: CuaRoute,
): Rejection {
  // A custom executor needs a custom provider too: the default OpenAI provider is vision-based
  // and would fail closed against an executor that returns no screenshot.
  if (hooks.buildExecutor !== undefined && hooks.buildProvider === undefined)
    return {
      code: "HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER",
      message:
        "cuaHooks.buildExecutor requires cuaHooks.buildProvider — a state-driven executor returns no screenshot, so it must be paired with a NON-vision provider (the default OpenAI computer-use provider is vision-based and would fail closed).",
    };
  // There is no built-in in-process driver for a local app.
  if (localAppSubject && !inProcessRoute)
    return {
      code: "HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR",
      message:
        "subject.source: local-app has no built-in driver. Supply one through runLab(config, { inProcess: { executor }, createProvider }); a state-driven executor needs a non-vision provider.",
    };
  // runLab gives a local browser study its desktop lane; a direct route call or an in-process
  // executor on the same lab has none.
  if (
    config.subject.source === "app-url" &&
    config.execution?.target === "local" &&
    !hooks.createDesktopLane
  )
    return {
      code: "HUMANISH_CUA_LAB_LOCAL_DESKTOP_MISSING",
      message:
        "An app-url lab with execution.target: local needs a local desktop. runLab starts one; a direct route call or an in-process executor does not.",
    };
  return undefined;
}

/** The lane roster, then the sandbox deadline its session budget derives. */
function laneShapeReason(config: LabConfig): Rejection {
  // Lanes XOR count/laneFocus, device XOR raw resolution, cap, unique ids,
  // allowPublicTargets with more than one lane, clone.fanout.
  const fanoutReason = cuaLaneValidationReason(config);
  if (fanoutReason) return { code: "HUMANISH_CUA_LAB_FANOUT_INVALID", message: fanoutReason };
  // The sandbox deadline is derived from the session budget, so a lab can ask for a session that
  // cannot legally be provisioned. Show the arithmetic: the provider's own error names a limit
  // but not which knob produced it.
  const derivedSandboxMs = resolvePerLaneSandboxMs(config);
  if (derivedSandboxMs <= MAX_SANDBOX_MS) return undefined;
  const provisionedRoute =
    config.subject.source === "clone" || config.subject.source === "local-tree";
  const sessionMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
  const headroomMs = derivedSandboxMs - sessionMs;
  return invalid(
    `execution.timeoutMs ${Math.round(sessionMs / 60_000)}m derives a ${Math.round(derivedSandboxMs / 60_000)}m sandbox deadline, and a sandbox may not live longer than ${MAX_SANDBOX_MS / 60_000}m. The deadline is the session budget plus ${Math.round(headroomMs / 60_000)}m of provisioning and teardown headroom${provisionedRoute ? " (this route clones, installs, builds and serves the subject before the actor starts)" : ""}. Lower execution.timeoutMs to at most ${Math.round((MAX_SANDBOX_MS - headroomMs) / 60_000)}m, or set execution.desktop.sandboxTimeoutMs explicitly.`,
  );
}

/**
 * Plan a computer-use lab. It is called for any config handed to the computer-use runner, not only
 * one routeOf sends here, so a config for another route gets this route's refusal.
 */
export function planComputerUseLab(
  config: LabConfig,
  input: {
    readonly dryRun: boolean;
    readonly lab?: RunLabProvenance;
    readonly hooks?: CuaActorLabHooks;
    readonly countOverride?: number;
    readonly rerun?: RunCuaActorLabOptions["rerun"];
  },
): ComputerUsePlanResult {
  const hooks = input.hooks ?? {};
  const refuse = (
    stage: ComputerUseRefusal["stage"],
    code: CuaActorLabErrorCode,
    message: string,
    actor?: string,
  ): ComputerUsePlanResult => ({
    ok: false,
    refusal: {
      route: "computer-use",
      code,
      message,
      stage,
      ...(actor === undefined ? {} : { actor }),
    },
  });

  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  if (!analysis.ok)
    return refuse("before-scope", "HUMANISH_LAB_ANALYSIS_INVALID", analysis.message);
  const tasksReason = taskProtocolValidationReason(config, true);
  if (tasksReason) return refuse("before-scope", "HUMANISH_LAB_TASKS_UNSUPPORTED", tasksReason);

  // The parser checks the actor too; a library caller skips the parser.
  const actorType = config.actors[0]?.type ?? "";
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor))
    return refuse(
      "in-scope",
      "HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered computer-use actor.`,
    );
  const actor = descriptor.id;
  const rejection = cuaLabRejection(config, hooks, cuaRoute(config, hooks));
  if (rejection) return refuse("in-scope", rejection.code, rejection.message, actor);
  // A shared world runs every seat against one app; this route would run them as separate lanes.
  // It comes after the rules above, so a shared-world config that breaks one of them, which runLab
  // sends here, still gets that rule's message.
  if (config.subject.topology === "shared-world")
    return refuse(
      "in-scope",
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      "subject.topology: shared-world labs run every seat against one shared app on the shared-world route; runCuaActorLab runs independent lanes. Run the lab with runLab or runConcurrentSharedWorld.",
      actor,
    );
  // The in-process route drives subject.appUrl on this machine and creates no desktop, so it would
  // skip the subject a clone, local-tree or desktop-cli lab declares.
  const source = config.subject.source;
  if (
    hooks.buildExecutor !== undefined &&
    (source === "clone" || source === "local-tree" || source === "desktop-cli")
  )
    return refuse(
      "in-scope",
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      `cuaHooks.buildExecutor drives subject.appUrl in this process, and a ${source} subject needs the hosted desktop the in-process route never creates. Use an app-url or local-app subject with buildExecutor, or remove buildExecutor to run on a hosted desktop.`,
      actor,
    );
  // The parser refuses this too; without a product the desktop study fails later.
  if (source === "desktop-cli" && config.subject.product?.name === undefined)
    return refuse(
      "in-scope",
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      "desktop-cli subjects need `subject.product.name` — the CLI the participant is being asked to use.",
      actor,
    );

  const participants = computerUseParticipants(config, input.countOverride);
  if (participants.length > MAX_CUA_LANES)
    return refuse(
      "after-personas",
      "HUMANISH_CUA_LAB_FANOUT_INVALID",
      `Computer-use fan-out is capped at ${MAX_CUA_LANES} lanes (resolved ${participants.length}); N concurrent paid desktops is real spend.`,
      actor,
    );
  const [first, ...rest] = participants;
  if (hooks.buildExecutor !== undefined && rest.length > 0)
    return refuse(
      "after-personas",
      "HUMANISH_CUA_LAB_FANOUT_INVALID",
      "Multi-lane fan-out is not supported on the in-process route (cuaHooks.buildExecutor) — fan-out provisions one independent E2B desktop per lane, which the in-process route deliberately skips. Run a single in-process lane, or fan out on the E2B route.",
      actor,
    );
  if (first === undefined) throw new Error("computerUseParticipants returned no participant");

  const appUrl = config.subject.appUrl ?? "";
  const appUrlSubject: AppUrlSubject = {
    kind: "app-url",
    appUrl,
    publicTargets: config.policies?.allowPublicTargets === true,
  };
  const product = config.subject.product;
  const hosted =
    source === "desktop-cli" && product !== undefined
      ? ({ kind: "desktop-cli", product } as const)
      : (provisionedSubject(config) ?? appUrlSubject);
  const brain = brainOf(config, hooks.buildProvider !== undefined);
  const runner: ComputerUseRunner =
    hooks.buildExecutor !== undefined
      ? {
          desktop: "in-process",
          brain: { kind: "caller" },
          participants: [first],
          subject: source === "local-app" ? { kind: "local-app", appUrl } : appUrlSubject,
        }
      : isLocalBrowserLab(config)
        ? { desktop: "local-vm", brain, participants: [first, ...rest], subject: appUrlSubject }
        : { desktop: "e2b-desktop", brain, participants: [first, ...rest], subject: hosted };
  const declared = config.execution?.concurrency;
  const n = participants.length;
  const provisioned = source === "clone" || source === "local-tree";
  const base = planBase(config, {
    dryRun: input.dryRun,
    ...(input.lab === undefined ? {} : { lab: input.lab }),
    analysis,
  });
  return {
    ok: true,
    plan: {
      ...base,
      route: "computer-use",
      actor,
      runner,
      concurrency: Math.max(1, declared === undefined ? n : Math.min(Math.max(1, declared), n)),
      sessionBudgetMs: config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config),
      sandboxMs: resolvePerLaneSandboxMs(config),
      caps: capsOf(config),
      ...(input.rerun === undefined
        ? {}
        : {
            rerun: {
              sourceRunId: input.rerun.sourceRunId,
              ...(input.rerun.laneIds === undefined ? {} : { participantIds: input.rerun.laneIds }),
            },
          }),
      requirements:
        base.dryRun || runner.desktop === "in-process"
          ? []
          : desktopRequirements(config, {
              e2b: runner.desktop === "e2b-desktop" && hooks.createDesktopLane === undefined,
              brain,
              localVm: runner.desktop === "local-vm",
              externalCatch: !provisioned,
            }),
    },
  };
}
