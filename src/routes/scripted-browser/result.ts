import type { ActorPersonaRef } from "../../actors/contract.js";
import type { ScriptedBrowserSessionResult } from "../../actors/scripted-browser/actor.js";
import type { BrowserPersonaJourney } from "../../actors/scripted-browser/types.js";
import type { ScriptedPlan } from "../../lab/plan-types.js";
import type { RunBundle, RunSubjectProvenance } from "../../run/bundle.js";
import type { RunScope } from "../../run/run.js";
import { validatePreparedRunArtifactPaths } from "../../run/paths.js";
import { resolveSubjectState } from "../computer-use/lab.js";
import { buildScriptedLabBundle } from "./bundle.js";
import { existingScreenshots } from "./session-result.js";
import type { ScriptedSubject } from "./subject.js";
import {
  SCRIPTED_BROWSER_LAB_SCHEMA,
  type RunScriptedBrowserLabOptions,
  type ScriptedBrowserLabResult,
} from "./types.js";
// Finishing a scripted-browser run: the subject's provenance, the bundle, the Observer and the
// lab result.

/** What the finish reads from the run. */
export interface ScriptedFinishInputs {
  options: RunScriptedBrowserLabOptions;
  actor: string;
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

export async function finishScriptedRun(
  inputs: ScriptedFinishInputs,
): Promise<ScriptedBrowserLabResult> {
  const { options, actor, cwd, evidenceAppUrl, run, source, journey, scenario, persona } = inputs;
  const { surfaces, sessionResults, sessionError, warnings, clone, redactRepoLabel } = inputs;
  const { subjectEnvNames, scriptedSubject } = inputs;
  const { config, dryRun } = options;
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

  const bundle = buildScriptedLabBundle({
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    actorId: actor,
    appUrl: evidenceAppUrl,
    createdAt,
    dryRun,
    journey,
    labId: config.id,
    ...(config.title ? { labTitle: config.title } : {}),
    persona,
    runId,
    scenarioSource: scenario.source,
    scenarioSourceDigest: scenario.sourceDigest,
    screenshotsBySurface,
    sessionResults,
    ...(sessionError === undefined ? {} : { sessionError }),
    source,
    surfaces,
    ...(subject === undefined ? {} : { subject }),
    ...(subjectDesktop === undefined ? {} : { subjectDesktop }),
    ...(config.execution?.desktop?.template === undefined
      ? {}
      : { desktopTemplate: config.execution.desktop.template }),
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

  const harnessError = sessionResults.some((result) => result.completionReason === "harness_error");
  const ok =
    observer.ok &&
    sessionError === undefined &&
    (dryRun || (sessionResults.length === surfaces.length && !harnessError));

  return {
    schema: SCRIPTED_BROWSER_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
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
                ? harnessError
                  ? `Scripted session ended with a harness error: ${sessionResults.find((result) => result.completionReason === "harness_error")?.reason ?? "unknown"}`
                  : "Scripted lab did not produce terminal sessions for every surface."
                : (observer.error?.message ?? "Observer failed for the scripted lab run.")),
          },
        }),
  };
}
