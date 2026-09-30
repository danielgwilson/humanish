// The serve pipeline the clone and local-tree subjects share once their source is in place.
import { failureTail } from "../evidence/redaction.js";
import type { LabStateStepWhen, LabSubjectServe, LabSubjectState } from "../lab/types.js";
import type { RunSubjectStateStepRecord } from "../run/bundle.js";
import {
  corepackCommandFor,
  needsNodeRuntime,
  nodeBootstrapCommand,
} from "../routes/subject-runtime.js";
import {
  probeUrl,
  readDetachedLog,
  runDetachedStep,
  startDetachedProcess,
  type DetachedStepOptions,
  type DetachedStepResult,
  type DetachedTimers,
} from "../substrates/detached.js";
import type { Shell } from "../substrates/shell.js";
import { DEFAULT_STATE_STEP_TIMEOUT_MS, runStateSteps } from "./state.js";
import {
  emitPhaseCompleted,
  emitPhaseStarted,
  INSTALL_TIMEOUT_MS,
  isoNow,
  SUBJECT_DIR,
  type SubjectPhaseEvent,
} from "./steps.js";

const BUILD_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_READY_TIMEOUT_MS = 180_000;

/**
 * Run a provisioning step and, when it fails with an EXIT CODE, run it once more (#602). A cold
 * install of 0.74.0 lost its whole first live study to one transient TLS error inside the
 * sandbox's `npm install`; the parallel install twenty seconds later passed, as had the ten
 * before it. One retry clears that class. A TIMEOUT is not retried: its budget is already spent,
 * and a second wait would double it. The retry runs under its own step name so both logs stay.
 */
async function runProvisioningStepWithOneRetry(
  shell: Shell,
  args: {
    name: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    requestTimeoutMs: number;
    timers: Partial<Pick<DetachedStepOptions, "now" | "sleep" | "pollIntervalMs">>;
    /** Phase name for the retry's own started/completed events (`cua-lab.subject.<phase>.*`). */
    retryPhase: string;
    retryMessage: string;
    onPhase: ((event: SubjectPhaseEvent) => void) | undefined;
    now: () => number;
  },
): Promise<DetachedStepResult & { attempts: 1 | 2; firstExitCode?: number }> {
  const first = await runDetachedStep(shell, {
    name: args.name,
    command: args.command,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    requestTimeoutMs: args.requestTimeoutMs,
    ...args.timers,
  });
  if (first.ok || first.timedOut) return { ...first, attempts: 1 };
  const retryStartedAt = args.now();
  emitPhaseStarted(
    args.onPhase,
    args.now,
    args.retryPhase,
    `${args.retryMessage} (first attempt exited ${first.exitCode ?? "null"}; retrying once)`,
  );
  const second = await runDetachedStep(shell, {
    name: `${args.name}-retry`,
    command: args.command,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    requestTimeoutMs: args.requestTimeoutMs,
    ...args.timers,
  });
  emitPhaseCompleted(
    args.onPhase,
    args.now,
    retryStartedAt,
    args.retryPhase,
    second.ok,
    second.ok
      ? `${args.retryMessage}: succeeded on the second attempt`
      : `${args.retryMessage}: failed twice`,
  );
  return {
    ...second,
    attempts: 2,
    ...(first.exitCode === undefined ? {} : { firstExitCode: first.exitCode }),
  };
}

/**
 * Shared post-populate provisioning pipeline (clone AND local-tree routes): (install) ->
 * state(before-build) -> (build) -> state(before-start) -> detached start -> readiness probe ->
 * state(after-ready). Both provisioning routes populate SUBJECT_DIR by different means (git
 * clone vs. upload+extract) and then run this identical pipeline unchanged.
 *
 * State steps run through the same detached primitive as serve steps (author-trusted, the
 * "serve commands are author-trusted" corollary) under the reserved `subject-state-<name>`
 * label prefix, so a step name can never collide with subject-clone/subject-extract/install/
 * build/start. after-ready steps complete BEFORE the caller opens the browser: the actor never
 * drives a half-seeded subject and seeding never eats the session budget.
 */
/**
 * The longest runSubjectServePipeline can take with these budgets: the Node bootstrap and install
 * with their one retry, the package-manager step, every seed step, the build and the readiness
 * wait. Detached-step polling adds seconds on top.
 */
export function serveProvisioningBudgetMs(
  serve: LabSubjectServe,
  state: LabSubjectState | undefined,
): number {
  const installMs = serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
  const commands = [serve.install, serve.build, serve.start];
  const runtimeMs = needsNodeRuntime(commands)
    ? 2 * installMs + (corepackCommandFor(commands) === undefined ? 0 : installMs)
    : 0;
  const seedMs = (state?.seed ?? []).reduce(
    (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
    0,
  );
  return (
    runtimeMs +
    (serve.install === undefined ? 0 : 2 * installMs) +
    seedMs +
    (serve.build === undefined ? 0 : (serve.buildTimeoutMs ?? BUILD_TIMEOUT_MS)) +
    (serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
  );
}

export async function runSubjectServePipeline(
  shell: Shell,
  args: {
    serve: LabSubjectServe;
    /** Declared subject state (seed steps; external declaration is provenance-only). */
    state?: LabSubjectState;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment each state step finishes, success or failure. */
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
    /** Called at each phase boundary (started/completed): install, build, serve start, ready,
     *  and each subject.state seed-step group (one pair per group, never per step). */
    onPhase?: (event: SubjectPhaseEvent) => void;
    /** Called after every phase completes. The clone route re-resolves HEAD here; the
     *  local-tree route omits this entirely (identity is the host-side archive digest, never
     *  an in-sandbox git refresh, because the archive excludes .git). */
    onPhaseComplete?: () => Promise<void>;
  } & DetachedTimers,
): Promise<void> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep }),
  };
  const now = args.now ?? Date.now;
  const refresh = args.onPhaseComplete ?? ((): Promise<void> => Promise.resolve());
  const runState = (when: LabStateStepWhen): Promise<void> =>
    runStateSteps(shell, when, {
      ...(args.state === undefined ? {} : { state: args.state }),
      requestTimeoutMs: args.requestTimeoutMs,
      scrub: args.scrub,
      ...(args.onStateStep === undefined ? {} : { onStateStep: args.onStateStep }),
      ...(args.onPhase === undefined ? {} : { onPhase: args.onPhase }),
      now,
      timers,
    });

  // Provide the runtime the pipeline needs before running it (#371). The stock desktop template
  // ships python3 and curl but no Node, so an `npm install` here used to die at exit 127 after the
  // sandbox was already paid for. Probe-first, so a template that ships its own Node pays nothing.
  const serveCommands = [args.serve.install, args.serve.build, args.serve.start];
  if (needsNodeRuntime(serveCommands)) {
    const runtimeStartedAt = now();
    emitPhaseStarted(
      args.onPhase,
      now,
      "runtime",
      "providing the Node runtime the serve pipeline needs",
    );
    const bootstrap = await runProvisioningStepWithOneRetry(shell, {
      name: "subject-runtime-node",
      command: nodeBootstrapCommand(),
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      timers,
      retryPhase: "runtime-retry",
      retryMessage: "Node runtime bootstrap",
      onPhase: args.onPhase,
      now,
    });
    let ok = bootstrap.ok;
    const corepack = ok ? corepackCommandFor(serveCommands) : undefined;
    if (corepack) {
      const pm = await runDetachedStep(shell, {
        name: "subject-runtime-pm",
        command: corepack,
        cwd: SUBJECT_DIR,
        timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
        requestTimeoutMs: args.requestTimeoutMs,
        ...timers,
      });
      ok = pm.ok;
    }
    emitPhaseCompleted(
      args.onPhase,
      now,
      runtimeStartedAt,
      "runtime",
      ok,
      ok ? "Node runtime ready" : "could not provide a Node runtime",
    );
    if (!ok) {
      throw new Error(
        `the subject's serve pipeline needs a Node runtime and this desktop template has none, and bootstrapping one failed${bootstrap.attempts === 2 ? " twice" : ""}: ${failureTail(args.scrub(bootstrap.logTail))}. Use execution.desktop.template with an image that ships Node, or change serve.install to a runtime the template provides.`,
      );
    }
  }

  if (args.serve.install) {
    const installStartedAt = now();
    emitPhaseStarted(args.onPhase, now, "install", "installing subject dependencies");
    const install = await runProvisioningStepWithOneRetry(shell, {
      name: "subject-install",
      command: args.serve.install,
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      timers,
      retryPhase: "install-retry",
      retryMessage: "subject install",
      onPhase: args.onPhase,
      now,
    });
    emitPhaseCompleted(
      args.onPhase,
      now,
      installStartedAt,
      "install",
      install.ok,
      install.ok
        ? install.attempts === 2
          ? "subject dependencies installed (on the second attempt)"
          : "subject dependencies installed"
        : install.attempts === 2
          ? "subject install failed twice"
          : "subject install failed",
    );
    if (!install.ok) {
      // Lead with the line a person can act on; npm's own trace follows it (#602).
      const headline = install.timedOut
        ? `subject install timed out after ${args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS}ms`
        : install.attempts === 2
          ? `subject install failed twice (exit ${install.firstExitCode ?? "null"}, then exit ${install.exitCode ?? "null"}); the sandbox could not complete serve.install`
          : `subject install failed (exit ${install.exitCode ?? "null"})`;
      throw new Error(`${headline}: ${failureTail(args.scrub(install.logTail))}`);
    }
    await refresh();
  }

  // before-build: after install, before build (builds that read seeded state, e.g. SSG).
  // When no build is declared this simply precedes start: equivalent to before-start.
  await runState("before-build");
  await refresh();

  if (args.serve.build) {
    const buildStartedAt = now();
    emitPhaseStarted(args.onPhase, now, "build", "building subject");
    const build = await runDetachedStep(shell, {
      name: "subject-build",
      command: args.serve.build,
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      ...timers,
    });
    emitPhaseCompleted(
      args.onPhase,
      now,
      buildStartedAt,
      "build",
      build.ok,
      build.ok ? "subject build complete" : "subject build failed",
    );
    if (!build.ok) {
      throw new Error(
        `subject build ${build.timedOut ? "timed out" : `failed (exit ${build.exitCode})`}: ${failureTail(args.scrub(build.logTail))}`,
      );
    }
    await refresh();
  }

  // before-start (the default phase): migrations, SQL/file fixtures, an in-sandbox DB server
  // (`sudo service postgresql start && pg_isready` is a bounded step; the daemon it forks is
  // reclaimed by the sandbox lifecycle like everything else).
  await runState("before-start");
  await refresh();

  await startDetachedProcess(shell, {
    name: "subject-start",
    command: args.serve.start,
    cwd: SUBJECT_DIR,
    requestTimeoutMs: args.requestTimeoutMs,
  });
  // Fire-and-forget: startDetachedProcess never waits for the long-lived server to exit, so
  // there is no matching completed event here (no ok/durationMs to report yet); readiness is
  // the next boundary.
  args.onPhase?.({
    at: isoNow(now),
    type: "cua-lab.subject.serve.started",
    message: "subject server launched (detached)",
  });

  const readyStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "ready", "waiting for subject to become ready");
  const ready = await probeUrl(shell, args.serve.url, {
    timeoutMs: args.serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers,
  });
  emitPhaseCompleted(
    args.onPhase,
    now,
    readyStartedAt,
    "ready",
    ready,
    ready ? "subject is ready" : "subject did not become ready in time",
  );
  if (!ready) {
    const startLog = await readDetachedLog(shell, "subject-start", args.requestTimeoutMs).catch(
      () => "",
    );
    throw new Error(
      `subject did not answer at ${args.serve.url} within ${args.serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms; server log tail: ${failureTail(args.scrub(startLog))}`,
    );
  }

  // after-ready: fixture loading through the RUNNING app (loopback curl from in-sandbox:
  // steps are author-trusted provisioning, not actors, so no new URL policy surface). These
  // complete before the caller opens the browser and the session timer starts.
  await runState("after-ready");
  await refresh();
}
