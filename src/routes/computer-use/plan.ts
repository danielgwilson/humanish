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
import { isHttpUrl, isLoopbackUrl } from "../../study/parse/subject.js";
import { studyUrlCredentialReason } from "../../study/url-credentials.js";
import { subjectStateInvalidReason } from "../../study/parse/subject-state.js";
import {
  brainOf,
  callerBrainOf,
  planCaps,
  desktopRequirements,
  planBase,
  provisionedSubject,
} from "../../study/plan-base.js";
import { computerUseParticipants, declaredTargets } from "../../study/plan-participants.js";
import type {
  AppUrlSubject,
  ComputerUsePlan,
  ComputerUseRunner,
  RoutePlanResult,
  RouteRefusal,
} from "../../study/plan-types.js";
import { MAX_COMPUTER_USE_PARTICIPANTS } from "../../study/routing.js";
import type { StudyConfig, StudySubjectServe, StudySubjectState } from "../../study/types.js";
import {
  cloneTargetValidationReason,
  computerUseValidationReason,
  desktopMediaValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  taskProtocolValidationReason,
} from "../../study/validation.js";
import { desktopCliProductReason } from "../../study/composition-rules.js";
import { isLocalBrowserStudy } from "../../substrates/local/runtime-config.js";
import {
  boundedConcurrency,
  defaultSessionTimeoutMs,
  resolveParticipantSandboxMs,
} from "./participant-runs.js";
import { MAX_SANDBOX_MS } from "../../substrates/e2b/lifetime.js";
import { type ComputerUseRunInput, type CuaActorStudyErrorCode } from "./types.js";
import { actorOf, declaresSharedWorld } from "../../study/study-fields.js";

/** The error a computer-use study returns before a run starts. */
export interface ComputerUseRefusal extends RouteRefusal<"computer-use", CuaActorStudyErrorCode> {
  /**
   * Where the route returns it. "before-scope": analysis and tasks, returned before the run scope
   * with no automatic-analysis record. "in-scope": after the cwd checks. "after-personas": after
   * the route reads committed persona files, so a persona-file error still wins over the participant cap
   * and in-process fan-out.
   */
  readonly stage: "before-scope" | "in-scope" | "after-personas";
  /** The registered actor id, once the registry check has passed. */
  readonly actor?: string;
}

export type ComputerUsePlanResult = RoutePlanResult<ComputerUsePlan, ComputerUseRefusal>;

/** The registered descriptor for a planned actor id; planComputerUseStudy checked the registry. */
export function cuaDescriptorOf(actor: string): CuaActorDescriptor {
  const descriptor = actorRegistry[actor as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor))
    throw new Error(`planned actor "${actor}" is not a registered computer-use actor`);
  return descriptor;
}

/**
 * The subject a study declares, read from its config and the caller's driving for the planner's checks. The checks
 * read the declaration because the planned subject falls back to app-url when a provisioned
 * subject cannot be built, which would hide the declaration a refusal has to name. A planned run
 * reads `plan.runner.subject` instead.
 */
interface DeclaredSubjectRoute {
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
  serve: StudySubjectServe | undefined;
  appUrl: string;
  subjectRepo: string | undefined;
  subjectEnvNames: string[];
}

function declaredSubjectRoute(config: StudyConfig, driving: CallerDriving): DeclaredSubjectRoute {
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
    inProcessRoute: driving.inProcess,
    serve,
    appUrl: (provisionedRoute ? serve?.url : config.subject.appUrl) ?? "",
    subjectRepo: cloneRoute ? (config.subject.repos?.[0] ?? "") : undefined,
    subjectEnvNames: provisionedRoute ? (config.subject.env ?? []) : [],
  };
}

/** Which of the caller's driving homes, createProvider and inProcess, a run has. */
export interface CallerDriving {
  readonly inProcess: boolean;
  readonly createProvider: boolean;
}

/** The driving a computer-use run's options carry. */
export function callerDrivingOf(options: {
  readonly inProcess?: unknown;
  readonly createProvider?: unknown;
}): CallerDriving {
  return {
    inProcess: options.inProcess !== undefined,
    createProvider: options.createProvider !== undefined,
  };
}

/** The state a planned run's provisioned subject declares. Other subjects declare none. */
export function cuaDeclaredState(plan: ComputerUsePlan): StudySubjectState | undefined {
  const { subject } = plan.runner;
  return subject.kind === "clone" || subject.kind === "local-tree" ? subject.state : undefined;
}

/** The URL a refused study's result names, from its declaration: a provisioned subject's serve URL. */
export function declaredAppUrl(config: StudyConfig): string {
  const { subject } = config;
  const provisioned = subject.source === "clone" || subject.source === "local-tree";
  return (provisioned ? subject.serve?.url : subject.appUrl) ?? "";
}

/** The URL a planned run's participants open: a provisioned subject's served URL, else its own. */
export function plannedAppUrl(subject: ComputerUseRunner["subject"]): string {
  if (subject.kind === "clone" || subject.kind === "local-tree") return subject.serve.url;
  return "appUrl" in subject ? subject.appUrl : "";
}

type Rejection = { code: CuaActorStudyErrorCode; message: string } | undefined;

const invalid = (message: string): Rejection => ({
  code: "HUMANISH_COMPUTER_USE_SUBJECT_INVALID",
  message,
});

/**
 * The first reason a computer-use study cannot start, checked before any sandbox, key or provider
 * is touched. The parser enforces most of these too; the engine repeats them for library callers
 * that hand it a config directly. The groups run in this order, and each returns its first reason.
 */
function cuaStudyRejection(
  config: StudyConfig,
  hasRunSession: boolean,
  driving: CallerDriving,
  subjectRoute: DeclaredSubjectRoute,
): Rejection {
  return (
    unsupportedDeclarationReason(config, hasRunSession, driving, subjectRoute) ??
    subjectStructureReason(config, subjectRoute) ??
    entryTargetReason(config, subjectRoute) ??
    driverReason(driving, subjectRoute) ??
    rosterShapeReason(config)
  );
}

/** A declaration this route cannot honor, for any subject or with the caller's own driver. */
function unsupportedDeclarationReason(
  config: StudyConfig,
  hasRunSession: boolean,
  driving: CallerDriving,
  { inProcessRoute }: DeclaredSubjectRoute,
): Rejection {
  const reason = desktopMediaValidationReason(config) || outputTokenLimitValidationReason(config);
  if (reason) return invalid(reason);
  if (
    actorOf(config)?.maxOutputTokens !== undefined &&
    (hasRunSession || driving.createProvider || driving.inProcess)
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
      "execution.desktop.media is not provisioned by a caller-supplied executor. Remove the declaration or use a hosted computer-use browser participant.",
    );
  if (inProcessRoute && config.execution?.desktop?.recording !== undefined)
    return invalid("execution.desktop.recording is not provisioned by a caller-supplied executor.");
  return undefined;
}

/** The subject's own shape: the clone target and repo, the local tree, and declared state. */
function subjectStructureReason(
  config: StudyConfig,
  subjectRoute: DeclaredSubjectRoute,
): Rejection {
  const { cloneRoute, localTreeRoute, provisionedRoute, serve, subjectRepo } = subjectRoute;
  const cloneTargetReason = cloneTargetValidationReason(config);
  if (cloneTargetReason) return invalid(cloneTargetReason);
  if (
    cloneRoute &&
    (!serve || !subjectRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(subjectRepo))
  )
    return invalid(
      !serve
        ? "A clone subject on the computer-use route needs `subject.serve` (start and url): humanish starts the app in the sandbox before the participant opens it."
        : `subject.repos[0] must be an owner/repo slug (got "${subjectRepo ?? ""}").`,
    );
  // A library caller that skips parseStudy gets the same fail-closed shape the parser
  // enforces, naming which requirement is missing.
  if (localTreeRoute && (!serve || config.execution?.target !== "e2b-desktop"))
    return invalid(
      !serve
        ? "local-tree subjects on the computer-use route require `subject.serve` (start + url): humanish packs and serves the working tree in the sandbox."
        : "local-tree subjects require `execution.target: e2b-desktop`: the packed working tree is provisioned and served inside a hosted desktop sandbox.",
    );
  if (config.subject.state) {
    const stateReason = !provisionedRoute
      ? "`subject.state` applies only to clone subjects or local-tree subjects (humanish seeds the state it serves)."
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
function entryTargetReason(config: StudyConfig, subjectRoute: DeclaredSubjectRoute): Rejection {
  const { desktopCliRoute, provisionedRoute, localAppSubject, appUrl } = subjectRoute;
  // A library caller's config skips the parser, which refuses these first.
  const credential = studyUrlCredentialReason(config);
  if (credential) return { code: "HUMANISH_COMPUTER_USE_SUBJECT_UNSAFE", message: credential };
  if (desktopCliRoute) return undefined;
  const allowPublicTargets = config.policies?.allowPublicTargets === true;
  const entryTargets = [appUrl, ...declaredTargets(config)];
  const entryTargetSafe = entryTargets.every((target) =>
    provisionedRoute || localAppSubject
      ? isLoopbackUrl(target)
      : allowPublicTargets
        ? isHttpUrl(target)
        : isLoopbackUrl(target),
  );
  if (entryTargetSafe) return undefined;
  return {
    code: "HUMANISH_COMPUTER_USE_SUBJECT_UNSAFE",
    message:
      provisionedRoute || localAppSubject || !allowPublicTargets
        ? "subject.appUrl and any participants[].target entries must be loopback (127.0.0.1 or localhost) unless policies.allowPublicTargets is set for an app-url subject."
        : "subject.appUrl and participants[].target entries must be valid http(s) URLs.",
  };
}

/** Something to drive the subject: the caller's executor with its provider. */
function driverReason(
  driving: CallerDriving,
  { localAppSubject, inProcessRoute }: DeclaredSubjectRoute,
): Rejection {
  // A custom executor needs a custom provider too: the default OpenAI provider is vision-based
  // and would fail closed against an executor that returns no screenshot.
  if (driving.inProcess && !driving.createProvider)
    return {
      code: "HUMANISH_COMPUTER_USE_EXECUTOR_NO_PROVIDER",
      message:
        "RunStudyOptions.inProcess needs RunStudyOptions.createProvider: an in-process executor returns no screenshot, so it needs a provider that does not read images. The default OpenAI computer-use provider reads screenshots and would stop the session.",
    };
  // There is no built-in in-process driver for a local app.
  if (localAppSubject && !inProcessRoute)
    return {
      code: "HUMANISH_COMPUTER_USE_LOCAL_APP_NO_EXECUTOR",
      message:
        "subject.source: local-app has no built-in driver. Supply one through runStudy(config, { inProcess: { executor }, createProvider }); a state-driven executor needs a non-vision provider.",
    };
  return undefined;
}

/** The participant roster, then the sandbox deadline its session budget derives. */
function rosterShapeReason(config: StudyConfig): Rejection {
  // Device XOR raw resolution, cap, unique ids,
  // allowPublicTargets with more than one participant, clone.fanout.
  const fanoutReason = computerUseValidationReason(config);
  if (fanoutReason) return { code: "HUMANISH_COMPUTER_USE_FANOUT_INVALID", message: fanoutReason };
  // The sandbox deadline is derived from the session budget, so a study can ask for a session that
  // cannot legally be provisioned. Show the arithmetic: the provider's own error names a limit
  // but not which knob produced it.
  const derivedSandboxMs = resolveParticipantSandboxMs(config);
  if (derivedSandboxMs <= MAX_SANDBOX_MS) return undefined;
  const provisionedRoute =
    config.subject.source === "clone" || config.subject.source === "local-tree";
  const sessionMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
  const headroomMs = derivedSandboxMs - sessionMs;
  return invalid(
    `execution.timeoutMs ${Math.round(sessionMs / 60_000)}m derives a ${Math.round(derivedSandboxMs / 60_000)}m sandbox deadline, and a sandbox may not live longer than ${MAX_SANDBOX_MS / 60_000}m. The deadline is the session budget plus ${Math.round(headroomMs / 60_000)}m of provisioning and teardown headroom${provisionedRoute ? " (this route clones, installs, builds and serves the subject before the actor starts)" : ""}. Lower execution.timeoutMs to at most ${Math.round((MAX_SANDBOX_MS - headroomMs) / 60_000)}m, or set execution.desktop.sandboxTimeoutMs explicitly.`,
  );
}

/** The plan's rerun: the source run and, when given, the participants to rerun. */
function rerunPlan({
  sourceRunId,
  participantIds,
}: {
  sourceRunId: string;
  participantIds?: string[];
}) {
  return { sourceRunId, ...(participantIds === undefined ? {} : { participantIds }) };
}

/**
 * Plan a computer-use study. It is called for any config handed to the computer-use runner, not only
 * one routeOf sends here, so a config for another route gets this route's refusal.
 */
export function planComputerUseStudy(
  config: StudyConfig,
  input: {
    readonly dryRun: boolean;
    /** Whether deps.runSession is set: a caller's session runner cannot enforce maxOutputTokens. */
    readonly hasRunSession?: boolean;
    /** Which of the caller's driving homes are set; neither when absent. */
    readonly driving?: CallerDriving;
    readonly countOverride?: number;
    readonly rerun?: ComputerUseRunInput["rerun"];
  },
): ComputerUsePlanResult {
  const hasRunSession = input.hasRunSession === true;
  const driving = input.driving ?? { inProcess: false, createProvider: false };
  const refuse = (
    stage: ComputerUseRefusal["stage"],
    code: CuaActorStudyErrorCode,
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
    return refuse("before-scope", "HUMANISH_STUDY_ANALYSIS_INVALID", analysis.message);
  const tasksReason = taskProtocolValidationReason(config, true);
  if (tasksReason) return refuse("before-scope", "HUMANISH_STUDY_TASKS_UNSUPPORTED", tasksReason);

  // The parser checks the actor too; a library caller skips the parser.
  const actorType = actorOf(config)?.type ?? "";
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor))
    return refuse(
      "in-scope",
      "HUMANISH_COMPUTER_USE_ACTOR_UNSUPPORTED",
      `actor.type "${actorType}" is not a registered computer-use actor.`,
    );
  const actor = descriptor.id;
  const rejection = cuaStudyRejection(
    config,
    hasRunSession,
    driving,
    declaredSubjectRoute(config, driving),
  );
  if (rejection) return refuse("in-scope", rejection.code, rejection.message, actor);
  // A shared world runs every participant against one app; this route would run them as separate
  // participants. It comes after the rules above, so a shared-world config that breaks one of them,
  // which runStudyWith sends here, still gets that rule's message.
  if (declaresSharedWorld(config))
    return refuse(
      "in-scope",
      "HUMANISH_COMPUTER_USE_SUBJECT_INVALID",
      "route: shared-world studies run every participant against one shared app on the shared-world route; this route runs independent participants. The shared-world route takes subject.source clone or local-tree, or app-url with policies.allowPublicTargets: true, on execution.target e2b-desktop.",
      actor,
    );
  // The in-process route drives subject.appUrl on this machine and creates no desktop, so it would
  // skip the subject a clone, local-tree or desktop-cli study declares.
  const source = config.subject.source;
  if (
    driving.inProcess &&
    (source === "clone" || source === "local-tree" || source === "desktop-cli")
  )
    return refuse(
      "in-scope",
      "HUMANISH_COMPUTER_USE_SUBJECT_INVALID",
      `RunStudyOptions.inProcess drives subject.appUrl in this process, and a ${source} subject needs the hosted desktop the in-process route never creates. Use an app-url or local-app subject with inProcess, or remove inProcess to run on a hosted desktop.`,
      actor,
    );
  // The parser's rule; without a product the desktop study fails later.
  const productReason = desktopCliProductReason(config);
  if (productReason)
    return refuse("in-scope", "HUMANISH_COMPUTER_USE_SUBJECT_INVALID", productReason, actor);

  const participants = computerUseParticipants(config, input.countOverride);
  if (participants.length > MAX_COMPUTER_USE_PARTICIPANTS)
    return refuse(
      "after-personas",
      "HUMANISH_COMPUTER_USE_FANOUT_INVALID",
      `Computer-use fan-out is capped at ${MAX_COMPUTER_USE_PARTICIPANTS} participants (resolved ${participants.length}); N concurrent paid desktops is real spend.`,
      actor,
    );
  const [first, ...rest] = participants;
  if (driving.inProcess && rest.length > 0)
    return refuse(
      "after-personas",
      "HUMANISH_COMPUTER_USE_FANOUT_INVALID",
      "Fan-out to more than one participant is not supported on the in-process route (RunStudyOptions.inProcess): fan-out provisions one independent E2B desktop per participant, which the in-process route deliberately skips. Run a single in-process participant, or fan out on the E2B route.",
      actor,
    );
  if (first === undefined) throw new Error("computerUseParticipants returned no participant");

  const appUrl = config.subject.appUrl ?? "";
  const declaredServeUrl = config.subject.serve?.url;
  const serveUrl = declaredServeUrl === undefined ? {} : { serveUrl: declaredServeUrl };
  const appUrlSubject: AppUrlSubject = {
    kind: "app-url",
    appUrl,
    publicTargets: config.policies?.allowPublicTargets === true,
    ...serveUrl,
  };
  const product = config.subject.product;
  const hosted =
    source === "desktop-cli" && product !== undefined
      ? ({ kind: "desktop-cli", product, ...serveUrl } as const)
      : (provisionedSubject(config) ?? appUrlSubject);
  const brain = brainOf(config, driving.createProvider);
  const runner: ComputerUseRunner = driving.inProcess
    ? {
        desktop: "in-process",
        brain: callerBrainOf(config),
        participants: [first],
        subject: source === "local-app" ? { kind: "local-app", appUrl } : appUrlSubject,
      }
    : isLocalBrowserStudy(config)
      ? { desktop: "local-vm", brain, participants: [first, ...rest], subject: appUrlSubject }
      : { desktop: "e2b-desktop", brain, participants: [first, ...rest], subject: hosted };
  const declared = config.execution?.concurrency;
  const n = participants.length;
  const provisioned = source === "clone" || source === "local-tree";
  const base = planBase(config, {
    dryRun: input.dryRun,
    analysis,
  });
  return {
    ok: true,
    plan: {
      ...base,
      route: "computer-use",
      actor,
      runner,
      concurrency: boundedConcurrency(declared, n),
      sessionBudgetMs: config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config),
      sandboxMs: resolveParticipantSandboxMs(config),
      caps: planCaps(config),
      ...(input.rerun === undefined ? {} : { rerun: rerunPlan(input.rerun) }),
      requirements:
        base.dryRun || runner.desktop === "in-process"
          ? []
          : desktopRequirements(config, {
              e2b: runner.desktop === "e2b-desktop",
              brain,
              localVm: runner.desktop === "local-vm",
              externalCatch: !provisioned,
            }),
    },
  };
}
