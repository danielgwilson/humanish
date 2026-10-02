import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import { createE2BParticipantDesktop } from "./e2b-desktop/desktop.js";
import { createInProcessDesktop } from "./in-process-desktop.js";
import path from "node:path";
import { cuaParticipantDiagnostics } from "./diagnostics.js";
import { mapWithConcurrency } from "../../run/concurrency.js";
import { assertScreenshotEvidence, stripPngMetadataChunks } from "../../evidence/image.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import {
  assertSafeOutputPathSegment,
  writeContainedOutputFile,
  type PreparedOutputRoot,
} from "../../run/contained-output.js";
import { participantOutcomeOk } from "./participant-facts.js";
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
  CuaSubjectProjection,
  ParticipantRunOutcome,
} from "./types.js";

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
function skippedOutcome(spec: DesktopParticipantRun, reason: string): ParticipantRunOutcome {
  return {
    spec,
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
  let model: ParticipantModel = {};
  const warnings: string[] = [];
  const screenshots: string[] = [];
  const writeScreenshot = makeParticipantWriteScreenshot(deps.artifactRoot, spec, screenshots);
  let session: CuaLoopResult | undefined;
  let sessionError: string | undefined;
  let providerCleanupError: string | undefined;
  let providerPolicyError: string | undefined;
  let provisioned = false;
  let signaled = false;
  const signal = (ok: boolean): void => {
    if (!signaled && deps.signalProvisioned) {
      signaled = true;
      deps.signalProvisioned(ok);
    }
  };
  const desktop =
    deps.createDesktop?.(spec, warnings, deps.artifactRoot) ??
    createE2BParticipantDesktop(spec, deps, warnings);
  try {
    await desktop.prepare();
    const ready = await desktop.openSession();
    model = await startParticipantModel(spec, deps, ready.executor);

    // World is ready: release the pipeline gate so the remaining participants may start.
    provisioned = true;
    signal(true);

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
            : `Codex output after the participant's last request could not be checked against the item policy (${closed.refusal}).`,
        ),
      );
    try {
      if (!provisioned) signal(false);
    } finally {
      await desktop.finalize({
        failed:
          sessionError !== undefined ||
          providerCleanupError !== undefined ||
          providerPolicyError !== undefined ||
          session === undefined,
      });
    }
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

  const { released, ...desktopEvidence } = desktop.snapshot();
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

/**
 * Run N>1 E2B participants with bounded concurrency, a pipeline gate (the first provisions
 * before the rest start), and session fail-fast on harness errors only (queued participants
 * become `blocked` with a pinned reason + a fail-fast event; mission verdicts never trip it).
 * Each participant tears down its own sandbox by id; nothing here ever enumerates.
 *
 * Exported for the #342 total-runner tests: the injectable runner lets a test make one participant
 * throw (the exact class the guard exists for) without a live sandbox. Production always uses
 * the default.
 */
export async function runCuaParticipants(
  runs: DesktopParticipantRun[],
  deps: Omit<CuaParticipantDeps, "signalProvisioned">,
  concurrency: number,
  runParticipant: typeof runCuaParticipant = runCuaParticipant,
): Promise<{ outcomes: ParticipantRunOutcome[]; failFastReason?: string }> {
  const failFast: { tripped: boolean; reason: string } = { tripped: false, reason: "" };
  let resolveGate: (() => void) | undefined;
  let rejectGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = () => reject(new Error("gate"));
  });
  // The gate is rejected on the first participant's provisioning failure; swallow the unhandled
  // rejection if no later participant ever awaits it (concurrency could let the first finish
  // alone).
  gate.catch(() => undefined);

  const outcomes = await mapWithConcurrency(
    runs,
    concurrency,
    async (spec, index): Promise<ParticipantRunOutcome> => {
      if (index > 0) {
        try {
          await gate;
        } catch {
          return skippedOutcome(
            spec,
            `skipped: participant ${runs[0]?.planned.id ?? "lane-01"} failed to provision its world (pipeline gate)`,
          );
        }
      }
      if (failFast.tripped) {
        return skippedOutcome(spec, `skipped: ${failFast.reason}`);
      }
      // The participant runner is total (#342): every exit path returns a recorded outcome. Without this
      // guard, one participant's late throw (e.g. its trace write hitting ENOSPC after its own sandbox was
      // already torn down) rejected the whole map while sibling workers kept launching sandboxes
      // nobody would ever record — the run spent money and then reported nothing.
      let outcome: ParticipantRunOutcome;
      try {
        outcome = await runParticipant(spec, {
          ...deps,
          ...(index === 0
            ? {
                signalProvisioned: (ok: boolean) => {
                  if (ok) {
                    resolveGate?.();
                  } else {
                    rejectGate?.();
                  }
                },
              }
            : {}),
        });
      } catch (error) {
        // The first participant may have thrown before signaling the provisioning gate — release the followers as
        // blocked rather than leaving them awaiting a gate that will never settle.
        if (index === 0) rejectGate?.();
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
      if (outcome.harnessError && !failFast.tripped) {
        failFast.tripped = true;
        failFast.reason = `a prior participant (${outcome.spec.planned.id}) ended in a harness error (fail-fast)`;
      }
      return outcome;
    },
  );

  return { outcomes, ...(failFast.tripped ? { failFastReason: failFast.reason } : {}) };
}

/** Project one participant outcome (or a dry-run contract spec) into the public CuaParticipantResult. */
export function toParticipantResult(
  spec: DesktopParticipantRun,
  outcome: ParticipantRunOutcome | undefined,
  subject: CuaSubjectProjection,
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
      error: { code: "HUMANISH_CUA_LAB_FAILED", message: outcome.skippedReason },
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
            code: outcome.failureCode ?? "HUMANISH_CUA_LAB_FAILED",
            message:
              outcome.sessionError ??
              (outcome.noEngagement
                ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
                : outcome.selfReportedBlocker
                  ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
                  : session?.completionReason === "harness_error"
                    ? `Computer-use session ended with a harness error: ${session.reason}`
                    : session?.status !== "passed"
                      ? `Computer-use session ended with ${session?.status ?? "unknown"}: ${session?.reason ?? "no terminal reason"}`
                      : "Computer-use lab did not produce a terminal session."),
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
  deps: Omit<CuaParticipantDeps, "signalProvisioned">,
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
