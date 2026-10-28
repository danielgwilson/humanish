import { scheduledParticipantDeps } from "./participant-runs.js";
import { judgeParticipantRecords } from "../../run/judge.js";
import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import { createE2BParticipantDesktop } from "./e2b-desktop/desktop.js";
import { createInProcessDesktop } from "./in-process-desktop.js";
import { cuaParticipantDiagnostics } from "./diagnostics.js";
import { pastEndReason, runOnSchedule, type ParticipantArrival } from "../../study/arrivals.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import { participantFrames } from "./participant-frames.js";
import { participantOutcomeOk, participantFactsOf } from "./participant-facts.js";
import {
  closeParticipantModel,
  judgeParticipantSession,
  participantSessionOptions,
  recordParticipantTrace,
  startParticipantModel,
  type ParticipantModel,
} from "./participant-model.js";
import type {
  CuaParticipantDeps,
  CuaParticipantPlan,
  CuaParticipantResult,
  DesktopParticipantRun,
  ParticipantRunOutcome,
} from "./types.js";
import type { RunSubjectProvenance } from "../../run/bundle.js";

/**
 * Told each participant's outcome when it ends, with the participant's place in the roster, while
 * the others may still run. A participant that runs alone is not reported: its end is the run's.
 */
export type ParticipantEnded = (index: number, outcome: ParticipantRunOutcome) => void;

/** A blocked participant outcome: the pipeline gate or the study budget skipped it. */
function skippedOutcome(
  spec: DesktopParticipantRun,
  reason: string,
  arrival?: ParticipantArrival,
): ParticipantRunOutcome {
  return {
    spec,
    ...(arrival === undefined ? {} : { arrival }),
    killed: false,
    streamUrlPresent: false,
    screenshots: [],
    stateStepRecords: [],
    phaseRecords: [],
    warnings: [],
    skippedReason: reason,
    noEngagement: false,
    selfReportedBlocker: false,
    reportedFriction: false,
    harnessError: false,
  };
}

/** Run one participant against a prepared desktop. The adapter owns provisioning, final
 * evidence and cleanup; this runner owns the model, trace and participant outcome. */
export async function runCuaParticipant(
  spec: DesktopParticipantRun,
  deps: CuaParticipantDeps,
): Promise<ParticipantRunOutcome> {
  // A participant whose start comes after the study budget is spent would pay for a desktop and a
  // model turn only to stop at its first one, so it is skipped before its desktop exists.
  const crossed = deps.runBudget?.crossed();
  if (crossed !== undefined) {
    return skippedOutcome(
      spec,
      `skipped: study budget reached before this participant started: ${crossed}; no desktop was created`,
    );
  }
  // One that waited for a slot until its scheduled end would only be asked for its closing report.
  const pastEnd = pastEndReason(deps.end, deps.now());
  if (pastEnd !== undefined) return skippedOutcome(spec, pastEnd);
  let model: ParticipantModel = {};
  const warnings: string[] = [];
  const frames = participantFrames(deps.artifactRoot, spec, { blurred: deps.redactScreenshots });
  const writeScreenshot = frames.write;
  let session: CuaLoopResult | undefined;
  let sessionError: string | undefined;
  let providerCleanupError: string | undefined;
  let providerPolicyError: string | undefined;
  const desktop =
    deps.createDesktop?.(spec, warnings, deps.artifactRoot) ??
    createE2BParticipantDesktop(spec, deps, warnings);
  try {
    await desktop.prepare();
    const ready = await desktop.openSession();
    model = await startParticipantModel(spec, deps, ready.executor);
    deps.signalReady?.();
    session = await deps.runSession(
      participantSessionOptions(spec, deps, ready, model.provider, writeScreenshot),
    );
  } catch (error) {
    sessionError = redactText(deps.scrubKnownValues(toErrorMessage(error)));
  } finally {
    // A provider whose cleanup is unconfirmed fails the run as an execution, apart from how the
    // session ended: a session that passed stays a passed participant.
    const closed = await closeParticipantModel(model, warnings);
    if (closed.unconfirmed) providerCleanupError = "Model provider cleanup is unconfirmed.";
    // The session's evidence would read clean, so a late refusal fails the run as an execution.
    if (closed.refusal !== undefined)
      providerPolicyError = redactText(
        deps.scrubKnownValues(
          closed.refusal === "codex_tool_call"
            ? `Codex reported a disallowed item after the participant's last request (${closed.refusal}).`
            : closed.refusal.startsWith("HUMANISH_CLAUDE_PARTICIPANT_")
              ? `Claude Code's stream showed a call the participant may not make after its last turn (${closed.refusal}); the participant was stopped.`
              : `Codex output after the participant's last request could not be checked against the item policy (${closed.refusal}).`,
        ),
      );
    await desktop.finalize({
      failed:
        sessionError !== undefined ||
        providerCleanupError !== undefined ||
        providerPolicyError !== undefined ||
        session === undefined,
    });
  }
  const { released, desktopFailure, ...desktopEvidence } = desktop.snapshot();
  // A desktop that died under the participant explains the failure better than the transport
  // error the session saw. A session that passed keeps its result.
  if (desktopFailure !== undefined) {
    if (session?.status === "passed") warnings.push(desktopFailure);
    else sessionError = desktopFailure;
  }
  const replacedFrames = await frames.finish(session?.trace);
  if (session) await recordParticipantTrace(spec, deps, session, warnings);
  const { noEngagement, selfReportedBlocker, reportedFriction } = judgeParticipantSession(
    session,
    deps,
    warnings,
  );

  // A provider-cleanup or provider-policy failure counts in the participant summary's harness
  // errors.
  const harnessError =
    sessionError !== undefined ||
    providerCleanupError !== undefined ||
    providerPolicyError !== undefined ||
    session?.completionReason === "harness_error";

  return {
    spec,
    ...(session ? { session } : {}),
    ...(sessionError === undefined ? {} : { sessionError }),
    ...(providerCleanupError === undefined ? {} : { providerCleanupError }),
    ...(providerPolicyError === undefined ? {} : { providerPolicyError }),
    ...desktopEvidence,
    killed: released,
    screenshots: frames.screenshots,
    replacedFrames,
    warnings,
    noEngagement,
    selfReportedBlocker,
    reportedFriction,
    harnessError,
    endedAt: deps.now(),
  };
}

/** What the pipeline gate tells a participant whose start has come. */
type GateTurn = "start" | "hold" | "closed";

/**
 * Holds a fan-out's participants back until one of them is ready, when each sets up the subject in
 * its own sandbox the same way (a clone or local tree built and served, a desktop CLI installed),
 * so a subject that fails to set up fails once. The first participant to enter holds the gate and
 * the others wait. Any participant that becomes ready opens it. A holder that never got a desktop
 * learned nothing about the subject, so the next waiting participant holds it instead. A holder
 * whose desktop came up and then failed before its session closes it, and `onClose` runs.
 */
function pipelineGate(open: boolean, onClose: () => void) {
  let state: "vacant" | "held" | "open" | "closed" = open ? "open" : "vacant";
  let holder: string | undefined;
  const waiting: { id: string; turn: (turn: GateTurn) => void }[] = [];
  const settle = (turn: GateTurn) => {
    for (const participant of waiting.splice(0)) participant.turn(turn);
  };
  return {
    /** The participant that holds the gate, or held it when it closed. */
    holder: () => holder,
    enter(id: string): Promise<GateTurn> {
      if (state === "open") return Promise.resolve("start");
      if (state === "closed") return Promise.resolve("closed");
      if (state === "vacant") {
        state = "held";
        holder = id;
        return Promise.resolve("hold");
      }
      return new Promise((turn) => waiting.push({ id, turn }));
    },
    ready(): void {
      if (state !== "held") return;
      state = "open";
      settle("start");
    },
    failed(id: string, { handOver }: { handOver: boolean }): void {
      if (state !== "held" || holder !== id) return;
      if (handOver) {
        const next = waiting.shift();
        if (next === undefined) state = "vacant";
        else {
          holder = next.id;
          next.turn("hold");
        }
        return;
      }
      state = "closed";
      settle("closed");
      onClose();
    },
  };
}

/**
 * Run N>1 E2B participants on the study's schedule (runOnSchedule: each at its start offset, at
 * most `concurrency` at once), behind the pipeline gate when the subject is set up in each sandbox.
 * A harness error ends only its own participant: one desktop's stall or one provider failure does
 * not predict the next participant's, so the schedule goes on. Only a closed gate ends every wait
 * for a later start at once, and the participants it skips are `blocked` with its reason. Each
 * participant tears down its own sandbox by id; nothing here ever enumerates.
 *
 * Exported for the total-runner tests: the injectable runner lets a test make one participant
 * throw (the exact class the guard exists for) without a live sandbox. Production always uses
 * the default.
 */
export async function runCuaParticipants(
  runs: DesktopParticipantRun[],
  deps: Omit<CuaParticipantDeps, "signalReady">,
  concurrency: number,
  runParticipant: typeof runCuaParticipant = runCuaParticipant,
  onEnded?: ParticipantEnded,
): Promise<ParticipantRunOutcome[]> {
  const stopping = new AbortController();
  // An app-url subject is only opened, so one participant's start says nothing about another's.
  const gate = pipelineGate(deps.subject.kind === "app-url", () => stopping.abort());

  return runOnSchedule(
    runs,
    {
      startAfterMs: (spec) => spec.planned.schedule.startAfterMs,
      slots: concurrency,
      now: deps.now,
      signal: stopping.signal,
    },
    async (spec, index, { scheduledAt }): Promise<ParticipantRunOutcome> => {
      const id = spec.planned.id;
      if ((await gate.enter(id)) === "closed") {
        return skippedOutcome(
          spec,
          `skipped: participant ${gate.holder()} failed to provision its world (pipeline gate)`,
          { scheduledAt },
        );
      }
      const arrival = { scheduledAt, startedAt: deps.now() };
      let ready = false;
      let threw = false;
      // The participant runner is total: every exit path returns a recorded outcome. Without this
      // guard, one participant's late throw (e.g. its trace write hitting ENOSPC after its own sandbox was
      // already torn down) rejected the whole map while sibling workers kept launching sandboxes
      // nobody would ever record, so the run spent money and then reported nothing.
      let outcome: ParticipantRunOutcome;
      try {
        outcome = await runParticipant(spec, {
          ...deps,
          ...scheduledParticipantDeps(spec.planned, deps, scheduledAt),
          signalReady: () => {
            ready = true;
            gate.ready();
          },
        });
      } catch (error) {
        threw = true;
        const detail = redactText(toErrorMessage(error));
        outcome = {
          spec,
          killed: false,
          streamUrlPresent: false,
          screenshots: [],
          stateStepRecords: [],
          phaseRecords: [],
          warnings: [],
          noEngagement: false,
          selfReportedBlocker: false,
          reportedFriction: false,
          harnessError: true,
          sessionError: `participant runner threw outside the session guard: ${detail}`,
          endedAt: deps.now(),
        };
      }
      // A participant that stopped before its session without a desktop says nothing about the
      // subject, so the next participant starts first. A runner that threw is a harness defect: it
      // closes the gate.
      if (!ready) gate.failed(id, { handOver: !threw && outcome.sandboxId === undefined });
      // A participant the study budget skipped never requested its desktop.
      const ended = {
        ...outcome,
        arrival: outcome.skippedReason === undefined ? arrival : { scheduledAt },
      };
      onEnded?.(index, ended);
      return ended;
    },
  );
}

/** Project one participant outcome (or a dry-run contract spec) into the public CuaParticipantResult. */
export function toParticipantResult(
  spec: DesktopParticipantRun,
  outcome: ParticipantRunOutcome | undefined,
  subject: RunSubjectProvenance,
  dryRun: boolean,
): CuaParticipantResult {
  const base = {
    id: spec.planned.id,
    ...(spec.planned.labels.actorType === undefined
      ? {}
      : { actorType: spec.planned.labels.actorType }),
    ...(spec.planned.labels.surface === undefined ? {} : { surface: spec.planned.labels.surface }),
    ...(spec.planned.labels.caseGroup === undefined
      ? {}
      : { caseGroup: spec.planned.labels.caseGroup }),
    index: spec.planned.index + 1,
    persona: spec.persona.id,
    device: spec.planned.device.name,
    resolution: spec.planned.device.resolution,
    subject,
  };
  if (!outcome || dryRun) {
    return {
      ...base,
      status: "contract_proof_only",
      ok: dryRun,
      diagnostics: cuaParticipantDiagnostics({ dryRun }),
    };
  }
  if (outcome.skippedReason !== undefined) {
    return {
      ...base,
      status: "blocked",
      ok: false,
      diagnostics: cuaParticipantDiagnostics({ dryRun, skipped: true }),
      skippedReason: outcome.skippedReason,
      error: { code: "HUMANISH_COMPUTER_USE_FAILED", message: outcome.skippedReason },
    };
  }
  const session = outcome.session;
  const participantOk = participantOutcomeOk(outcome, dryRun);
  const status: CuaParticipantResult["status"] = session ? session.status : "failed";
  return {
    ...base,
    status,
    ok: participantOk,
    diagnostics: cuaParticipantDiagnostics({
      dryRun,
      executionError: outcome.sessionError !== undefined,
      noEngagement: outcome.noEngagement,
      ...(session
        ? {
            session: {
              status: session.status,
              completionReason: session.completionReason,
              ...(session.trace.stopCause === undefined
                ? {}
                : { stopCause: session.trace.stopCause }),
            },
          }
        : {}),
    }),
    ...(session
      ? {
          session: {
            status: session.status,
            completionReason: session.completionReason,
            ...(session.trace.stopCause === undefined
              ? {}
              : { stopCause: session.trace.stopCause }),
            reason: session.reason,
            screenshots: outcome.screenshots.length,
          },
        }
      : {}),
    ...(outcome.sandboxId === undefined
      ? {}
      : {
          sandbox: {
            sandboxId: outcome.sandboxId,
            killed: outcome.killed,
            streamUrlPresent: outcome.streamUrlPresent,
          },
        }),
    ...(participantOk
      ? {}
      : {
          error: {
            code: outcome.failureCode ?? "HUMANISH_COMPUTER_USE_FAILED",
            message: judgeParticipantRecords([participantFactsOf(outcome)]).participants[0]!
              .notPassedMessage,
          },
        }),
  };
}

/**
 * Run every participant of a live run. The in-process route drives its single participant in this
 * process; one hosted participant runs alone; a fan-out runs at the plan's concurrency, and stops
 * early only when the pipeline gate closes.
 */
export async function runAllCuaParticipants(
  runs: readonly DesktopParticipantRun[],
  deps: Omit<CuaParticipantDeps, "signalReady">,
  participantPlan: CuaParticipantPlan,
  inProcess: boolean,
  onEnded?: ParticipantEnded,
): Promise<ParticipantRunOutcome[]> {
  // A participant that runs alone starts with the run.
  const alone = { ...deps, ...scheduledParticipantDeps(runs[0]!.planned, deps, deps.now()) };
  if (inProcess) {
    // The caller's executor stands in for a desktop, and the shared runner drives the participant.
    const outcome = await runCuaParticipant(runs[0]!, {
      ...alone,
      createDesktop: () => createInProcessDesktop(deps),
    });
    return [outcome];
  }
  if (runs.length === 1) return [await runCuaParticipant(runs[0]!, alone)];
  return runCuaParticipants([...runs], deps, participantPlan.concurrency, undefined, onEnded);
}
