// The scripted-browser lab backend: either an app-url subject (a loopback app the operator
// already runs) or one provisioned synthetic clone subject (served in E2B and exposed through
// getHost) driven by the REGISTRY-RESOLVED scripted-browser actor.
// Mirrors cua-actor-lab.ts: the descriptor returned by the registry runs the session; this
// backend consumes `scenario.ref` (resolves the committed scenario whose browser steps ARE the
// actor's behavior — no built-in fallback on the lab route, unlike `run --app-url`), composes
// the per-surface sessions, persists the evidence bundle, and renders the Observer.
//
// Spend posture: no model/provider-token spend BY MECHANISM — nothing on this code path can
// construct a provider client, and every projected trace records tokenUsage zeros. Local
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

import { parse as parseYaml } from "yaml";

import type { ActorCompletionReason, ActorPersonaRef, ActorStatus, ActorTrace } from "./actor-contract.js";
import { actorRegistry, isScriptedBrowserActorDescriptor } from "./actor-registry.js";
import { toErrorMessage } from "./command-failure.js";
import {
  commandDigestOf,
  provisionCloneSubject,
  resolveSubjectState
} from "./cua-actor-lab.js";
import {
  createDesktopSandbox,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import type { DetachedTimers } from "./e2b-detached.js";
import type { LabConfig } from "./lab-config.js";
import { renderObserver, type ObserverResult } from "./observer.js";
import { digestText, redactText } from "./redaction.js";
import {
  prepareRunArtifactPaths,
  type PreparedRunArtifactPaths,
  validatePreparedRunArtifactPaths
} from "./run-paths.js";
import {
  buildRunSource,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunSimulation,
  type RunStream,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord
} from "./run.js";
import {
  browserSurfaces,
  normalizeLocalAppUrl,
  parseBrowserPersonaJourneyFromScenario,
  resolveBrowserCommand,
  runScriptedBrowserSessionInPreparedRoot,
  type BrowserPersonaJourney,
  type BrowserSurface,
  type ScriptedBrowserEvidenceUrlPolicy,
  type ScriptedBrowserLaunchArgs,
  type ScriptedBrowserLike,
  type ScriptedBrowserSessionOptions,
  type ScriptedBrowserSessionResult
} from "./scripted-browser-actor.js";
import {
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
  writeContainedOutputFile,
  writePreparedRunLatestPointer
} from "./selected-output-paths.js";

export const SCRIPTED_BROWSER_LAB_SCHEMA = "humanish.scripted-lab-result.v1";

// Journey wall-clock budget per surface — same default as `run --app-url`.
const DEFAULT_SESSION_TIMEOUT_MS = 60_000;
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;
const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;
const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;
// Default surface roster is 1 (desktop only): the defaults-table single-lane row governs;
// `count: 2` is the declared override that adds the mobile surface.
const DEFAULT_SURFACE_COUNT = 1;
// Same public-safe token shape the lab id uses; an id-style scenario.ref must match it before
// it is interpolated into a repo path.
const SCENARIO_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

class UnsafeScriptedSessionResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeScriptedSessionResultError";
  }
}

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

export interface ScriptedBrowserLabResult {
  schema: typeof SCRIPTED_BROWSER_LAB_SCHEMA;
  /** True when the bundle verified AND (dry-run, or every session reached a terminal verdict
   * without a harness error). The subject failing the script is successful EVIDENCE, not a lab
   * failure — deliberate divergence from `run --app-url`, whose ok means "journey passed". */
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
      | "HUMANISH_SCRIPTED_LAB_FAILED"
      | "HUMANISH_SCRIPTED_LAB_ACTOR_UNSUPPORTED"
      | "HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID"
      | "HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE"
      | "HUMANISH_SCRIPTED_LAB_BROWSER_MISSING"
      | "HUMANISH_SCRIPTED_LAB_KEYS_MISSING"
      | "HUMANISH_SCRIPTED_LAB_SUBJECT_ENV_MISSING"
      | "HUMANISH_SCRIPTED_LAB_GETHOST_UNAVAILABLE";
    message: string;
  };
}

export async function runScriptedBrowserLab(options: RunScriptedBrowserLabOptions): Promise<ScriptedBrowserLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const physicalCwd = await realpath(cwd);
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const hooks = options.hooks ?? {};
  const render = hooks.renderObserverFn ?? renderObserver;
  const warnings: string[] = [];
  const actorType = config.actors[0]?.type ?? "";

  const failed = (
    code: NonNullable<ScriptedBrowserLabResult["error"]>["code"],
    message: string,
    extras?: { actor?: string; appUrl?: string }
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
    error: { code, message }
  });

  // Resolve the actor through the registry — the parse layer already validated this, but the
  // engine fails closed rather than trusting a config that arrived through another door
  // (runScriptedBrowserLab is itself exported npm surface).
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isScriptedBrowserActorDescriptor(descriptor)) {
    return failed(
      "HUMANISH_SCRIPTED_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered scripted-browser actor.`
    );
  }
  const runSession = hooks.runSession;
  const provisionedRoute = config.subject.source === "clone";
  const evidenceAppUrl = provisionedRoute ? "[provisioned-subject]" : normalizeLocalAppUrl(config.subject.appUrl ?? "") ?? "";
  const urlPolicy: ScriptedBrowserEvidenceUrlPolicy = provisionedRoute
    ? { kind: "provisioned-subject", evidenceOrigin: evidenceAppUrl }
    : { kind: "loopback" };
  const serve = config.subject.serve;
  const subjectRepo = provisionedRoute ? config.subject.repos?.[0] ?? "" : undefined;
  const subjectEnvNames = provisionedRoute ? config.subject.env ?? [] : [];
  const env = hooks.env ?? process.env;
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");
  const redactRepoLabel = config.policies?.redactRepos ?? hasGithubToken;
  const publicRepo = provisionedRoute && subjectRepo ? (redactRepoLabel ? "repo-01" : subjectRepo) : undefined;
  const scrubSourceValues = [
    ...(subjectRepo ? [subjectRepo] : []),
    ...subjectEnvNames.map((name) => env[name] ?? "")
  ].filter(Boolean);
  const scrubKnownValues = (text: string): string =>
    scrubSourceValues.reduce((acc, value) => acc.split(value).join("[redacted]"), text);

  // Re-enforce the local loopback entry boundary at the engine. The provisioned clone route
  // mints its own getHost URL later and persists only evidenceAppUrl.
  let appUrl = provisionedRoute ? serve?.url ?? "" : evidenceAppUrl;
  if (!provisionedRoute && !appUrl) {
    return failed(
      "HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE",
      "subject.appUrl must be a loopback http(s) URL (127.0.0.1 or localhost) on the scripted-browser route.",
      { actor: descriptor.id }
    );
  }
  if (provisionedRoute && (!serve || !subjectRepo || !publicRepo)) {
    return failed(
      "HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE",
      "clone scripted-browser labs require one subject repo plus subject.serve; parseLabConfig should have rejected this config.",
      { actor: descriptor.id, appUrl: evidenceAppUrl }
    );
  }

  // Consume scenario.ref (fail-closed: invariant 6 — the steps ARE the actor; there is no
  // built-in journey fallback on the lab route).
  const scenario = await resolveScriptedScenario(projectRoot, config.scenario?.ref);
  if (!scenario.ok) {
    return failed("HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID", scenario.message, { actor: descriptor.id, appUrl: evidenceAppUrl });
  }
  const journey = scenario.journey;

  if (!dryRun && provisionedRoute) {
      if (!e2bApiKey) {
      return failed(
        "HUMANISH_SCRIPTED_LAB_KEYS_MISSING",
        "Live clone scripted-browser labs require E2B_API_KEY (dry-run remains $0 and does not provision a subject).",
        { actor: descriptor.id, appUrl: evidenceAppUrl }
      );
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return failed(
        "HUMANISH_SCRIPTED_LAB_SUBJECT_ENV_MISSING",
        `Subject env values missing for live clone scripted-browser lab: ${missingSubjectEnv.join(", ")}.`,
        { actor: descriptor.id, appUrl: evidenceAppUrl }
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
    promptDigest: journey.sourceDigest.slice(0, 16)
  };

  // Live runs need a browser BEFORE any actuation (unless one is injected).
  let browserCommand = hooks.browserCommand;
  if (!dryRun && !hooks.launchBrowser && !browserCommand) {
    const resolved = await resolveBrowserCommand();
    if (!resolved) {
      return failed(
        "HUMANISH_SCRIPTED_LAB_BROWSER_MISSING",
        "No Chrome/Chromium browser command was found for the scripted-browser actor. Set HUMANISH_BROWSER_COMMAND to a browser binary playwright-core can launch.",
        { actor: descriptor.id, appUrl: evidenceAppUrl }
      );
    }
    browserCommand = resolved;
  }

  const runId = options.runId ?? makeScriptedRunId();
  const runPaths = await prepareRunArtifactPaths(physicalCwd, runId);
  const artifactRoot = runPaths.physicalRunRoot;
  const createdAt = new Date().toISOString();
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd: physicalCwd,
    humanishSource: "present",
    packageName: "humanish"
  });

  let sessionResults: ScriptedBrowserSessionResult[] = [];
  let sessionError: string | undefined;
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  let subjectCommit: string | undefined;
  let subjectSandboxId: string | undefined;
  let subjectKilled = false;
  let hostDigest: string | undefined;

  if (!dryRun) {
    let subjectModule: E2BDesktopModule | undefined;
    let subjectDesktop: E2BDesktopSandbox | undefined;
    try {
      if (provisionedRoute) {
        const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
        const timers: DetachedTimers = hooks.detachedTimers ?? {};
        subjectModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
        await validatePreparedRunArtifactPaths(runPaths);
        subjectDesktop = await createDesktopSandbox(subjectModule, {
          apiKey: e2bApiKey,
          requestTimeoutMs,
          timeoutMs: timeoutMs + SUBJECT_PROVISION_BUDGET_MS
            + (config.subject.state?.seed ?? []).reduce((sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0)
            + SANDBOX_TIMEOUT_BUFFER_MS,
          metadata: {
            mode: "scripted-browser-lab",
            tool: "humanish",
            labId: config.id,
            role: "subject",
            actor: descriptor.id
          },
          ...(subjectEnvNames.length > 0
            ? { envs: Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])) }
            : {}),
          dpi: 96,
          lifecycle: { onTimeout: "kill" }
        }, config.execution?.desktop?.template);
        subjectSandboxId = subjectDesktop.sandboxId;

        if (hooks.prepareDesktop) {
          await hooks.prepareDesktop(subjectDesktop);
          await validatePreparedRunArtifactPaths(runPaths);
        }

        subjectCommit = await provisionCloneSubject(subjectDesktop, {
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
          ...timers
        });

        if (typeof subjectDesktop.getHost !== "function") {
          throw new Error("the installed @e2b/desktop SDK does not expose getHost(port); clone scripted-browser labs require it to reach the provisioned subject");
        }
        const rawHost = subjectDesktop.getHost(servePort(serve!.url));
        const hostUrl = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
        if (!isTokenlessHost(hostUrl)) {
          throw new Error("getHost returned a non-tokenless URL; refusing to persist or drive a host URL that may carry a credential");
        }
        appUrl = hostUrl;
        hostDigest = hostOriginDigest(hostUrl);
      }

      // One session per surface, in parallel — parity with `run --app-url`.
      sessionResults = await Promise.all(surfaces.map((surface) => {
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
          ...(hooks.now === undefined ? {} : { now: hooks.now })
        };
        return runSession
          ? runSession(sessionOptions).then(async (result) => {
              await validatePreparedRunArtifactPaths(runPaths);
              validateScriptedSessionResult(surface, result);
              return result;
            })
          : runScriptedBrowserSessionInPreparedRoot(sessionOptions, runPaths);
      }));
    } catch (error) {
      if (error instanceof UnsafeScriptedSessionResultError) {
        throw error;
      }
      // The session itself maps launch failures to harness_error; reaching here means the
      // harness around it failed. Redacted at this boundary before persisting anywhere.
      sessionError = redactText(scrubKnownValues(toErrorMessage(error)));
    } finally {
      if (subjectDesktop && subjectModule) {
        if (typeof subjectModule.Sandbox.kill === "function") {
          try {
            await subjectModule.Sandbox.kill(subjectDesktop.sandboxId, { requestTimeoutMs: 60_000 });
            subjectKilled = true;
          } catch (error) {
            warnings.push(`Subject sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrubKnownValues(toErrorMessage(error)))}`);
          }
        } else {
          warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the subject sandbox.");
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
        "utf8"
      );
    }
  }

  const screenshotsBySurface = new Map<string, string[]>();
  for (const result of sessionResults) {
    screenshotsBySurface.set(
      result.capture.surface.id,
      await existingScreenshots(runPaths, result)
    );
  }
  const subject: RunSubjectProvenance | undefined = provisionedRoute
    ? {
        source: "clone",
        repo: publicRepo!,
        ...(subjectCommit === undefined ? {} : { commit: subjectCommit }),
        envNames: subjectEnvNames,
        state: resolveSubjectState({ declared: config.subject.state, dryRun, executed: stateStepRecords })
      }
    : undefined;

  const bundle = buildScriptedLabBundle({
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
    ...(config.execution?.desktop?.template === undefined ? {} : { desktopTemplate: config.execution.desktop.template }),
    ...(hostDigest === undefined ? {} : { hostDigest })
  });

  await writeContainedOutputFile(runPaths, "run.json", `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "review.json", `${JSON.stringify(bundle.review, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "review.md", renderScriptedReviewMarkdown(bundle), "utf8");
  await writeContainedOutputFile(runPaths, "events.ndjson", `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  // Keep `verify --run latest` honest: point it at THIS run (mirrors run.ts's RunPointer).
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId,
      path: runPaths.relativeRunRoot,
      updatedAt: createdAt
    }, null, 2)}\n`,
    "utf8"
  );

  // Surface the local-fidelity posture so the operator knows the bundle is not publish-safe as-is.
  if (sessionResults.some((result) => result.trace.redaction.screenshots === "raw")) {
    warnings.push("Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .humanish and nothing scans these pixels; review them before sharing anywhere. policies.redactScreenshots is not yet supported on the scripted route.");
  }

  const observer = await render(physicalCwd, runId, { open: options.open === true });
  await validatePreparedRunArtifactPaths(runPaths);

  const harnessError = sessionResults.some((result) => result.completionReason === "harness_error");
  const ok = observer.ok
    && sessionError === undefined
    && (dryRun || (sessionResults.length === surfaces.length && !harnessError));

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
    ...(subjectSandboxId === undefined ? {} : { subjectSandbox: { sandboxId: subjectSandboxId, killed: subjectKilled } }),
    ...(hostDigest === undefined ? {} : { hostDigest }),
    scenario: {
      id: journey.scenarioId,
      source: scenario.source,
      sourceDigest: scenario.sourceDigest,
      steps: journey.steps.length
    },
    sessions: sessionResults.map((result) => ({
      surface: result.capture.surface.id,
      status: result.status,
      completionReason: result.completionReason,
      reason: result.reason,
      screenshots: screenshotsBySurface.get(result.capture.surface.id)?.length ?? 0
    })),
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: "HUMANISH_SCRIPTED_LAB_FAILED" as const,
            message: sessionError
              ?? (observer.ok
                ? harnessError
                  ? `Scripted session ended with a harness error: ${sessionResults.find((result) => result.completionReason === "harness_error")?.reason ?? "unknown"}`
                  : "Scripted lab did not produce terminal sessions for every surface."
                : observer.error?.message ?? "Observer failed for the scripted lab run.")
          }
        })
  };
}

interface ResolvedScriptedScenario {
  ok: true;
  journey: BrowserPersonaJourney;
  /** Repo-relative provenance path (clamped inside the target cwd, fail-closed). */
  source: string;
  sourceDigest: string;
}

/**
 * Resolve and consume `scenario.ref`. Path-style refs (contain a separator or end .yaml/.yml)
 * resolve against cwd and are CLAMPED inside it — a ../../ escape is rejected, never recorded
 * as repo-relative provenance. Id-style refs must be public-safe tokens and resolve to
 * humanish/scenarios/<ref>.yaml (then .yml). Every failure mode is fail-closed.
 */
async function resolveScriptedScenario(
  projectRoot: PreparedSelectedOutputDirectory,
  ref: string | undefined
): Promise<ResolvedScriptedScenario | { ok: false; message: string }> {
  if (!ref || !ref.trim()) {
    return {
      ok: false,
      message: "scripted-browser labs require `scenario.ref` — the committed scenario's browser steps are what this actor executes."
    };
  }
  const trimmed = ref.trim();

  let absolutePath: string;
  let source: string;
  if (scenarioRefLooksLikePath(trimmed)) {
    absolutePath = path.resolve(projectRoot.physicalPath, trimmed);
    const relative = path.relative(projectRoot.physicalPath, absolutePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return {
        ok: false,
        message: `scenario.ref path must stay inside the target cwd (got "${trimmed}") — provenance is recorded repo-relative and an escaping path cannot be.`
      };
    }
    source = relative.split(path.sep).join("/");
  } else {
    if (!SCENARIO_REF_ID_PATTERN.test(trimmed)) {
      return {
        ok: false,
        message: `scenario.ref must be a public-safe scenario id or a .yaml path inside the repo (got "${trimmed}").`
      };
    }
    const candidates = [
      path.posix.join("humanish", "scenarios", `${trimmed}.yaml`),
      path.posix.join("humanish", "scenarios", `${trimmed}.yml`)
    ];
    const found = await firstExistingFile(projectRoot, candidates);
    if (!found) {
      return {
        ok: false,
        message: `scenario.ref "${trimmed}" was not found (looked for ${candidates.join(", ")}).`
      };
    }
    source = found;
    absolutePath = path.join(projectRoot.physicalPath, found);
  }

  const relativeScenarioPath = path.relative(projectRoot.physicalPath, absolutePath);
  const scenarioBytes = await readContainedRegularFile(projectRoot, relativeScenarioPath);
  if (!scenarioBytes) {
    return { ok: false, message: `scenario.ref "${trimmed}" could not be read (${source}).` };
  }
  const text = scenarioBytes.toString("utf8");

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return { ok: false, message: `${source} could not be parsed as YAML; the scripted scenario failed closed.` };
  }

  const sourceDigest = digestText(text);
  const parsed = parseBrowserPersonaJourneyFromScenario({ raw, relativePath: source, sourceDigest });
  if (parsed.failure) {
    return { ok: false, message: parsed.failure };
  }
  if (!parsed.journey) {
    return {
      ok: false,
      message: `${source} declares no executable browser steps — the scripted-browser actor needs a scenario with browser.steps (there is no built-in fallback on the lab route).`
    };
  }

  return { ok: true, journey: parsed.journey, source, sourceDigest };
}

function scenarioRefLooksLikePath(ref: string): boolean {
  return ref.endsWith(".yaml")
    || ref.endsWith(".yml")
    || ref.includes("/")
    || ref.includes("\\")
    || ref.startsWith(".");
}

async function firstExistingFile(projectRoot: PreparedSelectedOutputDirectory, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await readContainedRegularFile(projectRoot, candidate) !== null) {
      return candidate;
    }
  }
  return null;
}

async function existingScreenshots(runPaths: PreparedRunArtifactPaths, result: ScriptedBrowserSessionResult): Promise<string[]> {
  const existing: string[] = [];
  for (const step of result.capture.steps) {
    // Blocked steps whose evidence is the failure itself recorded no screenshot path.
    if (!step.screenshotPath) {
      continue;
    }
    const screenshot = await readContainedRegularFile(runPaths, step.screenshotPath);
    if (screenshot && screenshot.byteLength > 0) {
      existing.push(step.screenshotPath);
    }
  }
  return existing;
}

function validateScriptedSessionResult(
  expectedSurface: BrowserSurface,
  result: ScriptedBrowserSessionResult
): void {
  if (result.capture.surface.id !== expectedSurface.id || !isSafeOutputSegment(result.capture.surface.id)) {
    throw new UnsafeScriptedSessionResultError("Scripted session returned an unexpected or unsafe surface id.");
  }
  const paths = [
    result.capture.tracePath,
    ...(result.capture.screenshotPath ? [result.capture.screenshotPath] : []),
    ...result.capture.steps.flatMap((step) => step.screenshotPath ? [step.screenshotPath] : [])
  ];
  if (!paths.every(isSafeRelativeArtifactPath)) {
    throw new UnsafeScriptedSessionResultError("Scripted session returned an unsafe artifact path.");
  }
}

function isSafeOutputSegment(value: string): boolean {
  return value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

function isSafeRelativeArtifactPath(value: string): boolean {
  if (!value || value.includes("\0") || path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }
  return !value.replace(/\\/g, "/").split("/").some((part) => !part || part === "." || part === "..");
}

/**
 * Project the scripted lab run into a humanish.run-bundle.v1 (no schema change — a new
 * producer only). The load-bearing line is `stream.actor = result.trace`: the provider-neutral
 * ActorTrace seam the Observer renders and verifyRun's engagement check reads. Exported for
 * the bundle-builder tests.
 */
export function buildScriptedLabBundle(args: {
  actorId: string;
  appUrl: string;
  createdAt: string;
  desktopTemplate?: string;
  dryRun: boolean;
  hostDigest?: string;
  journey: BrowserPersonaJourney;
  labId: string;
  labTitle?: string;
  persona: ActorPersonaRef;
  runId: string;
  scenarioSource: string;
  scenarioSourceDigest: string;
  screenshotsBySurface: Map<string, string[]>;
  sessionResults: ScriptedBrowserSessionResult[];
  sessionError?: string;
  source: RunBundle["source"];
  subject?: RunSubjectProvenance;
  surfaces: BrowserSurface[];
}): RunBundle {
  const resultBySurface = new Map(args.sessionResults.map((result) => [result.capture.surface.id, result]));
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];

  args.surfaces.forEach((surface, index) => {
    const simId = `scripted-${surface.id}`;
    const streamId = `${simId}-stream`;
    const result = resultBySurface.get(surface.id);
    const screenshots = args.screenshotsBySurface.get(surface.id) ?? [];
    const lastScreenshot = screenshots.at(-1);
    const status = result
      ? result.status
      : args.sessionError
        ? "failed" as const
        : "contract_proof_only" as const;
    const reason = result?.reason
      ?? args.sessionError
      ?? "Contract bundle only: dry-run pinned the scenario contract without launching a browser or touching the subject app.";

    simulations.push({
      id: simId,
      index: index + 1,
      personaId: args.persona.id,
      scenarioId: args.journey.scenarioId,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: 100,
      currentStep: reason,
      summary: result
        ? `Scripted-browser actor (${args.actorId}) replayed ${args.journey.scenarioId} on the ${surface.id} surface; ${result.completionReason}.`
        : args.sessionError
          ? `Scripted lab failed before a terminal session verdict: ${args.sessionError}`
          : `Contract lane for the scripted-browser actor (${args.actorId}) against ${args.appUrl}.`,
      streamIds: [streamId],
      startedAt: args.createdAt,
      updatedAt: result?.capture.capturedAt ?? args.createdAt
    });

    streams.push({
      id: streamId,
      simId,
      kind: "browser",
      label: `${surface.label} — ${args.labId}`,
      status,
      transport: "snapshot",
      updatedAt: result?.capture.capturedAt ?? args.createdAt,
      embed: lastScreenshot
        ? { kind: "screenshot", url: `../${lastScreenshot}`, title: `${surface.label} (raw)` }
        : { kind: "placeholder", title: surface.label },
      // REAL emulated viewport: isMobile/deviceScaleFactor genuinely render on this route
      // (playwright emulation), unlike the e2b-desktop route's prompt-signal-only fidelity.
      viewport: surface.viewport,
      ui: {
        route: args.appUrl,
        intent: args.journey.goal,
        state: reason,
        ...(result ? { actorStatus: result.status } : {}),
        ...(lastScreenshot ? { screenshotUrl: `../${lastScreenshot}` } : {})
      },
      // The seam this registration exists to fill: the provider-neutral actor evidence.
      ...(result ? { actor: result.trace } : {}),
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" as const },
        { label: "review", path: "review.md", kind: "review" as const },
        { label: "events", path: "events.ndjson", kind: "events" as const },
        ...(result
          ? [
              { label: `${surface.id} browser trace`, path: result.capture.tracePath, kind: "trace" as const },
              { label: `${surface.id} actor trace`, path: `actor-${surface.id}.json`, kind: "trace" as const }
            ]
          : []),
        ...screenshots.map((screenshot, screenshotIndex) => ({
          label: `${surface.id} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (raw)`,
          path: screenshot,
          kind: "screenshot" as const
        }))
      ]
    });
  });

  const events: RunEvent[] = [
    {
      id: "event-000-created",
      at: args.createdAt,
      level: "info",
      type: "scripted-lab.run.created",
      message: `Created scripted-browser lab run for ${args.labId} (actor ${args.actorId}, ${args.surfaces.length} surface${args.surfaces.length === 1 ? "" : "s"}).`
    },
    {
      id: "event-001-subject",
      at: args.createdAt,
      level: "info",
      type: "scripted-lab.subject.declared",
      // Invariant 5: provenance recorded or its absence DECLARED. The lab did not provision
      // this subject on app-url routes; clone routes carry structured subject provenance below.
      message: args.subject
        ? `Provisioned synthetic subject: clone of ${args.subject.repo}${args.subject.commit ? `@${args.subject.commit}` : ""}, served + getHost-exposed in-sandbox; env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted); state provenance: ${args.subject.state.provenance}; evidence host digest: ${args.hostDigest ?? "dry-run"}.`
        : `Subject app declared at ${args.appUrl}; the lab did not provision it — subject build/commit provenance is UNPINNED; evidence binds to the scenario digest ${args.scenarioSourceDigest}.`
    },
    {
      id: "event-002-spend",
      at: args.createdAt,
      level: "info",
      type: "scripted-lab.spend",
      message: args.subject
        ? "No model spend by construction; live provisioned scripted runs may spend E2B sandbox minutes to clone/serve the synthetic subject, then drive deterministic browser steps."
        : "$0 provider spend by construction (no model and no sandbox in the loop); scenario.mode: live gates real browser actuation against the declared app, not cost."
    }
  ];

  if (args.sessionResults.length > 0) {
    for (const result of args.sessionResults) {
      events.push({
        id: `event-${String(events.length).padStart(3, "0")}-session-${result.capture.surface.id}`,
        at: result.capture.capturedAt,
        level: result.status === "passed" ? "info" : "warn",
        type: `scripted-lab.session.${result.completionReason}`,
        message: `${result.capture.surface.id}: ${result.status} — ${result.reason}`,
        simId: `scripted-${result.capture.surface.id}`,
        streamId: `scripted-${result.capture.surface.id}-stream`
      });
    }
  } else if (args.sessionError) {
    events.push({
      id: "event-003-session-error",
      at: args.createdAt,
      level: "error",
      type: "scripted-lab.session.error",
      message: args.sessionError
    });
  } else {
    events.push({
      id: "event-003-contract",
      at: args.createdAt,
      level: "info",
      type: "scripted-lab.contract.ready",
      message: `Dry-run contract bundle ready: scenario ${args.journey.scenarioId} @ ${args.scenarioSourceDigest} (${args.scenarioSource}, ${args.journey.steps.length} step${args.journey.steps.length === 1 ? "" : "s"}) parsed and digest-pinned; switch scenario.mode to live to actuate a real browser.`
    });
  }

  const review = buildScriptedReview(args);
  const ranLive = args.sessionResults.length > 0 || args.sessionError !== undefined;

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: args.surfaces.length,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".humanish", "runs", args.runId),
    source: args.source,
    persona: {
      id: args.persona.id,
      name: `Scripted journey persona (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    scenario: {
      id: args.journey.scenarioId,
      title: args.journey.scenarioTitle,
      goal: args.journey.goal,
      source: args.scenarioSource,
      sourceDigest: args.scenarioSourceDigest
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "scripted-lab.run.created",
        message: `Created scripted-browser lab run with ${args.surfaces.length} surface lane${args.surfaces.length === 1 ? "" : "s"} (actor ${args.actorId}).`
      }
    ],
    simulations,
    streams,
    events,
    redaction: {
      status: "passed",
      notes: ranLive
        ? "Scripted step URLs are sanitized to loopback origin+path (query/hash redacted) and step text passes text redaction. Screenshots are FULL-FIDELITY (raw), retained for local use in gitignored .humanish — NOT redacted for publishing; policies.redactScreenshots is not yet supported on this route."
        : "Dry-run contract bundle: no browser ran and no screenshots were captured. The scenario contract is digest-pinned; live step text passes text redaction when a session runs."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    feedbackCandidates: [],
    ...(args.subject === undefined ? {} : { subject: args.subject }),
    ...(args.desktopTemplate === undefined ? {} : { desktopTemplate: args.desktopTemplate })
  };
}

function buildScriptedReview(args: {
  appUrl: string;
  journey: BrowserPersonaJourney;
  scenarioSource: string;
  sessionResults: ScriptedBrowserSessionResult[];
  sessionError?: string;
  surfaces: BrowserSurface[];
}): ReviewSummary {
  if (args.sessionError) {
    return {
      schema: REVIEW_SCHEMA,
      verdict: "fail",
      summary: `Scripted lab failed before a terminal session verdict: ${args.sessionError}`,
      gaps: []
    };
  }
  if (args.sessionResults.length === 0) {
    return {
      schema: REVIEW_SCHEMA,
      verdict: "contract_proof_only",
      summary: `Dry-run contract for scenario ${args.journey.scenarioId} (${args.scenarioSource}, ${args.journey.steps.length} steps) against ${args.appUrl}: composition and scenario contract proven at $0; no browser ran.`,
      gaps: ["Live scripted session not yet run (dry-run contract only)."]
    };
  }

  // Worst-of across surfaces: harness/step failures outrank a timeout outranks a pass.
  const reasons = args.sessionResults.map((result) => result.completionReason);
  const verdict = reasons.some((reason) => reason === "harness_error" || reason === "step_failed")
    ? "fail" as const
    : reasons.some((reason) => reason === "timed_out")
      ? "timed_out" as const
      : "pass" as const;
  const passed = args.sessionResults.filter((result) => result.status === "passed").length;
  return {
    schema: REVIEW_SCHEMA,
    verdict,
    summary: `Scripted-browser actor replayed ${args.journey.scenarioId} on ${args.sessionResults.length} surface${args.sessionResults.length === 1 ? "" : "s"} against ${args.appUrl}: ${passed}/${args.sessionResults.length} satisfied the scenario predicate.`,
    gaps: args.sessionResults
      .filter((result) => result.status !== "passed")
      .map((result) => `${result.capture.surface.id}: ${result.reason}`)
  };
}

function renderScriptedReviewMarkdown(bundle: RunBundle): string {
  const subject = bundle.events.find((event) => event.type === "scripted-lab.subject.declared");
  const spend = bundle.events.find((event) => event.type === "scripted-lab.spend");
  const traces = bundle.streams
    .map((stream) => ({ stream, trace: stream.actor as ActorTrace | undefined }))
    .filter((entry): entry is { stream: RunStream; trace: ActorTrace } => entry.trace !== undefined);
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    `- scenario: ${bundle.scenario.id} @ ${bundle.scenario.sourceDigest} (${bundle.scenario.source})`,
    ...(subject ? [`- subject: ${subject.message}`] : []),
    ...(spend ? [`- spend: ${spend.message}`] : []),
    ...traces.map(({ stream, trace }) =>
      `- ${stream.simId}: ${trace.provider} (${trace.lane}/${trace.protocol}) ${trace.status} (${trace.completionReason}); ${trace.counts.actions ?? 0} step action(s), ${trace.counts.screenshots ?? 0} raw screenshot(s)`),
    ...(bundle.review.gaps.length > 0 ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)] : []),
    ""
  ].join("\n");
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
