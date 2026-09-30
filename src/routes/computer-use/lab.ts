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
//   .humanish/; `policies.redactScreenshots: true` opts into blur-at-capture for a share-as-is
//   bundle. Length-only typed text and text redaction of reasoning/messages are UNCONDITIONAL;
//   harness errors are redacted at THIS boundary; the bundle's `stream.actor` carries the
//   conformant humanish.actor-trace.v1 projection, whose `redaction.screenshots` records the
//   run's actual mode ("raw" | "blurred" | "n/a") — every label downstream derives from it.

import type { CuaLiveMetadata } from "../../actors/computer-use/loop.js";
import { prepareReceivingRun } from "../../comms/receiving-runtime.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import { laneHasInboxRecipient } from "./desktop-lane.js";
import { commandDigestOf } from "../../substrates/e2b/cua-provisioning.js";
import { receivingEmailValidationReason } from "../../lab/validation.js";
import { withTransientCommsSecrets } from "../../run/narration-secrets.js";
import { randomBytes } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import {
  completeAutomaticAnalysis,
  markFinalizedStudyResult,
} from "../../analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { describeMissingKeys } from "../../cli/key-resolution.js";
import {
  desktopMediaValidationReason,
  taskProtocolValidationReason,
} from "../../lab/validation.js";
import { toErrorMessage } from "../../substrates/command-failure.js";
import { summarizeCuaDiagnostics } from "./diagnostics.js";
import type { ActorTokenUsage, ActorTraceItem } from "../../actors/contract.js";
import { actorRegistry, isCuaActorDescriptor } from "../../actors/registry.js";
import {
  adapterScoreFailureMessage,
  applyBrowserAdapterHooks,
} from "../../lab/adapter-extension.js";
import { FakeInbox } from "../../comms/fake-inbox.js";
import {
  collectExternalCommsThread,
  externalCatchHealthy,
  externalInboxUrl,
} from "../../comms/sandbox-catch.js";
import type { CommsAddress } from "../../comms/types.js";
import { MAX_CUA_LANES } from "../../lab/routing.js";
import { cuaLaneValidationReason, outputTokenLimitValidationReason } from "../../lab/validation.js";
import { isHttpUrl, isLoopbackUrl, subjectStateInvalidReason } from "../../lab/parse-subject.js";
import { type LabSubjectState } from "../../lab/types.js";
import {
  checkHostedCodexCompatibility,
  detectLocalAgents,
  type LocalAgentId,
} from "../../actors/local-agent/cli.js";
import {
  attachObserverRuntimeStreamUrls,
  renderObserver,
  type ObserverResult,
  type ObserverRuntimeStreamUrl,
} from "../../observer/render.js";
import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { labPersonaIds, resolveCommittedPersonas } from "../../lab/persona-resolve.js";
import { scrubPersonaBrief } from "../../lab/persona.js";
import { MODEL_RATES, round6 } from "../../run/pricing.js";
import { redactText } from "../../evidence/redaction.js";
import { prepareRunArtifactPaths } from "../../run/paths.js";
import { beginRunStatus, withRunStatusScope, type RunStatusHandle } from "../../run/status.js";
import {
  buildRunSource,
  type RunBundle,
  type RunRerunLineage,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
} from "../../run/bundle.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareContainedOutputDirectory,
  prepareSelectedOutputDirectory,
  writeContainedOutputFile,
} from "../../run/selected-output-paths.js";
import { createLocalTreeArchive, type LocalTreeArchive } from "../../run/source-archive.js";
import {
  buildLaneSummary,
  laneOutcomeOk,
  observerResultForCuaArtifacts,
  writeCuaRunArtifacts,
} from "./bundle.js";
import { buildCuaFanoutBundle } from "./fanout-bundle.js";
import {
  defaultSessionTimeoutMs,
  emitPreflightPlan,
  laneSpecsAndPlan,
  makeCuaRunBudget,
  readPositiveInt,
  resolveCuaRerunSelection,
  resolvePerLaneSandboxMs,
} from "./lane-plan.js";
import {
  laneSubjectProjection,
  runCuaLane,
  runCuaLanes,
  runInProcessLane,
  subjectProvenanceArg,
  toLaneResult,
} from "./lanes.js";
import { buildSingleLaneBundle } from "./single-bundle.js";
import {
  CUA_ACTOR_LAB_SCHEMA,
  type CuaActorLabErrorCode,
  type CuaActorLabHooks,
  type CuaActorLabResult,
  type CuaLaneDeps,
  type CuaSubjectProjection,
  type LaneRunOutcome,
  MAX_SANDBOX_MS,
  type RunCuaActorLabOptions,
} from "./types.js";

export { inboxRecipientFor, laneHasInboxRecipient } from "./desktop-lane.js";
export {
  CUA_ACTOR_LAB_PROVIDER_METADATA,
  SUBJECT_DIR,
  buildFillDesktopWindowCommand,
  captureDesktopBrowserGeometry,
  commandDigestOf,
  declaredScreenForRender,
  desktopBrowserFamily,
  inspectDesktopScreenGeometry,
  makeChromeBrowserStateObserver,
  makeChromeDesktopGeometryObserver,
  parseXwininfoGeometry,
  provisionCloneSubject,
  provisionLocalTreeSubject,
  type DesktopBrowserEvidence,
  type DesktopBrowserFamily,
  type DesktopBrowserLaunchIdentity,
  type DesktopBrowserLaunchResult,
  type SubjectPhaseEvent,
} from "../../substrates/e2b/cua-provisioning.js";

/**
 * Wrapped so a DIRECT library caller gets the same status-record lifetime the CLI does: returning
 * from this function finalizes any record the run opened, whichever of its fail-closed exits it
 * took. `runLab` establishes a scope too and nesting is harmless — the inner scope owns what it
 * opened. Without this a test or an adopter calling the backend directly leaves the 5s cadence
 * ticking into a directory something else is deleting, which surfaces as an unrelated ENOTEMPTY.
 */
export async function runCuaActorLab(options: RunCuaActorLabOptions): Promise<CuaActorLabResult> {
  return withTransientCommsSecrets(() => runCuaActorLabWithSecrets(options));
}

async function runCuaActorLabWithSecrets(
  options: RunCuaActorLabOptions,
): Promise<CuaActorLabResult> {
  const analysisReason = resolveAutomaticAnalysis(options.config.review?.analysis);
  const tasksReason = analysisReason.ok
    ? taskProtocolValidationReason(options.config, true)
    : analysisReason.message;
  if (tasksReason)
    return {
      schema: CUA_ACTOR_LAB_SCHEMA,
      ok: false,
      cwd: path.resolve(options.cwd),
      labId: options.config.id,
      actor: options.config.actors[0]?.type ?? "",
      dryRun: options.dryRun,
      runId: options.runId ?? "not-created",
      appUrl: options.config.subject.appUrl ?? options.config.subject.serve?.url ?? "",
      lanes: [],
      warnings: [],
      error: {
        code: analysisReason.ok
          ? "HUMANISH_LAB_TASKS_UNSUPPORTED"
          : "HUMANISH_LAB_ANALYSIS_INVALID",
        message: tasksReason,
      },
    };
  const analysis = resolveAutomaticAnalysis(options.config.review?.analysis);
  const result = await withRunStatusScope(() => runCuaActorLabInScope(options));
  return completeAutomaticAnalysis(
    result,
    analysis.ok ? analysis.config : undefined,
    options.automaticAnalysis,
    options.config.review?.analysis === undefined ? "default" : "explicit",
    analysis.ok && analysis.preferLargerOutput === true,
  );
}

async function runCuaActorLabInScope(options: RunCuaActorLabOptions): Promise<CuaActorLabResult> {
  const { config, dryRun } = options;
  // Capture the physical project before reading or invoking any caller hook. A supported
  // symlink cwd remains valid, but retargeting that alias from a hook cannot redirect source
  // reads, local-tree packing, managed run storage, or Observer output into another project.
  const physicalCwd = await realpath(path.resolve(options.cwd));
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const cwd = projectRoot.physicalPath;
  const hooks = options.hooks ?? {};
  let liveObserver: (ObserverResult & { ok: true }) | undefined;
  const runtimeStreamUrls: ObserverRuntimeStreamUrl[] = [];
  const liveHooks: CuaActorLabHooks = {
    ...hooks,
    onRuntimeStreamReady: async (stream) => {
      await hooks.onRuntimeStreamReady?.(stream);
      runtimeStreamUrls.push({ streamId: stream.streamId, url: stream.url });
      if (liveObserver) {
        attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
      }
    },
    onRuntimeStreamEnded: async (stream) => {
      await hooks.onRuntimeStreamEnded?.(stream);
      // Mark, never remove: the tile needs to KNOW the live view ended (and say so) rather than
      // have the stream silently vanish from the overlay (#357).
      for (const entry of runtimeStreamUrls) {
        if (entry.streamId === stream.streamId) entry.ended = true;
      }
      if (liveObserver) {
        attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
      }
    },
  };
  const env = hooks.env ?? process.env;
  const render = hooks.renderObserverFn ?? renderObserver;

  const cloneRoute = config.subject.source === "clone";
  // A CLI studied at a desktop (#495): nothing cloned, no browser, a terminal instead.
  const desktopCliRoute = config.subject.source === "desktop-cli";
  const localTreeRoute = config.subject.source === "local-tree";
  // Both routes provision the subject in-sandbox (clone via git, local-tree via pack+upload)
  // and then share the identical install/build/state/start/probe pipeline, so every seam that
  // gates on "does this route provision a subject" is keyed on this union, not on cloneRoute
  // alone.
  const provisionedRoute = cloneRoute || localTreeRoute;
  const serve = config.subject.serve;
  const appUrl = (provisionedRoute ? serve?.url : config.subject.appUrl) ?? "";
  const subjectRepo = cloneRoute ? (config.subject.repos?.[0] ?? "") : undefined;
  const subjectEnvNames = provisionedRoute ? (config.subject.env ?? []) : [];
  const actor = config.actors[0];
  const actorType = actor?.type ?? "";

  const fail = (
    code: CuaActorLabErrorCode,
    message: string,
    actorLabel?: string,
  ): CuaActorLabResult => ({
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: actorLabel ?? actorType,
    appUrl,
    dryRun,
    runId: options.runId ?? "not-created",
    lanes: [],
    warnings: [],
    error: { code, message },
  });

  // Resolve the actor through the registry — the parse layer validated this, but the engine fails
  // closed rather than trusting a config that arrived through another door.
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return fail(
      "HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered computer-use actor.`,
    );
  }
  const runSession = hooks.runSession ?? descriptor.runSession;
  const mediaReason = desktopMediaValidationReason(config);
  if (mediaReason) return fail("HUMANISH_CUA_LAB_SUBJECT_INVALID", mediaReason, descriptor.id);
  const outputLimitReason = outputTokenLimitValidationReason(config);
  if (outputLimitReason)
    return fail("HUMANISH_CUA_LAB_SUBJECT_INVALID", outputLimitReason, descriptor.id);
  if (
    actor?.maxOutputTokens !== undefined &&
    (hooks.runSession || hooks.buildProvider || hooks.buildExecutor)
  ) {
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      "maxOutputTokens cannot be enforced by a custom runSession/provider/executor route.",
      descriptor.id,
    );
  }
  const receivingReason = receivingEmailValidationReason(config);
  if (receivingReason)
    return fail("HUMANISH_CUA_LAB_SUBJECT_INVALID", receivingReason, descriptor.id);
  const inProcessRoute = hooks.buildExecutor !== undefined;
  if (inProcessRoute && config.comms?.email?.kind === "real")
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      "Real email receiving requires hosted participant desktops.",
      descriptor.id,
    );
  if (inProcessRoute && config.execution?.desktop?.media !== undefined) {
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      "execution.desktop.media is not provisioned by a caller-supplied executor. Remove the declaration or use a hosted computer-use browser lane.",
      descriptor.id,
    );
  }
  if (inProcessRoute && config.execution?.desktop?.recording !== undefined) {
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      "execution.desktop.recording is not provisioned by a caller-supplied executor.",
      descriptor.id,
    );
  }
  const localAppSubject = config.subject.source === "local-app";
  // Adopter-hosted comms plane on the app-url route (#380): humanish provisions no subject here,
  // so it cannot host a catch — the OPERATOR runs one, and humanish still does every other part
  // of the funnel: tells each persona its address and inbox URL, drains the catch over HTTP after
  // the lanes, and writes the same digest-only evidence. Declaring `external` previously did
  // nothing on this route (and, per #387, on every other) while its docs said otherwise.
  const externalCommsConfig =
    !cloneRoute && !localTreeRoute && !inProcessRoute ? config.comms?.email?.external : undefined;
  const externalCommsEmail = externalCommsConfig ? config.comms?.email : undefined;

  // Engine re-enforcement of the clone-route structure (library API surface).
  if (
    cloneRoute &&
    (!serve || !subjectRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(subjectRepo))
  ) {
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      !serve
        ? "clone subjects on the computer-use route require `subject.serve` (start + url) — the lab serves the app in-sandbox."
        : `subject.repos[0] must be an owner/repo slug (got "${subjectRepo ?? ""}").`,
      descriptor.id,
    );
  }

  // Engine re-enforcement of the local-tree-route structure (library API surface): a caller
  // driving this function directly (bypassing parseLabConfig) still gets the same fail-closed
  // shape the parser enforces, naming which requirement is missing.
  if (localTreeRoute && (!serve || config.execution?.target !== "e2b-desktop")) {
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      !serve
        ? "local-tree subjects on the computer-use route require `subject.serve` (start + url): the lab packs and serves the working tree in-sandbox."
        : "local-tree subjects require `execution.target: e2b-desktop`: the packed working tree is provisioned and served inside a hosted desktop sandbox.",
      descriptor.id,
    );
  }

  // Engine re-enforcement of the state declaration (library API surface).
  if (config.subject.state) {
    const stateReason = !provisionedRoute
      ? "`subject.state` applies only to clone subjects or local-tree subjects (the lab seeds the state it serves)."
      : subjectStateInvalidReason(config.subject.state, config.subject.env);
    if (stateReason) {
      return fail("HUMANISH_CUA_LAB_SUBJECT_INVALID", stateReason, descriptor.id);
    }
  }

  // Re-enforce the entry-target boundary (library API surface). A desktop-cli study has no entry
  // target at all — the subject is a program on the machine, not an address — so the boundary is
  // vacuous there rather than violated by an empty string.
  const allowPublicTargets = config.policies?.allowPublicTargets === true;
  const declaredTargets = [
    appUrl,
    ...(actor?.lanes ?? [])
      .map((lane) => lane.target)
      .filter((target): target is string => target !== undefined),
  ];
  const entryTargetSafe =
    desktopCliRoute ||
    declaredTargets.every((target) =>
      provisionedRoute || localAppSubject
        ? isLoopbackUrl(target)
        : allowPublicTargets
          ? isHttpUrl(target)
          : isLoopbackUrl(target),
    );
  if (!entryTargetSafe) {
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_UNSAFE",
      provisionedRoute || localAppSubject || !allowPublicTargets
        ? "subject.appUrl and any actors[0].lanes[].target entries must be loopback (127.0.0.1 or localhost) unless policies.allowPublicTargets is set for an app-url subject."
        : "subject.appUrl and actors[0].lanes[].target entries must be valid http(s) URLs.",
      descriptor.id,
    );
  }

  // In-process route pairing guard (boot-time, BEFORE key-gating): a custom executor needs a
  // custom provider too (the default OpenAI provider is vision-based and would fail closed).
  if (hooks.buildExecutor !== undefined && hooks.buildProvider === undefined) {
    return fail(
      "HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER",
      "cuaHooks.buildExecutor requires cuaHooks.buildProvider — a state-driven executor returns no screenshot, so it must be paired with a NON-vision provider (the default OpenAI computer-use provider is vision-based and would fail closed).",
      descriptor.id,
    );
  }

  // local-app fail-closed (BEFORE key-gating): there is no built-in in-process driver.
  if (localAppSubject && !inProcessRoute) {
    return fail(
      "HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR",
      "subject.source: local-app requires a library caller to supply cuaHooks.buildExecutor + buildProvider; there is no built-in driver for an in-process JS contract. (Drive the app via runLab(..., { cuaHooks: { buildExecutor, buildProvider } }).)",
      descriptor.id,
    );
  }

  if (
    config.subject.source === "app-url" &&
    config.execution?.target === "local" &&
    !hooks.createDesktopLane
  ) {
    return fail(
      "HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR",
      "Local browser studies require a configured local desktop runtime.",
      descriptor.id,
    );
  }

  // Re-enforce the fan-out cross-validation (library API surface): lanes XOR count/laneFocus,
  // device XOR raw resolution, cap, unique ids, allowPublicTargets+N>1, clone.fanout.
  const fanoutReason = cuaLaneValidationReason(config);
  if (fanoutReason) {
    return fail("HUMANISH_CUA_LAB_FANOUT_INVALID", fanoutReason, descriptor.id);
  }

  // The sandbox deadline is DERIVED from the session budget, so a lab can ask for a session that
  // cannot legally be provisioned. Catch it here, before anything is created, and show the
  // arithmetic — the provider's own error names a limit but not which knob produced it.
  const derivedSandboxMs = resolvePerLaneSandboxMs(config);
  if (derivedSandboxMs > MAX_SANDBOX_MS) {
    const provisionedRoute =
      config.subject.source === "clone" || config.subject.source === "local-tree";
    const sessionMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
    const headroomMs = derivedSandboxMs - sessionMs;
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      `execution.timeoutMs ${Math.round(sessionMs / 60_000)}m derives a ${Math.round(derivedSandboxMs / 60_000)}m sandbox deadline, and a sandbox may not live longer than ${MAX_SANDBOX_MS / 60_000}m. The deadline is the session budget plus ${Math.round(headroomMs / 60_000)}m of provisioning and teardown headroom${provisionedRoute ? " (this route clones, installs, builds and serves the subject before the actor starts)" : ""}. Lower execution.timeoutMs to at most ${Math.round((MAX_SANDBOX_MS - headroomMs) / 60_000)}m, or set execution.desktop.sandboxTimeoutMs explicitly.`,
      descriptor.id,
    );
  }

  // Compile any committed personas BEFORE planning, so the plan builder stays pure and each lane's
  // prompt carries real behavioral directives rather than a bare `Persona: <id>.` label (#381).
  const personaResolution = await resolveCommittedPersonas(projectRoot, labPersonaIds(config));
  for (const warning of personaResolution.warnings) {
    process.stderr.write(`humanish: ${warning}\n`);
  }

  // Resolve the lane plan (pure) — the SAME table for dry-run and live.
  let { lanes: laneSpecs, plan } = laneSpecsAndPlan(config, {
    ...(options.countOverride === undefined ? {} : { countOverride: options.countOverride }),
    env,
    dryRun,
    personas: personaResolution.personas,
  });
  let laneCount = laneSpecs.length;

  if (laneCount > MAX_CUA_LANES) {
    return fail(
      "HUMANISH_CUA_LAB_FANOUT_INVALID",
      `Computer-use fan-out is capped at ${MAX_CUA_LANES} lanes (resolved ${laneCount}); N concurrent paid desktops is real spend.`,
      descriptor.id,
    );
  }
  if (inProcessRoute && laneCount > 1) {
    return fail(
      "HUMANISH_CUA_LAB_FANOUT_INVALID",
      "Multi-lane fan-out is not supported on the in-process route (cuaHooks.buildExecutor) — fan-out provisions one independent E2B desktop per lane, which the in-process route deliberately skips. Run a single in-process lane, or fan out on the E2B route.",
      descriptor.id,
    );
  }

  let rerunLineage: RunRerunLineage | undefined;
  if (options.rerun) {
    const selected = await resolveCuaRerunSelection({
      cwd,
      config,
      sourceRunId: options.rerun.sourceRunId,
      ...(options.rerun.laneIds === undefined ? {} : { laneIds: options.rerun.laneIds }),
      laneSpecs,
      plan,
    });
    if (!selected.ok) {
      return fail("HUMANISH_CUA_LAB_RERUN_INVALID", selected.message, descriptor.id);
    }
    laneSpecs = selected.laneSpecs;
    plan = selected.plan;
    laneCount = laneSpecs.length;
    rerunLineage = selected.rerun;
  }

  // Pre-flight plan: BEFORE any sandbox or provider call (dry-run AND live). The hook fires for
  // every N (observable + testable); the stderr table prints for fan-out (N>1) so single-lane
  // runs stay as quiet as they always were.
  if (laneCount > 1) {
    emitPreflightPlan(plan, config.id);
  }
  hooks.onPreflight?.(plan);
  await assertPreparedSelectedOutputDirectory(projectRoot);

  // Read keys once into locals (names only; values never logged or persisted).
  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";

  // Literal scrubber for every known provisioned value (no secret "shape" to pattern-match).
  const knownSecretValues = [
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? ""),
  ].filter((value) => value.length >= 4);
  const scrubKnownValues = (text: string): string =>
    knownSecretValues.reduce(
      (current, value) => current.split(value).join("[REDACTED_SECRET]"),
      text,
    );
  // Sanitize the declarative snapshot before initial, partial, or final bundle construction.
  for (const spec of laneSpecs) {
    if (spec.assignment) spec.assignment = participantAssignment(spec.assignment, scrubKnownValues);
    spec.evidenceInstructions = redactText(scrubKnownValues(spec.instructions));
    spec.persona = scrubPersonaBrief(spec.persona, scrubKnownValues);
  }

  const redactRepoLabel = config.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo =
    cloneRoute && subjectRepo ? (redactRepoLabel ? "repo-01" : subjectRepo) : undefined;
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");

  // The operator's own signed-in coding agent is the brain, so there is no provider key to ask
  // for — the entire point of the actor. E2B is still required: the persona needs a machine.
  const localAgentRoute = actorType === "local-agent";
  // Which local CLI, from its OWN field: `model` means the model, so that "Claude Code running
  // Opus" is sayable. Preflight below refuses when the chosen one is missing or signed out — that
  // news is worthless after a sandbox is paid for.
  const preferredLocalAgent: LocalAgentId = config.actors[0]?.localAgent ?? "codex";
  // Key-gating is route-aware: the in-process route uses the caller's OWN model + executor, and
  // the local-agent route uses a CLI the operator has already signed in to.
  if (!dryRun && !inProcessRoute) {
    const missingKeys = [
      ...(openaiApiKey || localAgentRoute || hooks.buildProvider ? [] : ["OPENAI_API_KEY"]),
      ...(e2bApiKey || hooks.createDesktopLane ? [] : ["E2B_API_KEY"]),
    ];
    if (missingKeys.length > 0) {
      // The moment someone new actually hits the wall. If a signed-in coding agent is sitting
      // right there, say so HERE rather than making them go and find an API key — that detour is
      // where most people trying humanish stop.
      const suggestion = missingKeys.includes("OPENAI_API_KEY")
        ? await (async () => {
            const ready = (await detectLocalAgents({ env })).filter(
              (agent) => agent.authStatus === "authenticated",
            );
            return ready.length === 0
              ? ""
              : ` ${ready.map((agent) => agent.label).join(" and ")} reports authenticated on this machine` +
                  ` — set actors[0].type: local-agent to use ${ready.length === 1 ? "it" : "one"} instead of a key.`;
          })()
        : "";
      return fail(
        "HUMANISH_CUA_LAB_KEYS_MISSING",
        `Live computer-use labs need ${missingKeys.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missingKeys, env)}${suggestion}`,
        descriptor.id,
      );
    }
    if (localAgentRoute && !hooks.buildProvider) {
      // Refuse HERE, before a sandbox exists. "codex is not installed" discovered after the
      // machine is paid for is the same information delivered at the worst possible moment.
      const available = await detectLocalAgents({ env });
      const chosen = available.find((agent) => agent.id === preferredLocalAgent);
      if (chosen === undefined) {
        return fail(
          "HUMANISH_CUA_LAB_KEYS_MISSING",
          `actors[0].type: local-agent needs the ${preferredLocalAgent} CLI on PATH and signed in. ` +
            `Install it, or set OPENAI_API_KEY and use actors[0].type: openai-computer-use instead.`,
          descriptor.id,
        );
      }
      if (chosen.authStatus !== "authenticated") {
        return fail(
          "HUMANISH_CUA_LAB_KEYS_MISSING",
          chosen.authStatus === "unauthenticated"
            ? `${chosen.label} reports not signed in — run \`${chosen.id === "codex" ? "codex login" : "claude auth login"}\`, then retry.`
            : `${chosen.label} authentication status could not be checked. Run \`${chosen.id === "codex" ? "codex login status" : "claude auth status"}\` and update the CLI if needed. No desktop was launched.`,
          descriptor.id,
        );
      }
      if (chosen.id === "codex") {
        const compatibility = await checkHostedCodexCompatibility(chosen.binPath, { env });
        if (compatibility !== "supported") {
          return fail(
            "HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED",
            compatibility === "unsupported_platform"
              ? `Hosted Codex participants require Linux or macOS on x64 or arm64. This host is ${process.platform}/${process.arch}; no desktop was launched.`
              : `Hosted Codex participants require Codex CLI 0.154.0. Run \`codex --version\` and install the supported version before retrying; no desktop was launched.`,
            descriptor.id,
          );
        }
        if (
          chosen.billing === "account-unknown" &&
          (config.execution?.caps?.maxUsd !== undefined ||
            config.execution?.caps?.maxTotalUsd !== undefined)
        ) {
          return fail(
            "HUMANISH_CUA_LAB_UNPRICED_CAP",
            "A ChatGPT-account Codex participant has no API-dollar price, so execution.caps.maxUsd/maxTotalUsd cannot be enforced. Remove the dollar cap and use finite execution timeout/step limits, or use an API-backed participant; no desktop was launched.",
            descriptor.id,
          );
        }
      }
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return fail(
        "HUMANISH_CUA_LAB_SUBJECT_ENV_MISSING",
        `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
        descriptor.id,
      );
    }
    // FAIL-CLOSED CAP TENSION (discipline #3): a maxUsd cap needs a MEASURABLE per-turn estimate.
    // If the operator set execution.caps.maxUsd but src/run/pricing.ts has no rate for the resolved
    // model, the loop could not enforce the cap — and silently running uncapped would break the
    // runaway-retry protection. Refuse at PREFLIGHT (before any sandbox/spend) rather than run
    // uncapped: an unenforceable cap is more dangerous than none. The operator adds a rate to
    // src/run/pricing.ts (the honest place) or removes the cap.
    if (
      config.execution?.caps?.maxUsd !== undefined ||
      config.execution?.caps?.maxTotalUsd !== undefined
    ) {
      const capModelId = (config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL).trim().toLowerCase();
      if (!MODEL_RATES[capModelId]) {
        return fail(
          "HUMANISH_CUA_LAB_UNPRICED_CAP",
          `execution.caps declares a spend cap (maxUsd/maxTotalUsd) but src/run/pricing.ts has no rate for model "${config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL}"; add a rate or remove the cap — an unenforceable cap is refused rather than run uncapped.`,
          descriptor.id,
        );
      }
    }
    // Adopter-hosted comms catch (#380): fail closed BEFORE any sandbox is created — a comms lab
    // whose catch is unreachable collects nothing while every lane still spends. The probe asserts
    // OUR service marker in /health, so an adopter's proxy answering 200 for everything cannot
    // pass for a catch.
    if (externalCommsConfig && !(await externalCatchHealthy(externalCommsConfig))) {
      return fail(
        "HUMANISH_CUA_LAB_COMMS_CATCH_UNREACHABLE",
        "The external comms catch or inbox is unreachable or incompatible (GET /health must identify humanish-comms-catch and advertise recipient-inbox-v1). Update Humanish on the catch host and restart it with `humanish comms catch` on that host, or drop comms.email to run without the inbox funnel.",
        descriptor.id,
      );
    }
  }

  const runId = options.runId ?? makeCuaRunId();
  const runPaths = await prepareRunArtifactPaths(cwd, runId);
  // Identity + liveness on disk from the first moment (#455): anything watching the runs
  // directory — the TUI, another terminal, an agent — can now tell which lab this is and that
  // it is alive, without waiting for the interactive observer flush that used to be the only
  // mid-run write. The success path finalizes it with the real outcome; the fail-closed returns
  // below do not, so `runLab`'s status scope finalizes those with no outcome. A crash reaches
  // neither and leaves the record stale, which reads as interrupted rather than as a lie.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab }),
  });
  const artifactRoot = runPaths.absoluteRunRoot;
  const physicalArtifactRoot = runPaths.physicalRunRoot;
  const createdAt = new Date().toISOString();
  const timeoutMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
  const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;

  await prepareContainedOutputDirectory(runPaths, "screenshots");
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  // Pack the working tree ONCE per run, on the host, BEFORE any sandbox or provider call: every
  // fan-out lane below uploads this SAME archive, so one archiveSha256 describes every lane's
  // digest. Dry-run packs nothing (no fs side effects; the contract bundle carries no
  // archiveSha256). A packing failure fails the run closed here, before createDesktopSandbox is
  // ever reached.
  let localTreeArchive: LocalTreeArchive | undefined;
  let localTreeArchiveBuffer: ArrayBuffer | undefined;
  if (localTreeRoute && !dryRun) {
    const packLocalTree = hooks.packLocalTree ?? defaultPackLocalTree;
    try {
      const packed = await packLocalTree({
        root: cwd,
        ...(config.subject.localTree?.exclude === undefined
          ? {}
          : { extraExclude: config.subject.localTree.exclude }),
        ...(config.subject.localTree?.maxArchiveBytes === undefined
          ? {}
          : { maxArchiveBytes: config.subject.localTree.maxArchiveBytes }),
      });
      localTreeArchive = packed.archive;
      localTreeArchiveBuffer = packed.buffer;
      // One operator-facing line (stderr, same channel as emitPreflightPlan): what left the
      // host, by counts and digest only, never paths or file names.
      process.stderr.write(
        `humanish local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}` +
          `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`,
      );
    } catch (error) {
      return fail(
        "HUMANISH_CUA_LAB_SUBJECT_INVALID",
        `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
        descriptor.id,
      );
    }
  }

  // Live-trace flush seam (#441): assigned by the attached-Observer block below when a live
  // run has an in-progress bundle to grow; lanes call it through deps.onTrace. Declared here
  // (before deps) so deps can reference it as a stable indirection.
  let flushLiveTrace:
    | ((
        laneId: string,
        items: readonly ActorTraceItem[],
        usage?: ActorTokenUsage,
        metadata?: CuaLiveMetadata,
      ) => void)
    | undefined;
  let stopLiveFlush: (() => Promise<void>) | undefined;

  const deps: Omit<CuaLaneDeps, "signalProvisioned"> = {
    ...(hooks.createDesktopLane ? { createDesktopLane: hooks.createDesktopLane } : {}),
    onTrace: (laneId, items, usage, metadata) => flushLiveTrace?.(laneId, items, usage, metadata),
    config,
    descriptor,
    appUrl,
    ...(localAgentRoute ? { localAgent: preferredLocalAgent } : {}),
    cloneRoute,
    desktopCliRoute,
    localTreeRoute,
    ...(serve === undefined ? {} : { serve }),
    ...(subjectRepo === undefined ? {} : { subjectRepo }),
    subjectEnvNames,
    hasGithubToken,
    ...(localTreeArchiveBuffer === undefined ? {} : { localTreeArchiveBuffer }),
    env,
    openaiApiKey,
    e2bApiKey,
    requestTimeoutMs,
    perLaneSandboxMs: resolvePerLaneSandboxMs(config),
    timeoutMs,
    laneCount,
    artifactRoot: runPaths,
    labCwd: options.cwd,
    redactScreenshots,
    scrubKnownValues,
    runSession,
    // The study-level ledger exists once per RUN, shared by every lane (#299). Dry runs never
    // spend, so they carry none.
    ...(dryRun || config.execution?.caps?.maxTotalUsd === undefined
      ? {}
      : { runBudget: makeCuaRunBudget(config.execution.caps.maxTotalUsd) }),
    ...(externalCommsConfig === undefined || externalCommsEmail === undefined
      ? {}
      : {
          externalComms: {
            email: externalCommsEmail,
            inboxUrl: externalInboxUrl(externalCommsConfig),
          },
        }),
    now: hooks.now ?? Date.now,
    hooks: liveHooks,
  };

  const inProgressLaneSubjects = laneSpecs.map(() =>
    laneSubjectProjection({
      cloneRoute,
      localTreeRoute,
      ...(publicRepo === undefined ? {} : { publicRepo }),
      subjectEnvNames,
      ...(localTreeArchive === undefined ? {} : { localTreeArchive }),
      subjectState: resolveSubjectState({
        declared: provisionedRoute ? config.subject.state : undefined,
        dryRun: false,
        executed: [],
      }),
    }),
  );
  const inProgressAggregateSubject = inProgressLaneSubjects[0]!;
  const inProgressProvenance = subjectProvenanceArg(
    inProgressAggregateSubject,
    publicRepo,
    subjectEnvNames,
  );

  // A live run writes what it is doing AS IT DOES IT, whether or not anyone is currently watching.
  // This used to be gated on `options.onObserverReady` — the interactive Observer callback — so a
  // run launched by an agent (`lab run --json`), detached, or from the terminal surface recorded
  // nothing at all until it completed, and anything asking "what is this participant doing right
  // now" got silence for the whole run. Who reads the evidence is not the run's business; the
  // callback below stays conditional, the writing does not.
  if (!dryRun) {
    const inProgressBundle =
      laneCount === 1 && rerunLineage === undefined
        ? buildSingleLaneBundle({
            ...(options.lab === undefined ? {} : { lab: options.lab }),
            spec: laneSpecs[0]!,
            outcome: undefined,
            descriptor,
            appUrl: laneSpecs[0]!.targetUrl ?? appUrl,
            createdAt,
            dryRun: false,
            config,
            runId,
            source,
            redactScreenshots,
            inProgress: true,
            ...(inProgressProvenance === undefined
              ? {}
              : { subjectProvenance: inProgressProvenance }),
            inProcessRoute,
            localAppSubject,
          })
        : buildCuaFanoutBundle({
            ...(options.lab === undefined ? {} : { lab: options.lab }),
            specs: laneSpecs,
            laneSubjects: inProgressLaneSubjects,
            aggregateSubject: inProgressAggregateSubject,
            descriptor,
            appUrl,
            createdAt,
            dryRun: false,
            config,
            runId,
            source,
            plan,
            ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
            cloneRoute,
            localTreeRoute,
            ...(publicRepo === undefined ? {} : { publicRepo }),
            subjectEnvNames,
            inProgress: true,
          });
    await writeCuaRunArtifacts(inProgressBundle, createdAt, runPaths);
    liveObserver = observerResultForCuaArtifacts(cwd, runId, artifactRoot, [
      "Live CUA Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted.",
    ]);
    if (options.onObserverReady) await options.onObserverReady(liveObserver);

    // Incremental live flush (#441): as each lane's loop reports its recorded-so-far items,
    // rewrite the in-progress bundle with per-stream `liveActor` partials so the attached
    // Observer's 5s poll sees the timeline grow. Throttled (one write per interval, trailing
    // write guaranteed), serialized (never two writers), and CLOSED before the final artifact
    // write so a stale flush can never resurrect the in-progress bundle. A flush failure is
    // swallowed: mid-run observability must never break the run itself.
    const streamIdByLane = new Map(laneSpecs.map((spec) => [spec.laneId, spec.streamId]));
    // The persona each lane is running, so the live flush can say who is in it.
    const personaByStream = new Map(
      laneSpecs
        .map((spec) => [spec.streamId, spec.persona?.id] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"),
    );
    const liveItemsByStream = new Map<string, ActorTraceItem[]>();
    // Running token usage per lane, so a run in flight can price itself instead of reporting the
    // cost as unknown until the moment it ends.
    const liveUsageByStream = new Map<string, ActorTokenUsage>();
    const liveMetadataByStream = new Map<string, CuaLiveMetadata>();
    // The rate the running usage prices at. Usage without its model is not a cost, so both travel
    // together or neither does.
    const modelForLiveCost = config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL;
    let flushWriting: Promise<void> | undefined;
    let flushDirty = false;
    let flushClosed = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let lastFlushAtMs = 0;
    const FLUSH_MIN_INTERVAL_MS = 2_000;
    const flushNow = async (): Promise<void> => {
      while (flushDirty && !flushClosed) {
        flushDirty = false;
        lastFlushAtMs = Date.now();
        const updatedAt = new Date(lastFlushAtMs).toISOString();
        const patched: RunBundle = {
          ...inProgressBundle,
          streams: inProgressBundle.streams.map((stream) => {
            const liveItems = liveItemsByStream.get(stream.id);
            return liveItems === undefined
              ? stream
              : {
                  ...stream,
                  liveActor: {
                    schema: "humanish.live-actor.v1" as const,
                    updatedAt,
                    // WHO is in this lane, carried while the run is live. Without it a surface
                    // watching a live run can only name the lane, and "CUA browser — observer-live-
                    // check" is the harness talking about itself where the participant should be.
                    ...(personaByStream.get(stream.id) === undefined
                      ? {}
                      : { persona: { id: personaByStream.get(stream.id)! } }),
                    ...(liveUsageByStream.get(stream.id) === undefined
                      ? {}
                      : {
                          tokenUsage: liveUsageByStream.get(stream.id)!,

                          // The model too: usage without the rate it prices at is not a cost.
                          ids: { model: modelForLiveCost },
                        }),
                    ...liveMetadataByStream.get(stream.id),
                    items: [...liveItems],
                  },
                };
          }),
        };
        try {
          await writeCuaRunArtifacts(patched, createdAt, runPaths);
        } catch {
          // Swallowed by design; the final write is the evidence of record.
        }
      }
      flushWriting = undefined;
    };
    const scheduleFlush = (): void => {
      if (flushClosed || flushWriting !== undefined) return;
      const sinceMs = Date.now() - lastFlushAtMs;
      if (sinceMs >= FLUSH_MIN_INTERVAL_MS) {
        flushWriting = flushNow();
        return;
      }
      if (flushTimer === undefined) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          scheduleFlush();
        }, FLUSH_MIN_INTERVAL_MS - sinceMs);
        flushTimer.unref?.();
      }
    };
    flushLiveTrace = (laneId, items, usage, metadata) => {
      // An empty snapshot (the initial observation on a frameless route) carries no
      // evidence worth a disk write; the first real item triggers the first flush.
      if (items.length === 0) return;
      const streamId = streamIdByLane.get(laneId);
      if (streamId === undefined) return;
      liveItemsByStream.set(streamId, items.slice());
      if (metadata !== undefined) liveMetadataByStream.set(streamId, metadata);
      if (usage !== undefined) liveUsageByStream.set(streamId, usage);
      flushDirty = true;
      scheduleFlush();
    };
    stopLiveFlush = async () => {
      flushClosed = true;
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      await flushWriting;
    };
  }

  const receivingWarnings: string[] = [];
  let receiving: CommsReceivingRun | undefined;
  if (!dryRun && config.comms?.email?.kind === "real") {
    try {
      receiving = await prepareReceivingRun({
        cwd,
        runId,
        config,
        env,
        participants: laneSpecs.map((spec) => spec.laneId),
        runPaths,
        registerSecrets: (values) => {
          for (const value of values)
            if (value.length >= 4 && !knownSecretValues.includes(value))
              knownSecretValues.push(value);
        },
      });
      if (receiving) deps.receiving = receiving;
    } catch {
      await stopLiveFlush?.();
      return fail(
        "HUMANISH_CUA_LAB_SUBJECT_INVALID",
        "Real email setup failed before desktop allocation. Run humanish comms check --online and humanish comms recover to inspect authentication and pending cleanup.",
        descriptor.id,
      );
    }
  }
  // Run lanes (dry-run runs none). In-process is always one lane.
  let outcomes: LaneRunOutcome[] | undefined;
  let failFastReason: string | undefined;
  try {
    if (!dryRun) {
      if (inProcessRoute) {
        outcomes = [await runInProcessLane(laneSpecs[0]!, deps)];
      } else if (laneCount === 1) {
        outcomes = [await runCuaLane(laneSpecs[0]!, deps)];
      } else {
        const ran = await runCuaLanes(laneSpecs, deps, plan.concurrency);
        outcomes = ran.outcomes;
        failFastReason = ran.failFastReason;
      }
    }
  } finally {
    try {
      await receiving?.finish();
    } catch {
      receivingWarnings.push(
        "Email finalization could not complete. Inspect humanish comms recover; provider cleanup remains unresolved.",
      );
    }
  }
  // Close the live flush BEFORE any final artifact work: no new flush may start, and an
  // in-flight one is awaited, so the final bundle write can never race a stale in-progress
  // rewrite (which would resurrect `liveActor` after completion).
  await stopLiveFlush?.();

  const externalCommsWarnings: string[] = [];
  // Adopter-hosted drain (#380): once per RUN, after every lane finished — the catch is one
  // shared external endpoint, not a per-sandbox file. Same routing and digest-only artifact as
  // the in-sandbox drain; the artifact is registered on every lane that declared a recipient
  // address, since the thread carries each inbox's mail. A drain failure never fails the run.
  if (!dryRun && externalCommsConfig && externalCommsEmail && outcomes !== undefined) {
    try {
      const commsChannel = new FakeInbox();
      const commsInboxes: CommsAddress[] = [];
      for (const recipient of externalCommsEmail.recipients ?? []) {
        if (recipient.address !== undefined) {
          commsInboxes.push(await commsChannel.provisionAddress(recipient.lane, recipient.address));
        }
      }
      const authToken =
        externalCommsConfig.authTokenEnv === undefined
          ? undefined
          : env[externalCommsConfig.authTokenEnv];
      const collected = await collectExternalCommsThread({
        external: { ...externalCommsConfig, ...(authToken === undefined ? {} : { authToken }) },
        channel: commsChannel,
        inboxes: commsInboxes,
      });
      if (collected.artifact) {
        const commsPath = "comms/thread.json";
        await writeContainedOutputFile(
          runPaths,
          commsPath,
          `${JSON.stringify(collected.artifact, null, 2)}\n`,
          "utf8",
        );
        for (const [index, outcome] of outcomes.entries()) {
          const laneId = laneSpecs[index]?.laneId;
          if (
            laneId !== undefined &&
            outcome.commsArtifactPath === undefined &&
            laneHasInboxRecipient(externalCommsEmail, laneId)
          ) {
            outcome.commsArtifactPath = commsPath;
          }
        }
      } else if (collected.captured > 0) {
        externalCommsWarnings.push(
          `Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`,
        );
      } else {
        externalCommsWarnings.push(
          `Comms catch captured ZERO email sends — your app never delivered mail through the catch at ${externalCommsConfig.catchBaseUrl}. Verify the app's email-API base URL points at it and that the flow reached an email step.`,
        );
      }
    } catch (error) {
      externalCommsWarnings.push(
        `Comms evidence collection failed against the adopter-hosted catch (run continues): ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
      );
    }
  }

  // Per-lane subject projections (invariant 5).
  const laneSubjects = laneSpecs.map((_spec, index) => {
    const outcome = outcomes?.[index];
    const subjectState = resolveSubjectState({
      declared: provisionedRoute ? config.subject.state : undefined,
      dryRun,
      executed: outcome?.stateStepRecords ?? [],
    });
    return laneSubjectProjection({
      cloneRoute,
      localTreeRoute,
      ...(publicRepo === undefined ? {} : { publicRepo }),
      subjectEnvNames,
      ...(outcome?.subjectCommit === undefined ? {} : { subjectCommit: outcome.subjectCommit }),
      ...(localTreeArchive === undefined ? {} : { localTreeArchive }),
      subjectState,
    });
  });

  // Aggregate subject (top-level + bundle): unanimity-gated commit (+ divergence warning) on
  // the clone route. Local-tree lanes all pack from the SAME once-per-run archive, so every
  // lane's projection already carries the identical archiveSha256/commit/dirty: the
  // `first.source !== "clone"` branch below returns it directly, with no unanimity math needed
  // (there is nothing that could diverge).
  const aggregateWarnings: string[] = [...externalCommsWarnings];
  // execution.caps.maxUsd is a PER-LANE cap: it is enforced INSIDE each lane's loop independently,
  // so an N-lane fan-out can spend up to N × maxUsd before any lane aborts, while the run cost
  // summary reports the (larger) aggregate. Warn at run level so the operator sees the true
  // ceiling — unless the study declared the shared budget (#299), which caps the run as a whole.
  const perLaneCapUsd = config.execution?.caps?.maxUsd;
  if (
    perLaneCapUsd !== undefined &&
    laneCount > 1 &&
    config.execution?.caps?.maxTotalUsd === undefined
  ) {
    aggregateWarnings.push(
      `execution.caps.maxUsd ($${perLaneCapUsd}) is a PER-LANE cap; ${laneCount} lanes may spend up to ${laneCount} × $${perLaneCapUsd} (~$${round6(perLaneCapUsd * laneCount)} total) before any lane aborts. Set execution.caps.maxTotalUsd for a shared study budget.`,
    );
  }
  const aggregateSubject = ((): CuaSubjectProjection => {
    const first = laneSubjects[0]!;
    if (first.source !== "clone") {
      return first;
    }
    const commits = (outcomes ?? [])
      .map((outcome) => outcome.subjectCommit)
      .filter((commit): commit is string => commit !== undefined);
    const unanimous = !dryRun && commits.length === laneCount && new Set(commits).size === 1;
    if (!dryRun && laneCount > 1 && new Set(commits).size > 1) {
      aggregateWarnings.push(
        "Fan-out lanes resolved DIVERGENT subject commits — the top-level subject.commit is omitted; see per-lane provenance in result.lanes for each lane's pinned commit.",
      );
    }
    // Build without commit, then add it only when unanimous (avoids an explicit commit:undefined
    // under exactOptionalPropertyTypes).
    return {
      source: "clone",
      ...(first.repo === undefined ? {} : { repo: first.repo }),
      ...(first.envNames === undefined ? {} : { envNames: first.envNames }),
      state: first.state,
      ...(unanimous && commits[0] !== undefined ? { commit: commits[0] } : {}),
    };
  })();
  const finalProvenance = subjectProvenanceArg(aggregateSubject, publicRepo, subjectEnvNames);

  const bundle =
    laneCount === 1 && rerunLineage === undefined
      ? buildSingleLaneBundle({
          ...(options.lab === undefined ? {} : { lab: options.lab }),
          spec: laneSpecs[0]!,
          outcome: outcomes?.[0],
          descriptor,
          appUrl: laneSpecs[0]!.targetUrl ?? appUrl,
          createdAt,
          dryRun,
          config,
          runId,
          source,
          redactScreenshots,
          ...(finalProvenance === undefined ? {} : { subjectProvenance: finalProvenance }),
          inProcessRoute,
          localAppSubject,
        })
      : buildCuaFanoutBundle({
          ...(options.lab === undefined ? {} : { lab: options.lab }),
          specs: laneSpecs,
          ...(outcomes === undefined ? {} : { outcomes }),
          laneSubjects,
          aggregateSubject,
          descriptor,
          appUrl,
          createdAt,
          dryRun,
          config,
          runId,
          source,
          plan,
          ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
          ...(failFastReason === undefined ? {} : { failFastReason }),
          cloneRoute,
          localTreeRoute,
          ...(publicRepo === undefined ? {} : { publicRepo }),
          subjectEnvNames,
        });

  const adapterWarnings: string[] = [];
  const scorerResult = await applyBrowserAdapterHooks({
    hooks,
    bundle,
    context: {
      bundle,
      runDir: physicalArtifactRoot,
      labId: config.id,
      runId,
      actor: descriptor.id,
      backend: "cua",
      dryRun,
      laneCount,
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "cuaHooks",
    ...(options.scorerProvenance === undefined
      ? {}
      : { scorerProvenance: options.scorerProvenance }),
  });

  if (receiving) bundle.commsReceiving = receiving.snapshot();
  await writeCuaRunArtifacts(bundle, createdAt, runPaths);
  // Finalize the status record from the bundle that was just written, so the index can never
  // claim an outcome the evidence does not carry. A run that throws before reaching here leaves
  // its record `running` and goes stale — read as interrupted, which is the truth.
  await runStatus.finish({
    ...(bundle.review?.verdict === undefined ? {} : { verdict: bundle.review.verdict }),
    ...(bundle.review?.participants === undefined
      ? {}
      : {
          participants: {
            total: bundle.review.participants.total,
            reachedGoal: bundle.review.participants.reachedGoal,
            ...(bundle.review.participants.reportedFriction === undefined
              ? {}
              : { reportedFriction: bundle.review.participants.reportedFriction }),
          },
        }),
    ...(bundle.cost?.estimatedTotalUsd === undefined
      ? {}
      : { estimatedCostUsd: bundle.cost.estimatedTotalUsd }),
  });

  const observer = await render(cwd, runId, { open: options.open === true });
  if (observer.ok && runtimeStreamUrls.length > 0) {
    attachObserverRuntimeStreamUrls(observer as ObserverResult & { ok: true }, runtimeStreamUrls);
  }

  // Lane-level pass: dry-run lanes are contract-ok; live lanes need a passed, engaged session.
  const laneOk = (outcome: LaneRunOutcome | undefined): boolean => laneOutcomeOk(outcome, dryRun);
  const allLanesOk = laneSpecs.every((_, index) => laneOk(outcomes?.[index]));
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok =
    observer.ok &&
    allLanesOk &&
    adapterFailure === undefined &&
    scorerResult.declaredVerdictFailure === undefined;

  const laneWarnings = (outcomes ?? []).flatMap((outcome) => outcome.warnings);
  const warnings = [
    ...receivingWarnings,
    ...laneWarnings,
    ...aggregateWarnings,
    ...adapterWarnings,
    ...observer.warnings,
  ];

  const laneResults = laneSpecs.map((spec, index) =>
    toLaneResult(spec, outcomes?.[index], laneSubjects[index]!, dryRun),
  );
  const laneSummary = buildLaneSummary(outcomes, laneCount, plan, dryRun);
  const firstOutcome = outcomes?.[0];

  const errorResult = ((): CuaActorLabResult["error"] | undefined => {
    if (ok) return undefined;
    if (adapterFailure !== undefined) {
      return {
        code: "HUMANISH_CUA_LAB_FAILED",
        message: adapterFailure,
      };
    }
    if (laneCount === 1) {
      const outcome = firstOutcome;
      return {
        code: outcome?.failureCode ?? "HUMANISH_CUA_LAB_FAILED",
        message:
          outcome?.sessionError ??
          (outcome?.noEngagement
            ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
            : // The lane result (toLaneResult) named this refusal; the N=1 envelope fell through to
              // "did not produce a terminal session", which is false — it produced one and refused it.
              outcome?.selfReportedBlocker
              ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
              : observer.ok
                ? outcome?.session?.completionReason === "harness_error"
                  ? `Computer-use session ended with a harness error: ${outcome.session.reason}`
                  : outcome?.session?.status !== "passed"
                    ? `Computer-use session ended with ${outcome?.session?.status ?? "unknown"}: ${outcome?.session?.reason ?? "no terminal reason"}`
                    : "Computer-use lab did not produce a terminal session."
                : (observer.error?.message ?? "Observer failed for the computer-use lab run.")),
      };
    }
    const failingLane = (outcomes ?? []).find((outcome) => !laneOk(outcome));
    const geometryLane = (outcomes ?? []).find(
      (outcome) => outcome.failureCode === "HUMANISH_CUA_LAB_DEVICE_GEOMETRY",
    );
    const code: CuaActorLabErrorCode = geometryLane?.failureCode ?? "HUMANISH_CUA_LAB_FAILED";
    return {
      code,
      message: observer.ok
        ? `Fan-out run failed: ${laneSummary.passed}/${laneCount} lane(s) passed (${laneSummary.skipped} skipped, ${laneSummary.harnessErrors} harness error(s), ${laneSummary.hollow} hollow)${failingLane?.sessionError ? `; first failure: ${failingLane.sessionError}` : ""}.`
        : (observer.error?.message ?? "Observer failed for the computer-use fan-out run."),
    };
  })();

  return markFinalizedStudyResult(
    {
      schema: CUA_ACTOR_LAB_SCHEMA,
      ok,
      cwd,
      labId: config.id,
      actor: descriptor.id,
      appUrl,
      dryRun,
      runId,
      ...(firstOutcome?.session
        ? {
            session: {
              status: firstOutcome.session.status,
              completionReason: firstOutcome.session.completionReason,
              ...(firstOutcome.session.trace.stopCause === undefined
                ? {}
                : { stopCause: firstOutcome.session.trace.stopCause }),
              reason: firstOutcome.session.reason,
              screenshots: firstOutcome.screenshots.length,
            },
          }
        : {}),
      ...(firstOutcome?.sandboxId
        ? {
            sandbox: {
              sandboxId: firstOutcome.sandboxId,
              killed: firstOutcome.killed,
              streamUrlPresent: firstOutcome.streamUrlPresent,
            },
          }
        : {}),
      subject: aggregateSubject,
      plan,
      lanes: laneResults,
      diagnostics: summarizeCuaDiagnostics({
        dryRun,
        evidenceInvalid: !observer.ok,
        lanes: laneResults,
      }),
      laneSummary,
      ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
      observer,
      warnings,
      ...(errorResult === undefined ? {} : { error: errorResult }),
    },
    runPaths,
  );
}

/**
 * Default local-tree packing implementation: createLocalTreeArchive(root, opts) on the host,
 * then a single read of the produced archive file into an ArrayBuffer for upload. The DI seam
 * (CuaActorLabHooks.packLocalTree) overrides this in deterministic tests so they never require
 * tar/git.
 */
export async function defaultPackLocalTree(args: {
  root: string;
  extraExclude?: string[];
  maxArchiveBytes?: number;
}): Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }> {
  const archive = createLocalTreeArchive(args.root, {
    ...(args.extraExclude === undefined ? {} : { extraExclude: args.extraExclude }),
    ...(args.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: args.maxArchiveBytes }),
  });
  const bytes = await readFile(archive.archivePath);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  // The archive was written to a fresh mkdtemp dir (no outputPath passed above); once the
  // bytes are buffered the on-disk copy is pure residue, and a packed working tree left in
  // the host tmpdir is itself a small leak surface. Best-effort removal.
  await rm(path.dirname(archive.archivePath), { recursive: true, force: true }).catch(
    () => undefined,
  );
  return { archive, buffer };
}

/**
 * Resolve the bundle's state marker from the declaration and what actually ran.
 * Precedence: external declared → "unpinned" (seed records, if any, stay attached — a
 * migrated external DB is still unpinned overall); else seed declared → "seeded" only when
 * every declared step executed ok on a live run, otherwise "declared-not-run" (dry-run
 * contract bundles and failed live provisioning); no declaration → "undeclared".
 */
export function resolveSubjectState(args: {
  declared: LabSubjectState | undefined;
  dryRun: boolean;
  executed: RunSubjectStateStepRecord[];
}): RunSubjectProvenance["state"] {
  const declared = args.declared;
  if (!declared) {
    return { provenance: "undeclared" };
  }
  const declaredSeed = declared.seed ?? [];
  const external = declared.external ?? [];
  // Dry-run: nothing executes (no sandbox) — record the DECLARED recipe: name, phase, and
  // command digest only, with NO execution fields.
  const seed: RunSubjectStateStepRecord[] = args.dryRun
    ? declaredSeed.map((step) => ({
        name: step.name,
        when: step.when ?? "before-start",
        commandDigest: commandDigestOf(step.command),
      }))
    : args.executed;
  const allRanOk =
    !args.dryRun &&
    declaredSeed.length > 0 &&
    seed.length === declaredSeed.length &&
    seed.every((record) => record.ok === true);
  const provenance: RunSubjectProvenance["state"]["provenance"] =
    external.length > 0
      ? "unpinned"
      : declaredSeed.length === 0
        ? "undeclared"
        : allRanOk
          ? "seeded"
          : "declared-not-run";
  return {
    provenance,
    ...(seed.length > 0 ? { seed } : {}),
    ...(external.length > 0 ? { externalEnvNames: external } : {}),
  };
}

function makeCuaRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `cua-${stamp}-${randomBytes(4).toString("hex")}`;
}
