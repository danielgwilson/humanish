import type { ActorPersonaRef } from "../../actors/contract.js";
import type { ScriptedBrowserSessionResult } from "../../actors/scripted-browser/actor.js";
import type { BrowserPersonaJourney } from "../../actors/scripted-browser/types.js";
import type { ScriptedPlan } from "../../lab/plan-types.js";
import type { RunBundle, RunSubjectProvenance } from "../../run/bundle.js";
import type { RunScope } from "../../run/run.js";
import {
  judgeExecution,
  sandboxCleanupFailure,
  judgeScripted,
  OUTCOME_POLICIES,
  resultOk,
  type ExecutionFailure,
  type ParticipantFacts,
} from "../../run/judge.js";
import type { ObserverResult } from "../../observer/render.js";
import { validatePreparedRunArtifactPaths } from "../../run/paths.js";
import { resolveSubjectState } from "../computer-use/subject-projection.js";
import { buildScriptedLabBundle } from "./bundle.js";
import { existingScreenshots } from "./session-result.js";
import type { ScriptedSubject } from "./subject.js";
import { SCRIPTED_BROWSER_LAB_SCHEMA, type ScriptedBrowserLabResult } from "./types.js";
// Finishing a scripted-browser run: the subject's provenance, the bundle, the Observer and the
// lab result.

/** What the finish reads from the run. */
export interface ScriptedFinishInputs {
  plan: ScriptedPlan;
  cwd: string;
  evidenceAppUrl: string;
  run: Extract<Awaited<ReturnType<RunScope["startRun"]>>, { ok: true }>["run"];
  source: RunBundle["source"];
  journey: BrowserPersonaJourney;
  scenario: { source: string; sourceDigest: string };
  persona: ActorPersonaRef;
  surfaces: ScriptedPlan["surfaces"];
  sessionResults: ScriptedBrowserSessionResult[];
  sessionError: string | undefined;
  warnings: string[];
  clone: Extract<ScriptedPlan["subject"], { readonly kind: "clone" }> | undefined;
  redactRepoLabel: boolean;
  subjectEnvNames: string[];
  scriptedSubject: ScriptedSubject | undefined;
}

/** What judgeScripted reads from one surface's session. Scripted has no engagement or blocker rule. */
function scriptedSurfaceFacts(result: ScriptedBrowserSessionResult): ParticipantFacts {
  return {
    status: result.status,
    completionReason: result.completionReason,
    skipped: false,
    noEngagement: false,
    selfReportedBlocker: false,
  };
}

/**
 * The scripted run's execution failures: the session's own error, a live surface that never
 * returned, a surface that ended in a harness error, a subject sandbox whose release is
 * unconfirmed, and an Observer that failed.
 */
export function scriptedExecutionFailures(args: {
  dryRun: boolean;
  runId: string;
  sessionError: string | undefined;
  expected: number;
  sessionResults: readonly Pick<ScriptedBrowserSessionResult, "completionReason" | "reason">[];
  subject: Pick<ScriptedSubject, "sandboxId" | "killed" | "releaseWarning"> | undefined;
  observer: Pick<ObserverResult, "ok" | "error">;
}): ExecutionFailure[] {
  const { sessionError, sessionResults, observer } = args;
  const harnessErrorSession = sessionResults.find(
    (result) => result.completionReason === "harness_error",
  );
  return [
    ...(sessionError === undefined ? [] : [{ kind: "harness" as const, message: sessionError }]),
    ...(harnessErrorSession === undefined
      ? []
      : [
          {
            kind: "harness" as const,
            message: `Scripted session ended with a harness error: ${harnessErrorSession.reason}`,
          },
        ]),
    ...(!args.dryRun && sessionError === undefined && sessionResults.length !== args.expected
      ? [
          {
            kind: "harness" as const,
            message: "Scripted lab did not produce terminal sessions for every surface.",
          },
        ]
      : []),
    ...(args.subject?.sandboxId === undefined || args.subject.killed
      ? []
      : [sandboxCleanupFailure("subject", args.subject.releaseWarning, args.runId)]),
    ...(observer.ok
      ? []
      : [
          {
            kind: "evidence" as const,
            message: observer.error?.message ?? "Observer failed for the scripted lab run.",
          },
        ]),
  ];
}

export async function finishScriptedRun(
  inputs: ScriptedFinishInputs,
): Promise<ScriptedBrowserLabResult> {
  const { plan, cwd, evidenceAppUrl, run, source, journey, scenario, persona } = inputs;
  const { surfaces, sessionResults, sessionError, warnings, clone, redactRepoLabel } = inputs;
  const { subjectEnvNames, scriptedSubject } = inputs;
  const { actor, dryRun } = plan;
  const { runId, createdAt, paths: runPaths } = run;
  const subjectCommit = scriptedSubject?.commit;
  const subjectSandboxId = scriptedSubject?.sandboxId;
  const subjectKilled = scriptedSubject?.killed ?? false;
  const hostDigest = scriptedSubject?.hostDigest;
  const stateStepRecords = scriptedSubject?.stateStepRecords ?? [];
  const subjectDesktop = scriptedSubject?.desktopUsage();

  const screenshotsBySurface = new Map<string, string[]>();
  for (const result of sessionResults) {
    screenshotsBySurface.set(
      result.capture.surface.id,
      await existingScreenshots(runPaths, result),
    );
  }
  const subject: RunSubjectProvenance | undefined = clone
    ? {
        source: "clone",
        repo: redactRepoLabel ? "repo-01" : clone.repo,
        ...(subjectCommit === undefined ? {} : { commit: subjectCommit }),
        envNames: subjectEnvNames,
        state: resolveSubjectState({
          declared: clone.state,
          dryRun,
          executed: stateStepRecords,
        }),
      }
    : undefined;

  // One judgment for the bundle's verdict and the result's ok.
  const judgment = judgeScripted({
    dryRun,
    sessionError,
    expected: surfaces.length,
    surfaces: sessionResults.map(scriptedSurfaceFacts),
  });
  const bundle = buildScriptedLabBundle({
    ...(plan.lab === undefined ? {} : { lab: plan.lab }),
    actorId: actor,
    appUrl: evidenceAppUrl,
    createdAt,
    dryRun,
    journey,
    labId: plan.labId,
    ...(plan.title ? { labTitle: plan.title } : {}),
    persona,
    runId,
    scenarioSource: scenario.source,
    scenarioSourceDigest: scenario.sourceDigest,
    screenshotsBySurface,
    sessionResults,
    ...(sessionError === undefined ? {} : { sessionError }),
    source,
    surfaces,
    verdict: judgment.verdict,
    ...(subject === undefined ? {} : { subject }),
    ...(subjectDesktop === undefined ? {} : { subjectDesktop }),
    ...(plan.residual.execution?.desktop?.template === undefined
      ? {}
      : { desktopTemplate: plan.residual.execution.desktop.template }),
    ...(hostDigest === undefined ? {} : { hostDigest }),
  });

  const finished = await run.finish(bundle);

  // Surface the local-fidelity posture so the operator knows the bundle is not publish-safe as-is.
  if (sessionResults.some((result) => result.trace.redaction.screenshots === "raw")) {
    warnings.push(
      "Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .humanish and nothing scans these pixels; review them before sharing anywhere. policies.redactScreenshots is not yet supported on the scripted route.",
    );
  }

  const observer = await finished.renderObserver();
  await validatePreparedRunArtifactPaths(runPaths);

  // A failing surface is captured evidence on this route: only the execution fails ok.
  const policy = OUTCOME_POLICIES.scripted;
  const execution = judgeExecution(
    scriptedExecutionFailures({
      dryRun,
      runId,
      sessionError,
      expected: surfaces.length,
      sessionResults,
      subject: scriptedSubject,
      observer,
    }),
    policy,
  );
  const ok = resultOk({ judgment, execution, scorerFailures: [], policy });
  await finished.recordOutcome({ ok, execution });
  const harnessErrorSession = sessionResults.find(
    (result) => result.completionReason === "harness_error",
  );

  return {
    schema: SCRIPTED_BROWSER_LAB_SCHEMA,
    ok,
    cwd,
    labId: plan.labId,
    actor,
    appUrl: evidenceAppUrl,
    dryRun,
    runId,
    ...(subject === undefined ? {} : { subject }),
    ...(subjectSandboxId === undefined
      ? {}
      : { subjectSandbox: { sandboxId: subjectSandboxId, killed: subjectKilled } }),
    ...(hostDigest === undefined ? {} : { hostDigest }),
    scenario: {
      id: journey.scenarioId,
      source: scenario.source,
      sourceDigest: scenario.sourceDigest,
      steps: journey.steps.length,
    },
    sessions: sessionResults.map((result) => ({
      surface: result.capture.surface.id,
      status: result.status,
      completionReason: result.completionReason,
      reason: result.reason,
      screenshots: screenshotsBySurface.get(result.capture.surface.id)?.length ?? 0,
    })),
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: "HUMANISH_SCRIPTED_LAB_FAILED" as const,
            message:
              sessionError ??
              (observer.ok
                ? harnessErrorSession
                  ? `Scripted session ended with a harness error: ${harnessErrorSession.reason}`
                  : "Scripted lab did not produce terminal sessions for every surface."
                : (observer.error?.message ?? "Observer failed for the scripted lab run.")),
          },
        }),
  };
}
