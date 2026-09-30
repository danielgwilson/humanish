// One run's lifetime on disk: its directory, its status record, its final publication, and the
// token that lets the Observer and automatic analysis read it. Routes build bundles and write
// their own evidence files; this module owns when the run starts, how it is published, and how it
// is closed on every exit.

import { buildObserverData } from "../observer/data.js";
import { renderObserver, type ObserverResult } from "../observer/render.js";
import { PUBLIC_TARGET_CWD, type RunBundle } from "./bundle.js";
import { type RunPointer } from "./results.js";
import {
  createRunArtifactPaths,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
  type RunIdInUse,
} from "./paths.js";
import {
  writeContainedOutputFile,
  writePreparedRunLatestPointer,
} from "./selected-output-paths.js";
import {
  beginRunStatus,
  runStatusOutcome,
  type RunLabProvenance,
  type RunStatusHandle,
} from "./status.js";

interface StartRunOptions {
  /** Project directory, in the form the route resolved it. */
  cwd: string;
  /** Caller-supplied id (`--run-id`, library `runId`); `mintRunId` runs when it is absent. */
  runId?: string | undefined;
  mintRunId: () => string;
  mode: "dry-run" | "live";
  lab?: RunLabProvenance | undefined;
  /** review.md for the published bundle. */
  renderReview: (bundle: RunBundle) => string;
  /** Used by `FinishedRun.renderObserver`; `render` is the routes' `renderObserverFn` seam. */
  observer?: { open: boolean; render?: typeof renderObserver | undefined };
  /** Clock for `createdAt` and the latest pointer. */
  now?: (() => number) | undefined;
}

interface Run {
  readonly runId: string;
  readonly createdAt: string;
  readonly mode: "dry-run" | "live";
  /** Routes write their evidence files through these and hand them to lanes. */
  readonly paths: PreparedRunArtifactPaths;
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
   * The one final publication: run.json, then the status outcome, then review.json, review.md,
   * events.ndjson, observer/observer-data.json, and last the latest pointer. The status goes
   * after run.json so the index never gets ahead of the evidence, and the pointer goes last so
   * `latest` never selects a run whose projections are incomplete. Rejects before writing on a
   * second call, after the scope closed, or when the bundle names another run or mode. A
   * rejection partway leaves the files written so far and issues no FinishedRun.
   */
  finish(bundle: RunBundle): Promise<FinishedRun>;
}

export interface RunScope {
  /**
   * Create `.humanish/runs/<id>` exclusively, begin status.json and wait for its first write, so
   * a run that got past this point has a status record before any sandbox exists. An id whose
   * directory exists is refused before any write. A scope starts at most one run.
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
  readonly runId: string;
  /** The paths created by startRun and validated at the start of `finish`. */
  readonly paths: PreparedRunArtifactPaths;

  constructor(
    key: typeof issueKey,
    runId: string,
    paths: PreparedRunArtifactPaths,
    observer: ObserverTarget | undefined,
  ) {
    if (key !== issueKey) throw new Error("Only Run.finish issues a FinishedRun.");
    this.runId = runId;
    this.paths = paths;
    this.#observer = observer;
  }

  static isIssued(value: unknown): value is FinishedRun {
    return typeof value === "object" && value !== null && #observer in value;
  }

  /** Render the Observer for exactly these paths, never a directory re-resolved by name. */
  renderObserver(): Promise<ObserverResult> {
    const target = this.#observer;
    if (target === undefined) {
      return Promise.reject(new RunLifecycleError("This run was started without an Observer."));
    }
    return target.render(target.cwd, this.runId, { open: target.open, expectedRun: this.paths });
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

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
  let finished: FinishedRun | undefined;
  const admitted = new Set<Promise<unknown>>();
  const admit = <V>(operation: Promise<V>): Promise<V> => {
    admitted.add(operation);
    const forget = () => admitted.delete(operation);
    void operation.then(forget, forget);
    return operation;
  };
  const refuse = (message: string) => Promise.reject(new RunLifecycleError(message));

  const startRun = (options: StartRunOptions): ReturnType<RunScope["startRun"]> => {
    if (closed) return refuse("The run scope has closed.");
    if (started) return refuse("A run scope starts one run.");
    started = true;
    return admit(
      (async () => {
        const runId = options.runId ?? options.mintRunId();
        const created = await createRunArtifactPaths(options.cwd, runId);
        if (!created.ok) return created;
        status = beginRunStatus(created.paths, {
          runId,
          mode: options.mode,
          ...(options.lab === undefined ? {} : { lab: options.lab }),
        });
        await status.started;
        return { ok: true as const, run: openRun(options, runId, created.paths, status) };
      })(),
    );
  };

  const openRun = (
    options: StartRunOptions,
    runId: string,
    paths: PreparedRunArtifactPaths,
    runStatus: RunStatusHandle,
  ): Run => {
    const now = options.now ?? Date.now;
    const createdAt = new Date(now()).toISOString();
    const observer: ObserverTarget | undefined =
      options.observer === undefined
        ? undefined
        : {
            cwd: options.cwd,
            open: options.observer.open,
            render: options.observer.render ?? renderObserver,
          };
    let finishCalled = false;
    let pointerWritten = false;
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
    const checkIdentity = (bundle: RunBundle): string | undefined =>
      bundle.runId !== runId || bundle.mode !== options.mode
        ? "The bundle names another run or mode than this run."
        : undefined;

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

    /** run.json, then `afterBundle`, then the review and projections. */
    const writeBundleFiles = async (
      bundle: RunBundle,
      afterBundle: (publicBundle: RunBundle) => Promise<void>,
    ): Promise<void> => {
      await validatePreparedRunArtifactPaths(paths);
      const publicBundle: RunBundle = { ...bundle, cwd: PUBLIC_TARGET_CWD };
      await writeContainedOutputFile(paths, "run.json", json(publicBundle), "utf8");
      await afterBundle(publicBundle);
      await writeContainedOutputFile(paths, "review.json", json(publicBundle.review), "utf8");
      await writeContainedOutputFile(
        paths,
        "review.md",
        options.renderReview(publicBundle),
        "utf8",
      );
      const events = publicBundle.events.map((event) => JSON.stringify(event)).join("\n");
      await writeContainedOutputFile(paths, "events.ndjson", `${events}\n`, "utf8");
      await writeContainedOutputFile(
        paths,
        "observer/observer-data.json",
        json(buildObserverData(publicBundle)),
        "utf8",
      );
    };

    const snapshot = async (bundle: RunBundle): Promise<void> => {
      await writeBundleFiles(bundle, async () => {});
      if (!pointerWritten) await writePointer();
    };

    const publish = async (bundle: RunBundle): Promise<FinishedRun> => {
      await writeBundleFiles(bundle, (publicBundle) =>
        runStatus.finish(runStatusOutcome(publicBundle)),
      );
      await writePointer();
      return new FinishedRun(issueKey, runId, paths, observer);
    };

    return {
      runId,
      createdAt,
      mode: options.mode,
      paths,
      writeSnapshot(bundle) {
        if (closed) return refuse("The run scope has closed.");
        if (finishCalled) return refuse("Run.finish was called; no snapshot follows it.");
        const mismatch = checkIdentity(bundle);
        if (mismatch !== undefined) return refuse(mismatch);
        return admit(enqueue(() => snapshot(bundle)));
      },
      finish(bundle) {
        if (closed) return refuse("The run scope has closed.");
        if (finishCalled) return refuse("Run.finish admits one call.");
        const mismatch = checkIdentity(bundle);
        if (mismatch !== undefined) return refuse(mismatch);
        finishCalled = true;
        return admit(
          enqueue(() => publish(bundle)).then((issued) => {
            finished = issued;
            return issued;
          }),
        );
      },
    };
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
    }
  }
  return { result: outcome.result, finished };
}
