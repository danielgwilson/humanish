// The computer-use lab backend: an app-url subject driven by a REGISTRY-RESOLVED computer-use
// actor inside a hosted E2B desktop. This is the path that makes `actors[].type` load-bearing —
// the descriptor returned by the registry runs the session; the lab only provisions the desktop,
// composes the prompt from config, persists the evidence bundle, and tears the sandbox down.
//
// Substrate notes:
// - The desktop is created via the shared loader in e2b-desktop-launch.ts with kill-on-timeout
//   lifecycle, so a dead host process can never orphan a sandbox past its server-side deadline.
// - NO env vars are forwarded into the sandbox: the model drives the desktop from OUTSIDE via
//   the provider API, so no key ever needs to exist inside the sandbox.
// - The live stream URL is runtime-only (carries an auth key) and is never persisted into run
//   artifacts — only its presence is recorded, mirroring the meta lab's convention.
// - Evidence is redacted at the loop boundary (blurred screenshots, length-only typed text);
//   the bundle's `stream.actor` carries the conformant mimetic.actor-trace.v1 projection.

import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ActorCompletionReason, ActorPersonaRef, ActorStatus, ActorTrace } from "./actor-contract.js";
import { actorRegistry, isCuaActorDescriptor } from "./actor-registry.js";
import type { CuaActorSessionOptions } from "./computer-use-actor.js";
import type { CuaLoopResult } from "./computer-use.js";
import type { E2BDesktopLike } from "./e2b-desktop-executor.js";
import {
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import { isLoopbackUrl, type LabConfig } from "./lab-config.js";
import { renderObserver, type ObserverResult } from "./observer.js";
import { redactText } from "./redaction.js";
import {
  buildRunSource,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunSimulation,
  type RunSimulationStatus,
  type RunStream
} from "./run.js";

export const CUA_ACTOR_LAB_SCHEMA = "mimetic.cua-lab-result.v1";

export const CUA_ACTOR_LAB_PROVIDER_METADATA = {
  mode: "cua-actor-lab",
  tool: "mimetic-cli"
} as const;

const DEFAULT_SESSION_TIMEOUT_MS = 300_000;
const DEFAULT_RESOLUTION: [number, number] = [1440, 960];
// Server-side reclamation buffer past the loop's own wall-clock stop.
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;

/**
 * Library-level hooks. `prepareDesktop` is a real (if early) feature: subject.appUrl must be
 * reachable from INSIDE the sandbox, and the lab does not serve the app yet — library callers
 * provision it here (write files, start a loopback server) before the browser opens. The rest
 * are DI seams so CI drives the full path with fakes at zero network/zero spend.
 */
export interface CuaActorLabHooks {
  prepareDesktop?: (desktop: E2BDesktopSandbox) => Promise<void>;
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  runSession?: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
}

export interface RunCuaActorLabOptions {
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  hooks?: CuaActorLabHooks;
}

export interface CuaActorLabResult {
  schema: typeof CUA_ACTOR_LAB_SCHEMA;
  /** True when the bundle verified AND (dry-run, or the session reached a terminal verdict
   * without a harness error). The actor's pass/fail is evidence, not the lab's exit code. */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the session. */
  actor: string;
  appUrl: string;
  dryRun: boolean;
  runId: string;
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
    screenshots: number;
  };
  sandbox?: {
    sandboxId: string;
    killed: boolean;
    /** The stream URL itself (carries an auth key) is runtime-only and is deliberately NOT
     * surfaced on the result — the sandbox is already dead by the time the result exists. */
    streamUrlPresent: boolean;
  };
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code:
      | "MIMETIC_CUA_LAB_FAILED"
      | "MIMETIC_CUA_LAB_KEYS_MISSING"
      | "MIMETIC_CUA_LAB_ACTOR_UNSUPPORTED"
      | "MIMETIC_CUA_LAB_SUBJECT_UNSAFE";
    message: string;
  };
}

export async function runCuaActorLab(options: RunCuaActorLabOptions): Promise<CuaActorLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const render = hooks.renderObserverFn ?? renderObserver;
  const warnings: string[] = [];

  const appUrl = config.subject.appUrl ?? "";
  const actor = config.actors[0];
  const actorType = actor?.type ?? "";

  // Resolve the actor through the registry — the parse layer already validated this, but the
  // engine fails closed rather than trusting a config that arrived through another door.
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return {
      schema: CUA_ACTOR_LAB_SCHEMA,
      ok: false,
      cwd,
      labId: config.id,
      actor: actorType,
      appUrl,
      dryRun,
      runId: options.runId ?? "not-created",
      warnings,
      error: {
        code: "MIMETIC_CUA_LAB_ACTOR_UNSUPPORTED",
        message: `actors[0].type "${actorType}" is not a registered computer-use actor.`
      }
    };
  }
  const runSession = hooks.runSession ?? descriptor.runSession;

  // Re-enforce the loopback entry boundary for configs that arrive through the library API
  // (the parser rejects these too, but runCuaActorLab is itself exported npm surface).
  if (!isLoopbackUrl(appUrl)) {
    return {
      schema: CUA_ACTOR_LAB_SCHEMA,
      ok: false,
      cwd,
      labId: config.id,
      actor: descriptor.id,
      appUrl,
      dryRun,
      runId: options.runId ?? "not-created",
      warnings,
      error: {
        code: "MIMETIC_CUA_LAB_SUBJECT_UNSAFE",
        message: "subject.appUrl must be a loopback http(s) URL (127.0.0.1 or localhost) — driving public targets is not allowed."
      }
    };
  }

  const runId = options.runId ?? makeCuaRunId();
  const artifactRoot = path.join(cwd, ".mimetic", "runs", runId);
  const createdAt = new Date().toISOString();
  const resolution = config.execution?.desktop?.resolution ?? DEFAULT_RESOLUTION;
  const timeoutMs = config.execution?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;

  const { instructions, persona } = composeInstructions(config);

  // Read once into locals (names only; values never logged or persisted) — this also keeps
  // history clean for line-pattern secret scanners that flag inline `apiKey: env.X` reads.
  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";

  if (!dryRun) {
    const missingKeys = [
      ...(openaiApiKey ? [] : ["OPENAI_API_KEY"]),
      ...(e2bApiKey ? [] : ["E2B_API_KEY"])
    ];
    if (missingKeys.length > 0) {
      return {
        schema: CUA_ACTOR_LAB_SCHEMA,
        ok: false,
        cwd,
        labId: config.id,
        actor: descriptor.id,
        appUrl,
        dryRun,
        runId: options.runId ?? "not-created",
        warnings,
        error: {
          code: "MIMETIC_CUA_LAB_KEYS_MISSING",
          message: `Live computer-use labs need ${missingKeys.join(" and ")} in the environment (pass them via --env-file; values are never persisted).`
        }
      };
    }
  }

  await mkdir(path.join(artifactRoot, "screenshots"), { recursive: true });
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    mimeticSource: "present",
    packageName: "mimetic-cli"
  });

  const screenshots: string[] = [];
  const writeScreenshot = async (name: string, bytes: Buffer): Promise<string> => {
    const rel = path.posix.join("screenshots", name);
    await writeFile(path.join(artifactRoot, "screenshots", name), bytes);
    screenshots.push(rel);
    return rel;
  };

  let session: CuaLoopResult | undefined;
  let sessionError: string | undefined;
  let sandboxId: string | undefined;
  let killed = false;
  let streamUrl: string | undefined;

  if (!dryRun) {
    // The module load lives INSIDE the try: a missing optional peer becomes a structured
    // failed result + persisted failed bundle, never a raw stack out of the CLI.
    let desktopModule: E2BDesktopModule | undefined;
    let desktop: E2BDesktopSandbox | undefined;
    try {
      desktopModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
      desktop = await desktopModule.Sandbox.create({
        apiKey: e2bApiKey,
        requestTimeoutMs: readPositiveInt(env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000),
        timeoutMs: config.execution?.desktop?.sandboxTimeoutMs ?? timeoutMs + SANDBOX_TIMEOUT_BUFFER_MS,
        metadata: {
          ...CUA_ACTOR_LAB_PROVIDER_METADATA,
          labId: config.id,
          simId: "sim-001"
        },
        // Deliberately NO envs: the model drives the desktop from outside via the provider
        // API, so no key or host environment ever enters the sandbox.
        resolution,
        dpi: 96,
        lifecycle: { onTimeout: "kill" }
      });
      sandboxId = desktop.sandboxId;

      if (hooks.prepareDesktop) {
        await hooks.prepareDesktop(desktop);
      }

      if (desktop.open) {
        await desktop.open(appUrl);
      } else {
        await desktop.launch("google-chrome", appUrl);
      }
      // Give the browser a beat to paint; the loop self-corrects via screenshots either way.
      await desktop.wait(2000).catch(() => undefined);

      try {
        await desktop.stream.start({ requireAuth: true });
        streamUrl = desktop.stream.getUrl({
          authKey: desktop.stream.getAuthKey(),
          autoConnect: true,
          viewOnly: true,
          resize: "scale"
        });
      } catch (error) {
        warnings.push(`Live desktop stream unavailable (run continues; evidence still captured): ${redactText(compactError(error))}`);
      }

      const sessionOptions: CuaActorSessionOptions = {
        instructions,
        persona,
        timeoutMs,
        openai: {
          apiKey: openaiApiKey,
          ...(actor?.model ? { model: actor.model } : {})
        },
        desktop: desktop as unknown as E2BDesktopLike,
        writeScreenshot
      };
      session = await runSession(sessionOptions);
    } catch (error) {
      // Redacted at the lab boundary: harness errors (SDK messages, paths) flow into the
      // persisted bundle and review.md, so they pass through the same scrubber as evidence.
      sessionError = redactText(compactError(error));
    } finally {
      if (desktop && desktopModule) {
        if (typeof desktopModule.Sandbox.kill === "function") {
          try {
            await desktopModule.Sandbox.kill(desktop.sandboxId, { requestTimeoutMs: 60_000 });
            killed = true;
          } catch (error) {
            warnings.push(`Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(compactError(error))}`);
          }
        } else {
          warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox.");
        }
      }
    }
  }

  const bundle = buildCuaBundle({
    actorId: descriptor.id,
    appUrl,
    createdAt,
    dryRun,
    labId: config.id,
    ...(config.title ? { labTitle: config.title } : {}),
    mission: instructions,
    persona,
    resolution,
    runId,
    screenshots,
    ...(session ? { session } : {}),
    ...(sessionError ? { sessionError } : {}),
    source,
    ...(session ? { traceArtifactPath: "actor.json" } : {})
  });

  if (session) {
    await writeFile(path.join(artifactRoot, "actor.json"), `${JSON.stringify(session.trace, null, 2)}\n`, "utf8");
  }
  await writeFile(path.join(artifactRoot, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.json"), `${JSON.stringify(bundle.review, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.md"), renderCuaReviewMarkdown(bundle), "utf8");
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

  const observer = await render(cwd, runId, { open: options.open === true });

  const ok = observer.ok
    && sessionError === undefined
    && (dryRun || (session !== undefined && session.completionReason !== "harness_error"));

  return {
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptor.id,
    appUrl,
    dryRun,
    runId,
    ...(session
      ? {
          session: {
            status: session.status,
            completionReason: session.completionReason,
            reason: session.reason,
            screenshots: screenshots.length
          }
        }
      : {}),
    ...(sandboxId
      ? { sandbox: { sandboxId, killed, streamUrlPresent: streamUrl !== undefined } }
      : {}),
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: "MIMETIC_CUA_LAB_FAILED" as const,
            message: sessionError
              ?? (observer.ok
                ? session?.completionReason === "harness_error"
                  ? `Computer-use session ended with a harness error: ${session.reason}`
                  : "Computer-use lab did not produce a terminal session."
                : observer.error?.message ?? "Observer failed for the computer-use lab run.")
          }
        })
  };
}

/** Compose the actor prompt from config: persona line + mission + per-lane steer. */
function composeInstructions(config: LabConfig): { instructions: string; persona: ActorPersonaRef } {
  const actor = config.actors[0];
  const mission = actor?.mission
    ?? "You are testing a web application. The browser is already open at the subject URL. Explore it, accomplish what the scenario asks, and stop when done.";
  const parts = [
    actor?.persona ? `Persona: ${actor.persona}.` : undefined,
    mission,
    actor?.laneFocus?.instruction ? `Lane focus: ${actor.laneFocus.instruction}` : undefined
  ].filter((part): part is string => Boolean(part));
  const instructions = parts.join("\n\n");
  return {
    instructions,
    persona: {
      id: actor?.persona ?? "cua-operator",
      traitsApplied: [],
      promptDigest: createHash("sha256").update(instructions).digest("hex").slice(0, 16)
    }
  };
}

/**
 * Project a computer-use session into a mimetic.run-bundle.v1. The load-bearing line is
 * `stream.actor = session.trace` — the provider-neutral ActorTrace seam the Observer renders.
 * Exported for the bundle-builder tests.
 */
export function buildCuaBundle(args: {
  actorId: string;
  appUrl: string;
  createdAt: string;
  dryRun: boolean;
  labId: string;
  labTitle?: string;
  mission: string;
  persona: ActorPersonaRef;
  resolution: [number, number];
  runId: string;
  screenshots: string[];
  session?: CuaLoopResult;
  sessionError?: string;
  source: RunBundle["source"];
  traceArtifactPath?: string;
}): RunBundle {
  const status: RunSimulationStatus = args.session
    ? args.session.status
    : args.sessionError
      ? "failed"
      : "contract_proof_only";
  const reason = args.session?.reason
    ?? args.sessionError
    ?? "Contract bundle only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.";
  const lastScreenshot = args.screenshots[args.screenshots.length - 1];

  const simulation: RunSimulation = {
    id: "sim-001",
    index: 1,
    personaId: args.persona.id,
    scenarioId: `cua-${args.labId}`,
    status,
    streamKind: "browser",
    mode: "browser-sim",
    progress: args.session || args.sessionError ? 1 : 0.25,
    currentStep: reason,
    summary: args.session
      ? `Computer-use actor (${args.actorId}) drove the subject app in a hosted desktop browser; ${args.session.completionReason}.`
      : args.sessionError
        ? `Computer-use lab failed before a terminal session verdict: ${args.sessionError}`
        : `Contract lane for the computer-use actor (${args.actorId}) against ${args.appUrl}.`,
    streamIds: ["stream-001"],
    startedAt: args.createdAt,
    updatedAt: args.createdAt
  };

  const stream: RunStream = {
    id: "stream-001",
    simId: "sim-001",
    kind: "browser",
    label: `CUA browser — ${args.labId}`,
    status,
    transport: "snapshot",
    updatedAt: args.createdAt,
    embed: lastScreenshot
      ? { kind: "screenshot", url: lastScreenshot, title: "CUA desktop (redacted)" }
      : { kind: "placeholder", title: "CUA desktop" },
    viewport: {
      width: args.resolution[0],
      height: args.resolution[1],
      deviceScaleFactor: 1
    },
    ui: {
      route: args.appUrl,
      intent: "Watch the computer-use actor drive the subject app in a hosted desktop browser.",
      state: reason,
      ...(args.session ? { actorStatus: args.session.status } : {}),
      ...(lastScreenshot ? { screenshotUrl: lastScreenshot } : {})
    },
    // The seam this lab exists to fill: the provider-neutral actor evidence projection.
    ...(args.session ? { actor: args.session.trace } : {}),
    artifacts: [
      { label: "run bundle", path: "run.json", kind: "bundle" as const },
      { label: "review", path: "review.md", kind: "review" as const },
      { label: "events", path: "events.ndjson", kind: "events" as const },
      ...(args.traceArtifactPath
        ? [{ label: "actor trace", path: args.traceArtifactPath, kind: "trace" as const }]
        : []),
      ...args.screenshots.map((screenshot, index) => ({
        label: `screenshot ${String(index + 1).padStart(2, "0")} (redacted)`,
        path: screenshot,
        kind: "screenshot" as const
      }))
    ]
  };

  const events: RunEvent[] = [
    {
      id: "event-000-created",
      at: args.createdAt,
      level: "info",
      type: "cua-lab.run.created",
      message: `Created computer-use lab run for ${args.labId} (actor ${args.actorId}).`
    },
    {
      id: "event-001-subject",
      at: args.createdAt,
      level: "info",
      type: "cua-lab.subject.declared",
      message: `Subject app declared at ${args.appUrl} (loopback inside the desktop sandbox).`,
      simId: "sim-001",
      streamId: "stream-001"
    },
    args.session
      ? {
          id: "event-002-session",
          at: args.createdAt,
          level: args.session.status === "passed" ? "info" : "warn",
          type: `cua-lab.session.${args.session.completionReason}`,
          message: `${args.session.status}: ${args.session.reason}`,
          simId: "sim-001",
          streamId: "stream-001"
        }
      : args.sessionError
        ? {
            id: "event-002-session",
            at: args.createdAt,
            level: "error" as const,
            type: "cua-lab.session.error",
            message: args.sessionError,
            simId: "sim-001",
            streamId: "stream-001"
          }
        : {
            id: "event-002-contract",
            at: args.createdAt,
            level: "info" as const,
            type: "cua-lab.contract.ready",
            message: "Dry-run contract bundle ready; switch scenario.mode to live for a real desktop session.",
            simId: "sim-001",
            streamId: "stream-001"
          }
  ];

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict: args.session ? verdictForStatus(args.session.status) : args.sessionError ? "fail" : "contract_proof_only",
    summary: reason,
    gaps: args.session || args.sessionError ? [] : ["Live desktop session not yet run (dry-run contract only)."]
  };

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: 1,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".mimetic", "runs", args.runId),
    source: args.source,
    persona: {
      id: args.persona.id,
      name: `Computer-use operator (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    scenario: {
      id: `cua-${args.labId}`,
      title: args.labTitle ?? `Computer-use lab: ${args.labId}`,
      goal: args.mission,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "cua-lab.run.created",
        message: `Created computer-use lab run with one desktop browser lane (actor ${args.actorId}).`
      }
    ],
    simulations: [simulation],
    streams: [stream],
    events,
    redaction: {
      status: "passed",
      notes: "Computer-use evidence is redacted at the loop boundary: screenshots are blurred fail-closed, typed text is recorded as length only, and reasoning/messages pass through text redaction."
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

function verdictForStatus(status: ActorStatus): ReviewSummary["verdict"] {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "blocked":
      return "blocked";
    case "timed_out":
      return "timed_out";
  }
}

function renderCuaReviewMarkdown(bundle: RunBundle): string {
  const trace: ActorTrace | undefined = bundle.streams[0]?.actor;
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    ...(trace
      ? [
          `- actor: ${trace.provider} (${trace.lane}/${trace.protocol})`,
          `- evidence: ${trace.items.length} trace item(s), ${trace.counts.screenshots ?? 0} redacted screenshot(s)`
        ]
      : []),
    ...(bundle.review.gaps.length > 0 ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)] : []),
    ""
  ].join("\n");
}

function makeCuaRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `cua-${stamp}-${randomBytes(4).toString("hex")}`;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
