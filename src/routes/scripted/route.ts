// The scripted route replays a committed scenario's browser steps with the registry-resolved
// scripted-browser actor, against a loopback app the operator runs or one synthetic clone served
// in E2B. A run reads top to bottom in runScriptedPlanInScope: setup's checks (setup.ts), startRun,
// provision a clone subject (subject.ts), one browser session per surface (surface-sessions.ts),
// each surface's trace, then finishScriptedRun (result.ts), which assembles the bundle and review.
//
// Spend: scripted steps make no model requests, and their traces record zero token usage. A local
// app-url run spends no sandbox minutes; a live clone run spends E2B minutes to clone and serve the
// subject. `scenario.mode: live` is required anyway, because a live run actuates a real browser
// against a real app (it fills forms and clicks buttons). A dry run parses and digest-pins the
// scenario and writes the contract bundle without touching anything.
//
// Subject provenance: an app-url run declares that humanish did not provision the
// subject, so its build provenance is unpinned and the evidence binds to the scenario digest. A
// clone run records commit, env names, state provenance and a host digest, never the raw getHost
// URL or a secret value.

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ScriptedBrowserSessionResult } from "../../actors/scripted-browser/actor.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type { ScriptedPlan } from "../../study/plan-types.js";
import type { AdmittedPlan } from "../../run-study.js";
import { buildRunSource } from "../../run/bundle.js";
import { prepareSelectedOutputDirectory } from "../../run/contained-output.js";
import { type RunScope } from "../../run/run.js";
import { admitRoute, completeRefusalAnalysis, type RefusedStudy } from "../../run/route-shell.js";
import { renderScriptedReviewMarkdown } from "./bundle.js";
import { injectedBrowser, planScriptedStudy, type ScriptedRefusal } from "./plan.js";
import { finishScriptedRun } from "./result.js";
import { UnsafeScriptedSessionResultError } from "./session-result.js";
import { prepareScriptedRun } from "./setup.js";
import { ScriptedSubject } from "./subject.js";
import { runScriptedSessions, writeSurfaceTraces } from "./surface-sessions.js";
import {
  type RunScriptedBrowserStudyOptions,
  type ScriptedBrowserStudyResult,
  type ScriptedRunInput,
} from "./types.js";
import { studyResultIdentity } from "../../run/study-result.js";

/**
 * The config-taking entry point. It plans, returns a refusal with the envelope the route has always
 * returned at that refusal's stage, and otherwise runs the plan.
 */
export async function runScriptedBrowserStudy(
  options: RunScriptedBrowserStudyOptions,
): Promise<ScriptedBrowserStudyResult> {
  const { config, dryRun, ...input } = options;
  // planScriptedStudy makes every configuration refusal, in the order this route always has.
  const planned = planScriptedStudy(config, {
    dryRun,
    injectedBrowser: injectedBrowser(input.deps),
  });
  if (planned.ok) return runScriptedPlan(planned.plan, input);
  return scriptedStudyRefusal(options, planned.refusal);
}

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
  const actorType = config.actors[0]?.type ?? "";
  if (refusal.beforeScope)
    return {
      ...studyResultIdentity("scripted", config.id),
      ok: false,
      cwd,
      actor: actorType,
      dryRun,
      runId: options.runId ?? "not-created",
      appUrl: config.subject.appUrl ?? "",
      sessions: [],
      warnings: [],
      error: { code: refusal.code, message: refusal.message },
    };
  // The other refusals come after the output directory checks and carry the analysis record.
  const physicalCwd = await realpath(cwd);
  await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const refused: ScriptedBrowserStudyResult = {
    ...studyResultIdentity("scripted", config.id),
    ok: false,
    cwd,
    actor: refusal.actor ?? actorType,
    appUrl: refusal.appUrl ?? config.subject.appUrl ?? "",
    dryRun,
    runId: options.runId ?? "not-created",
    sessions: [],
    warnings: [],
    error: { code: refusal.code, message: refusal.message },
  };
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

/** Run a scripted plan through admitScriptedPlan. */
export async function runScriptedPlan(
  plan: ScriptedPlan,
  input: ScriptedRunInput,
): Promise<ScriptedBrowserStudyResult> {
  const admitted = await admitScriptedPlan(plan, input);
  return (admitted.ok ? await admitted.run() : admitted.outcome).result;
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

  const started = await scope.startRun({
    cwd: setup.physicalCwd,
    runId: input.runId,
    mintRunId: makeScriptedRunId,
    mode: dryRun ? "dry-run" : "live",
    study: plan.study,
    renderReview: renderScriptedReviewMarkdown,
    observer: { open: input.open === true, render: setup.deps.renderObserver },
  });
  if (!started.ok) {
    return setup.failed(started.code, started.message);
  }
  const { run } = started;
  const { createdAt, paths: runPaths } = run;
  const artifactRoot = runPaths.physicalRunRoot;
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd: setup.physicalCwd,
    humanishSource: "present",
    packageName: "humanish",
  });

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
        scrubKnownValues: setup.scrubKnownValues,
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
        },
        {
          surfaces: setup.surfaces,
          deps: setup.deps,
          browserCommand: setup.browserCommand,
          runPaths,
        },
      );
    } catch (error) {
      if (error instanceof UnsafeScriptedSessionResultError) {
        throw error;
      }
      // The session itself maps launch failures to harness_error; reaching here means the
      // harness around it failed. Redacted at this boundary before persisting anywhere.
      sessionError = redactText(setup.scrubKnownValues(toErrorMessage(error)));
    } finally {
      await scriptedSubject?.teardown();
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

function makeScriptedRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `scripted-${stamp}-${randomBytes(4).toString("hex")}`;
}
