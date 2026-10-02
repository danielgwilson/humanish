// The live terminal session inside its E2B sandbox: acquire the sandbox, prove the shell and the
// runtime, prepare the product, run `codex exec` once under the wall-clock bound, and tear the
// sandbox down by exact id. The session's outcome (status, completion reason, reason, error) is
// recorded on the instance as each step runs; a step that fails closed returns false.

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ActorCompletionReason, ActorStatus } from "../../actors/contract.js";
import { digestText, toErrorMessage } from "../../evidence/redaction.js";
import type { LabRuntimeAuth } from "../../lab/types.js";
import { desktopSpanToMinutes, type DesktopUsage } from "../../run/cost-summary.js";
import { validatePreparedRunArtifactPaths } from "../../run/paths.js";
import type { RunScope } from "../../run/run.js";
import {
  extractLocalActorVerdict,
  normalizeLocalActorTranscript,
} from "../../run/terminal-contract.js";
import { NODE_BOOTSTRAP_COMMAND, NODE_BOOTSTRAP_TIMEOUT_MS } from "../../subject/node-bootstrap.js";
import {
  observeDesktopResources,
  type DesktopResourceObservation,
} from "../../substrates/e2b/desktop-resources.js";
import { acquireE2BShellSandbox } from "../../substrates/e2b/sandbox.js";
import type { OwnedDesktopAllocation } from "../../substrates/desktop-session.js";
import {
  E2BDesktopStartupError,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox,
} from "../../substrates/e2b/sdk.js";
import { shellQuote } from "../../substrates/shell.js";
import type { buildRuntimeAuth, buildSandboxMetadata } from "./credentials.js";
import type { createTerminalRecorder } from "./recorder.js";
import { buildOpenAiEgressNetwork } from "./runtime-auth.js";
import {
  TERMINAL_RUNTIME_VERSION_TIMEOUT_MS,
  buildRuntimeExecPrefix,
  buildRuntimeVersionCommand,
  parseTerminalRuntimeVersion,
  type declaredRuntimeProvenance,
} from "./runtime.js";
import { runWithWallClock, teardownSandbox } from "./sandbox.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  PRODUCT_SETUP_TIMEOUT_MS,
  SANDBOX_WORKDIR,
  UPLOAD_MAX_BYTES,
  type LiveTerminalPlan,
  type TerminalLedgers,
} from "./types.js";
import { terminalSandboxTimeoutMs } from "./lifetime.js";
import type { LabDeps } from "../../lab/lab-deps.js";

type StartedRun = Extract<Awaited<ReturnType<RunScope["startRun"]>>, { ok: true }>["run"];

/** What the sandbox session reads from the run. */
export interface LiveSandboxInputs {
  plan: LiveTerminalPlan;
  cwd: string;
  deps: LabDeps;
  now: () => number;
  nowIso: () => string;
  sanitize: (text: string) => string;
  runtimeEnv: Extract<ReturnType<typeof buildRuntimeAuth>, { ok: true }>;
  /** The runtime provenance; the version check records what it observed. */
  runtime: ReturnType<typeof declaredRuntimeProvenance>;
  composedPrompt: string;
  verdictNonce: string;
  maxMinutes: number;
  e2bApiKey: string;
  runPaths: StartedRun["paths"];
  metadata: ReturnType<typeof buildSandboxMetadata>;
  /** The run's warnings. Steps append to them. */
  warnings: string[];
  recorder: ReturnType<typeof createTerminalRecorder>;
}

export class LiveTerminalSandbox {
  status: ActorStatus = "failed";
  completionReason: ActorCompletionReason = "harness_error";
  reason = "live terminal-product session did not start";
  error: string | undefined;
  timedOut = false;
  sandboxId: string | undefined;
  cleanup: TerminalLedgers["cleanup"] = {
    killed: false,
    remaining: -1,
    reason: "teardown not reached",
  };
  private readonly inputs: LiveSandboxInputs;
  private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  private readonly wallClockMs: number;
  private readonly sandboxTimeoutMs: number;
  private sandbox: E2BDesktopSandbox | undefined;
  private module: E2BDesktopModule | undefined;
  private allocation: OwnedDesktopAllocation | undefined;
  private startupCleanup: E2BDesktopStartupError["cleanup"] | undefined;
  private startupCleanupDetail: string | undefined;
  // The sandbox's billed span (acquired to cleanup) and size price its compute time.
  private createdAtMs: number | undefined;
  private tornDownAtMs: number | undefined;
  private resources: DesktopResourceObservation | undefined;

  constructor(inputs: LiveSandboxInputs) {
    this.inputs = inputs;
    this.wallClockMs = inputs.maxMinutes * 60_000;
    this.sandboxTimeoutMs = terminalSandboxTimeoutMs({
      maxMinutes: inputs.maxMinutes,
      productInstall: inputs.plan.product.install !== undefined,
    });
  }

  async acquire(): Promise<void> {
    const { plan, deps, now, sanitize, runtimeEnv, e2bApiKey, runPaths, metadata } = this.inputs;
    const { warnings } = this.inputs;
    const { recordLifecycle } = this.inputs.recorder;
    const { requestTimeoutMs, sandboxTimeoutMs } = this;
    // Declared egress allowlist, or undefined for the historical unrestricted default (#538).
    const egressAllow = plan.egressAllow;
    const sandboxModule = await (deps.desktopModule ?? loadE2BDesktopModule)();
    this.module = sandboxModule;
    await validatePreparedRunArtifactPaths(runPaths);
    // No sandbox-global env in either mode. In openai-egress, only this host-side SDK request
    // carries the real runtime key; participant commands receive an inert placeholder. The proxy
    // capability is available from sandbox creation, including during bootstrap/product setup.
    const routing =
      egressAllow === undefined
        ? undefined
        : { allowOut: [...egressAllow], denyOut: ["0.0.0.0/0"] };
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
      receipt: { root: runPaths, participantId: "terminal", now },
    });
    const sandbox = acquired.sandbox;
    this.sandbox = sandbox;
    this.allocation = acquired.allocation;
    const sandboxId = acquired.allocation.resourceId;
    this.sandboxId = sandboxId;
    this.createdAtMs = now();
    await validatePreparedRunArtifactPaths(runPaths);
    recordLifecycle(
      "terminal-lab.sandbox.created",
      `E2B shell sandbox ${sandboxId} created with positive-allowlist metadata and kill-on-timeout; NO sandbox-global env.`,
    );
    const sandboxResources = await observeDesktopResources(sandbox);
    this.resources = sandboxResources;
    if ("reason" in sandboxResources) {
      warnings.push(
        `Sandbox resource size unavailable (${sandboxResources.reason}); its compute cost remains unpriced.`,
      );
    }
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
  }

  async probeReady(): Promise<void> {
    const { recordLifecycle } = this.inputs.recorder;
    const { requestTimeoutMs } = this;
    // Readiness: a tiny probe receives no runtime env; openai-egress's proxy is already available.
    const ready = await this.sandbox!.commands.run(
      `mkdir -p ${SANDBOX_WORKDIR} && echo HUMANISH_SHELL_READY`,
      { requestTimeoutMs },
    );
    recordLifecycle(
      "terminal-lab.sandbox.ready",
      `Shell readiness probe exit=${ready.exitCode ?? "null"}; workdir ${SANDBOX_WORKDIR} prepared.`,
    );
  }

  /** Returns false when the runtime bootstrap failed; the session then fails closed. */
  async bootstrap(): Promise<boolean> {
    const { now, sanitize } = this.inputs;
    const { recordLifecycle } = this.inputs.recorder;
    const { requestTimeoutMs } = this;
    // --- Runtime bootstrap: no runtime env; openai-egress proxy capability is already available. ---
    // The stock desktop needs Node/npm on `PATH` before npx can run Codex. Reuse a working
    // installation or install the pinned official binary after checksum verification (#674).
    // No raw runtime key touches this step; the egress proxy, when selected, is already available.
    const bootstrapStartedAt = now();
    let bootstrapError: string | undefined;
    try {
      const bootstrap = await this.sandbox!.commands.run(NODE_BOOTSTRAP_COMMAND, {
        requestTimeoutMs,
        timeoutMs: NODE_BOOTSTRAP_TIMEOUT_MS,
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
        ? `Runtime bootstrap FAILED after ${bootstrapDurationMs}ms: ${bootstrapError}. codex exec runs via npx and needs Node/npm present; the participant fails closed rather than attempting an exec with no runtime.`
        : `Runtime bootstrap ensured Node/npm present in ${bootstrapDurationMs}ms (codex exec runs via npx).`,
    );

    if (bootstrapError) {
      // Fail closed as a structured route status (never a raw throw): no codex exec is attempted
      // without a proven runtime; this mirrors the exec-error status assignment below so the
      // bundle and verify surface the failure the same way.
      this.status = "failed";
      this.completionReason = "harness_error";
      this.error = sanitize(bootstrapError);
      this.reason = `runtime bootstrap could not ensure Node/npm before codex exec: ${this.error}`;
      return false;
    }
    return true;
  }

  /** Returns false when the observed Codex version is missing or not the requested one. */
  async verifyRuntimeVersion(): Promise<boolean> {
    const { plan, sanitize, runtime } = this.inputs;
    const requested = plan.runtime.version;
    const { recordLifecycle } = this.inputs.recorder;
    const { requestTimeoutMs } = this;
    // Observe the executable without command-scoped auth, then use only that exact version.
    // The SDK bounds the request and command; version failures reach the owned cleanup path.
    try {
      const versionProbe = await this.sandbox!.commands.run(buildRuntimeVersionCommand(requested), {
        requestTimeoutMs,
        timeoutMs: TERMINAL_RUNTIME_VERSION_TIMEOUT_MS,
      });
      const observed = parseTerminalRuntimeVersion(versionProbe.stdout ?? "");
      if (observed !== undefined) runtime.observedVersion = observed;
      if (versionProbe.exitCode !== 0 || observed === undefined)
        throw new Error(
          "Codex version probe did not return a successful `codex-cli <exact-version>` result.",
        );
      if (requested !== undefined && observed !== requested) {
        throw new Error(`Codex version mismatch: requested ${requested}, observed ${observed}.`);
      }
      runtime.versionStatus = "verified";
      recordLifecycle(
        "terminal-lab.runtime.version",
        `Codex requested ${runtime.requestedVersion}, observed ${observed}; exact version selected for execution. Model ${runtime.requestedModel ?? "unrecorded"} (${runtime.modelStatus}); reasoning effort ${runtime.requestedReasoningEffort ?? "runtime default (unobserved)"}.`,
      );
    } catch (error) {
      runtime.versionStatus = "failed";
      this.status = "failed";
      this.completionReason = "harness_error";
      this.error = sanitize(toErrorMessage(error));
      this.reason = `Codex runtime version could not be verified before execution: ${this.error}`;
      recordLifecycle("terminal-lab.runtime.version.error", this.reason);
      return false;
    }
    return true;
  }

  /** Returns false when the declared product upload or install could not prepare the world. */
  async prepareProduct(): Promise<boolean> {
    const { plan, cwd, now, sanitize } = this.inputs;
    const { recordLifecycle } = this.inputs.recorder;
    const { requestTimeoutMs } = this;
    // --- Optional product setup (no runtime env), before the Codex exec. ---
    // Same channel and same guarantees as the runtime bootstrap above: no runtime key touches it,
    // and a failure fails the run closed rather than handing the agent a half-built world. It
    // exists so a study can put the participant in a prepared project: asking an agent what
    // studies a project contains, in an empty directory, measures the lab and not the product
    // (learned the hard way on the desktop route, labs/tui-self-study.yaml).
    const install = plan.product.install;
    if (install === undefined) return true;

    // An optional local file, put on the machine before the install runs, so a study can meet a
    // build that is not published yet. It is read and checked here, so nothing is trusted from the
    // manifest: this puts a file from the operator's disk onto a machine an autonomous agent is
    // about to drive, so it stays inside the project, must be a regular file, and is size-capped.
    let uploadAssignment = "";
    const uploadRel = plan.product.upload;
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
        await this.sandbox!.commands.run(`mkdir -p ${SANDBOX_WORKDIR}/.humanish-upload`, {
          requestTimeoutMs,
        });
        const bytes = await readFile(real);
        await this.sandbox!.files.write(
          destination,
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );
        // Inlined into the command string rather than passed as `envs`: the only call on this
        // route that carries envs is the keyed codex exec, and that invariant is worth more than
        // the convenience of a second envs channel.
        uploadAssignment = `export HUMANISH_PRODUCT_UPLOAD=${shellQuote(destination)}; `;
        recordLifecycle(
          "terminal-lab.product.uploaded",
          `Uploaded ${info.size} bytes to the sandbox in ${Math.max(0, now() - uploadStartedAt)}ms (no runtime env; declared egress auth may already be available).`,
        );
      } catch (error) {
        this.status = "failed";
        this.completionReason = "harness_error";
        this.error = sanitize(toErrorMessage(error));
        this.reason = `subject.product.upload could not be placed in the sandbox: ${this.error}`;
        return false;
      }
    }
    const setupStartedAt = now();
    let setupError: string | undefined;
    try {
      const setup = await this.sandbox!.commands.run(
        `${uploadAssignment}cd ${SANDBOX_WORKDIR} && ${install}`,
        {
          // The install step may run the product itself (release:dogfood's does: `humanish init
          // --yes`); on the 0.67.0 dogfood that one command arrived unmarked while the participant's
          // nine others carried the marker (#546).
          envs: { HUMANISH_STUDY_PARTICIPANT: "1" },
          requestTimeoutMs,
          timeoutMs: PRODUCT_SETUP_TIMEOUT_MS,
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
      this.status = "failed";
      this.completionReason = "harness_error";
      this.error = sanitize(setupError);
      this.reason = `subject.product.install could not prepare the world before codex exec: ${this.error}`;
      return false;
    }
    return true;
  }

  async execCodex(): Promise<void> {
    const { plan, now, nowIso, sanitize, runtimeEnv, runtime } = this.inputs;
    const { model, reasoningEffort } = plan.runtime;
    const { composedPrompt, verdictNonce, maxMinutes } = this.inputs;
    const { recordLifecycle, recordStreamedTerminalChunk, appendReturnedTerminalOutput } =
      this.inputs.recorder;
    const { commandLog, terminalEvents } = this.inputs.recorder;
    const { requestTimeoutMs, wallClockMs } = this;
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
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
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
        this.sandbox!.commands.run(codexCommand, {
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
        this.timedOut = true;
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
      envNames: Object.keys(runtimeEnv.envs), // Names only: the credential evidence (item 4).
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(this.timedOut ? { timedOut: true } : {}),
      durationMs,
    });

    // Score by the verdict-nonce marker over the scrubbed, redacted and normalized transcript, with
    // the exact same logic the local-actor routes use (extractLocalActorVerdict/normalizeLocalActorTranscript).
    const rawTranscript = terminalEvents.map((e) => e.chunk).join("");
    const normalizedTranscript = normalizeLocalActorTranscript(rawTranscript);
    const markerStatus = extractLocalActorVerdict(normalizedTranscript, verdictNonce);

    if (this.timedOut) {
      this.status = "timed_out";
      this.completionReason = "timed_out";
      this.reason = `codex exec exceeded the maxMinutes wall-clock (${maxMinutes}m); killed and failed closed.`;
      recordLifecycle("terminal-lab.exec.timed_out", this.reason);
    } else if (runError) {
      this.status = "failed";
      this.completionReason = "harness_error";
      this.error = sanitize(runError);
      this.reason = `codex exec could not run: ${this.error}`;
      recordLifecycle("terminal-lab.exec.error", this.reason);
    } else if (markerStatus) {
      this.status = markerStatus;
      this.completionReason =
        markerStatus === "passed"
          ? "goal_satisfied"
          : markerStatus === "blocked"
            ? "blocked_approval"
            : "gave_up";
      this.reason = `agent reported ${markerStatus} verdict marker (nonce-verified)`;
      recordLifecycle(
        "terminal-lab.exec.completed",
        `codex exec exit=${exitCode ?? "null"}; ${this.reason}.`,
      );
    } else {
      // No nonce-verified verdict: the agent did not (credibly) report a terminal status. A run
      // that exited 0 but printed no verified marker is blocked evidence: the failure is the
      // evidence, and it stays structurally verifiable.
      this.status = "blocked";
      this.completionReason = "gave_up";
      this.reason = `codex exec exit=${exitCode ?? "null"} but no nonce-verified HUMANISH_ACTOR_VERDICT marker was emitted; recorded as blocked (the missing verdict is the evidence).`;
      recordLifecycle("terminal-lab.exec.blocked", this.reason);
    }
  }

  /** Records a failure of the session around the steps (not one a step already recorded). */
  recordSessionError(error: unknown): void {
    const { sanitize } = this.inputs;
    const { recordLifecycle } = this.inputs.recorder;
    if (error instanceof E2BDesktopStartupError) {
      this.startupCleanup = error.cleanup;
      this.startupCleanupDetail = error.cleanupDetail;
    }
    this.error = sanitize(toErrorMessage(error));
    this.status = "failed";
    this.completionReason = "harness_error";
    this.reason = `live terminal-product session failed: ${this.error}`;
    recordLifecycle("terminal-lab.session.error", this.reason);
  }

  async teardown(): Promise<void> {
    const { now, sanitize, warnings } = this.inputs;
    const { recordLifecycle } = this.inputs.recorder;
    const { requestTimeoutMs } = this;
    // --- Safety contract item 8: proven cleanup, by exact id, never Sandbox.list. ---
    this.cleanup = await teardownSandbox({
      allocation: this.allocation,
      sandboxModule: this.module,
      ...(this.startupCleanup === undefined ? {} : { startupCleanup: this.startupCleanup }),
      startupCleanupDetail: this.startupCleanupDetail,
      requestTimeoutMs,
      sanitize,
      recordLifecycle,
      warnings,
    });
    if (this.createdAtMs !== undefined) this.tornDownAtMs = now();
  }

  /** The sandbox's compute time for the run cost summary, when a sandbox was acquired. */
  runCostDesktops(): DesktopUsage[] | undefined {
    if (this.createdAtMs === undefined) return undefined;
    return [
      {
        minutes: desktopSpanToMinutes(
          this.tornDownAtMs === undefined
            ? undefined
            : Math.max(0, this.tornDownAtMs - this.createdAtMs),
        ),
        observation: this.resources,
        lifetimeComplete: this.cleanup.remaining === 0,
      },
    ];
  }
}

/** Build the in-sandbox `codex exec` command (non-interactive, JSON, stdin disabled by mechanism). */
function buildCodexExecCommand(args: {
  workdir: string;
  prompt: string;
  runtimeAuth: LabRuntimeAuth;
  version: string;
  model: string;
  reasoningEffort?: import("../../actors/reasoning-effort.js").ReasoningEffort;
}): string {
  // stdin is disabled (item 7), so no heredoc on a wrapper's stdin carries the prompt;
  // the prompt rides as the final positional arg, shell-quoted. codex exec --json runs once and
  // exits (no interactive loop). --skip-git-repo-check: the workdir is a fresh scratch dir.
  // Pinned via npx (never an ambient/preinstalled `codex` binary, which the stock @e2b/desktop
  // image does not ship, per issue #159); npm_config_update_notifier=false silences npx's own
  // update check so it cannot leak into the captured stdout the scorer/redactor parse.
  const quotedPrompt = shellQuote(args.prompt);
  // --dangerously-bypass-approvals-and-sandbox: codex's own inner sandbox is
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
