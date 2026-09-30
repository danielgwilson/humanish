import { randomBytes, randomUUID } from "node:crypto";
import { TERMINAL_NODE_BOOTSTRAP_COMMAND } from "../../subject/node-bootstrap.js";
import { parseTerminalTokenUsage } from "./token-usage.js";
import {
  buildRuntimeExecPrefix,
  buildRuntimeVersionCommand,
  declaredRuntimeProvenance,
  parseTerminalRuntimeVersion,
  TERMINAL_RUNTIME_VERSION_TIMEOUT_MS,
} from "./runtime.js";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveCommittedPersona as resolveTerminalPersona } from "../../lab/persona-resolve.js";
import type { ActorCompletionReason, ActorPersonaRef, ActorStatus } from "../../actors/contract.js";
import { actorRegistry } from "../../actors/registry.js";
import { buildOpenAiEgressNetwork } from "./runtime-auth.js";
import type { LabRuntimeAuth } from "../../lab/types.js";
import {
  E2BDesktopStartupError,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox,
} from "../../substrates/e2b/desktop-launch.js";
import { acquireE2BShellSandbox } from "../../substrates/e2b/sandbox.js";
import { shellQuote } from "../../substrates/shell.js";
import {
  personaBrief,
  personaToDirectives,
  renderPersonaPromptSection,
} from "../../lab/persona.js";
import { digestText, redactText, scrubLiterals, toErrorMessage } from "../../evidence/redaction.js";
import { validatePreparedRunArtifactPaths } from "../../run/paths.js";
import { prepareSelectedOutputDirectory } from "../../run/selected-output-paths.js";
import { buildRunSource } from "../../run/bundle.js";
import { extractLocalActorVerdict, normalizeLocalActorTranscript } from "../../run/verify-actor.js";
import { applyAdapterExtensionSeam } from "./adapter.js";
import { buildLiveTerminalProductBundle, renderTerminalReviewMarkdown } from "./bundle.js";
import { buildRuntimeAuth, buildSandboxMetadata } from "./credentials.js";
import {
  buildCostLedger,
  buildNoSpendProof,
  describeMeasuredSpend,
  evaluateCapsAgainstLedger,
  noSpendLineMeasured,
  noSpendNotEstablished,
} from "./ledger.js";
import { runWithWallClock, teardownSandbox } from "./sandbox.js";
import { buildTerminalActorTrace, scrubSplitKnownValues, tailOf } from "./trace.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type RunLiveTerminalSessionArgs,
  RUNTIME_BOOTSTRAP_TIMEOUT_MS,
  SANDBOX_TIMEOUT_BUFFER_MS,
  SANDBOX_WORKDIR,
  type TerminalLedgers,
  type TerminalProductLabResult,
  UPLOAD_MAX_BYTES,
} from "./types.js";
import { createTerminalRecorder } from "./recorder.js";
import { writeTerminalEvidence } from "./artifacts.js";
import { terminalLabResult } from "./result.js";

/**
 * The live in-sandbox agent session orchestrator (mirror of runCuaActorLab's E2B branch). Enforces
 * the 8-point safety contract by construction; fails closed before any sandbox/key/spend on any
 * precondition miss. Persists the substrate-lifecycle/command-log/interventions/cleanup ledgers,
 * the redacted terminal event stream + normalized transcript, the agent report, and the
 * provider-neutral actor trace; tears the sandbox down in a finally and proves the teardown.
 */
export async function runLiveTerminalSession(
  args: RunLiveTerminalSessionArgs,
): Promise<TerminalProductLabResult> {
  const { options, cwd, config, descriptorId, product, warnings, failed, scope } = args;
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const now = hooks.now ?? (() => Date.now());
  const nowIso = (): string => new Date(now()).toISOString();

  // Check the registered terminal actor's default placement contract before launching. The
  // explicit openai-egress mode overrides the resolved trace's placement to external; registry
  // metadata continues to describe the compatible openai-env default.
  const descriptor = actorRegistry[descriptorId as keyof typeof actorRegistry];
  const keyPlacement = descriptor?.capabilities.keyPlacement;
  if (keyPlacement !== "in-sandbox-command-scoped") {
    return failed(
      "HUMANISH_TERMINAL_LAB_KEYPLACEMENT_INVALID",
      `Terminal actor "${descriptorId}" must declare keyPlacement "in-sandbox-command-scoped" for the live lane (got "${String(keyPlacement)}"). The engine requires this registered default before applying the declared runtime-auth mode.`,
      { actor: descriptorId },
    );
  }

  // --- Safety contract item 2: a fail-closed cap MUST be in force before the live key runs. ---
  const caps = config.scenario?.caps;
  const maxUsd = caps?.maxUsd;
  const maxMinutes = caps?.maxMinutes;
  if (caps === undefined || maxUsd === undefined || maxMinutes === undefined || maxMinutes <= 0) {
    return failed(
      "HUMANISH_TERMINAL_LAB_CAPS_MISSING",
      "A live terminal-product run grants provider access to the in-sandbox agent and so REQUIRES a fail-closed cap: scenario.caps with maxUsd (0 = no-spend) and a positive maxMinutes (the codex command's wall-clock kill). The live key is never exercised without a cap in force.",
      { actor: descriptorId },
    );
  }
  // maxUsd is checked against the cost ledger after the session, and only KNOWN lines can trip it.
  // Core records the Codex provider line as unpriced tokens (no rate for model `codex`) and has no
  // product, media or payment signal, so without a costProbe every line is null and a positive
  // maxUsd could never trip. That cap would promise a bound nothing enforces, so it is refused;
  // maxMinutes is what bounds a live run.
  if (maxUsd > 0 && hooks.costProbe === undefined) {
    return failed(
      "HUMANISH_TERMINAL_LAB_UNPRICED_CAP",
      `scenario.caps.maxUsd=${maxUsd} cannot be enforced: the Codex participant's provider spend is recorded as unpriced tokens and no product, media or payment spend is measured, so a positive dollar cap can never trip. Set scenario.caps.maxUsd to 0 and bound the run with scenario.caps.maxMinutes, the codex command's wall-clock kill. No sandbox was created and the runtime key was not used.`,
      { actor: descriptorId },
    );
  }
  if (maxUsd > 0) {
    warnings.push(
      `scenario.caps.maxUsd=${maxUsd} is checked after the session against the lines the costProbe measures; lines it leaves null (unmeasured) never trip it. scenario.caps.maxMinutes bounds the run while it runs.`,
    );
  }

  // --- Safety contract item 4: deny-by-default credentials; build the command-scoped allowlist. ---
  const runtimeEnv = buildRuntimeAuth({ runtimeAuth: config.execution?.runtimeAuth, env });
  if (!runtimeEnv.ok) {
    return failed(runtimeEnv.code, runtimeEnv.message, { actor: descriptorId });
  }

  // Compose the prompt from PUBLIC surfaces + the author mission ONLY (safety contract item 3).
  // Inject a per-run verdict nonce: the agent echoes HUMANISH_ACTOR_VERDICT=<status>
  // HUMANISH_ACTOR_NONCE=<nonce>; the scorer verifies the nonce so replayed text cannot forge it.
  const mission = config.actors[0]?.mission ?? defaultMission(product.name);
  const personaId = config.actors[0]?.persona ?? "autonomous-terminal-agent";
  const physicalCwd = await realpath(cwd);
  // Resolve the committed persona so its traits actually shape the agent prompt (#308); fail-safe to
  // the bare persona id (no traits applied) when no persona file is committed.
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const resolvedPersona = await resolveTerminalPersona(projectRoot, personaId);
  warnings.push(...resolvedPersona.warnings);
  const personaLine = resolvedPersona.persona
    ? renderPersonaPromptSection(resolvedPersona.persona)
    : `persona: ${personaId}`;
  const traitsApplied = resolvedPersona.persona
    ? personaToDirectives(resolvedPersona.persona).traitsApplied
    : [];
  const verdictNonce = randomUUID().slice(0, 12);
  const composedPrompt = composeLivePrompt({
    mission,
    personaLine,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    verdictNonce,
  });
  const promptDigest = digestText(composedPrompt);

  // --- Safety contract item 5: literal-scrub EVERY known value, then pattern-redact, at the source. ---
  // The runtime key value (+ any other provisioned value) is scrubbed by LITERAL match before
  // anything persists (a key has no detectable "shape" if it is an arbitrary token); redactText is
  // the second pass for secret-SHAPED content. Applied PRE-truncation so a cut can never split a
  // value past the scrubber.
  const knownSecretValues = [runtimeEnv.keyValue, env.E2B_API_KEY?.trim() ?? ""].filter(
    (v) => v.length >= 4,
  );
  const scrubKnownValues = scrubLiterals(knownSecretValues);
  const sanitize = (text: string): string => redactText(scrubKnownValues(text));
  const persona: ActorPersonaRef = {
    id: personaId,
    traitsApplied,
    promptDigest,
    ...(resolvedPersona.persona
      ? { brief: personaBrief(resolvedPersona.persona, scrubKnownValues) }
      : {}),
  };

  const started = await scope.startRun({
    cwd: physicalCwd,
    runId: options.runId,
    mintRunId: makeTerminalRunId,
    // This entry point is the live terminal route; its dry-run sibling is a separate function.
    mode: "live",
    lab: options.lab,
    renderReview: renderTerminalReviewMarkdown,
    observer: { open: options.open === true, render: hooks.renderObserverFn },
    now,
  });
  if (!started.ok) return failed(started.code, started.message, { actor: descriptorId });
  const { run } = started;
  const { runId, createdAt, paths: runPaths } = run;
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd: physicalCwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  // Declared egress allowlist, or undefined for the historical unrestricted default (#538).
  const egressAllow = config.execution?.egressAllow;

  // The ledgers + capture buffers, mutated through the live lifecycle.
  const {
    lifecycle,
    commandLog,
    terminalEvents,
    interventions,
    discardedPrefixes,
    recordLifecycle,
    recordStreamedTerminalChunk,
    appendReturnedTerminalOutput,
  } = createTerminalRecorder({ nowIso, sanitize, knownSecretValues });
  let cleanup: TerminalLedgers["cleanup"] = {
    killed: false,
    remaining: -1,
    reason: "teardown not reached",
  };

  let sandbox: E2BDesktopSandbox | undefined;
  let sandboxModule: E2BDesktopModule | undefined;
  let sandboxId: string | undefined;
  let sessionStatus: ActorStatus = "failed";
  let completionReason: ActorCompletionReason = "harness_error";
  let sessionReason = "live terminal-product session did not start";
  let sessionError: string | undefined;
  let startupCleanup: E2BDesktopStartupError["cleanup"] | undefined;
  let timedOut = false;
  const runtime = declaredRuntimeProvenance({
    ...(config.execution?.runtime?.version === undefined
      ? {}
      : { version: config.execution.runtime.version }),
    ...(config.actors[0]?.model === undefined ? {} : { model: sanitize(config.actors[0].model) }),
    ...(config.actors[0]?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: config.actors[0].reasoningEffort }),
  });

  recordLifecycle(
    "terminal-lab.run.created",
    `Created live terminal-product run ${runId} (actor ${descriptorId}, product ${product.name}). Caps: maxUsd=${maxUsd}, maxMinutes=${maxMinutes}. Subject provenance UNPINNED (public surfaces only).`,
  );

  const requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const wallClockMs = maxMinutes * 60_000;
  const sandboxTimeoutMs = wallClockMs + SANDBOX_TIMEOUT_BUFFER_MS;
  const metadata = buildSandboxMetadata({ labId: config.id, simId: "sim-001", runId });

  try {
    sandboxModule = await (hooks.loadModule ?? loadE2BDesktopModule)();
    await validatePreparedRunArtifactPaths(runPaths);
    // No sandbox-global env in either mode. In openai-egress, only this host-side SDK request
    // carries the real runtime key; participant commands receive an inert placeholder. The proxy
    // capability is available from sandbox creation, including during bootstrap/product setup.
    const routing =
      egressAllow === undefined ? undefined : { allowOut: egressAllow, denyOut: ["0.0.0.0/0"] };
    const network =
      runtimeEnv.mode === "openai-egress"
        ? buildOpenAiEgressNetwork(runtimeEnv.keyValue, routing)
        : routing;
    const acquired = await acquireE2BShellSandbox({
      module: sandboxModule,
      options: {
        apiKey: e2bApiKey,
        requestTimeoutMs,
        timeoutMs: sandboxTimeoutMs,
        metadata,
        ...(network === undefined ? {} : { network }),
        lifecycle: { onTimeout: "kill" },
      },
      retry: {
        // A failed first attempt may have allocated a sandbox whose id never reached this run;
        // its own kill-on-timeout reclaims it.
        onRetry: (reason) => {
          const named = sanitize(reason);
          warnings.push(
            `Sandbox create retried once after a transient provider error (${named}). A sandbox the failed attempt may have allocated is reclaimed by its ${sandboxTimeoutMs} ms timeout.`,
          );
          recordLifecycle(
            "terminal-lab.sandbox.create.retry",
            `sandbox create retried once (${named})`,
          );
        },
      },
      // The receipt is on disk the moment the sandbox exists, so reclaim can kill it by exact id.
      receipt: { root: runPaths, laneId: "terminal", now },
    });
    sandbox = acquired.sandbox;
    sandboxId = acquired.allocation.resourceId;
    await validatePreparedRunArtifactPaths(runPaths);
    recordLifecycle(
      "terminal-lab.sandbox.created",
      `E2B shell sandbox ${sandboxId} created with positive-allowlist metadata and kill-on-timeout; NO sandbox-global env.`,
    );
    // The allowlist is evidence: a reader of the ledger can see exactly what the participant was
    // able to reach, without the ledger carrying any secret.
    recordLifecycle(
      "terminal-lab.egress.policy",
      egressAllow === undefined
        ? "Egress UNRESTRICTED (no execution.egressAllow declared)."
        : `Egress routing allowlist: ${egressAllow.length} declared host(s): ${egressAllow.join(", ")}; deny-all fallback. Domain routing is not strict destination isolation on shared infrastructure.`,
    );

    recordLifecycle(
      "terminal-lab.runtime-auth",
      runtimeEnv.mode === "openai-egress"
        ? "Runtime auth openai-egress: raw key remains outside the sandbox in the api.openai.com HTTPS Authorization transform; Codex receives an inert CODEX_API_KEY placeholder and the default OpenAI endpoint. Every sandbox process, including bootstrap/setup, can spend via this proxy; no added routing restriction or provider spending limit."
        : `Runtime auth openai-env: raw key from ${runtimeEnv.keyName} is passed command-scoped to Codex and inherited by its child processes.`,
    );
    if (runtimeEnv.mode === "openai-egress") {
      warnings.push(
        "openai-egress keeps the raw runtime key outside the sandbox, but every sandbox process can spend through the api.openai.com proxy from creation until teardown. It adds no egress restriction or provider-enforced budget; extra provider calls may be absent from the Codex usage ledger.",
      );
    }

    // Readiness: a tiny probe receives no runtime env; openai-egress's proxy is already available.
    const ready = await sandbox.commands.run(
      `mkdir -p ${SANDBOX_WORKDIR} && echo HUMANISH_SHELL_READY`,
      { requestTimeoutMs },
    );
    recordLifecycle(
      "terminal-lab.sandbox.ready",
      `Shell readiness probe exit=${ready.exitCode ?? "null"}; workdir ${SANDBOX_WORKDIR} prepared.`,
    );

    // --- Runtime bootstrap: no runtime env; openai-egress proxy capability is already available. ---
    // The stock desktop needs Node/npm on PATH before npx can run Codex. Reuse a working
    // installation or install the pinned official binary after checksum verification (#674).
    // No raw runtime key touches this step; the egress proxy, when selected, is already available.
    const bootstrapStartedAt = now();
    let bootstrapError: string | undefined;
    try {
      const bootstrap = await sandbox.commands.run(TERMINAL_NODE_BOOTSTRAP_COMMAND, {
        requestTimeoutMs,
        timeoutMs: RUNTIME_BOOTSTRAP_TIMEOUT_MS,
      });
      if ((bootstrap.exitCode ?? 1) !== 0) {
        bootstrapError = `runtime bootstrap exited ${bootstrap.exitCode ?? "null"}`;
      }
    } catch (error) {
      bootstrapError = toErrorMessage(error);
    }
    const bootstrapDurationMs = Math.max(0, now() - bootstrapStartedAt);
    recordLifecycle(
      "terminal-lab.runtime.bootstrapped",
      bootstrapError
        ? `Runtime bootstrap FAILED after ${bootstrapDurationMs}ms: ${bootstrapError}. codex exec runs via npx and needs Node/npm present; the lane fails closed rather than attempting an exec with no runtime.`
        : `Runtime bootstrap ensured Node/npm present in ${bootstrapDurationMs}ms (codex exec runs via npx).`,
    );

    if (bootstrapError) {
      // Fail closed as a structured lane status (never a raw throw): no codex exec is attempted
      // without a proven runtime; this mirrors the exec-error status assignment below so the
      // bundle and verify surface the failure the same way.
      sessionStatus = "failed";
      completionReason = "harness_error";
      sessionError = sanitize(bootstrapError);
      sessionReason = `runtime bootstrap could not ensure Node/npm before codex exec: ${sessionError}`;
    } else if (
      await (async (): Promise<boolean> => {
        // Observe the executable without command-scoped auth, then use only that exact version.
        // The SDK bounds the request and command; version failures reach the owned cleanup path.
        try {
          const versionProbe = await sandbox.commands.run(
            buildRuntimeVersionCommand(config.execution?.runtime?.version),
            {
              requestTimeoutMs,
              timeoutMs: TERMINAL_RUNTIME_VERSION_TIMEOUT_MS,
            },
          );
          const observed = parseTerminalRuntimeVersion(versionProbe.stdout ?? "");
          if (observed !== undefined) runtime.observedVersion = observed;
          if (versionProbe.exitCode !== 0 || observed === undefined)
            throw new Error(
              "Codex version probe did not return a successful `codex-cli <exact-version>` result.",
            );
          if (
            config.execution?.runtime?.version !== undefined &&
            observed !== config.execution.runtime.version
          ) {
            throw new Error(
              `Codex version mismatch: requested ${config.execution.runtime.version}, observed ${observed}.`,
            );
          }
          runtime.versionStatus = "verified";
          recordLifecycle(
            "terminal-lab.runtime.version",
            `Codex requested ${runtime.requestedVersion}, observed ${observed}; exact version selected for execution. Model ${runtime.requestedModel ?? "runtime default (unobserved)"}; reasoning effort ${runtime.requestedReasoningEffort ?? "runtime default (unobserved)"}.`,
          );
        } catch (error) {
          runtime.versionStatus = "failed";
          sessionStatus = "failed";
          completionReason = "harness_error";
          sessionError = sanitize(toErrorMessage(error));
          sessionReason = `Codex runtime version could not be verified before execution: ${sessionError}`;
          recordLifecycle("terminal-lab.runtime.version.error", sessionReason);
          return false;
        }
        // --- Optional product setup (no runtime env), before the Codex exec. ---
        // Same channel and same guarantees as the runtime bootstrap above: no runtime key touches it,
        // and a failure fails the lane closed rather than handing the agent a half-built world. It
        // exists so a study can put the participant IN a prepared project — asking an agent what
        // studies a project contains, in an empty directory, measures the lab and not the product
        // (learned the hard way on the desktop lane, labs/tui-self-study.yaml).
        const install = config.subject.product?.install;
        if (install === undefined) return true;

        // An optional local file, put on the machine before the install runs, so a study can meet a
        // build that is not published yet. Read and checked HERE rather than trusted from the
        // manifest: this puts a file from the operator's disk onto a machine an autonomous agent is
        // about to drive, so it stays inside the project, must be a regular file, and is size-capped.
        let uploadAssignment = "";
        const uploadRel = config.subject.product?.upload;
        if (uploadRel !== undefined) {
          const uploadStartedAt = now();
          try {
            const resolved = path.resolve(cwd, uploadRel);
            const projectRoot = await realpath(cwd);
            const real = await realpath(resolved);
            if (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`)) {
              throw new Error("subject.product.upload resolved outside the project");
            }
            const info = await stat(real);
            if (!info.isFile()) throw new Error("subject.product.upload is not a regular file");
            if (info.size > UPLOAD_MAX_BYTES) {
              throw new Error(
                `subject.product.upload is ${info.size} bytes; the cap is ${UPLOAD_MAX_BYTES}`,
              );
            }
            const destination = `${SANDBOX_WORKDIR}/.humanish-upload/${path.basename(real)}`;
            await sandbox.commands.run(`mkdir -p ${SANDBOX_WORKDIR}/.humanish-upload`, {
              requestTimeoutMs,
            });
            const bytes = await readFile(real);
            await sandbox.files.write(
              destination,
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            );
            // Inlined into the command string rather than passed as `envs`: the ONLY call in this
            // lane that carries envs is the keyed codex exec, and that invariant is worth more than
            // the convenience of a second envs channel.
            uploadAssignment = `export HUMANISH_PRODUCT_UPLOAD=${shellQuote(destination)}; `;
            recordLifecycle(
              "terminal-lab.product.uploaded",
              `Uploaded ${info.size} bytes to the sandbox in ${Math.max(0, now() - uploadStartedAt)}ms (no runtime env; declared egress auth may already be available).`,
            );
          } catch (error) {
            sessionStatus = "failed";
            completionReason = "harness_error";
            sessionError = sanitize(toErrorMessage(error));
            sessionReason = `subject.product.upload could not be placed in the sandbox: ${sessionError}`;
            return false;
          }
        }
        const setupStartedAt = now();
        let setupError: string | undefined;
        try {
          const setup = await sandbox.commands.run(
            `${uploadAssignment}cd ${SANDBOX_WORKDIR} && ${install}`,
            {
              // The install step may run the product itself (release:dogfood's does: `humanish init
              // --yes`); on the 0.67.0 dogfood that one command arrived unmarked while the participant's
              // nine others carried the marker (#546).
              envs: { HUMANISH_STUDY_PARTICIPANT: "1" },
              requestTimeoutMs,
              timeoutMs: RUNTIME_BOOTSTRAP_TIMEOUT_MS,
            },
          );
          if ((setup.exitCode ?? 1) !== 0) {
            setupError = `product setup exited ${setup.exitCode ?? "null"}`;
          }
        } catch (error) {
          setupError = toErrorMessage(error);
        }
        recordLifecycle(
          "terminal-lab.product.prepared",
          setupError
            ? `Product setup FAILED after ${Math.max(0, now() - setupStartedAt)}ms: ${sanitize(setupError)}`
            : `Product setup completed in ${Math.max(0, now() - setupStartedAt)}ms (no runtime env; declared egress auth may already be available).`,
        );
        if (setupError) {
          sessionStatus = "failed";
          completionReason = "harness_error";
          sessionError = sanitize(setupError);
          sessionReason = `subject.product.install could not prepare the world before codex exec: ${sessionError}`;
          return false;
        }
        return true;
      })()
    ) {
      // --- The keyed run: `codex exec --json` non-interactively (stdin disabled). ---
      // openai-env passes the real key here; openai-egress passes an inert placeholder. stdin is
      // never wired (safety contract item 7) — commands.run takes no stdin channel. The command's
      // wall-clock is bounded by maxMinutes (safety contract item 2): commands.run timeoutMs +
      // an injected-clock guard so a mock/real run that exceeds it is killed and fails closed.
      const codexCommand = buildCodexExecCommand({
        workdir: SANDBOX_WORKDIR,
        prompt: composedPrompt,
        runtimeAuth: runtimeEnv.mode,
        version: runtime.observedVersion!,
        ...(config.actors[0]?.model === undefined ? {} : { model: config.actors[0].model }),
        ...(config.actors[0]?.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: config.actors[0].reasoningEffort }),
      });
      const commandDigest = digestText(codexCommand);
      const startedAt = now();
      recordLifecycle(
        "terminal-lab.exec.started",
        `Launching codex exec (runtime auth ${runtimeEnv.mode}; command env names: ${Object.keys(runtimeEnv.envs).join(", ")}); wall-clock bound ${wallClockMs}ms.`,
      );

      let exitCode: number | undefined;
      let runError: string | undefined;
      try {
        const result = await runWithWallClock(
          sandbox.commands.run(codexCommand, {
            // The selected command env (raw key or inert placeholder). The participant
            // marker rides the same command: humanish telemetry from inside a study reads as a new
            // adopter otherwise. #546 added the flag and nothing set it; the 0.66.0 dogfood
            // participant's twelve commands arrived unmarked.
            envs: { ...runtimeEnv.envs, HUMANISH_STUDY_PARTICIPANT: "1" },
            requestTimeoutMs,
            timeoutMs: wallClockMs,
            onStdout: (data: string) => recordStreamedTerminalChunk("stdout", data),
            onStderr: (data: string) => recordStreamedTerminalChunk("stderr", data),
          }),
          wallClockMs,
          now,
        );
        if (result.timedOut) {
          timedOut = true;
        } else {
          exitCode = result.value.exitCode;
          // Reconcile the SDK's returned aggregate against bytes already delivered by callbacks.
          if (result.value.stdout) appendReturnedTerminalOutput("stdout", result.value.stdout);
          if (result.value.stderr) appendReturnedTerminalOutput("stderr", result.value.stderr);
          if (result.value.error) runError = result.value.error;
        }
      } catch (error) {
        runError = toErrorMessage(error);
      }
      const durationMs = Math.max(0, now() - startedAt);

      commandLog.push({
        at: nowIso(),
        label: "codex-exec",
        commandDigest,
        envNames: Object.keys(runtimeEnv.envs), // NAMES only — the credential evidence (item 4).
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(timedOut ? { timedOut: true } : {}),
        durationMs,
      });

      // Score by the verdict-nonce marker over the SCRUBBED+REDACTED, NORMALIZED transcript — the
      // exact same logic the local-actor lanes use (extractLocalActorVerdict/normalizeLocalActorTranscript).
      const rawTranscript = terminalEvents.map((e) => e.chunk).join("");
      const normalizedTranscript = normalizeLocalActorTranscript(rawTranscript);
      const markerStatus = extractLocalActorVerdict(normalizedTranscript, verdictNonce);

      if (timedOut) {
        sessionStatus = "timed_out";
        completionReason = "timed_out";
        sessionReason = `codex exec exceeded the maxMinutes wall-clock (${maxMinutes}m); killed and failed closed.`;
        recordLifecycle("terminal-lab.exec.timed_out", sessionReason);
      } else if (runError) {
        sessionStatus = "failed";
        completionReason = "harness_error";
        sessionError = sanitize(runError);
        sessionReason = `codex exec could not run: ${sessionError}`;
        recordLifecycle("terminal-lab.exec.error", sessionReason);
      } else if (markerStatus) {
        sessionStatus = markerStatus;
        completionReason =
          markerStatus === "passed"
            ? "goal_satisfied"
            : markerStatus === "blocked"
              ? "blocked_approval"
              : "gave_up";
        sessionReason = `agent reported ${markerStatus} verdict marker (nonce-verified)`;
        recordLifecycle(
          "terminal-lab.exec.completed",
          `codex exec exit=${exitCode ?? "null"}; ${sessionReason}.`,
        );
      } else {
        // No nonce-verified verdict: the agent did not (credibly) report a terminal status. A run
        // that exited 0 but printed no verified marker is BLOCKED evidence (the failure IS the
        // evidence — still structurally verifiable), not a silent pass.
        sessionStatus = "blocked";
        completionReason = "gave_up";
        sessionReason = `codex exec exit=${exitCode ?? "null"} but no nonce-verified HUMANISH_ACTOR_VERDICT marker was emitted; recorded as blocked (the missing verdict is the evidence).`;
        recordLifecycle("terminal-lab.exec.blocked", sessionReason);
      }
    }
  } catch (error) {
    if (error instanceof E2BDesktopStartupError) startupCleanup = error.cleanup;
    sessionError = sanitize(toErrorMessage(error));
    sessionStatus = "failed";
    completionReason = "harness_error";
    sessionReason = `live terminal-product session failed: ${sessionError}`;
    recordLifecycle("terminal-lab.session.error", sessionReason);
  } finally {
    // --- Safety contract item 8: PROVEN cleanup, BY EXACT ID, never Sandbox.list. ---
    cleanup = await teardownSandbox({
      sandboxModule,
      sandboxId,
      ...(startupCleanup === undefined ? {} : { startupCleanup }),
      requestTimeoutMs,
      sanitize,
      recordLifecycle,
      warnings,
    });
  }

  // Prefix reconciliation may cut through a known key. Scrub literal values across the retained
  // chunks before any transcript/trace/event artifact is persisted. Check both each stream and
  // the combined event order that the transcript uses; either view can assemble a split value.
  scrubSplitKnownValues(terminalEvents, knownSecretValues, discardedPrefixes);

  // Build the actor trace FIRST (the cost ledger reads its tokenUsage).
  const normalizedTranscript = normalizeLocalActorTranscript(
    terminalEvents.map((e) => e.chunk).join(""),
  );
  // Parsed from the FULL stream, not the tail: usage records arrive once per turn and the tail
  // would drop all but the last (#531).
  const terminalTokenUsage = parseTerminalTokenUsage(normalizedTranscript);
  const trace = buildTerminalActorTrace({
    persona,
    productName: product.name,
    status: sessionStatus,
    completionReason,
    reason: sanitize(sessionReason),
    createdAt,
    completedAt: nowIso(),
    durationMs: commandLog[0]?.durationMs ?? 0,
    terminalEvents,
    commandLog,
    transcriptTail: tailOf(normalizedTranscript),
    runtimeAuth: runtimeEnv.mode,
    runtime,
    ...(terminalTokenUsage === undefined ? {} : { tokenUsage: terminalTokenUsage }),
  });

  // --- Spend ledger + no-spend proof + full caps enforcement (fail-closed). ---
  // The cost ledger is DERIVED, with the null discipline: provider spend from the trace's
  // tokenUsage.costUsd when present (else null = NOT MEASURED), product/media/payment null by
  // default (core has no signal). The costProbe hook lets tests or adapters inject KNOWN
  // spend to exercise the fail-closed cap without a real billable run.
  const injectedLines = hooks.costProbe?.(
    trace.tokenUsage?.costUsd === undefined ? {} : { tokenCostUsd: trace.tokenUsage.costUsd },
  );
  if (hooks.costProbe) await validatePreparedRunArtifactPaths(runPaths);
  const cost = buildCostLedger({
    ...(trace.tokenUsage?.costUsd === undefined ? {} : { tokenCostUsd: trace.tokenUsage.costUsd }),
    ...(trace.tokenUsage === undefined ? {} : { tokenUsage: trace.tokenUsage }),
    ...(injectedLines ? { injectedLines } : {}),
  });
  const noSpendProof = buildNoSpendProof(cost, maxUsd ?? null, trace.tokenUsage);
  const proofVerdict = !noSpendProof.satisfied
    ? `No-spend proof NOT satisfied for maxUsd=${maxUsd ?? "null"}.`
    : noSpendLineMeasured(noSpendProof)
      ? noSpendNotEstablished(maxUsd ?? 0)
      : `No-spend proof satisfied on the measured lines for maxUsd=${maxUsd ?? "null"}.`;
  const measuredSpend = describeMeasuredSpend(cost, trace.tokenUsage);
  recordLifecycle(
    "terminal-lab.cost.measured",
    `Cost ledger: known total ${cost.knownTotalUsd} USD${cost.fullyMeasured ? " (fully measured)" : " (lower bound)"}.${measuredSpend.length > 0 ? ` ${measuredSpend}` : ""} ${proofVerdict}`,
  );

  // FULL caps enforcement (fail-closed, NOT advisory): if a KNOWN spend line exceeds maxUsd (or a
  // known job count exceeds maxJobs), the run fails closed — never a green pass. Unknowns (null) do
  // NOT trip the cap (we cannot claim a violation we did not measure) but never grant a pass either
  // (the no-spend proof reports them as unmeasured). maxMinutes is already wall-clock-enforced above.
  const capCheck = evaluateCapsAgainstLedger(cost, caps);
  let capsExceeded = false;
  if (!capCheck.ok) {
    capsExceeded = true;
    sessionStatus = "failed";
    completionReason = "harness_error";
    sessionError = capCheck.message;
    sessionReason = capCheck.message;
    recordLifecycle("terminal-lab.caps.exceeded", capCheck.message);
    // Reflect the fail-closed verdict in the trace the bundle/observer reads (so the run cannot show
    // a passing agent verdict while the cap was blown).
    trace.status = "failed";
    trace.completionReason = "harness_error";
    trace.reason = capCheck.message;
  }

  // Assemble + persist the ledgers (now carrying the cost block + no-spend proof), the redacted
  // event stream, the normalized transcript, the actor trace, and the run bundle.
  const ledgers: TerminalLedgers = {
    schema: "humanish.terminal-ledgers.v1",
    runtime,
    lifecycle,
    commandLog,
    interventions, // ALWAYS present, ALWAYS empty while no assisted-input path ships.
    cleanup,
    cost,
    noSpendProof,
  };

  await writeTerminalEvidence(runPaths, { terminalEvents, normalizedTranscript, ledgers, trace });

  const bundle = buildLiveTerminalProductBundle({
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    actorId: descriptorId,
    createdAt,
    labId: config.id,
    ...(config.title ? { labTitle: config.title } : {}),
    mission: sanitize(mission),
    persona,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    caps,
    runtimeAuthKeyName: runtimeEnv.keyName,
    runtimeAuth: runtimeEnv.mode,
    policies: {
      allowPrivateRepoAccess: config.policies?.allowPrivateRepoAccess ?? false,
      allowProviderCredentials: config.policies?.allowProviderCredentials ?? false,
      allowPaymentCredentials: config.policies?.allowPaymentCredentials ?? false,
      allowGitHubMutation: config.policies?.allowGitHubMutation ?? false,
    },
    runId,
    source,
    trace,
    ledgers,
    ...(sandboxId ? { sandboxId } : {}),
    ...(sessionError ? { sessionError } : {}),
    sessionReason: sanitize(sessionReason),
  });

  // --- THE LAYER-6 EXTENSION SEAM (issue #154 acceptance #8). ---
  // When a thin adapter registered a scorer / feedback strategy, the lane calls it over the
  // FULLY-ASSEMBLED, redacted evidence and attaches the results to the bundle WITHOUT knowing any
  // product noun: the namespaced RunAdapterScore lands on bundle.adapterScore, and the derived
  // feedback candidates (each carrying its own namespaced product-noun block) are appended to
  // bundle.feedbackCandidates. Core's mission-based verdict (bundle.review) is left UNCHANGED — the
  // adapter score is additive, not a replacement. The adapter payloads pass the same scrub+redact
  // the rest of the bundle does (the adapter is trusted in-repo code, but the harness never relies
  // on that for secret values) and are validated fail-closed by the bundle verifier downstream.
  const declaredScorerFailure = await applyAdapterExtensionSeam({
    hooks,
    bundle,
    trace,
    ledgers,
    transcript: normalizedTranscript,
    product: product.name,
    labId: config.id,
    runId,
    sanitize,
    warnings,
    ...(options.scorerProvenance === undefined
      ? {}
      : { scorerProvenance: options.scorerProvenance }),
  });
  await validatePreparedRunArtifactPaths(runPaths);

  const finished = await run.finish(bundle);
  const observer = await finished.renderObserver();
  await validatePreparedRunArtifactPaths(runPaths);

  return terminalLabResult({
    cwd,
    labId: config.id,
    actorId: descriptorId,
    productName: product.name,
    runId,
    sessionStatus,
    completionReason,
    sessionReason: sanitize(sessionReason),
    sessionError,
    sandboxId,
    cleanup,
    cost,
    noSpendProof,
    capsExceeded,
    declaredScorerFailure,
    observer,
    warnings,
  });
}

/** Build the in-sandbox `codex exec` command (non-interactive, JSON, stdin disabled by mechanism). */
function buildCodexExecCommand(args: {
  workdir: string;
  prompt: string;
  runtimeAuth: LabRuntimeAuth;
  version: string;
  model?: string;
  reasoningEffort?: import("../../actors/reasoning-effort.js").ReasoningEffort;
}): string {
  // The prompt is passed via a heredoc on stdin of a wrapper? NO, stdin is DISABLED (item 7), so
  // the prompt rides as the final positional arg, shell-quoted. codex exec --json runs once and
  // exits (no interactive loop). --skip-git-repo-check: the workdir is a fresh scratch dir.
  // Pinned via npx (never an ambient/preinstalled `codex` binary, which the stock @e2b/desktop
  // image does not ship, per issue #159); npm_config_update_notifier=false silences npx's own
  // update check so it cannot leak into the captured stdout the scorer/redactor parse.
  const quotedPrompt = shellQuote(args.prompt);
  // --dangerously-bypass-approvals-and-sandbox: codex's OWN inner sandbox is
  // redundant here and blocks the network/file access the study mission needs.
  // The E2B sandbox is the trust boundary (the disposable machine), and exec mode has no
  // interactive approval channel at all.
  // The egress transform protects only the default OpenAI host. Pin the effective built-in
  // provider/base URL above config-file settings so setup-written custom endpoints cannot make
  // this invocation silently claim protection for another provider. openai-env is unchanged.
  const providerConfig =
    args.runtimeAuth === "openai-egress"
      ? ` -c 'model_provider="openai"' -c 'openai_base_url="https://api.openai.com/v1"'`
      : "";
  return `cd ${args.workdir} && ${buildRuntimeExecPrefix(args.version, args.model, args.reasoningEffort)} --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check${providerConfig} --json ${quotedPrompt}`;
}

/** Compose the live prompt: PUBLIC surfaces + author mission + the verdict-nonce marker contract. */
function composeLivePrompt(args: {
  mission: string;
  personaLine: string;
  productName: string;
  publicSurfaces: string[];
  verdictNonce: string;
}): string {
  return [
    args.personaLine,
    `product: ${args.productName}`,
    `public-surfaces: ${args.publicSurfaces.join(" ")}`,
    `mission: ${args.mission}`,
    "",
    "Work ONLY from the public surfaces above. Do NOT clone or inspect any private repository.",
    `When finished, print exactly one final machine-readable line in this format: HUMANISH_ACTOR_VERDICT=<status> HUMANISH_ACTOR_NONCE=${args.verdictNonce} where <status> is passed, blocked, or failed.`,
  ].join("\n");
}

/** The default mission when the lab omits one. Public-safe, product-neutral author text. */
export function defaultMission(productName: string): string {
  return `You are an autonomous agent. Discover ${productName} from its public surfaces and determine whether it can help with a durable real task. Stay within the declared no-spend caps. Leave feedback if the workflow is confusing.`;
}

export function makeTerminalRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `terminal-${stamp}-${randomBytes(4).toString("hex")}`;
}
