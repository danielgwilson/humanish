// The computer-use lab backend: a subject (an app-url the caller provisioned, or a repo the
// lab clones AND serves in-sandbox) driven by a REGISTRY-RESOLVED computer-use actor inside a
// hosted E2B desktop. This is the path that makes `actors[].type` load-bearing — the
// descriptor returned by the registry runs the session; the lab provisions the desktop and
// subject, composes the prompt from config, persists the evidence bundle, and tears down.
//
// Substrate notes:
// - The desktop is created via the shared loader in e2b-desktop-launch.ts with kill-on-timeout
//   lifecycle, so a dead host process can never orphan a sandbox past its server-side deadline.
// - Env placement follows the doctrine (docs/principles/invariants-and-defaults.md): the
//   ACTOR's key never enters the sandbox (the model drives from outside via the provider API);
//   the SUBJECT's declared env NAMES are provisioned in on the clone route — values come from
//   the caller's environment and are never logged or persisted.
// - The live stream URL is runtime-only (carries an auth key) and is never persisted into run
//   artifacts — only its presence is recorded, mirroring the meta lab's convention.
// - Evidence redaction is mode-aware (docs/principles/invariants-and-defaults.md, the
//   capture-vs-publish rule): screenshots persist RAW (full fidelity) by default into gitignored
//   .mimetic/; `policies.redactScreenshots: true` opts into blur-at-capture for a share-as-is
//   bundle. Length-only typed text and text redaction of reasoning/messages are UNCONDITIONAL;
//   harness errors are redacted at THIS boundary; the bundle's `stream.actor` carries the
//   conformant mimetic.actor-trace.v1 projection, whose `redaction.screenshots` records the
//   run's actual mode ("raw" | "blurred" | "n/a") — every label downstream derives from it.

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
import {
  probeUrl,
  readDetachedLog,
  runDetachedStep,
  startDetachedProcess,
  type DetachedTimers
} from "./e2b-detached.js";
import {
  DEFAULT_DEVICE_PRESET,
  isDevicePresetName,
  resolveDevicePreset,
  type DevicePreset
} from "./device-presets.js";
import { isHttpUrl, isLoopbackUrl, type LabConfig, type LabSubjectServe } from "./lab-config.js";
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
// Settle after opening the browser, before the first screenshot — long enough for a cold
// browser + page load to paint (2s captured a blank desktop; the render empirically needs ~6-9s).
const BROWSER_SETTLE_MS = 8_000;
// Device/viewport comes from the named-preset registry (device-presets.ts), selectable per run
// via execution.desktop.device (default `desktop`=1440x950). NOTE: this is run-wide for now; a
// per-PERSONA device dimension (N personas × devices, as the bespoke sims author) lands with
// fan-out. On this E2B-desktop route only width/height physically render — isMobile/DSF are
// honest metadata + a prompt signal, not rendered (device-presets.ts FIDELITY NOTE).
// Server-side reclamation buffer past the loop's own wall-clock stop.
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;
// Room the clone route adds to the sandbox deadline for clone/install/build/start/probe.
const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;
const SUBJECT_DIR = "/home/user/subject";
const CLONE_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 180_000;
// How much of a failing step's log tail rides the (redacted) error message.
const ERROR_TAIL_CHARS = 2000;

/**
 * Library-level hooks. `prepareDesktop` runs after sandbox creation and before subject
 * provisioning / browser launch — library callers use it for extra in-sandbox setup beyond
 * what `subject.serve` declares (or to provision an app-url subject entirely). The rest are
 * DI seams so CI drives the full path with fakes at zero network/zero spend.
 */
export interface CuaActorLabHooks {
  prepareDesktop?: (desktop: E2BDesktopSandbox) => Promise<void>;
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  runSession?: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock/sleep for the detached-step polling (tests only). */
  detachedTimers?: DetachedTimers;
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
  /** Subject provenance (invariant 5): what the actor actually drove. */
  subject?: {
    source: "app-url" | "clone";
    repo?: string;
    /** Cloned commit SHA, when the clone route resolved one. */
    commit?: string;
    /** Declared env NAMES provisioned for the subject (values never surface anywhere). */
    envNames?: string[];
  };
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code:
      | "MIMETIC_CUA_LAB_FAILED"
      | "MIMETIC_CUA_LAB_KEYS_MISSING"
      | "MIMETIC_CUA_LAB_SUBJECT_ENV_MISSING"
      | "MIMETIC_CUA_LAB_ACTOR_UNSUPPORTED"
      | "MIMETIC_CUA_LAB_SUBJECT_INVALID"
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

  // The entry URL: caller-provisioned for app-url subjects; serve-declared for clone subjects
  // (the lab serves the app in-sandbox before the actor drives it).
  const cloneRoute = config.subject.source === "clone";
  const serve = config.subject.serve;
  const appUrl = (cloneRoute ? serve?.url : config.subject.appUrl) ?? "";
  const subjectRepo = cloneRoute ? config.subject.repos?.[0] ?? "" : undefined;
  const subjectEnvNames = cloneRoute ? config.subject.env ?? [] : [];
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

  // Engine re-enforcement of the clone-route structure for configs arriving via the library
  // API (the parser rejects these too, but runCuaActorLab is itself exported npm surface).
  if (cloneRoute && (!serve || !subjectRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(subjectRepo))) {
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
        code: "MIMETIC_CUA_LAB_SUBJECT_INVALID",
        message: !serve
          ? "clone subjects on the computer-use route require `subject.serve` (start + url) — the lab serves the app in-sandbox."
          : `subject.repos[0] must be an owner/repo slug (got "${subjectRepo ?? ""}").`
      }
    };
  }

  // Re-enforce the entry-target boundary for configs that arrive through the library API
  // (the parser rejects these too, but runCuaActorLab is itself exported npm surface). For a
  // served clone the entry is always loopback (we serve it in-sandbox); for an app-url subject
  // the owner may declare a public/preview target via policies.allowPublicTargets.
  const allowPublicTargets = config.policies?.allowPublicTargets === true;
  const entryTargetSafe = cloneRoute
    ? isLoopbackUrl(appUrl)
    : allowPublicTargets
      ? isHttpUrl(appUrl)
      : isLoopbackUrl(appUrl);
  if (!entryTargetSafe) {
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
        message: cloneRoute || !allowPublicTargets
          ? "subject entry URL must be loopback (127.0.0.1 or localhost) unless policies.allowPublicTargets is set for an app-url subject."
          : "subject.appUrl must be a valid http(s) URL."
      }
    };
  }

  const runId = options.runId ?? makeCuaRunId();
  const artifactRoot = path.join(cwd, ".mimetic", "runs", runId);
  const createdAt = new Date().toISOString();
  // Device resolution order (most-specific wins): raw resolution escape hatch → named device
  // preset → default preset. The preset also carries isMobile/DSF as honest metadata + a prompt
  // signal (only width/height physically render on the E2B-desktop route — see device-presets.ts).
  // Resolve ONE device — so the rendered resolution, the prompt, and the bundle's isMobile/DSF
  // metadata can never contradict each other. A raw `resolution` override wins, but then it is
  // an unnamed custom desktop (non-mobile, DSF 1): we will not claim a named preset's
  // mobile/DPR for geometry the caller hand-set.
  const rawResolution = config.execution?.desktop?.resolution;
  let deviceName: string;
  let devicePreset: DevicePreset;
  if (rawResolution) {
    deviceName = "custom";
    devicePreset = { width: rawResolution[0], height: rawResolution[1], isMobile: false, deviceScaleFactor: 1 };
  } else {
    const presetName = isDevicePresetName(config.execution?.desktop?.device)
      ? config.execution?.desktop?.device
      : DEFAULT_DEVICE_PRESET;
    deviceName = presetName;
    devicePreset = resolveDevicePreset(presetName);
  }
  const resolution: [number, number] = [devicePreset.width, devicePreset.height];
  const timeoutMs = config.execution?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;

  const { instructions, persona } = composeInstructions(config, { name: deviceName, preset: devicePreset });

  // Read once into locals (names only; values never logged or persisted) — this also keeps
  // history clean for line-pattern secret scanners that flag inline `apiKey: env.X` reads.
  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";

  // Pattern-based redaction cannot catch an ARBITRARY provisioned value (a DB password has
  // no secret "shape"), so every value this lab knows is scrubbed by literal match before
  // anything can persist — applied at the log-tail source (pre-truncation, so a cut tail can
  // never split a value past the scrubber) and again at the catch boundary.
  const knownSecretValues = [
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? "")
  ].filter((value) => value.length >= 4);
  const scrubKnownValues = (text: string): string =>
    knownSecretValues.reduce((current, value) => current.split(value).join("[REDACTED_SECRET]"), text);

  // Provenance redaction: honor policies.redactRepos, and DEFAULT to redacting the slug when
  // the clone authenticates (a token-bearing clone is a private repo until declared otherwise).
  const redactRepoLabel = config.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo = cloneRoute && subjectRepo ? (redactRepoLabel ? "repo-01" : subjectRepo) : undefined;

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

    // The subject's declared env channel fails closed BEFORE any sandbox exists: every
    // declared NAME must be present in the caller's environment.
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
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
          code: "MIMETIC_CUA_LAB_SUBJECT_ENV_MISSING",
          message: `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`
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
  let subjectCommit: string | undefined;

  if (!dryRun) {
    const requestTimeoutMs = readPositiveInt(env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000);
    // The subject's serve steps (clone/install/build) need their own room beyond the actor
    // session budget; the sandbox deadline covers the whole lane.
    const sandboxTimeoutMs = config.execution?.desktop?.sandboxTimeoutMs
      ?? timeoutMs + (cloneRoute ? SUBJECT_PROVISION_BUDGET_MS : 0) + SANDBOX_TIMEOUT_BUFFER_MS;
    // The module load lives INSIDE the try: a missing optional peer becomes a structured
    // failed result + persisted failed bundle, never a raw stack out of the CLI.
    let desktopModule: E2BDesktopModule | undefined;
    let desktop: E2BDesktopSandbox | undefined;
    try {
      desktopModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
      desktop = await desktopModule.Sandbox.create({
        apiKey: e2bApiKey,
        requestTimeoutMs,
        timeoutMs: sandboxTimeoutMs,
        metadata: {
          ...CUA_ACTOR_LAB_PROVIDER_METADATA,
          labId: config.id,
          simId: "sim-001"
        },
        // Env placement per the doctrine: the ACTOR's key never enters the sandbox (the model
        // drives from outside). The SUBJECT's declared env NAMES are provisioned here on the
        // clone route — values resolve from the caller's environment and are never persisted.
        ...(subjectEnvNames.length > 0
          ? { envs: Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])) }
          : {}),
        resolution,
        dpi: 96,
        lifecycle: { onTimeout: "kill" }
      });
      sandboxId = desktop.sandboxId;

      if (hooks.prepareDesktop) {
        await hooks.prepareDesktop(desktop);
      }

      if (cloneRoute && serve && subjectRepo) {
        subjectCommit = await provisionCloneSubject(desktop, {
          repo: subjectRepo,
          depth: config.subject.clone?.depth ?? 1,
          serve,
          hasGithubToken: subjectEnvNames.includes("GITHUB_TOKEN"),
          requestTimeoutMs,
          scrub: scrubKnownValues,
          // Provenance survives later-step failures: the commit is recorded the moment it
          // resolves, not only when provisioning returns.
          onCommit: (commit) => {
            subjectCommit = commit;
          },
          ...(hooks.detachedTimers ?? {})
        });
      }

      if (desktop.open) {
        await desktop.open(appUrl);
      } else {
        await desktop.launch("google-chrome", appUrl);
      }
      // Let the browser cold-start AND paint the page before the first screenshot. 2s was
      // empirically too short (a cold browser + page load needs ~6-9s; a 2s settle captured a
      // blank desktop, which the model then "completed" with zero actions — a false pass).
      await desktop.wait(BROWSER_SETTLE_MS).catch(() => undefined);

      try {
        await desktop.stream.start({ requireAuth: true });
        streamUrl = desktop.stream.getUrl({
          authKey: desktop.stream.getAuthKey(),
          autoConnect: true,
          viewOnly: true,
          resize: "scale"
        });
      } catch (error) {
        warnings.push(`Live desktop stream unavailable (run continues; evidence still captured): ${redactText(scrubKnownValues(compactError(error)))}`);
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
        // Default raw (full fidelity, local .mimetic); opt into blur for unowned/shared bundles.
        redactScreenshots: config.policies?.redactScreenshots === true,
        // Close the narration hole: a provisioned VALUE the model transcribes into reasoning/
        // message text is literal-scrubbed (it has no shape for pattern redaction to catch).
        scrubText: scrubKnownValues,
        writeScreenshot
      };
      session = await runSession(sessionOptions);
    } catch (error) {
      // Scrubbed + redacted at the lab boundary: known provisioned VALUES are literal-scrubbed
      // first (pattern redaction cannot catch them), then the pattern pass handles
      // secret-shaped content. Flows into the bundle, review.md, and result.error.
      sessionError = redactText(scrubKnownValues(compactError(error)));
    } finally {
      if (desktop && desktopModule) {
        // Honor subject.clone.keep on FAILURE: leave the sandbox up so the operator can drop in
        // and debug a failed install/build/boot (the smoke route honors keep; parity here). On
        // success, or when keep is not set, always reclaim.
        const failed = sessionError !== undefined || session === undefined;
        const keepForDebug = config.subject.clone?.keep === true && failed;
        if (keepForDebug) {
          warnings.push(`Sandbox ${desktop.sandboxId} kept for debugging (subject.clone.keep on failure); reclaim it via E2B or it will be killed on its server-side timeout.`);
        } else if (typeof desktopModule.Sandbox.kill === "function") {
          try {
            await desktopModule.Sandbox.kill(desktop.sandboxId, { requestTimeoutMs: 60_000 });
            killed = true;
          } catch (error) {
            warnings.push(`Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrubKnownValues(compactError(error)))}`);
          }
        } else {
          warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox.");
        }
      }
    }
  }

  const subjectProvenance = cloneRoute && publicRepo
    ? {
        repo: publicRepo,
        ...(subjectCommit === undefined ? {} : { commit: subjectCommit }),
        envNames: subjectEnvNames
      }
    : undefined;

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
    deviceScaleFactor: devicePreset.deviceScaleFactor,
    isMobile: devicePreset.isMobile,
    runId,
    screenshots,
    captureRedaction: config.policies?.redactScreenshots === true ? "blurred" : "raw",
    ...(session ? { session } : {}),
    ...(sessionError ? { sessionError } : {}),
    source,
    ...(subjectProvenance === undefined ? {} : { subjectProvenance }),
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

  // Surface the local-fidelity posture so the operator knows the bundle is not publish-safe as-is.
  if (session?.trace.redaction.screenshots === "raw") {
    warnings.push("Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .mimetic and nothing scans these pixels; review them before sharing anywhere. Set policies.redactScreenshots: true to blur a share-as-is bundle.");
  }

  // Honesty guard: a "goal_satisfied" with ZERO actions and ZERO messages is not a credible
  // natural endpoint — the actor neither did nor said anything, which in practice means it saw a
  // blank or still-loading screen and stopped. Such a run must NOT pass as a proof.
  const noEngagement = !dryRun
    && session !== undefined
    && session.completionReason === "goal_satisfied"
    && (session.trace.counts.actions ?? 0) === 0
    && (session.trace.counts.messages ?? 0) === 0;
  if (noEngagement) {
    warnings.push("Actor returned goal_satisfied with ZERO actions and ZERO messages — it likely saw a blank or still-loading screen and stopped without engaging. NOT counted as a pass. Check the screenshot; raise execution.timeoutMs or confirm the subject painted before the first turn.");
  }

  const observer = await render(cwd, runId, { open: options.open === true });

  const ok = observer.ok
    && sessionError === undefined
    && !noEngagement
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
    subject: cloneRoute && publicRepo
      ? {
          source: "clone",
          repo: publicRepo,
          ...(subjectCommit === undefined ? {} : { commit: subjectCommit }),
          envNames: subjectEnvNames
        }
      : { source: "app-url" },
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: "MIMETIC_CUA_LAB_FAILED" as const,
            message: sessionError
              ?? (observer.ok
                ? noEngagement
                  ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
                  : session?.completionReason === "harness_error"
                  ? `Computer-use session ended with a harness error: ${session.reason}`
                  : "Computer-use lab did not produce a terminal session."
                : observer.error?.message ?? "Observer failed for the computer-use lab run.")
          }
        })
  };
}

/**
 * Provision a clone subject inside the sandbox: clone → (install) → (build) → start →
 * readiness probe. Returns the cloned commit SHA. Throws (with a capped log tail for the
 * caller to redact) on any failing step — the lab persists that as a failed-evidence bundle.
 *
 * Auth: when GITHUB_TOKEN is among the declared subject env names, the clone authenticates
 * via an Authorization header computed IN-SANDBOX from the provisioned env — the token never
 * appears in the script text, the process argv beyond the transient git call, the clone URL,
 * or .git/config.
 */
async function provisionCloneSubject(
  desktop: E2BDesktopSandbox,
  args: {
    repo: string;
    depth: number;
    serve: LabSubjectServe;
    hasGithubToken: boolean;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment the cloned commit resolves, so provenance survives later failures. */
    onCommit?: (commit: string) => void;
  } & DetachedTimers
): Promise<string | undefined> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep })
  };
  const cloneCommand = args.hasGithubToken
    ? `auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0) && git -c http.extraHeader="Authorization: Basic $auth" clone --depth ${args.depth} https://github.com/${args.repo}.git ${SUBJECT_DIR}`
    : `git clone --depth ${args.depth} https://github.com/${args.repo}.git ${SUBJECT_DIR}`;

  const clone = await runDetachedStep(desktop, {
    name: "subject-clone",
    command: cloneCommand,
    timeoutMs: CLONE_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers
  });
  if (!clone.ok) {
    throw new Error(`subject clone ${clone.timedOut ? "timed out" : `failed (exit ${clone.exitCode})`}: ${tailOf(args.scrub(clone.logTail))}`);
  }

  const head = await desktop.commands.run(
    `git -C ${SUBJECT_DIR} rev-parse HEAD 2>/dev/null || true`,
    { requestTimeoutMs: args.requestTimeoutMs }
  );
  const commit = (head.stdout ?? "").trim() || undefined;
  if (commit) {
    args.onCommit?.(commit);
  }

  if (args.serve.install) {
    const install = await runDetachedStep(desktop, {
      name: "subject-install",
      command: args.serve.install,
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      ...timers
    });
    if (!install.ok) {
      throw new Error(`subject install ${install.timedOut ? "timed out" : `failed (exit ${install.exitCode})`}: ${tailOf(args.scrub(install.logTail))}`);
    }
  }

  if (args.serve.build) {
    const build = await runDetachedStep(desktop, {
      name: "subject-build",
      command: args.serve.build,
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      ...timers
    });
    if (!build.ok) {
      throw new Error(`subject build ${build.timedOut ? "timed out" : `failed (exit ${build.exitCode})`}: ${tailOf(args.scrub(build.logTail))}`);
    }
  }

  await startDetachedProcess(desktop, {
    name: "subject-start",
    command: args.serve.start,
    cwd: SUBJECT_DIR,
    requestTimeoutMs: args.requestTimeoutMs
  });

  const ready = await probeUrl(desktop, args.serve.url, {
    timeoutMs: args.serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers
  });
  if (!ready) {
    const startLog = await readDetachedLog(desktop, "subject-start", args.requestTimeoutMs).catch(() => "");
    throw new Error(`subject did not answer at ${args.serve.url} within ${args.serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms; server log tail: ${tailOf(args.scrub(startLog))}`);
  }

  return commit;
}

function tailOf(log: string): string {
  // Pattern-redact on the FULL text BEFORE truncating: slicing a tail could otherwise cut
  // through a secret's prefix (e.g. drop "sk-proj-") and defeat the pattern matcher on the
  // remainder. Callers literal-scrub known provisioned values first; this is the pattern pass.
  // (The in-sandbox `tail -c` upstream is a fundamental log-tail limit we cannot redact past.)
  const trimmed = redactText(log).trim();
  return trimmed.length > ERROR_TAIL_CHARS ? `…${trimmed.slice(-ERROR_TAIL_CHARS)}` : trimmed || "(no output)";
}

/** Compose the actor prompt from config: persona line + mission + per-lane steer. */
function composeInstructions(
  config: LabConfig,
  device: { name: string; preset: DevicePreset }
): { instructions: string; persona: ActorPersonaRef } {
  const actor = config.actors[0];
  const mission = actor?.mission
    ?? "You are testing a web application. The browser is already open at the subject URL. Explore it, accomplish what the scenario asks, and stop when done.";
  // Device prompt signal (copied from the bespoke sims' organic lanes): only width/height
  // physically render on this route, so the model is TOLD its device so it behaves accordingly
  // (e.g. expects a mobile layout / touch targets on a phone preset).
  const deviceLine = device.preset.isMobile
    ? `You are a mobile user on a ${device.name} device (${device.preset.width}x${device.preset.height} @${device.preset.deviceScaleFactor}x). Expect a mobile/touch layout.`
    : `You are a desktop user (${device.name}, ${device.preset.width}x${device.preset.height}).`;
  const parts = [
    actor?.persona ? `Persona: ${actor.persona}.` : undefined,
    deviceLine,
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
  /** Device metadata for the stream viewport (honest; isMobile/DSF are not rendered on this route). */
  deviceScaleFactor?: number;
  isMobile?: boolean;
  runId: string;
  screenshots: string[];
  /**
   * Capture-time screenshot policy ("blurred" when policies.redactScreenshots, else "raw").
   * When a session ran, its trace's `redaction.screenshots` is the evidence-of-record and
   * wins; this fallback keeps labels honest for frames written before a mid-session failure
   * (no trace exists to testify then). Defaults to "raw" — the engine default.
   */
  captureRedaction?: "raw" | "blurred";
  session?: CuaLoopResult;
  sessionError?: string;
  source: RunBundle["source"];
  /** Clone-route provenance: what the actor actually drove (names only, never values). */
  subjectProvenance?: { repo: string; commit?: string; envNames: string[] };
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

  // Honest labels (invariant 6: claims match mechanism): every screenshot label names the
  // run's ACTUAL mode. The session trace is the evidence-of-record; the capture policy covers
  // frames written before a mid-session failure produced a trace.
  const traceScreenshotMode = args.session?.trace.redaction.screenshots;
  const screenshotMode: "raw" | "blurred" =
    traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
      ? traceScreenshotMode
      : args.captureRedaction ?? "raw";

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
      ? { kind: "screenshot", url: lastScreenshot, title: `CUA desktop (${screenshotMode})` }
      : { kind: "placeholder", title: "CUA desktop" },
    viewport: {
      width: args.resolution[0],
      height: args.resolution[1],
      deviceScaleFactor: args.deviceScaleFactor ?? 1,
      ...(args.isMobile === undefined ? {} : { isMobile: args.isMobile })
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
        label: `screenshot ${String(index + 1).padStart(2, "0")} (${screenshotMode})`,
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
    args.subjectProvenance
      ? {
          id: "event-001-subject",
          at: args.createdAt,
          level: "info" as const,
          type: "cua-lab.subject.provenance",
          // HONEST WORDING: claim "cloned and served" only when it actually happened.
          message: `${args.dryRun
            ? `Subject declared: clone of ${args.subjectProvenance.repo}, to be served at ${args.appUrl} in-sandbox (dry-run contract; nothing cloned)`
            : args.subjectProvenance.commit
              ? args.session
                ? `Subject cloned from ${args.subjectProvenance.repo}@${args.subjectProvenance.commit} and served at ${args.appUrl} in-sandbox`
                : `Subject cloned from ${args.subjectProvenance.repo}@${args.subjectProvenance.commit}; serving at ${args.appUrl} did not complete (see session error)`
              : `Subject clone attempted from ${args.subjectProvenance.repo}; commit unresolved (provisioning failed before resolution)`
          } (subject env names: ${args.subjectProvenance.envNames.length > 0 ? args.subjectProvenance.envNames.join(", ") : "none"}; values never persisted).`,
          simId: "sim-001",
          streamId: "stream-001"
        }
      : {
          id: "event-001-subject",
          at: args.createdAt,
          level: "info" as const,
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
      notes: traceScreenshotMode === "raw"
        ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are FULL-FIDELITY (raw), retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle."
        : traceScreenshotMode === "blurred"
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle."
          : args.screenshots.length > 0
            ? `Session ended before a trace was recorded; ${args.screenshots.length} already-written frame(s) follow the capture policy (${screenshotMode}). Typed text is recorded as length only and reasoning/messages pass through text redaction.`
            : "No screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs."
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
  const provenance = bundle.events.find((event) => event.type === "cua-lab.subject.provenance");
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    ...(provenance ? [`- subject: ${provenance.message}`] : []),
    ...(trace
      ? [
          `- actor: ${trace.provider} (${trace.lane}/${trace.protocol})`,
          // Honest count: name the trace's actual screenshot mode ("raw" | "blurred"); say
          // nothing when no frames exist ("n/a") rather than claim a redaction that never ran.
          `- evidence: ${trace.items.length} trace item(s), ${trace.counts.screenshots ?? 0} ${
            trace.redaction.screenshots === "raw" || trace.redaction.screenshots === "blurred"
              ? `${trace.redaction.screenshots} screenshot(s)`
              : "screenshot(s)"
          }`
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
