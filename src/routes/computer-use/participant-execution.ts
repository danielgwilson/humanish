import { judgeParticipantRecords } from "../../run/judge.js";
import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import { createE2BParticipantDesktop } from "./e2b-desktop/desktop.js";
import { createInProcessDesktop } from "./in-process-desktop.js";
import path from "node:path";
import { cuaParticipantDiagnostics } from "./diagnostics.js";
import { runOnSchedule, type ParticipantArrival } from "../../study/arrivals.js";
import { assertScreenshotEvidence, stripPngMetadataChunks } from "../../evidence/image.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import {
  assertSafeOutputPathSegment,
  writeContainedOutputFile,
  type PreparedOutputRoot,
} from "../../run/contained-output.js";
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

/** Build a participant's writeScreenshot closure: writes under screenshots/<screenshotDir>/ and records
 *  the relative path the trace references (screenshots/<name> at N=1; screenshots/<laneId>/<name>
 *  at N>1). */
export function makeParticipantWriteScreenshot(
  artifactRoot: PreparedOutputRoot,
  spec: { screenshotDir: string },
  screenshots: string[],
): (name: string, bytes: Buffer) => Promise<string> {
  if (spec.screenshotDir) {
    assertSafeOutputPathSegment(spec.screenshotDir, "Screenshot participant id");
  }
  const dirParts = spec.screenshotDir ? ["screenshots", spec.screenshotDir] : ["screenshots"];
  const relPrefix = spec.screenshotDir
    ? path.posix.join("screenshots", spec.screenshotDir)
    : "screenshots";
  return async (name: string, bytes: Buffer): Promise<string> => {
    assertSafeOutputPathSegment(name, "Screenshot name");
    const rel = path.posix.join(relPrefix, name);
    // Evidence holds image data only, whatever the executor's frames carried.
    const frame = stripPngMetadataChunks(bytes);
    assertScreenshotEvidence(rel, frame);
    await writeContainedOutputFile(artifactRoot, path.join(...dirParts, name), frame);
    screenshots.push(rel);
    return rel;
  };
}

/** A blocked participant outcome (pipeline gate / fail-fast skipped it before it ran). */
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
  let model: ParticipantModel = {};
  const warnings: string[] = [];
  const screenshots: string[] = [];
  const writeScreenshot = makeParticipantWriteScreenshot(deps.artifactRoot, spec, screenshots);
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
  if (session) await recordParticipantTrace(spec, deps, session, warnings);
  const { noEngagement, selfReportedBlocker, reportedFriction } = judgeParticipantSession(
    session,
    deps,
    warnings,
  );

  // A provider-cleanup or provider-policy failure still trips fail-fast and counts in the
  // participant summary's harness errors.
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
    screenshots,
    warnings,
    noEngagement,
    selfReportedBlocker,
    reportedFriction,
    harnessError,
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
 * most `concurrency` at once), behind the pipeline gate when the subject is set up in each sandbox,
 * and session fail-fast on harness errors only (queued participants become `blocked` with a pinned
 * reason + a fail-fast event; mission verdicts never trip it). A participant that stops before its
 * session has failed on its own and trips no fail-fast. A closed gate or a fail-fast ends every
 * wait for a later start at once. Each participant tears down its own sandbox by id; nothing here
 * ever enumerates.
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
): Promise<{ outcomes: ParticipantRunOutcome[]; failFastReason?: string }> {
  const failFast: { tripped: boolean; reason: string } = { tripped: false, reason: "" };
  const stopping = new AbortController();
  // An app-url subject is only opened, so one participant's start says nothing about another's.
  const gate = pipelineGate(deps.subject.kind === "app-url", () => stopping.abort());

  const outcomes = await runOnSchedule(
    runs,
    {
      startAfterMs: (spec) => spec.planned.startAfterMs,
      slots: concurrency,
      now: deps.now,
      signal: stopping.signal,
    },
    async (spec, _index, { scheduledAt }): Promise<ParticipantRunOutcome> => {
      if (failFast.tripped) {
        return skippedOutcome(spec, `skipped: ${failFast.reason}`, { scheduledAt });
      }
      // A participant trips fail-fast only after the gate opened, or as it closes the gate, so no
      // participant is still waiting at the gate when fail-fast skips the rest.
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
        };
      }
      // A participant that stopped before its session failed on its own and trips no fail-fast.
      // Without a desktop it says nothing about the subject, so the next participant starts first.
      // A runner that threw is a harness defect: it closes the gate and trips fail-fast.
      if (!ready) gate.failed(id, { handOver: !threw && outcome.sandboxId === undefined });
      if (outcome.harnessError && (ready || threw) && !failFast.tripped) {
        failFast.tripped = true;
        failFast.reason = `a prior participant (${outcome.spec.planned.id}) ended in a harness error (fail-fast)`;
        stopping.abort();
      }
      // A participant the study budget skipped never requested its desktop.
      return {
        ...outcome,
        arrival: outcome.skippedReason === undefined ? arrival : { scheduledAt },
      };
    },
  );

  return { outcomes, ...(failFast.tripped ? { failFastReason: failFast.reason } : {}) };
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
 * process; one hosted participant runs alone; a fan-out runs at the plan's concurrency and may stop early.
 */
export async function runAllCuaParticipants(
  runs: readonly DesktopParticipantRun[],
  deps: Omit<CuaParticipantDeps, "signalReady">,
  participantPlan: CuaParticipantPlan,
  inProcess: boolean,
): Promise<{ outcomes: ParticipantRunOutcome[]; failFastReason: string | undefined }> {
  if (inProcess) {
    // The caller's executor stands in for a desktop, and the shared runner drives the participant.
    const outcome = await runCuaParticipant(runs[0]!, {
      ...deps,
      createDesktop: () => createInProcessDesktop(deps),
    });
    return { outcomes: [outcome], failFastReason: undefined };
  }
  if (runs.length === 1)
    return { outcomes: [await runCuaParticipant(runs[0]!, deps)], failFastReason: undefined };
  const ran = await runCuaParticipants([...runs], deps, participantPlan.concurrency);
  return { outcomes: ran.outcomes, failFastReason: ran.failFastReason };
}
