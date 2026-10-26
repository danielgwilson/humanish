import { ComputerUseExecutorError } from "../../actors/computer-use/executor-error.js";
import type { CuaAction } from "../../actors/computer-use/loop.js";
import { planX11Action, type X11Dialect, type X11Point, type X11Step } from "./translator.js";

// Runs a translated action on one X11 desktop through that substrate's transport. The transport is
// the only thing a sandbox provider implements: E2B and Modal sandboxes share one over their
// command channel (src/substrates/e2b/desktop-executor.ts), and the guest VM has its own
// (src/guest/desktop-executor.ts).

/** Text staged for insertion. paste inserts it once; close releases what prepare made. */
export interface X11TextChannel {
  paste(): Promise<void>;
  close(): Promise<void>;
}

/**
 * What a substrate provides so the translator can drive its desktop. Every method gets the
 * action's signal; a transport that dispatches asynchronously checks it right before native input.
 */
export interface X11Transport {
  /**
   * Run one xdotool command: the words after `xdotool`. The translator sends only flags, numbers
   * and key-table names, none of which needs shell quoting. A failure rejects with the
   * substrate's own error, which the loop reads (a command exit is a skipped action).
   */
  input(args: readonly string[], signal: AbortSignal): Promise<void>;
  /** Stage `text` for insertion at the keyboard focus. The runner always closes the channel. */
  prepareText(text: string, signal: AbortSignal): Promise<X11TextChannel>;
  /** Wait `ms` on the desktop. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  /** Capture the whole desktop as PNG bytes. */
  capture(signal: AbortSignal): Promise<Buffer>;
  /**
   * Read the pointer position. A transport without it moves for every click, since a read that
   * cannot happen cannot show the pointer is already there.
   */
  readPointer?(signal: AbortSignal): Promise<X11Point>;
}

/** A desktop: the transport that reaches it and the dialect its commands are written in. */
export interface X11Desktop {
  readonly transport: X11Transport;
  readonly dialect: X11Dialect;
}

/** The longest a pointer read may delay an action; a slower read counts as unknown. */
const POINTER_READ_TIMEOUT_MS = 500;

/**
 * Run one action: plan it (a refusal throws before anything is sent), press any held modifiers,
 * run each step, then release them. The signal is checked before the first step and after a
 * pointer read; the transport checks it before each input it sends.
 */
export async function executeX11Action(
  action: CuaAction,
  desktop: X11Desktop,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const plan = planX11Action(action, desktop.dialect);
  const run = () => runSteps(plan.steps, desktop.transport, signal);
  if (plan.held === undefined) return run();
  return holding(plan.held, desktop, signal, run);
}

async function runSteps(
  steps: readonly X11Step[],
  transport: X11Transport,
  signal: AbortSignal,
): Promise<void> {
  let pointerThere = false;
  for (const step of steps) {
    switch (step.kind) {
      case "read-pointer":
        pointerThere = await pointerReadsAt(transport, step.at, signal);
        signal.throwIfAborted();
        break;
      case "xdotool":
        if (!(step.unlessPointerThere && pointerThere)) await transport.input(step.args, signal);
        break;
      case "text": {
        const channel = await transport.prepareText(step.text, signal);
        try {
          await channel.paste();
        } finally {
          await channel.close();
        }
        break;
      }
      case "wait":
        await transport.wait(step.ms, signal);
        break;
    }
  }
}

/**
 * Hold `chord` down for `run`, then release it whether `run` succeeded or not. A keydown that
 * failed may still have pressed some keys, so the release is sent after it too, once and never
 * retried. The dialect says what a failed release reports.
 */
async function holding(
  chord: string,
  { transport, dialect }: X11Desktop,
  signal: AbortSignal,
  run: () => Promise<void>,
): Promise<void> {
  let failure: { readonly error: unknown } | undefined;
  try {
    await transport.input(["keydown", chord], signal);
    await run();
  } catch (error) {
    failure = { error };
  }
  try {
    await transport.input(["keyup", chord], signal);
  } catch (error) {
    if (dialect.releaseFailure === "uncertain")
      throw new ComputerUseExecutorError("execution_failed", "outcome_uncertain");
    if (failure === undefined) throw error;
  }
  if (failure !== undefined) throw failure.error;
}

/**
 * Whether the pointer is exactly at `at`. Only an integer target can match, and a read that fails,
 * is malformed, is cancelled or takes longer than 500 ms counts as no. A late read is left to
 * finish: it is read-only and cannot dispatch input.
 */
function pointerReadsAt(
  transport: X11Transport,
  at: X11Point,
  signal: AbortSignal,
): Promise<boolean> {
  const { x, y } = at;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0)
    return Promise.resolve(false);
  const readPointer = transport.readPointer;
  if (readPointer === undefined || signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (matches: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(matches);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(false), POINTER_READ_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => (settled ? undefined : readPointer.call(transport, signal)))
      .then(
        (point: unknown) => {
          if (settled) return;
          // A custom transport can return malformed values or throwing accessors; all are unknown.
          try {
            const read = point as { x?: unknown; y?: unknown } | null;
            finish(
              typeof read === "object" &&
                read !== null &&
                Number.isSafeInteger(read.x) &&
                Number.isSafeInteger(read.y) &&
                read.x === x &&
                read.y === y,
            );
          } catch {
            finish(false);
          }
        },
        () => finish(false),
      );
  });
}

/** The pointer position in `xdotool getmouselocation` output. */
export function parseMouseLocation(stdout: string): X11Point {
  const match = /x:(\d+)\s+y:(\d+)/.exec(stdout);
  if (!match) throw new Error("xdotool getmouselocation reported no pointer position.");
  return { x: Number.parseInt(match[1]!, 10), y: Number.parseInt(match[2]!, 10) };
}
