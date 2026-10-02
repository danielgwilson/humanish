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
// Subject provenance: an app-url run declares that the lab did not provision the
// subject, so its build provenance is unpinned and the evidence binds to the scenario digest. A
// clone run records commit, env names, state provenance and a host digest, never the raw getHost
// URL or a secret value.

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ScriptedBrowserSessionResult } from "../../actors/scripted-browser/actor.js";
import { completeAutomaticAnalysis } from "../../analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type { ScriptedPlan } from "../../lab/plan-types.js";
import type { AdmittedPlan } from "../../run-lab.js";
import { buildRunSource } from "../../run/bundle.js";
import { prepareSelectedOutputDirectory } from "../../run/contained-output.js";
import { runScope, type RunScope } from "../../run/run.js";
import { renderScriptedReviewMarkdown } from "./bundle.js";
import { injectedBrowser, planScriptedLab, type ScriptedRefusal } from "./plan.js";
import { finishScriptedRun } from "./result.js";
import { UnsafeScriptedSessionResultError } from "./session-result.js";
import { prepareScriptedRun } from "./setup.js";
import { ScriptedSubject } from "./subject.js";
import { runScriptedSessions, writeSurfaceTraces } from "./surface-sessions.js";
import {
  SCRIPTED_BROWSER_LAB_SCHEMA,
  type RunScriptedBrowserLabOptions,
  type ScriptedBrowserLabResult,
  type ScriptedRunInput,
} from "./types.js";

/**
 * The config-taking entry point. It plans, returns a refusal with the envelope the route has always
 * returned at that refusal's stage, and otherwise runs the plan.
 */
export async function runScriptedBrowserLab(
  options: RunScriptedBrowserLabOptions,
): Promise<ScriptedBrowserLabResult> {
  const { config, dryRun, ...input } = options;
  // planScriptedLab makes every configuration refusal, in the order this route always has.
  const planned = planScriptedLab(config, {
    dryRun,
    injectedBrowser: injectedBrowser(input.deps),
  });
  if (planned.ok) return runScriptedPlan(planned.plan, input);
  return scriptedLabRefusal(options, planned.refusal);
}

/**
 * A refused scripted lab's result, at the refusal's stage: a before-scope refusal has its own field
 * order and no analysis record; the others come after the output directory checks.
 */
export async function scriptedLabRefusal(
  options: RunScriptedBrowserLabOptions,
  refusal: ScriptedRefusal,
): Promise<ScriptedBrowserLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const actorType = config.actors[0]?.type ?? "";
  if (refusal.beforeScope)
    return {
      schema: SCRIPTED_BROWSER_LAB_SCHEMA,
      ok: false,
      cwd,
      labId: config.id,
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
  const refused: ScriptedBrowserLabResult = {
    schema: SCRIPTED_BROWSER_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: refusal.actor ?? actorType,
    appUrl: refusal.appUrl ?? config.subject.appUrl ?? "",
    dryRun,
    runId: options.runId ?? "not-created",
    sessions: [],
    warnings: [],
    error: { code: refusal.code, message: refusal.message },
  };
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  return completeAutomaticAnalysis(
    refused,
    undefined,
    analysis.ok ? analysis.config : undefined,
    options,
    { trigger: config.review?.analysis === undefined ? "default" : "explicit" },
  );
}

/**
 * runLab's step for a scripted plan. It takes no scorer, and its local checks (keys, a browser)
 * run inside the run, so it returns the run.
 */
export function admitScriptedPlan(
  plan: ScriptedPlan,
  input: ScriptedRunInput,
): AdmittedPlan<"scripted"> {
  return {
    ok: true,
    run: async () => ({
      route: "scripted",
      result: await runScriptedPlan(plan, input),
    }),
  };
}

/**
 * Run a scripted plan. The run scope gives a direct library caller the same status-record lifetime
 * the CLI gets: returning from this function finalizes any record the run opened, whichever of its
 * fail-closed exits it took. Each route opens its own scope; `runLab` opens none. Without this a
 * test or an adopter calling the route directly leaves
 * the 5s cadence ticking into a directory something else is deleting, which surfaces as an
 * unrelated ENOTEMPTY.
 */
export async function runScriptedPlan(
  plan: ScriptedPlan,
  input: ScriptedRunInput,
): Promise<ScriptedBrowserLabResult> {
  const { result, finished } = await runScope((scope) =>
    runScriptedPlanInScope(plan, input, scope),
  );
  return completeAutomaticAnalysis(result, finished, plan.analysis?.config, input, {
    ...(plan.analysis === undefined ? {} : { trigger: plan.analysis.trigger }),
    preferLargerOutput: plan.analysis?.preferLargerOutput === true,
  });
}

async function runScriptedPlanInScope(
  plan: ScriptedPlan,
  input: ScriptedRunInput,
  scope: RunScope,
): Promise<ScriptedBrowserLabResult> {
  const prepared = await prepareScriptedRun(plan, input);
  if (!prepared.ok) return prepared.result;
  const { dryRun } = plan;
  const { setup } = prepared;

  const started = await scope.startRun({
    cwd: setup.physicalCwd,
    runId: input.runId,
    mintRunId: makeScriptedRunId,
    mode: dryRun ? "dry-run" : "live",
    lab: plan.lab,
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
