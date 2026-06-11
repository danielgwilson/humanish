// The scripted-browser lab backend: an app-url subject (a loopback app the operator already
// runs) driven by the REGISTRY-RESOLVED scripted-browser actor on the operator's machine.
// Mirrors cua-actor-lab.ts: the descriptor returned by the registry runs the session; this
// backend consumes `scenario.ref` (resolves the committed scenario whose browser steps ARE the
// actor's behavior — no built-in fallback on the lab route, unlike `run --app-url`), composes
// the per-surface sessions, persists the evidence bundle, and renders the Observer.
//
// Spend posture: $0 provider spend BY MECHANISM — nothing on this code path can construct a
// provider client, and every projected trace records tokenUsage zeros. `scenario.mode: live`
// is still required for a real run because the gate's justification here is ACTUATION, not
// cost: a live scripted run drives a real browser against a real running app (fills forms,
// clicks buttons — state-mutating effects on the operator's app), which deserves the same
// affirmative declaration as spend. Dry-run (the default) parses and digest-pins the scenario
// and emits the contract bundle without touching anything.
//
// Subject provenance (invariant 5): the lab does NOT provision the subject, so the bundle
// declares the absence explicitly — subject build/commit provenance is UNPINNED; the evidence
// binds to the scenario digest instead.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { ActorCompletionReason, ActorPersonaRef, ActorStatus, ActorTrace } from "./actor-contract.js";
import { actorRegistry, isScriptedBrowserActorDescriptor } from "./actor-registry.js";
import type { LabConfig } from "./lab-config.js";
import { renderObserver, type ObserverResult } from "./observer.js";
import { digestText, redactText } from "./redaction.js";
import {
  buildRunSource,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunSimulation,
  type RunStream
} from "./run.js";
import {
  browserSurfaces,
  normalizeLocalAppUrl,
  parseBrowserPersonaJourneyFromScenario,
  resolveBrowserCommand,
  type BrowserPersonaJourney,
  type BrowserSurface,
  type ScriptedBrowserLaunchArgs,
  type ScriptedBrowserLike,
  type ScriptedBrowserSessionOptions,
  type ScriptedBrowserSessionResult
} from "./scripted-browser-actor.js";

export const SCRIPTED_BROWSER_LAB_SCHEMA = "mimetic.scripted-lab-result.v1";

// Journey wall-clock budget per surface — same default as `run --app-url`.
const DEFAULT_SESSION_TIMEOUT_MS = 60_000;
// Default surface roster is 1 (desktop only): the defaults-table single-lane row governs;
// `count: 2` is the declared override that adds the mobile surface.
const DEFAULT_SURFACE_COUNT = 1;
// Same public-safe token shape the lab id uses; an id-style scenario.ref must match it before
// it is interpolated into a repo path.
const SCENARIO_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Library-level hooks: DI seams so CI drives the full path (real engine, real projection)
 * with a fake browser at zero spend, plus the production browser resolution override.
 */
export interface ScriptedBrowserLabHooks {
  runSession?: (options: ScriptedBrowserSessionOptions) => Promise<ScriptedBrowserSessionResult>;
  /** Injected browser factory — forwarded to every session; skips browser-binary resolution. */
  launchBrowser?: (args: ScriptedBrowserLaunchArgs) => Promise<ScriptedBrowserLike>;
  /** Override the resolved browser binary (tests; operators use MIMETIC_BROWSER_COMMAND). */
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
      | "MIMETIC_SCRIPTED_LAB_FAILED"
      | "MIMETIC_SCRIPTED_LAB_ACTOR_UNSUPPORTED"
      | "MIMETIC_SCRIPTED_LAB_SCENARIO_INVALID"
      | "MIMETIC_SCRIPTED_LAB_SUBJECT_UNSAFE"
      | "MIMETIC_SCRIPTED_LAB_BROWSER_MISSING";
    message: string;
  };
}

export async function runScriptedBrowserLab(options: RunScriptedBrowserLabOptions): Promise<ScriptedBrowserLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
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
      "MIMETIC_SCRIPTED_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered scripted-browser actor.`
    );
  }
  const runSession = hooks.runSession ?? descriptor.runSession;

  // Re-enforce the loopback entry boundary at the engine. The scripted route is loopback-ONLY
  // (no allowPublicTargets escape hatch here): the step driver re-enforces it per navigation.
  const appUrl = normalizeLocalAppUrl(config.subject.appUrl ?? "");
  if (!appUrl) {
    return failed(
      "MIMETIC_SCRIPTED_LAB_SUBJECT_UNSAFE",
      "subject.appUrl must be a loopback http(s) URL (127.0.0.1 or localhost) on the scripted-browser route.",
      { actor: descriptor.id }
    );
  }

  // Consume scenario.ref (fail-closed: invariant 6 — the steps ARE the actor; there is no
  // built-in journey fallback on the lab route).
  const scenario = await resolveScriptedScenario(cwd, config.scenario?.ref);
  if (!scenario.ok) {
    return failed("MIMETIC_SCRIPTED_LAB_SCENARIO_INVALID", scenario.message, { actor: descriptor.id, appUrl });
  }
  const journey = scenario.journey;

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
        "MIMETIC_SCRIPTED_LAB_BROWSER_MISSING",
        "No Chrome/Chromium browser command was found for the scripted-browser actor. Set MIMETIC_BROWSER_COMMAND to a browser binary playwright-core can launch.",
        { actor: descriptor.id, appUrl }
      );
    }
    browserCommand = resolved;
  }

  const runId = options.runId ?? makeScriptedRunId();
  const artifactRoot = path.join(cwd, ".mimetic", "runs", runId);
  const createdAt = new Date().toISOString();
  await mkdir(path.join(artifactRoot, "screenshots"), { recursive: true });
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    mimeticSource: "present",
    packageName: "mimetic-cli"
  });

  let sessionResults: ScriptedBrowserSessionResult[] = [];
  let sessionError: string | undefined;

  if (!dryRun) {
    try {
      // One session per surface, in parallel — parity with `run --app-url`.
      sessionResults = await Promise.all(surfaces.map((surface) => runSession({
        appUrl,
        journey,
        surface,
        persona,
        timeoutMs,
        artifactRoot,
        ...(browserCommand === undefined ? {} : { browserCommand }),
        ...(hooks.launchBrowser === undefined ? {} : { launchBrowser: hooks.launchBrowser }),
        ...(hooks.now === undefined ? {} : { now: hooks.now })
      })));
    } catch (error) {
      // The session itself maps launch failures to harness_error; reaching here means the
      // harness around it failed. Redacted at this boundary before persisting anywhere.
      sessionError = redactText(compactError(error));
    }

    for (const result of sessionResults) {
      // The backend writes the provider-neutral projection next to the session's native
      // traces/<surface>.json (cua's actor.json convention, pluralized per surface).
      await writeFile(
        path.join(artifactRoot, `actor-${result.capture.surface.id}.json`),
        `${JSON.stringify(result.trace, null, 2)}\n`,
        "utf8"
      );
    }
  }

  const screenshotsBySurface = new Map<string, string[]>();
  for (const result of sessionResults) {
    screenshotsBySurface.set(
      result.capture.surface.id,
      await existingScreenshots(artifactRoot, result)
    );
  }

  const bundle = buildScriptedLabBundle({
    actorId: descriptor.id,
    appUrl,
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
    surfaces
  });

  await writeFile(path.join(artifactRoot, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.json"), `${JSON.stringify(bundle.review, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.md"), renderScriptedReviewMarkdown(bundle), "utf8");
  await writeFile(path.join(artifactRoot, "events.ndjson"), `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  // Keep `verify --run latest` honest: point it at THIS run (mirrors run.ts's RunPointer).
  await writeFile(
    path.join(cwd, ".mimetic", "runs", "latest.json"),
    `${JSON.stringify({
      schema: "mimetic.latest-run.v1",
      runId,
      path: path.join(".mimetic", "runs", runId),
      updatedAt: createdAt
    }, null, 2)}\n`,
    "utf8"
  );

  // Surface the local-fidelity posture so the operator knows the bundle is not publish-safe as-is.
  if (sessionResults.some((result) => result.trace.redaction.screenshots === "raw")) {
    warnings.push("Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .mimetic and nothing scans these pixels; review them before sharing anywhere. policies.redactScreenshots is not yet supported on the scripted route.");
  }

  const observer = await render(cwd, runId, { open: options.open === true });

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
    appUrl,
    dryRun,
    runId,
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
            code: "MIMETIC_SCRIPTED_LAB_FAILED" as const,
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
 * mimetic/scenarios/<ref>.yaml (then .yml). Every failure mode is fail-closed.
 */
async function resolveScriptedScenario(
  cwd: string,
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
    absolutePath = path.resolve(cwd, trimmed);
    const relative = path.relative(cwd, absolutePath);
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
      path.posix.join("mimetic", "scenarios", `${trimmed}.yaml`),
      path.posix.join("mimetic", "scenarios", `${trimmed}.yml`)
    ];
    const found = await firstExistingFile(cwd, candidates);
    if (!found) {
      return {
        ok: false,
        message: `scenario.ref "${trimmed}" was not found (looked for ${candidates.join(", ")}).`
      };
    }
    source = found;
    absolutePath = path.join(cwd, found);
  }

  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch {
    return { ok: false, message: `scenario.ref "${trimmed}" could not be read (${source}).` };
  }

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

async function firstExistingFile(cwd: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const stats = await stat(path.join(cwd, candidate)).catch(() => null);
    if (stats?.isFile()) {
      return candidate;
    }
  }
  return null;
}

async function existingScreenshots(artifactRoot: string, result: ScriptedBrowserSessionResult): Promise<string[]> {
  const existing: string[] = [];
  for (const step of result.capture.steps) {
    const stats = await stat(path.join(artifactRoot, step.screenshotPath)).catch(() => null);
    if (stats?.isFile() && stats.size > 0) {
      existing.push(step.screenshotPath);
    }
  }
  return existing;
}

/**
 * Project the scripted lab run into a mimetic.run-bundle.v1 (no schema change — a new
 * producer only). The load-bearing line is `stream.actor = result.trace`: the provider-neutral
 * ActorTrace seam the Observer renders and verifyRun's engagement check reads. Exported for
 * the bundle-builder tests.
 */
export function buildScriptedLabBundle(args: {
  actorId: string;
  appUrl: string;
  createdAt: string;
  dryRun: boolean;
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
      progress: result || args.sessionError ? 1 : 0.25,
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
      // this subject, so its build/commit provenance is explicitly UNPINNED.
      message: `Subject app declared at ${args.appUrl}; the lab did not provision it — subject build/commit provenance is UNPINNED; evidence binds to the scenario digest ${args.scenarioSourceDigest}.`
    },
    {
      id: "event-002-spend",
      at: args.createdAt,
      level: "info",
      type: "scripted-lab.spend",
      message: "$0 provider spend by construction (no model in the loop); scenario.mode: live gates real browser actuation against the declared app, not cost."
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
    artifactRoot: path.join(".mimetic", "runs", args.runId),
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
        ? "Scripted step URLs are sanitized to loopback origin+path (query/hash redacted) and step text passes text redaction. Screenshots are FULL-FIDELITY (raw), retained for local use in gitignored .mimetic — NOT redacted for publishing; policies.redactScreenshots is not yet supported on this route."
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
    feedbackCandidates: []
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

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
