import type { CuaAction, CuaExecutor } from "./computer-use.js";
import { CuaExecutorError } from "./cua-executor-error.js";

/** Internal lifecycle contract. Provider IDs are evidence, not permission to acquire a handle. */
export type DesktopReleaseResult =
  | { status: "released"; reason: "terminated" | "already_gone" }
  | { status: "retained"; reason: "debug" }
  | { status: "unconfirmed"; reason: "release_unavailable" | "invalid_result" | "release_failed"; error?: unknown };

export interface DesktopSession {
  readonly resourceId: string;
  readonly executor: CuaExecutor;
  close(options?: { retainForDebug?: boolean }): Promise<DesktopReleaseResult>;
}

export interface OwnedDesktopAllocation {
  readonly resourceId: string;
  /** Bind after adapter-specific provisioning, once per allocation. */
  open(executor: CuaExecutor): DesktopSession;
  /** Also available before open, so a provisioning failure cannot lose its cleanup handle. */
  close(options?: { retainForDebug?: boolean }): Promise<DesktopReleaseResult>;
}

/**
 * Wrap an already-acquired resource. The adapter supplies release authority as a closure;
 * this layer never reconstructs it from a saved ID or enumerates provider resources.
 * Closing immediately rejects new actions, including when release is unconfirmed. An
 * in-flight backend operation may reject as the resource stops; close does not wait for it.
 */
export function ownDesktopAllocation(options: {
  resourceId: string;
  release: () => Promise<Exclude<DesktopReleaseResult, { status: "retained" }>>;
}): OwnedDesktopAllocation {
  const resourceId = options.resourceId;
  const release = options.release;
  let opened = false;
  let closing: Promise<DesktopReleaseResult> | undefined;
  const assertOpen = (): void => {
    if (closing !== undefined) throw new CuaExecutorError("executor_closed", "not_dispatched");
  };
  const close: OwnedDesktopAllocation["close"] = (policy = {}) => {
    // Install the promise before invoking release: concurrent/reentrant callers share it.
    closing ??= policy.retainForDebug === true
      ? Promise.resolve({ status: "retained", reason: "debug" })
      : Promise.resolve().then(release).catch((error: unknown): DesktopReleaseResult => ({
          status: "unconfirmed", reason: "release_failed", error
        }));
    return closing;
  };
  return Object.freeze({
    resourceId,
    close,
    open(executor: CuaExecutor): DesktopSession {
      assertOpen();
      if (opened) throw new Error("Desktop allocation already has a participant session.");
      opened = true;
      return Object.freeze({
        resourceId,
        close,
        executor: {
          ...(executor.stallRecovery === "fail_closed" ? { stallRecovery: "fail_closed" as const } : {}),
          observe: async () => { assertOpen(); return executor.observe(); },
          execute: async (action: CuaAction, signal?: AbortSignal) => { assertOpen(); return executor.execute(action, signal); }
        }
      });
    }
  });
}
