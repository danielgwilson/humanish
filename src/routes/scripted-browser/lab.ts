// The scripted-browser lab backend: either an app-url subject (a loopback app the operator
// already runs) or one provisioned synthetic clone subject (served in E2B and exposed through
// getHost) driven by the REGISTRY-RESOLVED scripted-browser actor.
// Mirrors routes/computer-use/lab.ts: the descriptor returned by the registry runs the session; this
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
import path from "node:path";
import type { ActorCompletionReason, ActorPersonaRef, ActorStatus } from "../../actors/contract.js";
import { actorRegistry, isScriptedBrowserActorDescriptor } from "../../actors/registry.js";
import {
  runScriptedBrowserSessionInPreparedRoot,
  type ScriptedBrowserSessionOptions,
  type ScriptedBrowserSessionResult,
} from "../../actors/scripted-browser/actor.js";
import { resolveBrowserCommand } from "../../actors/scripted-browser/browser-command.js";
import { normalizeLocalAppUrl } from "../../actors/scripted-browser/steps.js";
import {
  browserSurfaces,
  type ScriptedBrowserEvidenceUrlPolicy,
  type ScriptedBrowserLaunchArgs,
  type ScriptedBrowserLike,
} from "../../actors/scripted-browser/types.js";
import {
  completeAutomaticAnalysis,
  type AutomaticAnalysisHooks,
  type AutomaticAnalysisResult,
} from "../../analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type { LabConfig } from "../../lab/types.js";
import {
  cloneTargetValidationReason,
  desktopMediaValidationReason,
  taskProtocolValidationReason,
} from "../../lab/validation.js";
import { renderObserver, type ObserverResult } from "../../observer/render.js";
import {
  buildRunSource,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
} from "../../run/bundle.js";
import { validatePreparedRunArtifactPaths } from "../../run/paths.js";
import { runScope, type RunScope } from "../../run/run.js";
import {
  prepareSelectedOutputDirectory,
  writeContainedOutputFile,
} from "../../run/selected-output-paths.js";
import type { RunLabProvenance } from "../../run/status.js";
import { provisionCloneSubject } from "../../subject/clone.js";
import { commandDigestOf } from "../../subject/state.js";
import type { DetachedTimers } from "../../substrates/detached.js";
import {
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox,
} from "../../substrates/e2b/desktop-launch.js";
import {
  observeDesktopResources,
  type DesktopResourceObservation,
} from "../../substrates/e2b/desktop-resources.js";
import { acquireE2BDesktopSandbox } from "../../substrates/e2b/sandbox.js";
import { e2bShell } from "../../substrates/e2b/shell.js";
import { resolveSubjectState } from "../computer-use/lab.js";
import { buildScriptedLabBundle, renderScriptedReviewMarkdown } from "./bundle.js";
import { resolveScriptedScenario } from "./scenario.js";
import {
  UnsafeScriptedSessionResultError,
  existingScreenshots,
  validateScriptedSessionResult,
} from "./session-result.js";

export const SCRIPTED_BROWSER_LAB_SCHEMA = "humanish.scripted-lab-result.v1";

// Journey wall-clock budget per surface: 5 minutes. A scripted surface has zero model cost and
// sandbox-seconds are pennies; a short default only truncated slow-loading subjects.
const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;

const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;

const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;

// Default surface roster is 1 (desktop only): the defaults-table single-lane row governs;
// `count: 2` is the declared override that adds the mobile surface.
const DEFAULT_SURFACE_COUNT = 1;

/**
 * Library-level hooks: DI seams so CI drives the full path (real engine, real projection)
 * with a fake browser at zero spend, plus the production browser resolution override.
 */
export interface ScriptedBrowserLabHooks {
  runSession?: (options: ScriptedBrowserSessionOptions) => Promise<ScriptedBrowserSessionResult>;
  /** Injected browser factory — forwarded to every session; skips browser-binary resolution. */
  launchBrowser?: (args: ScriptedBrowserLaunchArgs) => Promise<ScriptedBrowserLike>;
  /** Test/library env seam; CLI passes process.env. Values are scrubbed, names only persist. */
  env?: Record<string, string | undefined>;
  /** E2B DI seam for clone × e2b-desktop × scripted-browser. */
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  /** Optional adopter hook after subject sandbox creation, before clone provisioning. */
  prepareDesktop?: (desktop: E2BDesktopSandbox) => Promise<void>;
  /** Detached-step timers for deterministic tests around clone/seed/start provisioning. */
  detachedTimers?: DetachedTimers;
  /** Override the resolved browser binary (tests; operators use HUMANISH_BROWSER_COMMAND). */
  browserCommand?: string;
  renderObserverFn?: typeof renderObserver;
  now?: () => number;
}

export interface RunScriptedBrowserLabOptions {
  automaticAnalysis?: AutomaticAnalysisHooks;
  /** Which manifest produced this run (#455); threaded into the status record + bundle. */
  lab?: RunLabProvenance;
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  hooks?: ScriptedBrowserLabHooks;
}

export interface ScriptedBrowserLabSession {
  surface: string;
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  screenshots: number;
}

export interface ScriptedBrowserLabResult extends AutomaticAnalysisResult {
  schema: typeof SCRIPTED_BROWSER_LAB_SCHEMA;
  /** True when the bundle verified AND (dry-run, or every session reached a terminal verdict
   * without a harness error). The subject failing the script is successful EVIDENCE, not a lab
   * failure. */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the sessions. */
  actor: string;
  appUrl: string;
  dryRun: boolean;
  runId: string;
  subject?: RunSubjectProvenance;
  subjectSandbox?: { sandboxId: string; killed: boolean };
  hostDigest?: string;
  /** The consumed scenario.ref: digest-pinned provenance of the executable steps. */
  scenario?: {
    id: string;
    source: string;
    sourceDigest: string;
    steps: number;
  };
  sessions: ScriptedBrowserLabSession[];
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code:
      | "HUMANISH_LAB_ANALYSIS_INVALID"
      | "HUMANISH_LAB_TASKS_UNSUPPORTED"
      | "HUMANISH_SCRIPTED_LAB_FAILED"
      | "HUMANISH_SCRIPTED_LAB_ACTOR_UNSUPPORTED"
      | "HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID"
      | "HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE"
      | "HUMANISH_SCRIPTED_LAB_BROWSER_MISSING"
      | "HUMANISH_SCRIPTED_LAB_KEYS_MISSING"
      | "HUMANISH_SCRIPTED_LAB_SUBJECT_ENV_MISSING"
      | "HUMANISH_SCRIPTED_LAB_GETHOST_UNAVAILABLE"
      | "HUMANISH_RUN_ID_IN_USE";
    message: string;
  };
}

/**
 * Wrapped so a DIRECT library caller gets the same status-record lifetime the CLI does: returning
 * from this function finalizes any record the run opened, whichever of its fail-closed exits it
 * took. `runLab` establishes a scope too and nesting is harmless — the inner scope owns what it
 * opened. Without this a test or an adopter calling the backend directly leaves the 5s cadence
 * ticking into a directory something else is deleting, which surfaces as an unrelated ENOTEMPTY.
 */
export async function runScriptedBrowserLab(
  options: RunScriptedBrowserLabOptions,
): Promise<ScriptedBrowserLabResult> {
  if (String(options.config.comms?.email?.kind) === "real")
    return {
      schema: SCRIPTED_BROWSER_LAB_SCHEMA,
      ok: false,
      cwd: path.resolve(options.cwd),
      labId: options.config.id,
      actor: options.config.actors[0]?.type ?? "",
      dryRun: options.dryRun,
      runId: options.runId ?? "not-created",
      appUrl: options.config.subject.appUrl ?? "",
      sessions: [],
      warnings: [],
      error: {
        code: "HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID",
        message:
          "Real email receiving is unsupported on the scripted-browser backend. Use a supported hosted computer-use browser study.",
      },
    };
  const analysisReason = resolveAutomaticAnalysis(options.config.review?.analysis);
  const tasksReason = analysisReason.ok
    ? taskProtocolValidationReason(options.config, false)
    : analysisReason.message;
  if (tasksReason)
    return {
      schema: SCRIPTED_BROWSER_LAB_SCHEMA,
      ok: false,
      cwd: path.resolve(options.cwd),
      labId: options.config.id,
      actor: options.config.actors[0]?.type ?? "",
      dryRun: options.dryRun,
      runId: options.runId ?? "not-created",
      appUrl: options.config.subject.appUrl ?? "",
      sessions: [],
      warnings: [],
      error: {
        code: analysisReason.ok
          ? "HUMANISH_LAB_TASKS_UNSUPPORTED"
          : "HUMANISH_LAB_ANALYSIS_INVALID",
        message: tasksReason,
      },
    };
  const analysis = resolveAutomaticAnalysis(options.config.review?.analysis);
  const { result, finished } = await runScope((scope) =>
    runScriptedBrowserLabInScope(options, scope),
  );
  return completeAutomaticAnalysis(
    result,
    finished,
    analysis.ok ? analysis.config : undefined,
    options.automaticAnalysis,
    options.config.review?.analysis === undefined ? "default" : "explicit",
    analysis.ok && analysis.preferLargerOutput === true,
  );
}

async function runScriptedBrowserLabInScope(
  options: RunScriptedBrowserLabOptions,
  scope: RunScope,
): Promise<ScriptedBrowserLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const physicalCwd = await realpath(cwd);
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const hooks = options.hooks ?? {};
  const warnings: string[] = [];
  const actorType = config.actors[0]?.type ?? "";

  const failed = (
    code: NonNullable<ScriptedBrowserLabResult["error"]>["code"],
    message: string,
    extras?: { actor?: string; appUrl?: string },
  ): ScriptedBrowserLabResult => ({
    schema: SCRIPTED_BROWSER_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: extras?.actor ?? actorType,
    appUrl: extras?.appUrl ?? config.subject.appUrl ?? "",
    dryRun,
    runId: options.runId ?? "not-created",
    sessions: [],
    warnings,
    error: { code, message },
  });

  // Resolve the actor through the registry — the parse layer already validated this, but the
  // engine fails closed rather than trusting a config that arrived through another door
  // (runScriptedBrowserLab is itself exported npm surface).
  const mediaReason = desktopMediaValidationReason(config);
  if (mediaReason) return failed("HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID", mediaReason);
  const cloneTargetReason = cloneTargetValidationReason(config);
  if (cloneTargetReason) return failed("HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE", cloneTargetReason);

  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isScriptedBrowserActorDescriptor(descriptor)) {
    return failed(
      "HUMANISH_SCRIPTED_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered scripted-browser actor.`,
    );
  }
  const runSession = hooks.runSession;
  const provisionedRoute = config.subject.source === "clone";
  const evidenceAppUrl = provisionedRoute
    ? "[provisioned-subject]"
    : (normalizeLocalAppUrl(config.subject.appUrl ?? "") ?? "");
  const urlPolicy: ScriptedBrowserEvidenceUrlPolicy = provisionedRoute
    ? { kind: "provisioned-subject", evidenceOrigin: evidenceAppUrl }
    : { kind: "loopback" };
  const serve = config.subject.serve;
  const subjectRepo = provisionedRoute ? (config.subject.repos?.[0] ?? "") : undefined;
  const subjectEnvNames = provisionedRoute ? (config.subject.env ?? []) : [];
  const env = hooks.env ?? process.env;
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");
  const redactRepoLabel = config.policies?.redactRepos ?? hasGithubToken;
  const publicRepo =
    provisionedRoute && subjectRepo ? (redactRepoLabel ? "repo-01" : subjectRepo) : undefined;
  const scrubSourceValues = [
    ...(subjectRepo ? [subjectRepo] : []),
    ...subjectEnvNames.map((name) => env[name] ?? ""),
  ].filter(Boolean);
  const scrubKnownValues = (text: string): string =>
    scrubSourceValues.reduce((acc, value) => acc.split(value).join("[redacted]"), text);

  // Re-enforce the local loopback entry boundary at the engine. The provisioned clone route
  // mints its own getHost URL later and persists only evidenceAppUrl.
  let appUrl = provisionedRoute ? (serve?.url ?? "") : evidenceAppUrl;
  if (!provisionedRoute && !appUrl) {
    return failed(
      "HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE",
      "subject.appUrl must be a loopback http(s) URL (127.0.0.1 or localhost) on the scripted-browser route.",
      { actor: descriptor.id },
    );
  }
  if (provisionedRoute && (!serve || !subjectRepo || !publicRepo)) {
    return failed(
      "HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE",
      "clone scripted-browser labs require one subject repo plus subject.serve; parseLabConfig should have rejected this config.",
      { actor: descriptor.id, appUrl: evidenceAppUrl },
    );
  }

  // Consume scenario.ref (fail-closed: invariant 6 — the steps ARE the actor; there is no
  // built-in journey fallback on the lab route).
  const scenario = await resolveScriptedScenario(projectRoot, config.scenario?.ref);
  if (!scenario.ok) {
    return failed("HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID", scenario.message, {
      actor: descriptor.id,
      appUrl: evidenceAppUrl,
    });
  }
  const journey = scenario.journey;

  if (!dryRun && provisionedRoute) {
    if (!e2bApiKey) {
      return failed(
        "HUMANISH_SCRIPTED_LAB_KEYS_MISSING",
        `Live clone scripted-browser labs require E2B_API_KEY (dry-run remains $0 and does not provision a subject). ${describeMissingKeys(["E2B_API_KEY"], env)}`,
        { actor: descriptor.id, appUrl: evidenceAppUrl },
      );
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return failed(
        "HUMANISH_SCRIPTED_LAB_SUBJECT_ENV_MISSING",
        `Subject env values missing for live clone scripted-browser lab: ${missingSubjectEnv.join(", ")}.`,
        { actor: descriptor.id, appUrl: evidenceAppUrl },
      );
    }
  }

  const surfaces = browserSurfaces.slice(0, config.actors[0]?.count ?? DEFAULT_SURFACE_COUNT);
  const timeoutMs = config.execution?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const persona: ActorPersonaRef = {
    id: config.actors[0]?.persona ?? "scripted-journey",
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
      return failed(
        "HUMANISH_SCRIPTED_LAB_BROWSER_MISSING",
        "No Chrome/Chromium browser command was found for the scripted-browser actor. Set HUMANISH_BROWSER_COMMAND to a browser binary playwright-core can launch.",
        { actor: descriptor.id, appUrl: evidenceAppUrl },
      );
    }
    browserCommand = resolved;
  }

  const started = await scope.startRun({
    cwd: physicalCwd,
    runId: options.runId,
    mintRunId: makeScriptedRunId,
    mode: dryRun ? "dry-run" : "live",
    lab: options.lab,
    renderReview: renderScriptedReviewMarkdown,
    observer: { open: options.open === true, render: hooks.renderObserverFn },
  });
  if (!started.ok) {
    return failed(started.code, started.message, { actor: descriptor.id, appUrl: evidenceAppUrl });
  }
  const { run } = started;
  const { runId, createdAt, paths: runPaths } = run;
  const artifactRoot = runPaths.physicalRunRoot;
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd: physicalCwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  let sessionResults: ScriptedBrowserSessionResult[] = [];
  let sessionError: string | undefined;
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  let subjectCommit: string | undefined;
  let subjectSandboxId: string | undefined;
  let subjectKilled = false;
  const now = hooks.now ?? Date.now;
  let subjectCreatedAtMs: number | undefined;
  let subjectTornDownAtMs: number | undefined;
  let subjectResources: DesktopResourceObservation | undefined;
  let hostDigest: string | undefined;

  if (!dryRun) {
    let subjectModule: E2BDesktopModule | undefined;
    let subjectDesktop: E2BDesktopSandbox | undefined;
    try {
      if (provisionedRoute) {
        const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
        const timers: DetachedTimers = hooks.detachedTimers ?? {};
        const subjectSandboxTimeoutMs =
          timeoutMs +
          SUBJECT_PROVISION_BUDGET_MS +
          (config.subject.state?.seed ?? []).reduce(
            (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
            0,
          ) +
          SANDBOX_TIMEOUT_BUFFER_MS;
        subjectModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
        await validatePreparedRunArtifactPaths(runPaths);
        // The receipt is on disk before any work on the sandbox, so `humanish reclaim` can kill
        // it by exact id when this process dies mid-run; the finally block below only runs while
        // the process is alive.
        const subject = await acquireE2BDesktopSandbox({
          module: subjectModule,
          options: {
            apiKey: e2bApiKey,
            requestTimeoutMs,
            timeoutMs: subjectSandboxTimeoutMs,
            metadata: {
              mode: "scripted-browser-lab",
              tool: "humanish",
              labId: config.id,
              role: "subject",
              actor: descriptor.id,
            },
            ...(subjectEnvNames.length > 0
              ? {
                  envs: Object.fromEntries(
                    subjectEnvNames.map((name) => [name, env[name] as string]),
                  ),
                }
              : {}),
            dpi: 96,
            lifecycle: { onTimeout: "kill" },
          },
          template: config.execution?.desktop?.template,
          receipt: { root: runPaths, laneId: "subject" },
        });
        subjectDesktop = subject.sandbox;
        subjectSandboxId = subject.allocation.resourceId;
        subjectCreatedAtMs = now();
        subjectResources = await observeDesktopResources(subjectDesktop);

        if (hooks.prepareDesktop) {
          await hooks.prepareDesktop(subjectDesktop);
          await validatePreparedRunArtifactPaths(runPaths);
        }

        subjectCommit = await provisionCloneSubject(e2bShell(subjectDesktop), {
          repo: subjectRepo!,
          depth: config.subject.clone?.depth ?? 1,
          serve: serve!,
          ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
          hasGithubToken,
          requestTimeoutMs,
          scrub: scrubKnownValues,
          onCommit: (commit) => {
            subjectCommit = commit;
          },
          onStateStep: (record) => {
            stateStepRecords.push(record);
          },
          ...timers,
        });

        if (typeof subjectDesktop.getHost !== "function") {
          throw new Error(
            "the installed @e2b/desktop SDK does not expose getHost(port); clone scripted-browser labs require it to reach the provisioned subject",
          );
        }
        const rawHost = subjectDesktop.getHost(servePort(serve!.url));
        const hostUrl = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
        if (!isTokenlessHost(hostUrl)) {
          throw new Error(
            "getHost returned a non-tokenless URL; refusing to persist or drive a host URL that may carry a credential",
          );
        }
        appUrl = hostUrl;
        hostDigest = hostOriginDigest(hostUrl);
      }

      // One session per surface, in parallel.
      sessionResults = await Promise.all(
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
    } catch (error) {
      if (error instanceof UnsafeScriptedSessionResultError) {
        throw error;
      }
      // The session itself maps launch failures to harness_error; reaching here means the
      // harness around it failed. Redacted at this boundary before persisting anywhere.
      sessionError = redactText(scrubKnownValues(toErrorMessage(error)));
    } finally {
      if (subjectSandboxId !== undefined && subjectModule) {
        if (typeof subjectModule.Sandbox.kill === "function") {
          try {
            await subjectModule.Sandbox.kill(subjectSandboxId, {
              requestTimeoutMs: 60_000,
            });
            subjectKilled = true;
          } catch (error) {
            warnings.push(
              `Subject sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
            );
          }
          subjectTornDownAtMs = now();
        } else {
          warnings.push(
            "Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the subject sandbox.",
          );
        }
      }
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

  const screenshotsBySurface = new Map<string, string[]>();
  for (const result of sessionResults) {
    screenshotsBySurface.set(
      result.capture.surface.id,
      await existingScreenshots(runPaths, result),
    );
  }
  const subject: RunSubjectProvenance | undefined = provisionedRoute
    ? {
        source: "clone",
        repo: publicRepo!,
        ...(subjectCommit === undefined ? {} : { commit: subjectCommit }),
        envNames: subjectEnvNames,
        state: resolveSubjectState({
          declared: config.subject.state,
          dryRun,
          executed: stateStepRecords,
        }),
      }
    : undefined;

  const bundle = buildScriptedLabBundle({
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    actorId: descriptor.id,
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
    ...(subjectSandboxId === undefined
      ? {}
      : {
          subjectDesktop: {
            durationMs:
              subjectCreatedAtMs === undefined || subjectTornDownAtMs === undefined
                ? undefined
                : Math.max(0, subjectTornDownAtMs - subjectCreatedAtMs),
            observation: subjectResources,
            killed: subjectKilled,
          },
        }),
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
    actor: descriptor.id,
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

function makeScriptedRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `scripted-${stamp}-${randomBytes(4).toString("hex")}`;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function servePort(serveUrl: string): number {
  const url = new URL(serveUrl);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function isTokenlessHost(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "";
  } catch {
    return false;
  }
}

function hostOriginDigest(url: string): string {
  try {
    return commandDigestOf(new URL(url).origin);
  } catch {
    return commandDigestOf(url);
  }
}
