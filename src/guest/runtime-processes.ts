import { spawn, type ChildProcess } from "node:child_process";
import { CuaExecutorError } from "../actors/computer-use/executor-error.js";

/** A short-lived helper that has not exited by then is killed. Persistent children have no bound. */
const HELPER_TIMEOUT_MS = 2000;
/** Helpers report success through exit status, so stderr past this budget is a failure. */
const STDERR_LIMIT_BYTES = 16_384;

export const setupFailed = (): CuaExecutorError =>
  new CuaExecutorError("execution_failed", "not_dispatched");

interface GuestChildRecord {
  child: ChildProcess;
  closed: Promise<void>;
  exited: boolean;
}

export interface GuestProcesses {
  /** `done` resolves when the child exits 0 within its bounds and rejects otherwise. */
  spawn(
    binary: string,
    args: readonly string[],
    input?: string,
    persistent?: boolean,
  ): { done: Promise<void>; child: ChildProcess };
  /** SIGKILLs every child still running and returns whether there was one. */
  killRunning(): boolean;
  /** Resolves when every child spawned so far has closed. */
  closed(): Promise<void>;
  allExited(): boolean;
}

/**
 * The guest desktop's fixed child processes. A persistent child (the display server, the window
 * manager) that exits, fails or is killed by the owner's abort reports `onTerminal` unless the
 * desktop is already stopping.
 */
export function createGuestProcesses(options: {
  env: Readonly<Record<string, string>>;
  cwd: string;
  signal: AbortSignal;
  check(): void;
  isStopping(): boolean;
  onTerminal(): void;
}): GuestProcesses {
  const children: GuestChildRecord[] = [];
  const { signal } = options;
  const terminal = (persistent: boolean): void => {
    if (persistent && !options.isStopping()) options.onTerminal();
  };
  return {
    spawn(binary, args, input, persistent = false) {
      options.check();
      const process = spawn(binary, args, {
        env: options.env,
        cwd: options.cwd,
        stdio: ["pipe", "ignore", "pipe"],
      });
      let finish!: () => void;
      const record: GuestChildRecord = {
        child: process,
        closed: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        exited: false,
      };
      children.push(record);
      const done = new Promise<void>((resolve, reject) => {
        let count = 0,
          failed = false;
        const fail = (): void => {
          failed = true;
          if (!record.exited) process.kill("SIGKILL");
          terminal(persistent);
        };
        const timer = persistent ? undefined : setTimeout(fail, HELPER_TIMEOUT_MS);
        // xdpyinfo's normal display inventory is large and is not an error log.
        const consume = (data: Buffer): void => {
          count += data.length;
          if (count > STDERR_LIMIT_BYTES) fail();
        };
        process.stderr!.on("data", consume);
        process.on("error", fail);
        process.stdin!.on("error", fail);
        process.once("exit", () => {
          record.exited = true;
          terminal(persistent);
        });
        process.once("close", (code) => {
          record.exited = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", fail);
          finish();
          terminal(persistent);
          if (failed || code !== 0) reject(setupFailed());
          else resolve();
        });
        signal.addEventListener("abort", fail, { once: true });
        process.stdin!.end(input);
        if (signal.aborted) fail();
      });
      void done.catch(() => {});
      return { done, child: process };
    },
    killRunning() {
      let running = false;
      for (const record of children)
        if (!record.exited) {
          running = true;
          record.child.kill("SIGKILL");
        }
      return running;
    },
    async closed() {
      await Promise.all(children.map((record) => record.closed));
    },
    allExited() {
      return children.every((record) => record.exited);
    },
  };
}
