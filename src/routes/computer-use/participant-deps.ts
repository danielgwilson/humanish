// The deps every desktop participant reads, built here for computer use and shared world. A field
// both routes hand their participants is added once, in desktopParticipantDeps; each route passes
// what only it knows as overrides.

import type { ComputerUsePlan, SharedWorldPlan } from "../../study/plan-types.js";
import type { StudyDeps } from "../../study/study-deps.js";
import { e2bRequestTimeoutMs } from "../../substrates/e2b/lifetime.js";
import type { LiveTraceFlush } from "./live-flush.js";
import { makeCuaRunBudget } from "./participant-model.js";
import type { CuaParticipantDeps } from "./types.js";

/** The deps a desktop route builds once per run. Each participant adds the app URL it opens. */
export type DesktopParticipantDeps = Omit<
  CuaParticipantDeps,
  "signalReady" | "appUrl" | "onObservedUrl"
>;

/** What every participant of a desktop run reads. Each route supplies all of it. */
interface DesktopRunFacts {
  plan: Pick<ComputerUsePlan | SharedWorldPlan, "studyId" | "residual" | "caps" | "dryRun">;
  /** The plan's brain. A local agent runs each participant on the operator's signed-in CLI. */
  brain: CuaParticipantDeps["brain"];
  /** What the participant's desktop does with the subject. */
  subject: CuaParticipantDeps["subject"];
  /** The run's env. The E2B request timeout is read from it. */
  env: CuaParticipantDeps["env"];
  openaiApiKey: string;
  e2bApiKey: string;
  /** Each participant's session budget. */
  timeoutMs: number;
  /** Each participant's sandbox lifetime. */
  sandboxMs: number;
  participantCount: number;
  artifactRoot: CuaParticipantDeps["artifactRoot"];
  studyCwd: string;
  redactScreenshots: boolean;
  scrubKnownValues: (text: string) => string;
  runSession: CuaParticipantDeps["runSession"];
  /** The run's live-trace flush, once a live run has started it. */
  liveFlush: () => LiveTraceFlush["flush"] | undefined;
  onStream: CuaParticipantDeps["onStream"];
  reportSubjectPhase: CuaParticipantDeps["reportSubjectPhase"];
  /** The run's test seams: the clock, the E2B SDK loader and the detached timers. */
  seams: StudyDeps;
  /** The caller's prepareDesktop, which each participant's desktop runs. */
  prepareDesktop: CuaParticipantDeps["prepareDesktop"];
}

/** The fields one desktop route sets and the other does not. Undefined leaves a field out. */
type DesktopRouteOverrides = {
  [
    K in
      | "createDesktop"
      | "createProvider"
      | "inProcessExecutor"
      | "localTreeArchiveBuffer"
      | "externalComms"
      | "receiving"
      | "screenMismatchPolicy"
  ]?: CuaParticipantDeps[K] | undefined;
};

/**
 * One run's participant deps. Call it once per run: the run budget it creates is the one ledger
 * every participant notes its spend on, and a dry run, which never spends, gets none.
 */
export function desktopParticipantDeps(
  run: DesktopRunFacts,
  overrides: DesktopRouteOverrides,
): DesktopParticipantDeps {
  const { plan, seams } = run;
  const { maxTotalUsd } = plan.caps;
  const optional = {
    ...overrides,
    prepareDesktop: run.prepareDesktop,
    desktopModule: seams.desktopModule,
    detachedTimers: seams.detachedTimers,
    runBudget: plan.dryRun || maxTotalUsd === undefined ? undefined : makeCuaRunBudget(maxTotalUsd),
  };
  return {
    ...definedFields(optional),
    onTrace: (participantId, items, usage, metadata) =>
      run.liveFlush()?.(participantId, items, usage, metadata),
    residual: plan.residual,
    studyId: plan.studyId,
    caps: plan.caps,
    brain: run.brain,
    subject: run.subject,
    env: run.env,
    openaiApiKey: run.openaiApiKey,
    e2bApiKey: run.e2bApiKey,
    requestTimeoutMs: e2bRequestTimeoutMs(run.env),
    sandboxMs: run.sandboxMs,
    timeoutMs: run.timeoutMs,
    participantCount: run.participantCount,
    artifactRoot: run.artifactRoot,
    studyCwd: run.studyCwd,
    redactScreenshots: run.redactScreenshots,
    scrubKnownValues: run.scrubKnownValues,
    runSession: run.runSession,
    // The run's own clock unless a test sets another, so a participant's times and the run's host
    // suspensions read one clock.
    now: seams.now ?? seams.hostClock?.now ?? Date.now,
    onStream: run.onStream,
    reportSubjectPhase: run.reportSubjectPhase,
  };
}

/** The fields of `fields` that are set. The deps never carry a key whose value is undefined. */
function definedFields<T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
