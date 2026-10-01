// The scripted-browser lab backend: either an app-url subject (a loopback app the operator
// already runs) or one provisioned synthetic clone subject (served in E2B and exposed through
// getHost) driven by the REGISTRY-RESOLVED scripted-browser actor.
// Mirrors routes/computer-use/route.ts: the descriptor returned by the registry runs the session; this
// backend consumes `scenario.ref` (resolves the committed scenario whose browser steps are the
// actor's behavior), composes the per-surface sessions, persists the evidence bundle, and renders
// the Observer. Beside it, scenario.ts resolves `scenario.ref`, session-result.ts checks each
// session result before it is persisted, and bundle.ts assembles the bundle and review.
//
// Spend posture: scripted participant steps make no model requests, and their traces record
// tokenUsage zeros. Post-run analysis has a separate model budget unless explicitly disabled. Local
// app-url runs also spend no sandbox minutes; live provisioned clone runs can spend E2B
// sandbox minutes to clone/serve the synthetic subject. `scenario.mode: live` is still
// required because the gate's justification here is ACTUATION: a live scripted run drives a
// real browser against a real running app (fills forms, clicks buttons — state-mutating
// effects), which deserves the same affirmative declaration as spend. Dry-run (the default)
// parses and digest-pins the scenario and emits the contract bundle without touching anything.
//
// Subject provenance (invariant 5): local app-url runs declare that the lab did NOT provision
// the subject, so build/commit provenance is UNPINNED and the evidence binds to the scenario
// digest instead. Provisioned clone runs persist structured commit/env-name/state provenance
// plus a host digest while never writing the raw getHost URL or secret values into artifacts.

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ActorPersonaRef } from "../../actors/contract.js";
import {
  runScriptedBrowserSessionInPreparedRoot,
  type ScriptedBrowserSessionOptions,
  type ScriptedBrowserSessionResult,
} from "../../actors/scripted-browser/actor.js";
import { resolveBrowserCommand } from "../../actors/scripted-browser/browser-command.js";
import type {
  BrowserPersonaJourney,
  ScriptedBrowserEvidenceUrlPolicy,
} from "../../actors/scripted-browser/types.js";
import { completeAutomaticAnalysis } from "../../analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import { buildRunSource } from "../../run/bundle.js";
import {
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "../../run/paths.js";
import { runScope, type RunScope } from "../../run/run.js";
import {
  prepareSelectedOutputDirectory,
  writeContainedOutputFile,
} from "../../run/contained-output.js";
import { renderScriptedReviewMarkdown } from "./bundle.js";
import { evidenceAppUrlOf, planScriptedLab, type ScriptedRefusal } from "./plan.js";
import { resolveScriptedScenario } from "./scenario.js";
import {
  UnsafeScriptedSessionResultError,
  validateScriptedSessionResult,
} from "./session-result.js";
import { ScriptedSubject } from "./subject.js";
import {
  SCRIPTED_BROWSER_LAB_SCHEMA,
  type RunScriptedBrowserLabOptions,
  type ScriptedBrowserLabHooks,
  type ScriptedBrowserLabResult,
  type ScriptedRunInput,
} from "./types.js";
import { finishScriptedRun } from "./result.js";
import type { ScriptedPlan } from "../../lab/plan-types.js";
import { scriptedInput } from "../../lab/route-inputs.js";
import type { AdmittedPlan } from "../../run-lab.js";
import path from "node:path";

// Journey wall-clock budget per surface: 5 minutes. A scripted surface has zero model cost and
// sandbox-seconds are pennies; a short default only truncated slow-loading subjects.
const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

/**
 * The config-taking entry point. It plans, returns a refusal with the envelope the route has always
 * returned at that refusal's stage, and otherwise runs the plan.
 */
export async function runScriptedBrowserLab(
  options: RunScriptedBrowserLabOptions,
): Promise<ScriptedBrowserLabResult> {
  const { config, dryRun, lab, ...input } = options;
  // planScriptedLab makes every configuration refusal, in the order this route always has.
  const planned = planScriptedLab(config, {
    dryRun,
    ...(lab === undefined ? {} : { lab }),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
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
    options.automaticAnalysis,
    { trigger: config.review?.analysis === undefined ? "default" : "explicit" },
  );
}

/** runLab's step for a scripted plan: its local checks run inside the run, so it returns the run. */
export function admitScriptedPlan(plan: ScriptedPlan): AdmittedPlan<"scripted"> {
  return {
    ok: true,
    run: async (options) => ({
      route: "scripted",
      backend: "scripted",
      result: await runScriptedPlan(plan, scriptedInput(options)),
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
  return completeAutomaticAnalysis(
    result,
    finished,
    plan.analysis?.config,
    input.automaticAnalysis,
    {
      ...(plan.analysis === undefined ? {} : { trigger: plan.analysis.trigger }),
      preferLargerOutput: plan.analysis?.preferLargerOutput === true,
    },
  );
}

/** What setup hands the run: the plan's subject and scenario, keys and the browser to launch. */
interface ScriptedRunSetup {
  cwd: string;
  physicalCwd: string;
  hooks: ScriptedBrowserLabHooks;
  warnings: string[];
  failed: (
    code: NonNullable<ScriptedBrowserLabResult["error"]>["code"],
    message: string,
  ) => ScriptedBrowserLabResult;
  clone: Extract<ScriptedPlan["subject"], { readonly kind: "clone" }> | undefined;
  evidenceAppUrl: string;
  urlPolicy: ScriptedBrowserEvidenceUrlPolicy;
  subjectEnvNames: string[];
  env: Record<string, string | undefined>;
  e2bApiKey: string;
  hasGithubToken: boolean;
  redactRepoLabel: boolean;
  scrubKnownValues: (text: string) => string;
  /** The loopback app URL, or the clone's serve URL until its getHost URL replaces it. */
  appUrl: string;
  scenario: { source: string; sourceDigest: string };
  journey: BrowserPersonaJourney;
  surfaces: ScriptedPlan["surfaces"];
  timeoutMs: number;
  persona: ActorPersonaRef;
  browserCommand: string | undefined;
}

/**
 * Checks what the plan cannot: the scenario file, the E2B key and subject env of a live clone,
 * and a browser to launch. Returns the refusal, or what the run needs.
 */
async function prepareScriptedRun(
  plan: ScriptedPlan,
  input: ScriptedRunInput,
): Promise<
  { ok: false; result: ScriptedBrowserLabResult } | { ok: true; setup: ScriptedRunSetup }
> {
  const { dryRun } = plan;
  const cwd = path.resolve(input.cwd);
  const physicalCwd = await realpath(cwd);
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const hooks = input.hooks ?? {};
  const warnings: string[] = [];
  const clone = plan.subject.kind === "clone" ? plan.subject : undefined;
  const evidenceAppUrl = evidenceAppUrlOf(plan.subject);
  const failed = (
    code: NonNullable<ScriptedBrowserLabResult["error"]>["code"],
    message: string,
  ): ScriptedBrowserLabResult => ({
    schema: SCRIPTED_BROWSER_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: plan.labId,
    actor: plan.actor,
    appUrl: evidenceAppUrl,
    dryRun,
    runId: input.runId ?? "not-created",
    sessions: [],
    warnings,
    error: { code, message },
  });

  const urlPolicy: ScriptedBrowserEvidenceUrlPolicy = clone
    ? { kind: "provisioned-subject", evidenceOrigin: evidenceAppUrl }
    : { kind: "loopback" };
  const subjectEnvNames = [...(clone?.env ?? [])];
  const env = hooks.env ?? process.env;
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");
  const redactRepoLabel = plan.residual.policies?.redactRepos ?? hasGithubToken;
  const scrubSourceValues = [
    ...(clone ? [clone.repo] : []),
    ...subjectEnvNames.map((name) => env[name] ?? ""),
  ].filter(Boolean);
  const scrubKnownValues = (text: string): string =>
    scrubSourceValues.reduce((acc, value) => acc.split(value).join("[redacted]"), text);

  // A clone's URL is replaced by its getHost URL once it is served.
  let appUrl = plan.subject.kind === "clone" ? plan.subject.serve.url : plan.subject.appUrl;

  const scenario = await resolveScriptedScenario(projectRoot, plan.scenarioRef);
  if (!scenario.ok) {
    return {
      ok: false,
      result: failed("HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID", scenario.message),
    };
  }
  const journey = scenario.journey;

  if (!dryRun && clone) {
    if (!e2bApiKey) {
      return {
        ok: false,
        result: failed(
          "HUMANISH_SCRIPTED_LAB_KEYS_MISSING",
          `Live clone scripted-browser labs require E2B_API_KEY (dry-run remains $0 and does not provision a subject). ${describeMissingKeys(["E2B_API_KEY"], env)}`,
        ),
      };
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return {
        ok: false,
        result: failed(
          "HUMANISH_SCRIPTED_LAB_SUBJECT_ENV_MISSING",
          `Subject env values missing for live clone scripted-browser lab: ${missingSubjectEnv.join(", ")}.`,
        ),
      };
    }
  }

  const surfaces = plan.surfaces;
  const timeoutMs = plan.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const persona: ActorPersonaRef = {
    id: plan.personaId ?? "scripted-journey",
    traitsApplied: [],
    // The step manifest IS the "prompt" on this lane; the digest binds the trace to the
    // committed scenario text.
    promptDigest: journey.sourceDigest.slice(0, 16),
  };

  // Live runs need a browser BEFORE any actuation (unless one is injected).
  let browserCommand = hooks.browserCommand;
  if (!dryRun && !hooks.launchBrowser && !browserCommand) {
    const resolved = await resolveBrowserCommand();
    if (!resolved) {
      return {
        ok: false,
        result: failed(
          "HUMANISH_SCRIPTED_LAB_BROWSER_MISSING",
          "No Chrome/Chromium browser command was found for the scripted-browser actor. Set HUMANISH_BROWSER_COMMAND to a browser binary playwright-core can launch.",
        ),
      };
    }
    browserCommand = resolved;
  }
  return {
    ok: true,
    setup: {
      cwd,
      physicalCwd,
      hooks,
      warnings,
      failed,
      clone,
      evidenceAppUrl,
      urlPolicy,
      subjectEnvNames,
      env,
      e2bApiKey,
      hasGithubToken,
      redactRepoLabel,
      scrubKnownValues,
      appUrl,
      scenario,
      journey,
      surfaces,
      timeoutMs,
      persona,
      browserCommand,
    },
  };
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
    observer: { open: input.open === true, render: setup.hooks.renderObserverFn },
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
        hooks: setup.hooks,
        env: setup.env,
        e2bApiKey: setup.e2bApiKey,
        runPaths,
        timeoutMs: setup.timeoutMs,
        subjectEnvNames: setup.subjectEnvNames,
        hasGithubToken: setup.hasGithubToken,
        scrubKnownValues: setup.scrubKnownValues,
        now: setup.hooks.now ?? Date.now,
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
          hooks: setup.hooks,
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

    for (const result of sessionResults) {
      // The backend writes the provider-neutral projection next to the session's native
      // traces/<surface>.json (cua's actor.json convention, pluralized per surface).
      await writeContainedOutputFile(
        runPaths,
        `actor-${result.capture.surface.id}.json`,
        `${JSON.stringify(result.trace, null, 2)}\n`,
        "utf8",
      );
    }
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

/** One session per surface, in parallel. */
function runScriptedSessions(
  session: Required<
    Pick<
      ScriptedBrowserSessionOptions,
      | "appUrl"
      | "evidenceAppUrl"
      | "urlPolicy"
      | "journey"
      | "persona"
      | "timeoutMs"
      | "artifactRoot"
    >
  >,
  run: {
    surfaces: ScriptedPlan["surfaces"];
    hooks: ScriptedBrowserLabHooks;
    browserCommand: string | undefined;
    runPaths: PreparedRunArtifactPaths;
  },
): Promise<ScriptedBrowserSessionResult[]> {
  const { appUrl, evidenceAppUrl, urlPolicy, journey, persona, timeoutMs, artifactRoot } = session;
  const { surfaces, hooks, browserCommand, runPaths } = run;
  const runSession = hooks.runSession;
  return Promise.all(
    surfaces.map((surface) => {
      const sessionOptions: ScriptedBrowserSessionOptions = {
        appUrl,
        evidenceAppUrl,
        urlPolicy,
        journey,
        surface,
        persona,
        timeoutMs,
        artifactRoot,
        ...(browserCommand === undefined ? {} : { browserCommand }),
        ...(hooks.launchBrowser === undefined ? {} : { launchBrowser: hooks.launchBrowser }),
        ...(hooks.now === undefined ? {} : { now: hooks.now }),
      };
      return runSession
        ? runSession(sessionOptions).then(async (result) => {
            await validatePreparedRunArtifactPaths(runPaths);
            validateScriptedSessionResult(surface, result);
            return result;
          })
        : runScriptedBrowserSessionInPreparedRoot(sessionOptions, runPaths);
    }),
  );
}

function makeScriptedRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `scripted-${stamp}-${randomBytes(4).toString("hex")}`;
}
