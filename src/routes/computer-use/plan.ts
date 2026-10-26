// The computer-use route's plan: every configuration refusal the route makes before a run starts,
// in its order and with its codes, then the plan the run uses. What stays in the route reads
// external state: committed personas, a rerun's source run, keys, the local agent, subject env
// values, spend-cap prices and the comms catch.

import type { SandboxProviderId } from "../../run/sandbox-receipts.js";
import { MODAL_MAX_SANDBOX_MS } from "../../substrates/modal/sdk.js";
import { DESKTOP_FILES_ROUTE_REASON } from "../../study/desktop-files.js";
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
import {
  type ComputerUseParticipant,
  computerUseParticipants,
  declaredTargets,
} from "../../study/plan-participants.js";
import { planStarts, windowDeadlineRefusal } from "../../study/arrivals.js";
import type {
  AppUrlSubject,
  ComputerUsePlan,
  ComputerUseRunner,
  RoutePlanResult,
  RouteRefusal,
} from "../../study/plan-types.js";
import { computerUseParticipantCount, participantCountReason } from "../../study/routing.js";
import type { StudyConfig, StudySubjectServe, StudySubjectState } from "../../study/types.js";
import {
  cloneTargetValidationReason,
  computerUseValidationReason,
  desktopMediaValidationReason,
  networkCaptureValidationReason,
  outputTokenLimitValidationReason,
  participantModelValidationReason,
  serviceTierValidationReason,
  receivingEmailValidationReason,
  taskProtocolValidationReason,
  waitLimitValidationReason,
} from "../../study/validation.js";
import { desktopCliProductReason } from "../../study/composition-rules.js";
import { isLocalBrowserStudy } from "../../substrates/local/runtime-config.js";
import {
  boundedConcurrency,
  defaultSessionTimeoutMs,
  resolveParticipantSandboxMs,
} from "./participant-runs.js";
import {
  ceilingAdvice,
  participantsAtOnce,
  type ConcurrentSandboxes,
  type SandboxCeiling,
} from "../../substrates/e2b/lifetime.js";
import { type ComputerUseRunInput, type CuaActorStudyErrorCode } from "./types.js";

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
  ceilingMs: number,
): Rejection {
  return (
    unsupportedDeclarationReason(config, hasRunSession, driving, subjectRoute) ??
    subjectStructureReason(config, subjectRoute) ??
    entryTargetReason(config, subjectRoute) ??
    driverReason(driving, subjectRoute) ??
    rosterShapeReason(config, ceilingMs)
  );
}

/** A declaration this route cannot honor, for any subject or with the caller's own driver. */
function unsupportedDeclarationReason(
  config: StudyConfig,
  hasRunSession: boolean,
  driving: CallerDriving,
  { inProcessRoute }: DeclaredSubjectRoute,
): Rejection {
  const reason =
    desktopMediaValidationReason(config) ||
    networkCaptureValidationReason(config, "computer-use") ||
    // A caller's own provider runs whatever model it runs, so only a study's API participant is
    // resolved against the participant model table.
    (driving.createProvider || driving.inProcess
      ? null
      : participantModelValidationReason(config)) ||
    outputTokenLimitValidationReason(config) ||
    serviceTierValidationReason(config) ||
    waitLimitValidationReason(config);
  if (reason) return invalid(reason);
  if (
    config.actor?.maxOutputTokens !== undefined &&
    (hasRunSession || driving.createProvider || driving.inProcess)
  )
    return invalid(
      "maxOutputTokens cannot be enforced by a custom runSession/provider/executor route.",
    );
  if (
    config.actor?.serviceTier !== undefined &&
    (hasRunSession || driving.createProvider || driving.inProcess)
  )
    return invalid("serviceTier is not sent by a custom runSession/provider/executor route.");
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
  // A custom executor needs a custom provider too: every API participant's provider reads
  // screenshots and would fail closed against an executor that returns none.
  if (driving.inProcess && !driving.createProvider)
    return {
      code: "HUMANISH_COMPUTER_USE_EXECUTOR_NO_PROVIDER",
      message:
        "RunStudyOptions.inProcess needs RunStudyOptions.createProvider: an in-process executor returns no screenshot, so it needs a provider that does not read images. The API computer-use providers read screenshots and would stop the session.",
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
function rosterShapeReason(config: StudyConfig, ceilingMs: number): Rejection {
  // Device XOR raw resolution, cap, unique ids,
  // allowPublicTargets with more than one participant, clone.fanout.
  const fanoutReason = computerUseValidationReason(config);
  if (fanoutReason) return { code: "HUMANISH_COMPUTER_USE_FANOUT_INVALID", message: fanoutReason };
  // The sandbox deadline is derived from the session budget, so a study can ask for a session that
  // cannot legally be provisioned. Show the arithmetic: the provider's own error names a limit
  // but not which knob produced it.
  const derivedSandboxMs = resolveParticipantSandboxMs(config, ceilingMs);
  if (derivedSandboxMs <= ceilingMs) return undefined;
  const provisionedRoute =
    config.subject.source === "clone" || config.subject.source === "local-tree";
  const sessionMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config, ceilingMs);
  const headroomMs = derivedSandboxMs - sessionMs;
  return invalid(
    `execution.timeoutMs ${Math.round(sessionMs / 60_000)}m derives a ${Math.round(derivedSandboxMs / 60_000)}m sandbox deadline, and a sandbox may not live longer than ${ceilingMs / 60_000}m. The deadline is the session budget plus ${Math.round(headroomMs / 60_000)}m of provisioning and teardown headroom${provisionedRoute ? " (this route clones, installs, builds and serves the subject before the actor starts)" : ""}. Lower execution.timeoutMs to at most ${Math.round((ceilingMs - headroomMs) / 60_000)}m, or set execution.desktop.sandboxTimeoutMs explicitly.${ceilingAdvice(derivedSandboxMs)}`,
  );
}

/**
 * How many of the runner's participants run at once, and when each one starts, with the session
 * budget the `ceilingMs` sandbox ceiling leaves. Hosted desktops share the E2B plan's concurrent
 * sandboxes; the local VM has its own capacity rules and the in-process route runs one
 * participant. HUMANISH_CUA_MAX_CONCURRENCY (`concurrencyCap`) lowers the count on every desktop.
 * `starts` holds the plan's fields for them.
 */
function startsOf(
  config: StudyConfig,
  runner: ComputerUseRunner,
  limits: {
    readonly concurrentSandboxes: ConcurrentSandboxes;
    readonly concurrencyCap?: number | undefined;
  },
  ceilingMs: number,
):
  | {
      ok: true;
      starts: Pick<
        ComputerUsePlan,
        "concurrency" | "envLoweredConcurrencyFrom" | "arrivals" | "sessionBudgetMs"
      >;
      warnings: string[];
    }
  | { ok: false; message: string } {
  const declared = config.execution?.concurrency;
  const n = runner.participants.length;
  const hosted = runner.desktop === "e2b-desktop";
  // The E2B plan's limit binds only E2B desktops; Modal's container limit is far above a study's.
  const e2bHosted = hosted && runner.provider === "e2b";
  const atOnce = participantsAtOnce(
    {
      concurrency: boundedConcurrency(declared, n),
      declared: declared !== undefined,
      participants: n,
    },
    {
      ...(e2bHosted ? { sandboxes: limits.concurrentSandboxes } : {}),
      cap: limits.concurrencyCap,
    },
  );
  if (!atOnce.ok) return atOnce;
  const sessionMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config, ceilingMs);
  // A participant with a declared end gets a sandbox sized from its own window.
  if (hosted) {
    const sandboxMs = resolveParticipantSandboxMs(config, ceilingMs);
    const window = windowDeadlineRefusal(runner.participants, { sessionMs, sandboxMs }, ceilingMs);
    if (window !== undefined) return { ok: false, message: window };
  }
  const { arrivals, warnings } = planStarts(
    runner.participants,
    { slots: atOnce.count, sessionMs },
    atOnce.lowered,
  );
  const lowered = atOnce.loweredFrom;
  return {
    ok: true,
    starts: {
      concurrency: atOnce.count,
      ...(lowered === undefined ? {} : { envLoweredConcurrencyFrom: lowered }),
      arrivals,
      sessionBudgetMs: sessionMs,
    },
    warnings,
  };
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
 * Why participants[].files cannot run on this runner, or undefined. The parser refuses them off the
 * hosted desktop; a library caller's config skips the parser, and only the hosted desktop copies
 * files.
 */
function desktopFilesRunnerReason(
  desktop: ComputerUseRunner["desktop"],
  participants: readonly ComputerUseParticipant[],
): string | undefined {
  if (desktop === "e2b-desktop" || participants.every((entry) => entry.files === undefined))
    return undefined;
  return `participants[].files: ${DESKTOP_FILES_ROUTE_REASON}. This study runs on a ${desktop} desktop; remove the files or set execution.target: e2b-desktop.`;
}

/**
 * Why a participant's time zone cannot run on this runner, or undefined. The zone also sets the
 * zone its browser runs in, which humanish sets on a hosted desktop's browser launch only: the
 * local runtime's guest browser and an in-process caller's browser keep their own.
 */
function timeZoneRunnerReason(
  desktop: ComputerUseRunner["desktop"],
  participants: readonly ComputerUseParticipant[],
): string | undefined {
  const zoned = participants.find((entry) => entry.limits.timeZone !== undefined);
  if (desktop === "e2b-desktop" || zoned === undefined) return undefined;
  const declared = `Participant ${zoned.id} has the time zone ${zoned.limits.timeZone}, which sets the zone its browser runs in, and humanish sets a browser's zone only on a hosted desktop.`;
  return desktop === "local-vm"
    ? `${declared} This study runs on the local browser runtime. Remove actor.clock and participants[].clock, or set execution.target: e2b-desktop.`
    : `${declared} This study drives your own browser through RunStudyOptions.inProcess. Remove actor.clock and participants[].clock, and set the zone in that browser yourself, or run on a hosted desktop.`;
}

/** Who hosts the study's desktops and the longest sandbox they allow, or why it cannot run. */
function hostingOf(
  config: StudyConfig,
  e2bCeiling: SandboxCeiling,
): { provider: SandboxProviderId; ceiling: { ms: number } } | { refusal: string } {
  if (config.execution?.target !== "modal-desktop")
    return e2bCeiling.ok
      ? { provider: "e2b", ceiling: e2bCeiling }
      : { refusal: e2bCeiling.message };
  const refusal = modalDesktopRefusal(config);
  return refusal === undefined
    ? { provider: "modal", ceiling: { ms: MODAL_MAX_SANDBOX_MS } }
    : { refusal };
}

/** The app-url subject the study names, and the subject a hosted desktop provisions. */
function subjectsOf(config: StudyConfig) {
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
    config.subject.source === "desktop-cli" && product !== undefined
      ? ({ kind: "desktop-cli", product, ...serveUrl } as const)
      : (provisionedSubject(config) ?? appUrlSubject);
  return { appUrl, appUrlSubject, hosted };
}

/**
 * What a study on a Modal desktop cannot have that one on an E2B desktop can, or undefined. The
 * Modal desktop runs an app-url subject in Chromium; provisioned subjects, a terminal subject,
 * E2B templates and the speech template are E2B's.
 */
function modalDesktopRefusal(config: StudyConfig): string | undefined {
  const desktop = config.execution?.desktop;
  if (config.subject.source !== "app-url")
    return `A Modal desktop runs app-url subjects only, and this study's subject is ${config.subject.source}. Set execution.target: e2b-desktop.`;
  if (config.route === "shared-world")
    return "A shared-world study runs on E2B desktops only. Set execution.target: e2b-desktop.";
  if (desktop?.template !== undefined)
    return "execution.desktop.template names an E2B template, which a Modal desktop cannot use. Remove it, or set execution.target: e2b-desktop.";
  if (desktop?.media !== undefined)
    return "execution.desktop.media needs the E2B speech or camera template, which a Modal desktop does not have. Remove it, or set execution.target: e2b-desktop.";
  const browser = desktop?.browser;
  if (browser !== undefined && browser !== "default" && browser !== "chromium")
    return `A Modal desktop has Chromium only, and execution.desktop.browser is ${browser}. Set it to chromium or default, or set execution.target: e2b-desktop.`;
  return undefined;
}

/** What the participants declare that this runner cannot do, with its code, or undefined. */
function runnerRefusal(
  desktop: ComputerUseRunner["desktop"],
  participants: readonly ComputerUseParticipant[],
): { code: CuaActorStudyErrorCode; message: string } | undefined {
  const files = desktopFilesRunnerReason(desktop, participants);
  if (files) return { code: "HUMANISH_COMPUTER_USE_DESKTOP_FILES_INVALID", message: files };
  const timeZone = timeZoneRunnerReason(desktop, participants);
  if (timeZone) return { code: "HUMANISH_COMPUTER_USE_TIME_ZONE_UNSUPPORTED", message: timeZone };
  return undefined;
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
    /** The longest sandbox lifetime the operator's E2B plan allows (sandboxCeiling). */
    readonly sandboxCeiling: SandboxCeiling;
    /** How many sandboxes the operator's E2B plan runs at once (concurrentSandboxes). */
    readonly concurrentSandboxes: ConcurrentSandboxes;
    /** HUMANISH_CUA_MAX_CONCURRENCY (concurrencyCap), which may only lower the participants at once. */
    readonly concurrencyCap?: number | undefined;
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

  const analysis = resolveAutomaticAnalysis(config.review?.analysis, config.actor);
  if (!analysis.ok)
    return refuse("before-scope", "HUMANISH_STUDY_ANALYSIS_INVALID", analysis.message);
  const tasksReason = taskProtocolValidationReason(config, true);
  if (tasksReason) return refuse("before-scope", "HUMANISH_STUDY_TASKS_UNSUPPORTED", tasksReason);

  // The parser checks the actor too; a library caller skips the parser.
  const actorType = config.actor?.type ?? "";
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor))
    return refuse(
      "in-scope",
      "HUMANISH_COMPUTER_USE_ACTOR_UNSUPPORTED",
      `actor.type "${actorType}" is not a registered computer-use actor.`,
    );
  const actor = descriptor.id;
  const hosting = hostingOf(config, input.sandboxCeiling);
  if ("refusal" in hosting)
    return refuse("in-scope", "HUMANISH_COMPUTER_USE_SUBJECT_INVALID", hosting.refusal, actor);
  const { provider, ceiling } = hosting;
  const rejection = cuaStudyRejection(
    config,
    hasRunSession,
    driving,
    declaredSubjectRoute(config, driving),
    ceiling.ms,
  );
  if (rejection) return refuse("in-scope", rejection.code, rejection.message, actor);
  // A shared world runs every participant against one app; this route would run them as separate
  // participants. It comes after the rules above, so a shared-world config that breaks one of them,
  // which runStudyWith sends here, still gets that rule's message.
  if (config.route === "shared-world")
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

  // Counted before any participant is built, so a large --count is refused without building it.
  const countReason = participantCountReason(
    computerUseParticipantCount(config, input.countOverride),
  );
  if (countReason)
    return refuse("after-personas", "HUMANISH_COMPUTER_USE_FANOUT_INVALID", countReason, actor);
  const participants = computerUseParticipants(config, input.countOverride);
  const [first, ...rest] = participants;
  if (driving.inProcess && rest.length > 0)
    return refuse(
      "after-personas",
      "HUMANISH_COMPUTER_USE_FANOUT_INVALID",
      "Fan-out to more than one participant is not supported on the in-process route (RunStudyOptions.inProcess): fan-out provisions one independent E2B desktop per participant, which the in-process route deliberately skips. Run a single in-process participant, or fan out on the E2B route.",
      actor,
    );
  if (first === undefined) throw new Error("computerUseParticipants returned no participant");

  const { appUrl, appUrlSubject, hosted } = subjectsOf(config);
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
      : {
          desktop: "e2b-desktop",
          provider,
          brain,
          participants: [first, ...rest],
          subject: hosted,
        };
  const unsupported = runnerRefusal(runner.desktop, participants);
  if (unsupported) return refuse("in-scope", unsupported.code, unsupported.message, actor);
  const starts = startsOf(config, runner, input, ceiling.ms);
  if (!starts.ok)
    return refuse("after-personas", "HUMANISH_COMPUTER_USE_FANOUT_INVALID", starts.message, actor);
  const provisioned = source === "clone" || source === "local-tree";
  const base = planBase(config, { dryRun: input.dryRun, analysis });
  return {
    ok: true,
    plan: {
      ...base,
      ...(starts.warnings.length === 0 ? {} : { warnings: starts.warnings }),
      route: "computer-use",
      actor,
      runner,
      ...starts.starts,
      sandboxMs: resolveParticipantSandboxMs(config, ceiling.ms),
      caps: planCaps(config),
      ...(input.rerun === undefined ? {} : { rerun: rerunPlan(input.rerun) }),
      requirements:
        base.dryRun || runner.desktop === "in-process"
          ? []
          : desktopRequirements(config, {
              e2b: runner.desktop === "e2b-desktop" && runner.provider === "e2b",
              modal: runner.desktop === "e2b-desktop" && runner.provider === "modal",
              brain,
              localVm: runner.desktop === "local-vm",
              externalCatch: !provisioned,
            }),
    },
  };
}
