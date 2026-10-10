// One run's lifetime on disk: its directory, its status record, its final publication, and the
// token that lets the Observer and automatic analysis read it. Routes build bundles and write
// their own evidence files; this module owns when the run starts, how it is published, and how it
// is closed on every exit.

import { randomBytes } from "node:crypto";
import { redactText } from "../evidence/redaction.js";
import { buildObserverData } from "../observer/data.js";
import { renderObserver, type ObserverResult } from "../observer/render.js";
import {
  RUN_BUNDLE_FILE,
  PUBLIC_TARGET_CWD,
  buildRunSource,
  type RunBundle,
  type RunEvent,
  type RunOutcome,
} from "./bundle.js";
import {
  judgeExecution,
  type ExecutionFailure,
  type ExecutionOutcome,
  type OutcomePolicy,
} from "./judge.js";
import { type RunPointer } from "./results.js";
import {
  createRunArtifactPaths,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
  type RunIdInUse,
} from "./paths.js";
import { registerActiveRun } from "./active-runs.js";
import { writeContainedOutputFile, writePreparedRunLatestPointer } from "./contained-output.js";
import { scrubRunSandboxIds, withPublicSandboxIds } from "./sandbox-ids.js";
import { RunSecrets } from "./secrets.js";
import {
  RUN_STATUS_FILE,
  beginRunStatus,
  runStatusOutcome,
  type RunInterruptSignal,
  type RunStatusHandle,
} from "./status.js";
import { readRunJsonIfExists, runJsonValue } from "./locate.js";
import {
  hostSuspensionEvents,
  systemHostClock,
  type HostClock,
  type HostSuspension,
} from "./host-suspension.js";
import type { RunStudyProvenance } from "./study-provenance.js";

interface StartRunOptions {
  /** Project directory, in the form the route resolved it. */
  cwd: string;
  /** Caller-supplied id (`--run-id`, library `runId`); `mintRunId` runs when it is absent. */
  runId?: string | undefined;
  mintRunId: () => string;
  mode: "dry-run" | "live";
  study?: RunStudyProvenance | undefined;
  /** `none` when the route creates no sandbox for this run; status.json records it for reclaim. */
  sandboxes?: "none" | undefined;
  /** review.md for the published bundle. */
  renderReview: (bundle: RunBundle, status?: unknown) => string;
  /** Used by `FinishedRun.renderObserver`; `render` is the `StudyDeps.renderObserver` seam. */
  observer?: { open: boolean; render?: typeof renderObserver | undefined };
  /** Clock for `createdAt` and the latest pointer. Defaults to the clock's `now`. */
  now?: (() => number) | undefined;
  /** The run's wall clock and heartbeat timer. Defaults to systemHostClock. */
  clock?: HostClock | undefined;
  /** Warnings about the study's own fields. Every bundle write records each as a warn event. */
  warnings?: readonly string[] | undefined;
  /** The route's known values, created before the run so a refusal before it is scrubbed too. */
  secrets?: RunSecrets | undefined;
}

/** The prefix of the run ids each recorded route mints. Preview mints its own `dryrun-` ids. */
type RunIdPrefix = "cua" | "concurrent-shared-world" | "scripted" | "terminal";

/** What a recorded route's plan holds for its run's start. */
interface StartRunPlan {
  readonly dryRun: boolean;
  readonly study?: RunStudyProvenance | undefined;
  readonly warnings?: readonly string[] | undefined;
}

/** What a recorded route's input holds for its run's start. */
interface StartRunInput {
  /** Caller-supplied id (`--run-id`, library `runId`); one is minted from the prefix when absent. */
  readonly runId?: string | undefined;
  /** Open the Observer page once it renders. */
  readonly open?: boolean | undefined;
  /**
   * `renderObserver` is the seam FinishedRun.renderObserver calls; `hostClock` is the run's
   * clock and heartbeat timer.
   */
  readonly deps?:
    | {
        readonly renderObserver?: typeof renderObserver | undefined;
        readonly hostClock?: HostClock | undefined;
      }
    | undefined;
}

/** What a recorded route passes to startRun besides its plan and input. */
interface RouteRunOptions {
  /** Project directory, in the form the route resolved it. */
  cwd: string;
  prefix: RunIdPrefix;
  /** review.md for the published bundle. */
  renderReview: (bundle: RunBundle, status?: unknown) => string;
  /** `none` when the route creates no sandbox for this run; status.json records it for reclaim. */
  sandboxes?: "none" | undefined;
  /** Clock for `createdAt` and the latest pointer. The minted id reads the wall clock. */
  now?: (() => number) | undefined;
  /** The route's known values, created before the run so a refusal before it is scrubbed too. */
  secrets?: RunSecrets | undefined;
}

/** How a run ended as an execution, as run.json records it: the result's ok and execution outcome. */
interface RecordedOutcome {
  ok: boolean;
  execution: ExecutionOutcome;
}

/** What a route hands Run.finish about how its run ended, before the Observer renders. */
export interface FinishOutcome extends RecordedOutcome {
  /**
   * The route's entry in OUTCOME_POLICIES. FinishedRun.renderObserver records an Observer that
   * did not render under it, as a failure or a warning.
   */
  policy: OutcomePolicy;
}

interface Run {
  readonly runId: string;
  readonly createdAt: string;
  readonly mode: "dry-run" | "live";
  /** The manifest the run came from; bundleHead copies it into the bundle. */
  readonly study?: RunStudyProvenance;
  /** Routes write their evidence files through these and hand them to participants. */
  readonly paths: PreparedRunArtifactPaths;
  /** The literal values the route scrubs from this run's evidence; a value found later is added here. */
  readonly secrets: RunSecrets;
  /**
   * Publish an in-progress bundle: run.json, review.json, review.md, events.ndjson and
   * observer/observer-data.json, plus the latest pointer until one pointer write has succeeded,
   * so a live run is `latest` from its first snapshot and a later flush never takes the pointer
   * back from a newer run. status.json stays running. Writes are serialized with each other and
   * with `finish`; a rejected write reaches only its caller. Rejects before writing once `finish`
   * was called or the scope closed, or when the bundle names another run or mode, so a late flush
   * can never overwrite the final bundle. Routes that throttle snapshots own their timers.
   */
  writeSnapshot(bundle: RunBundle): Promise<void>;
  /**
   * A participant's session started: its actor began to act on the subject. FinishedRun's
   * participantsRan reads this, so a session that throws before it returns a trace still counts,
   * and a run that failed before any session (a refused E2B key) does not.
   */
  participantStarted(): void;
  /**
   * The times this process did not run while the run was alive, most likely because the host
   * slept, as the run's heartbeat saw them up to this call. Every bundle write records each as a
   * `host.suspended` event; a route reads them to say which participant failures they caused.
   */
  hostSuspensions(): readonly HostSuspension[];
  /**
   * The one final publication: run.json with `outcome` set from `outcome`, then the status
   * outcome copied from it, then review.json, review.md, events.ndjson,
   * observer/observer-data.json, and last the latest pointer. The status goes after run.json so
   * the index never gets ahead of the evidence, and the pointer goes last so `latest` never
   * selects a run whose projections are incomplete. Every projection reads the outcome, so none
   * shows a pass for a run whose ok is false. Rejects before writing on a second call, after the
   * scope closed, or when the bundle names another run or mode. A rejection partway leaves the
   * files written so far and issues no FinishedRun.
   */
  finish(bundle: RunBundle, outcome: FinishOutcome): Promise<FinishedRun>;
}

/** A recorded route's run, with the source its bundle records. */
interface RecordedRun extends Run {
  /** The package and the project's git state, captured once the run exists, at its createdAt. */
  readonly source: RunBundle["source"];
}

export interface RunScope {
  /**
   * Start a recorded route's run from its plan and input: the input's run id or one minted from
   * `prefix`, the plan's mode, study and warnings, and an Observer that opens when the input says
   * `open` and renders through the input's `deps.renderObserver`. Then capture the run's source.
   * The run starts as the form below does.
   */
  startRun(
    plan: StartRunPlan,
    input: StartRunInput,
    options: RouteRunOptions,
  ): Promise<{ ok: true; run: RecordedRun } | RunIdInUse>;
  /**
   * Create `.humanish/runs/<id>` exclusively, begin status.json and wait for its first write, so
   * a run that got past this point has a status record before any sandbox exists. An id whose
   * directory exists is refused before any write. A scope starts at most one run. Preview calls
   * this form, since it builds its source before the run and mints its own id.
   */
  startRun(options: StartRunOptions): Promise<{ ok: true; run: Run } | RunIdInUse>;
}

/** An entry point called in a state that does not admit it. */
class RunLifecycleError extends Error {
  override name = "RunLifecycleError";
}

interface ObserverTarget {
  cwd: string;
  open: boolean;
  render: typeof renderObserver;
}

const issueKey = Symbol("FinishedRun");

/**
 * Proof that one run published its final bundle, and the only input automatic analysis accepts.
 * A private field makes the type nominal, so no object literal satisfies it, `isIssued` checks
 * that field at runtime, and the constructor refuses callers without the module-private key. This
 * guards against accidental misuse; code in the same process can still forge one.
 */
export class FinishedRun {
  readonly #observer: ObserverTarget | undefined;
  readonly #recordFailure: (failure: ExecutionFailure) => Promise<RecordedOutcome>;
  readonly #interrupted: () => boolean;
  #outcome: RecordedOutcome;
  readonly runId: string;
  /** The paths created by startRun and validated at the start of `finish`. */
  readonly paths: PreparedRunArtifactPaths;
  readonly #participantsRan: () => boolean;

  constructor(
    key: typeof issueKey,
    runId: string,
    paths: PreparedRunArtifactPaths,
    observer: ObserverTarget | undefined,
    outcome: RecordedOutcome,
    recordFailure: (failure: ExecutionFailure) => Promise<RecordedOutcome>,
    interrupted: () => boolean,
    participantsRan: () => boolean,
  ) {
    if (key !== issueKey) throw new Error("Only Run.finish issues a FinishedRun.");
    this.runId = runId;
    this.paths = paths;
    this.#participantsRan = participantsRan;
    this.#observer = observer;
    this.#outcome = outcome;
    this.#recordFailure = recordFailure;
    this.#interrupted = interrupted;
  }

  /**
   * A signal stopped this run's process: status.json and run.json record it `interrupted`. Read
   * when asked, since the signal can arrive after the bundle was published.
   */
  get interrupted(): boolean {
    return this.#interrupted();
  }

  /** The route reported a participant's session started (Run.participantStarted). */
  get participantsRan(): boolean {
    return this.#participantsRan();
  }

  static isIssued(value: unknown): value is FinishedRun {
    return typeof value === "object" && value !== null && #observer in value;
  }

  /**
   * The run's ok and execution outcome as run.json records them: what the route passed to
   * finish, plus an Observer that did not render. A route's result reads them from here.
   */
  get outcome(): RecordedOutcome {
    return this.#outcome;
  }

  /**
   * Render the Observer for exactly these paths, never a directory re-resolved by name. An
   * Observer that did not render is an `evidence` failure: it is added to run.json's outcome and
   * status.json under the route's policy before this resolves. No page exists then that could
   * show the run without it. A render that throws records nothing and rejects.
   */
  async renderObserver(): Promise<ObserverResult> {
    const target = this.#observer;
    if (target === undefined)
      throw new RunLifecycleError("This run was started without an Observer.");
    const observer = await target.render(target.cwd, this.runId, {
      open: target.open,
      expectedRun: this.paths,
    });
    if (!observer.ok) {
      this.#outcome = await this.#recordFailure({
        kind: "evidence",
        message: observer.error?.message ?? "The Observer did not render.",
      });
    }
    return observer;
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** An execution outcome as run.json records it, each message through the shape redaction. */
function redactedExecution(execution: ExecutionOutcome): ExecutionOutcome {
  const redacted = (failure: ExecutionFailure): ExecutionFailure => ({
    kind: failure.kind,
    message: redactText(failure.message),
  });
  return {
    succeeded: execution.succeeded,
    failures: execution.failures.map(redacted),
    ...(execution.warnings === undefined ? {} : { warnings: execution.warnings.map(redacted) }),
  };
}

/** Where FinishedRun renders the Observer, when the run was started with one. */
function observerTarget(options: StartRunOptions): ObserverTarget | undefined {
  return options.observer === undefined
    ? undefined
    : {
        cwd: options.cwd,
        open: options.observer.open,
        render: options.observer.render ?? renderObserver,
      };
}

/** The writes of one run, queued in order: its snapshots, its final publication and its interrupt. */
interface RunPublisher {
  snapshot(bundle: RunBundle): Promise<void>;
  publish(bundle: RunBundle, outcome: FinishOutcome): Promise<FinishedRun>;
  /**
   * A signal stopped the run: every later write carries the interrupted outcome, and the last
   * bundle written or queued is written again with it. A run with no bundle yet writes nothing.
   */
  interrupt(signal: RunInterruptSignal): Promise<void>;
}

function runPublisher(args: {
  options: StartRunOptions;
  runId: string;
  createdAt: string;
  paths: PreparedRunArtifactPaths;
  runStatus: RunStatusHandle;
  now: () => number;
  /** The scope's tracker, so the scope waits for a failure recorded after the Observer render. */
  admit: <V>(operation: Promise<V>) => Promise<V>;
  /** Whether the route reported a participant's session started. */
  participantsRan: () => boolean;
}): RunPublisher {
  const { options, runId, createdAt, paths, runStatus, now, admit, participantsRan } = args;
  const observer = observerTarget(options);
  // The study's warnings join whatever events the route wrote, once, in every write. A warning can
  // quote the study file, which may name a sandbox URL a participant needs, so each goes through
  // the redaction a run failure gets.
  const studyWarnings: RunEvent[] = (options.warnings ?? []).map((message, index) => ({
    id: `event-study-warning-${String(index + 1).padStart(3, "0")}`,
    at: createdAt,
    level: "warn",
    type: "study.warning",
    message: redactText(message),
  }));
  // So do the host suspensions the heartbeat has seen by the time of the write.
  const withRunEvents = (events: readonly RunEvent[]): RunEvent[] => {
    const owned = [
      ...studyWarnings,
      ...hostSuspensionEvents(runStatus.suspensions(), Date.parse(createdAt)),
    ];
    return [...events.filter((event) => !owned.some((mine) => mine.id === event.id)), ...owned];
  };
  let pointerWritten = false;
  // The bundle of the last write asked for, and the outcome every later write carries once a
  // signal stopped the run, so no write after the interrupt can drop it.
  let lastBundle: RunBundle | undefined;
  let interrupted: Extract<RunOutcome, { state: "interrupted" }> | undefined;
  // One chain serializes every write. A rejection reaches only the caller of that write; the
  // chain itself continues, so a failed snapshot never blocks the final publication.
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <V>(write: () => Promise<V>): Promise<V> => {
    const written = tail.then(write);
    tail = written.then(
      () => undefined,
      () => undefined,
    );
    return written;
  };
  const writePointer = async (): Promise<void> => {
    const pointer: RunPointer = {
      schema: "humanish.latest-run.v1",
      runId,
      path: paths.relativeRunRoot,
      updatedAt: new Date(now()).toISOString(),
    };
    await writePreparedRunLatestPointer(paths, json(pointer), "utf8");
    pointerWritten = true;
  };

  /** run.json with its outcome, then `afterBundle`, then the review and projections. */
  const writeBundleFiles = async (
    bundle: RunBundle,
    outcome: RunOutcome | undefined,
    afterBundle: (publicBundle: RunBundle) => Promise<void>,
  ): Promise<void> => {
    await validatePreparedRunArtifactPaths(paths);
    // The run owns `outcome`: a bundle read back from disk keeps none of its own.
    const { outcome: _previous, ...evidence } = bundle;
    const recorded = interrupted ?? outcome;
    const publicBundle = await withPublicSandboxIds(paths, {
      ...evidence,
      events: withRunEvents(evidence.events),
      cwd: PUBLIC_TARGET_CWD,
      ...(recorded === undefined ? {} : { outcome: recorded }),
    });
    await writeContainedOutputFile(paths, RUN_BUNDLE_FILE, json(publicBundle), "utf8");
    await afterBundle(publicBundle);
    // The run writes its own status.json; one it refuses renders as a missing one does.
    const status =
      recorded === undefined
        ? runJsonValue(await readRunJsonIfExists(paths, RUN_STATUS_FILE))
        : undefined;
    await writeContainedOutputFile(paths, "review.json", json(publicBundle.review), "utf8");
    await writeContainedOutputFile(
      paths,
      "review.md",
      options.renderReview(publicBundle, status),
      "utf8",
    );
    const events = publicBundle.events.map((event) => JSON.stringify(event)).join("\n");
    await writeContainedOutputFile(paths, "events.ndjson", `${events}\n`, "utf8");
    await writeContainedOutputFile(
      paths,
      "observer/observer-data.json",
      json(buildObserverData(publicBundle, undefined, status)),
      "utf8",
    );
  };

  const snapshot = async (bundle: RunBundle): Promise<void> => {
    await writeBundleFiles(bundle, undefined, async () => {});
    if (!pointerWritten) await writePointer();
  };

  const finishedOutcome = (outcome: RecordedOutcome): RunOutcome => ({
    state: "finished",
    ok: outcome.ok,
    execution: redactedExecution(outcome.execution),
  });

  const publish = async (bundle: RunBundle, outcome: FinishOutcome): Promise<FinishedRun> => {
    await writeBundleFiles(bundle, finishedOutcome(outcome), (publicBundle) =>
      runStatus.finish(runStatusOutcome(publicBundle)),
    );
    await scrubRunSandboxIds(paths);
    await writePointer();
    let current: RecordedOutcome = { ok: outcome.ok, execution: outcome.execution };
    // An Observer that did not render, judged under the route's policy and written to run.json
    // and status.json, so the two agree with the result the route returns. A run directory that
    // can no longer be written (replaced, or a disk error) keeps the files it has, and the
    // result still carries the failure.
    const recordFailure = (failure: ExecutionFailure): Promise<RecordedOutcome> =>
      admit(
        enqueue(async () => {
          const { failures, warnings = [] } = current.execution;
          const execution = judgeExecution([...failures, ...warnings, failure], outcome.policy);
          current = { ok: current.ok && execution.succeeded, execution };
          await writeBundleFiles(bundle, finishedOutcome(current), (publicBundle) =>
            runStatus.restate(runStatusOutcome(publicBundle)),
          ).catch(() => undefined);
          return current;
        }),
      );
    return new FinishedRun(
      issueKey,
      runId,
      paths,
      observer,
      current,
      recordFailure,
      () => runStatus.interrupted,
      participantsRan,
    );
  };

  const interrupt = async (signal: RunInterruptSignal): Promise<void> => {
    interrupted = { state: "interrupted", ok: false, signal, at: new Date(now()).toISOString() };
    const written = lastBundle;
    if (written === undefined) return;
    // A failed write leaves status.json as the record of the interrupt.
    await enqueue(() => writeBundleFiles(written, undefined, async () => {})).catch(
      () => undefined,
    );
  };

  return {
    snapshot(bundle) {
      lastBundle = bundle;
      return enqueue(() => snapshot(bundle));
    },
    publish(bundle, outcome) {
      lastBundle = bundle;
      return enqueue(() => publish(bundle, outcome));
    },
    interrupt,
  };
}

/**
 * Run `fn` as the lifetime of at most one run. When `fn` settles the scope closes synchronously,
 * so the scope and its run admit no further calls, even through references `fn` leaked into
 * timers or callbacks. It then waits for the calls it admitted and, unless the run finished,
 * finishes status.json with no outcome. The close cannot replace `fn`'s exception: admitted calls
 * are awaited settled and the status finish swallows its own write errors. `finished` is set only
 * when `Run.finish` resolved inside the scope, so a refusal cannot hand analysis another run.
 */
export async function runScope<T>(
  fn: (scope: RunScope) => Promise<T>,
): Promise<{ result: T; finished: FinishedRun | undefined }> {
  let closed = false;
  let started = false;
  let status: RunStatusHandle | undefined;
  let unregister: (() => void) | undefined;
  let finished: FinishedRun | undefined;
  const admitted = new Set<Promise<unknown>>();
  const admit = <V>(operation: Promise<V>): Promise<V> => {
    admitted.add(operation);
    const forget = () => admitted.delete(operation);
    void operation.then(forget, forget);
    return operation;
  };
  const refuse = (message: string) => Promise.reject(new RunLifecycleError(message));

  const startRunWith = (options: StartRunOptions): Promise<{ ok: true; run: Run } | RunIdInUse> => {
    if (closed) return refuse("The run scope has closed.");
    if (started) return refuse("A run scope starts one run.");
    started = true;
    return admit(
      (async () => {
        const runId = options.runId ?? options.mintRunId();
        const created = await createRunArtifactPaths(options.cwd, runId);
        if (!created.ok) return created;
        // beginRunStatus reads only the mode, the study provenance, the sandboxes field and the
        // clock from the run's options.
        const runStatus = beginRunStatus(created.paths, { ...options, runId });
        status = runStatus;
        let interruptBundle: ((signal: RunInterruptSignal) => Promise<void>) | undefined;
        // Registered before the first write lands: a signal while it is still settling reaches
        // the handle, whose interrupt queues behind that write. The interrupt lands in
        // status.json first, then in run.json once the run has written one.
        unregister = registerActiveRun({
          cwd: options.cwd,
          runId,
          paths: created.paths,
          status: {
            async interrupt(signal) {
              const recorded = await runStatus.interrupt(signal);
              if (recorded) await interruptBundle?.(signal);
              return recorded;
            },
          },
        });
        await runStatus.started;
        const run = openRun(options, runId, created.paths, runStatus);
        interruptBundle = run.interrupt;
        return { ok: true as const, run: run.run };
      })(),
    );
  };

  function startRun(options: StartRunOptions): Promise<{ ok: true; run: Run } | RunIdInUse>;
  function startRun(
    plan: StartRunPlan,
    input: StartRunInput,
    route: RouteRunOptions,
  ): Promise<{ ok: true; run: RecordedRun } | RunIdInUse>;
  function startRun(
    ...args: [StartRunOptions] | [StartRunPlan, StartRunInput, RouteRunOptions]
  ): Promise<{ ok: true; run: Run | RecordedRun } | RunIdInUse> {
    return args.length === 1 ? startRunWith(args[0]) : startRecordedRun(startRunWith, ...args);
  }

  const openRun = (
    options: StartRunOptions,
    runId: string,
    paths: PreparedRunArtifactPaths,
    runStatus: RunStatusHandle,
  ): { run: Run; interrupt: (signal: RunInterruptSignal) => Promise<void> } => {
    const now = options.now ?? (options.clock ?? systemHostClock).now;
    const createdAt = new Date(now()).toISOString();
    let participantsRan = false;
    const publisher = runPublisher({
      options,
      runId,
      createdAt,
      paths,
      runStatus,
      now,
      admit,
      participantsRan: () => participantsRan,
    });
    let finishCalled = false;
    const checkIdentity = (bundle: RunBundle): string | undefined =>
      bundle.runId !== runId || bundle.mode !== options.mode
        ? "The bundle names another run or mode than this run."
        : undefined;

    const run: Run = {
      runId,
      createdAt,
      mode: options.mode,
      ...(options.study === undefined ? {} : { study: options.study }),
      paths,
      secrets: options.secrets ?? new RunSecrets([]),
      participantStarted() {
        participantsRan = true;
      },
      hostSuspensions: () => runStatus.suspensions(),
      writeSnapshot(bundle) {
        if (closed) return refuse("The run scope has closed.");
        if (finishCalled) return refuse("Run.finish was called; no snapshot follows it.");
        const mismatch = checkIdentity(bundle);
        if (mismatch !== undefined) return refuse(mismatch);
        return admit(publisher.snapshot(bundle));
      },
      finish(bundle, outcome) {
        if (closed) return refuse("The run scope has closed.");
        if (finishCalled) return refuse("Run.finish admits one call.");
        const mismatch = checkIdentity(bundle);
        if (mismatch !== undefined) return refuse(mismatch);
        finishCalled = true;
        return admit(
          publisher.publish(bundle, outcome).then((issued) => {
            finished = issued;
            return issued;
          }),
        );
      },
    };
    return { run, interrupt: publisher.interrupt };
  };

  let outcome: { result: T } | undefined;
  try {
    outcome = { result: await fn({ startRun }) };
  } finally {
    closed = true;
    try {
      await Promise.allSettled(admitted);
    } finally {
      if (finished === undefined) await status?.finish();
      unregister?.();
    }
  }
  return { result: outcome.result, finished };
}

/** Start a recorded route's run through `start`, the scope's own form, then capture its source. */
async function startRecordedRun(
  start: (options: StartRunOptions) => Promise<{ ok: true; run: Run } | RunIdInUse>,
  plan: StartRunPlan,
  input: StartRunInput,
  route: RouteRunOptions,
): Promise<{ ok: true; run: RecordedRun } | RunIdInUse> {
  const started = await start({
    cwd: route.cwd,
    runId: input.runId,
    mintRunId: () => mintRunId(route.prefix),
    mode: plan.dryRun ? "dry-run" : "live",
    study: plan.study,
    warnings: plan.warnings,
    sandboxes: route.sandboxes,
    renderReview: route.renderReview,
    observer: { open: input.open === true, render: input.deps?.renderObserver },
    now: route.now,
    clock: input.deps?.hostClock,
    secrets: route.secrets,
  });
  if (!started.ok) return started;
  const source = await buildRunSource({
    cwd: route.cwd,
    capturedAt: started.run.createdAt,
    humanishSource: "present",
    packageName: "humanish",
  });
  return { ok: true, run: { ...started.run, source } };
}

/** `<prefix>-<wall-clock time, with : and . as ->-<8 hex>`. */
function mintRunId(prefix: RunIdPrefix): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${stamp}-${randomBytes(4).toString("hex")}`;
}
