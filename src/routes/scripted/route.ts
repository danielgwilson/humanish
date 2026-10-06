// The scripted route replays a committed scenario's browser steps with the registry-resolved
// scripted-browser actor, against a loopback app the operator runs or one synthetic clone served
// in E2B. A run reads top to bottom in runScriptedPlanInScope: setup's checks (setup.ts), startRun,
// provision a clone subject (subject.ts), one browser session per surface (surface-sessions.ts),
// each surface's trace, then finishScriptedRun (result.ts), which assembles the bundle and review.
//
// Spend: scripted steps make no model requests, and their traces record zero token usage. A local
// app-url run spends no sandbox minutes; a live clone run spends E2B minutes to clone and serve the
// subject. `mode: live` is required anyway, because a live run actuates a real browser
// against a real app (it fills forms and clicks buttons). A dry run parses and digest-pins the
// scenario and writes the contract bundle without touching anything.
//
// Subject provenance: an app-url run declares that humanish did not provision the
// subject, so its build provenance is unpinned and the evidence binds to the scenario digest. A
// clone run records commit, env names, state provenance and a host digest, never the raw getHost
// URL or a secret value.

import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ScriptedBrowserSessionResult } from "../../actors/scripted-browser/actor.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type { ScriptedPlan } from "../../study/plan-types.js";
import type { AdmittedPlan } from "../../run-study.js";
import { prepareSelectedOutputDirectory } from "../../run/contained-output.js";
import { type RunScope } from "../../run/run.js";
import { admitRoute, completeRefusalAnalysis, type RefusedStudy } from "../../run/route-shell.js";
import { renderScriptedReviewMarkdown } from "./bundle.js";
import { type ScriptedRefusal } from "./plan.js";
import { finishScriptedRun } from "./result.js";
import { UnsafeScriptedSessionResultError } from "./session-result.js";
import { prepareScriptedRun } from "./setup.js";
import { ScriptedSubject } from "./subject.js";
import { runScriptedSessions, writeSurfaceTraces } from "./surface-sessions.js";
import { type ScriptedBrowserStudyResult, type ScriptedRunInput } from "./types.js";
import { refusedResult } from "../../run/study-result.js";

/**
 * A refused scripted study's result, at the refusal's stage: a before-scope refusal has its own field
 * order and no analysis record; the others come after the output directory checks.
 */
export async function scriptedStudyRefusal(
  options: ScriptedRunInput & RefusedStudy,
  refusal: ScriptedRefusal,
): Promise<ScriptedBrowserStudyResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const actorType = config.actor?.type ?? "";
  const error = { code: refusal.code, message: refusal.message };
  if (refusal.beforeScope)
    return refusedResult(
      "scripted",
      { studyId: config.id, cwd, error },
      {
        actor: actorType,
        dryRun,
        runId: options.runId ?? "not-created",
        appUrl: config.subject.appUrl ?? "",
        sessions: [],
      },
    );
  // The other refusals come after the output directory checks and carry the analysis record.
  const physicalCwd = await realpath(cwd);
  await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const refused: ScriptedBrowserStudyResult = refusedResult(
    "scripted",
    { studyId: config.id, cwd, error },
    {
      actor: refusal.actor ?? actorType,
      appUrl: refusal.appUrl ?? config.subject.appUrl ?? "",
      dryRun,
      runId: options.runId ?? "not-created",
      sessions: [],
    },
  );
  return completeRefusalAnalysis(refused, config, options);
}

/**
 * runStudyWith's step for a scripted plan. It takes no scorer, and its local checks (keys, a browser)
 * run inside the run, so it returns the run.
 */
export function admitScriptedPlan(
  plan: ScriptedPlan,
  input: ScriptedRunInput,
): Promise<AdmittedPlan<"scripted">> {
  return admitRoute({
    route: "scripted",
    analysis: plan.analysis,
    input,
    admit: () => ({ ok: true, admitted: plan }),
    runInScope: runScriptedPlanInScope,
  });
}

async function runScriptedPlanInScope(
  plan: ScriptedPlan,
  input: ScriptedRunInput,
  scope: RunScope,
): Promise<ScriptedBrowserStudyResult> {
  const prepared = await prepareScriptedRun(plan, input);
  if (!prepared.ok) return prepared.result;
  const { dryRun } = plan;
  const { setup } = prepared;

  const started = await scope.startRun(plan, input, {
    cwd: setup.physicalCwd,
    prefix: "scripted",
    // Only a clone subject is served from a sandbox; an app-url run drives a local browser.
    sandboxes: setup.clone ? undefined : "none",
    renderReview: renderScriptedReviewMarkdown,
    secrets: setup.secrets,
  });
  if (!started.ok) {
    return setup.failed(started.code, started.message);
  }
  const { run } = started;
  const { paths: runPaths, source } = run;
  const artifactRoot = runPaths.physicalRunRoot;

  const scriptedSubject = setup.clone
    ? new ScriptedSubject({
        plan,
        clone: setup.clone,
        deps: setup.deps,
        ...(input.prepareDesktop === undefined ? {} : { prepareDesktop: input.prepareDesktop }),
        env: setup.env,
        e2bApiKey: setup.e2bApiKey,
        runPaths,
        timeoutMs: setup.timeoutMs,
        subjectEnvNames: setup.subjectEnvNames,
        hasGithubToken: setup.hasGithubToken,
        scrubKnownValues: run.secrets.scrub,
        now: setup.deps.now ?? Date.now,
        warnings: setup.warnings,
      })
    : undefined;
  let sessionResults: ScriptedBrowserSessionResult[] = [];
  let sessionError: string | undefined;

  if (!dryRun) {
    try {
      const appUrl = scriptedSubject ? await scriptedSubject.provision() : setup.appUrl;
      sessionResults = await runScriptedSessions(
        {
          appUrl,
          evidenceAppUrl: setup.evidenceAppUrl,
          urlPolicy: setup.urlPolicy,
          journey: setup.journey,
          persona: setup.persona,
          timeoutMs: setup.timeoutMs,
          artifactRoot,
          scrubKnownValues: run.secrets.scrub,
        },
        {
          surfaces: setup.surfaces,
          deps: setup.deps,
          browserCommand: setup.browserCommand,
          runPaths,
          onSessionStart: () => run.participantStarted(),
        },
      );
    } catch (error) {
      if (error instanceof UnsafeScriptedSessionResultError) {
        throw error;
      }
      // The session itself maps launch failures to harness_error; reaching here means the
      // harness around it failed. Redacted at this boundary before persisting anywhere.
      sessionError = redactText(run.secrets.scrub(toErrorMessage(error)));
    } finally {
      await scriptedSubject?.sandbox.release();
    }

    await writeSurfaceTraces(runPaths, sessionResults);
  }

  return finishScriptedRun({
    plan,
    cwd: setup.cwd,
    evidenceAppUrl: setup.evidenceAppUrl,
    run,
    source,
    journey: setup.journey,
    scenario: setup.scenario,
    persona: setup.persona,
    surfaces: setup.surfaces,
    sessionResults,
    sessionError,
    warnings: setup.warnings,
    clone: setup.clone,
    redactRepoLabel: setup.redactRepoLabel,
    subjectEnvNames: setup.subjectEnvNames,
    scriptedSubject,
  });
}
