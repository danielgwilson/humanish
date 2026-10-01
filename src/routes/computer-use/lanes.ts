import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import { createE2BParticipantDesktop } from "./e2b-desktop.js";
import { createInProcessDesktop } from "./in-process-desktop.js";
import path from "node:path";
import { cuaLaneDiagnostics } from "./diagnostics.js";
import { mapWithConcurrency } from "../../run/concurrency.js";
import { assertScreenshotEvidence } from "../../evidence/image.js";
import { round6 } from "../../run/pricing.js";
import type { LabConfig } from "../../lab/types.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import { type RunSubjectProvenance } from "../../run/bundle.js";
import {
  assertSafeOutputPathSegment,
  writeContainedOutputFile,
  type PreparedOutputRoot,
} from "../../run/contained-output.js";
import { type LocalTreeArchive } from "../../run/source-archive.js";
import { laneOutcomeOk } from "./bundle.js";
import {
  closeParticipantModel,
  judgeParticipantSession,
  participantSessionOptions,
  recordParticipantTrace,
  startParticipantModel,
  type ParticipantModel,
} from "./participant-model.js";
import type {
  CuaLaneDeps,
  CuaLanePlan,
  CuaLaneResult,
  DesktopParticipantRun,
  CuaSubjectProjection,
  CuaSubjectProvenanceArg,
  LaneRunOutcome,
} from "./types.js";

/** Build a lane's writeScreenshot closure: writes under screenshots/<screenshotDir>/ and records
 *  the relative path the trace references (screenshots/<name> at N=1; screenshots/<laneId>/<name>
 *  at N>1). */
export function makeLaneWriteScreenshot(
  artifactRoot: PreparedOutputRoot,
  spec: { screenshotDir: string },
  screenshots: string[],
): (name: string, bytes: Buffer) => Promise<string> {
  if (spec.screenshotDir) {
    assertSafeOutputPathSegment(spec.screenshotDir, "Screenshot lane id");
  }
  const dirParts = spec.screenshotDir ? ["screenshots", spec.screenshotDir] : ["screenshots"];
  const relPrefix = spec.screenshotDir
    ? path.posix.join("screenshots", spec.screenshotDir)
    : "screenshots";
  return async (name: string, bytes: Buffer): Promise<string> => {
    assertSafeOutputPathSegment(name, "Screenshot name");
    const rel = path.posix.join(relPrefix, name);
    assertScreenshotEvidence(rel, bytes);
    await writeContainedOutputFile(artifactRoot, path.join(...dirParts, name), bytes);
    screenshots.push(rel);
    return rel;
  };
}

/** A blocked lane outcome (pipeline gate / fail-fast skipped it before it ran). */
function skippedOutcome(spec: DesktopParticipantRun, reason: string): LaneRunOutcome {
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
export async function runCuaLane(
  spec: DesktopParticipantRun,
  deps: CuaLaneDeps,
): Promise<LaneRunOutcome> {
  let model: ParticipantModel = {};
  const warnings: string[] = [];
  const screenshots: string[] = [];
  const writeScreenshot = makeLaneWriteScreenshot(deps.artifactRoot, spec, screenshots);
  let session: CuaLoopResult | undefined;
  let sessionError: string | undefined;
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

    // World is ready: release the pipeline gate so the remaining lanes may start.
    provisioned = true;
    signal(true);

    session = await deps.runSession(
      participantSessionOptions(spec, deps, ready, model.provider, writeScreenshot),
    );
  } catch (error) {
    sessionError = redactText(deps.scrubKnownValues(toErrorMessage(error)));
  } finally {
    if (await closeParticipantModel(model, warnings)) {
      sessionError ??= "Model provider cleanup is unconfirmed.";
    }
    try {
      if (!provisioned) signal(false);
    } finally {
      await desktop.finalize({ failed: sessionError !== undefined || session === undefined });
    }
  }
  if (session) await recordParticipantTrace(spec, deps, session, warnings);
  const { noEngagement, selfReportedBlocker, reportedFriction } = judgeParticipantSession(
    session,
    deps,
    warnings,
  );

  const harnessError = sessionError !== undefined || session?.completionReason === "harness_error";

  const { released, ...desktopEvidence } = desktop.snapshot();
  return {
    spec,
    ...(session ? { session } : {}),
    ...(sessionError === undefined ? {} : { sessionError }),
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
 * Run N>1 E2B lanes with bounded concurrency, a pipeline gate (lane 1 provisions before the rest
 * start), and session fail-fast on HARNESS errors only (queued lanes become `blocked` with a
 * pinned reason + a fail-fast event; mission verdicts never trip it). Each lane tears down ITS
 * OWN sandbox by id; nothing here ever enumerates.
 *
 * Exported for the #342 total-runner tests: the injectable runner lets a test make one lane
 * THROW (the exact class the guard exists for) without a live sandbox. Production always uses
 * the default.
 */
export async function runCuaLanes(
  laneSpecs: DesktopParticipantRun[],
  deps: Omit<CuaLaneDeps, "signalProvisioned">,
  concurrency: number,
  runParticipant: typeof runCuaLane = runCuaLane,
): Promise<{ outcomes: LaneRunOutcome[]; failFastReason?: string }> {
  const failFast: { tripped: boolean; reason: string } = { tripped: false, reason: "" };
  let resolveGate: (() => void) | undefined;
  let rejectGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = () => reject(new Error("gate"));
  });
  // The gate is rejected on lane-0 provisioning failure; swallow the unhandled rejection if no
  // later lane ever awaits it (concurrency could let lane 0 finish alone).
  gate.catch(() => undefined);

  const outcomes = await mapWithConcurrency(
    laneSpecs,
    concurrency,
    async (spec, index): Promise<LaneRunOutcome> => {
      if (index > 0) {
        try {
          await gate;
        } catch {
          return skippedOutcome(
            spec,
            `skipped: lane ${laneSpecs[0]?.planned.id ?? "lane-01"} failed to provision its world (pipeline gate)`,
          );
        }
      }
      if (failFast.tripped) {
        return skippedOutcome(spec, `skipped: ${failFast.reason}`);
      }
      // The lane runner is TOTAL (#342): every exit path returns a recorded outcome. Without this
      // guard, one lane's late throw (e.g. its trace write hitting ENOSPC after its own sandbox was
      // already torn down) rejected the whole map while sibling workers kept launching sandboxes
      // nobody would ever record — the run spent money and then reported nothing.
      let outcome: LaneRunOutcome;
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
        // Lane 0 may have thrown before signaling the provisioning gate — release the followers as
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
          sessionError: `lane runner threw outside the session guard: ${detail}`,
        };
      }
      if (outcome.harnessError && !failFast.tripped) {
        failFast.tripped = true;
        failFast.reason = `a prior lane (${outcome.spec.planned.id}) ended in a harness error (fail-fast)`;
      }
      return outcome;
    },
  );

  return { outcomes, ...(failFast.tripped ? { failFastReason: failFast.reason } : {}) };
}

/** Project one lane outcome (or a dry-run contract spec) into the public CuaLaneResult. */
export function toLaneResult(
  spec: DesktopParticipantRun,
  outcome: LaneRunOutcome | undefined,
  subject: CuaSubjectProjection,
  dryRun: boolean,
): CuaLaneResult {
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
      diagnostics: cuaLaneDiagnostics({ dryRun }),
    };
  }
  if (outcome.skippedReason !== undefined) {
    return {
      ...base,
      status: "blocked",
      ok: false,
      diagnostics: cuaLaneDiagnostics({ dryRun, skipped: true }),
      skippedReason: outcome.skippedReason,
      error: { code: "HUMANISH_CUA_LAB_FAILED", message: outcome.skippedReason },
    };
  }
  const session = outcome.session;
  const participantOk = laneOutcomeOk(outcome, dryRun);
  const status: CuaLaneResult["status"] = session ? session.status : "failed";
  return {
    ...base,
    status,
    ok: participantOk,
    diagnostics: cuaLaneDiagnostics({
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

/** Build the per-lane subject projection (invariant 5). Local-tree lanes all share ONE
 *  host-packed archive, so every lane's projection carries the identical archiveSha256/
 *  commit/dirty (no per-lane divergence is possible, unlike the clone route's per-lane
 *  in-sandbox commit). */
export function laneSubjectProjection(args: {
  cloneRoute: boolean;
  localTreeRoute: boolean;
  publicRepo?: string;
  subjectEnvNames: string[];
  subjectCommit?: string;
  localTreeArchive?: LocalTreeArchive;
  subjectState: RunSubjectProvenance["state"];
}): CuaSubjectProjection {
  if (args.cloneRoute && args.publicRepo) {
    return {
      source: "clone",
      repo: args.publicRepo,
      ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
      envNames: args.subjectEnvNames,
      state: args.subjectState,
    };
  }
  if (args.localTreeRoute) {
    const archive = args.localTreeArchive;
    return {
      source: "local-tree",
      ...(archive === undefined ? {} : { archiveSha256: archive.archiveSha256 }),
      ...(archive?.git === undefined
        ? {}
        : { commit: archive.git.commit, dirty: archive.git.dirty }),
      envNames: args.subjectEnvNames,
      state: args.subjectState,
    };
  }
  return { source: "app-url", state: args.subjectState };
}

/** Narrow a resolved CuaSubjectProjection into the shape buildCuaBundle/buildSingleLaneBundle's
 *  subjectProvenance param wants (provisioned-route sources only; app-url stays undeclared, the
 *  default branch buildCuaBundle already handles). */
export function subjectProvenanceArg(
  subject: CuaSubjectProjection,
  publicRepo: string | undefined,
  subjectEnvNames: string[],
): CuaSubjectProvenanceArg | undefined {
  if (subject.source === "clone" && publicRepo) {
    return {
      source: "clone",
      repo: publicRepo,
      ...(subject.commit === undefined ? {} : { commit: subject.commit }),
      envNames: subjectEnvNames,
      state: subject.state,
    };
  }
  if (subject.source === "local-tree") {
    return {
      source: "local-tree",
      ...(subject.archiveSha256 === undefined ? {} : { archiveSha256: subject.archiveSha256 }),
      ...(subject.commit === undefined ? {} : { commit: subject.commit }),
      ...(subject.dirty === undefined ? {} : { dirty: subject.dirty }),
      envNames: subjectEnvNames,
      state: subject.state,
    };
  }
  return undefined;
}

/**
 * The run-level subject for the top level and the bundle. Local-tree lanes all pack from the same
 * once-per-run archive, so every lane already carries the identical archiveSha256/commit/dirty and
 * the first lane's projection is the aggregate. Clone lanes each resolve their own commit; the
 * aggregate carries it only when every lane agrees, and warns when they diverge.
 */
export function aggregateCuaSubject(args: {
  laneSubjects: readonly CuaSubjectProjection[];
  outcomes: readonly LaneRunOutcome[] | undefined;
  laneCount: number;
  dryRun: boolean;
}): { subject: CuaSubjectProjection; warnings: string[] } {
  const { laneSubjects, outcomes, laneCount, dryRun } = args;
  const first = laneSubjects[0]!;
  if (first.source !== "clone") return { subject: first, warnings: [] };
  const commits = (outcomes ?? [])
    .map((outcome) => outcome.subjectCommit)
    .filter((commit): commit is string => commit !== undefined);
  const unanimous = !dryRun && commits.length === laneCount && new Set(commits).size === 1;
  const warnings =
    !dryRun && laneCount > 1 && new Set(commits).size > 1
      ? [
          "Fan-out lanes resolved DIVERGENT subject commits — the top-level subject.commit is omitted; see per-lane provenance in result.lanes for each lane's pinned commit.",
        ]
      : [];
  return {
    subject: {
      source: "clone",
      ...(first.repo === undefined ? {} : { repo: first.repo }),
      ...(first.envNames === undefined ? {} : { envNames: first.envNames }),
      state: first.state,
      ...(unanimous && commits[0] !== undefined ? { commit: commits[0] } : {}),
    },
    warnings,
  };
}

/**
 * execution.caps.maxUsd is enforced inside each lane's loop independently, so an N-lane fan-out can
 * spend up to N × maxUsd before any lane aborts, while the run cost summary reports the larger
 * aggregate. The warning names that ceiling, unless the study declared a shared maxTotalUsd budget.
 */
export function perLaneCapWarning(config: LabConfig, laneCount: number): string | undefined {
  const perLaneCapUsd = config.execution?.caps?.maxUsd;
  if (perLaneCapUsd === undefined || laneCount <= 1) return undefined;
  if (config.execution?.caps?.maxTotalUsd !== undefined) return undefined;
  return `execution.caps.maxUsd ($${perLaneCapUsd}) is a PER-LANE cap; ${laneCount} lanes may spend up to ${laneCount} × $${perLaneCapUsd} (~$${round6(perLaneCapUsd * laneCount)} total) before any lane aborts. Set execution.caps.maxTotalUsd for a shared study budget.`;
}

/**
 * Run every lane of a live run. The in-process route drives its single lane in this process; one
 * hosted lane runs alone; a fan-out runs at the plan's concurrency and may stop early.
 */
export async function runAllCuaLanes(
  laneSpecs: readonly DesktopParticipantRun[],
  deps: Omit<CuaLaneDeps, "signalProvisioned">,
  plan: CuaLanePlan,
  inProcessRoute: boolean,
): Promise<{ outcomes: LaneRunOutcome[]; failFastReason: string | undefined }> {
  if (inProcessRoute) {
    // The caller's executor stands in for a desktop, and the shared runner drives the participant.
    const outcome = await runCuaLane(laneSpecs[0]!, {
      ...deps,
      createDesktop: () => createInProcessDesktop(deps),
    });
    return { outcomes: [outcome], failFastReason: undefined };
  }
  if (laneSpecs.length === 1)
    return { outcomes: [await runCuaLane(laneSpecs[0]!, deps)], failFastReason: undefined };
  const ran = await runCuaLanes([...laneSpecs], deps, plan.concurrency);
  return { outcomes: ran.outcomes, failFastReason: ran.failFastReason };
}
