import { toErrorMessage } from "../../evidence/redaction.js";
import type { OwnedDesktopAllocation } from "../../substrates/desktop-session.js";
import {
  E2BDesktopStartupError,
  isSandboxNotFoundError,
  type E2BDesktopModule,
} from "../../substrates/e2b/sdk.js";
import { releaseUnavailableDetail } from "../../substrates/e2b/sandbox.js";
import type { TerminalLedgers } from "./types.js";

/**
 * Tear the sandbox down and PROVE it BY EXACT ID -- NEVER Sandbox.list (humanish must never
 * enumerate the operator's E2B account; see docs/principles/invariants-and-defaults.md). The
 * allocation's release (src/substrates/e2b/sandbox.ts) kills the exact id and reads the answer the
 * same way every route does: true is terminated, false or a not-found error is already gone. That
 * is the PRIMARY proof. Where the SDK exposes Sandbox.getInfo(id), a thrown SandboxNotFoundError is
 * a second by-id confirmation that the exact sandbox is gone; a returned SandboxInfo with a live
 * state means teardown is NOT confirmed. Never throws -- teardown failure is recorded, the caller
 * fails closed on an unproven teardown.
 */
export async function teardownSandbox(args: {
  /** The allocation from acquisition; its release kills the exact id it captured. */
  allocation: OwnedDesktopAllocation | undefined;
  /** For the Sandbox.getInfo(id) re-check only. */
  sandboxModule: E2BDesktopModule | undefined;
  startupCleanup?: E2BDesktopStartupError["cleanup"];
  requestTimeoutMs: number;
  sanitize: (text: string) => string;
  recordLifecycle: (event: string, message: string) => void;
  warnings: string[];
}): Promise<TerminalLedgers["cleanup"]> {
  const {
    allocation,
    sandboxModule,
    startupCleanup,
    requestTimeoutMs,
    sanitize,
    recordLifecycle,
    warnings,
  } = args;
  if (allocation === undefined || !sandboxModule) {
    // create() can reject AFTER its constructor acquired a handle. The default loader retains
    // that authority and reclaims it before rejecting; the lane itself never receives its ID.
    if (startupCleanup === "killed" || startupCleanup === "already_gone") {
      const reason = `desktop startup guard confirmed its acquired sandbox ${startupCleanup === "killed" ? "was killed" : "was already gone"}`;
      recordLifecycle("terminal-lab.cleanup.killed", reason);
      return { killed: true, remaining: 0, reason };
    }
    const reason =
      startupCleanup === "unconfirmed"
        ? "desktop startup guard could not confirm cleanup of its acquired sandbox; provider timeout remains the backstop"
        : "create did not return a sandbox; the participant has no acquired handle and cannot establish allocation or cleanup";
    recordLifecycle("terminal-lab.cleanup.unconfirmed", reason);
    return { killed: false, remaining: -1, reason };
  }
  const sandboxId = allocation.resourceId;
  const released = await allocation.close();
  if (released.status !== "released") {
    if (released.status === "unconfirmed" && released.reason === "release_unavailable") {
      return { killed: false, remaining: -1, reason: releaseUnavailableDetail(released.detail) };
    }
    if (released.status === "unconfirmed" && released.reason === "release_failed") {
      const sanitizedError = sanitize(toErrorMessage(released.error));
      warnings.push(
        `Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${sanitizedError}`,
      );
      recordLifecycle(
        "terminal-lab.cleanup.kill_error",
        `Sandbox ${sandboxId} kill(id) failed: ${sanitizedError}`,
      );
      return {
        killed: false,
        remaining: -1,
        reason: `kill(id) failed: ${sanitizedError} (server-side kill-on-timeout will reclaim it)`,
      };
    }
    // kill(id) answered neither true nor false: nothing proves this id is gone.
    const reason =
      "kill(id) returned neither true nor false; this sandbox's teardown is not confirmed by id (server-side kill-on-timeout remains the backstop)";
    warnings.push(`Sandbox teardown unconfirmed: ${reason}`);
    recordLifecycle("terminal-lab.cleanup.unconfirmed", `Sandbox ${sandboxId} ${reason}.`);
    return { killed: false, remaining: -1, reason };
  }

  // BY-ID verification only, from here down: NEVER Sandbox.list. A released result is itself proof
  // the exact sandbox is gone: terminated when kill(id) found and killed it, already gone when
  // kill(id) answered false or threw not-found (a 404, e.g. the server-side kill-on-timeout raced
  // ahead). Both mean "this id is no longer running." Sandbox.getInfo(id), when the SDK exposes
  // it, adds a second by-id confirmation; the only thing that overturns the release proof is
  // getInfo returning a LIVE sandbox for this exact id.
  const killNote =
    released.reason === "terminated"
      ? "kill(id) returned true (found and killed)"
      : "kill(id) found the exact sandbox already gone (404)";

  if (typeof sandboxModule.Sandbox.getInfo !== "function") {
    recordLifecycle(
      "terminal-lab.cleanup.killed",
      `Sandbox ${sandboxId} reclaimed: ${killNote}; the installed SDK has no getInfo(id) to re-verify, so kill(id)'s own result is the proof.`,
    );
    return {
      killed: true,
      remaining: 0,
      reason: `reclaimed by id; ${killNote} and the installed SDK does not expose Sandbox.getInfo to re-verify`,
    };
  }

  try {
    const info = await sandboxModule.Sandbox.getInfo(sandboxId, { requestTimeoutMs });
    const state = info.state ?? "unknown";
    recordLifecycle(
      "terminal-lab.cleanup.unconfirmed",
      `Sandbox ${sandboxId} ${killNote}, but getInfo(id) still reports state=${state} (not confirmed reclaimed by id).`,
    );
    return {
      killed: true,
      remaining: 1,
      reason: `${killNote} but getInfo(id) still reports state=${state}; this sandbox's teardown is not confirmed by id`,
    };
  } catch (error) {
    if (isSandboxNotFoundError(error)) {
      recordLifecycle(
        "terminal-lab.cleanup.verified",
        `Sandbox ${sandboxId} reclaimed; getInfo(id) confirms it no longer exists (SandboxNotFoundError) -- by exact id, never re-listed.`,
      );
      return {
        killed: true,
        remaining: 0,
        reason: `reclaimed by id; getInfo(id) confirms the exact sandbox no longer exists (SandboxNotFoundError)`,
      };
    }
    // getInfo(id) failed for a reason OTHER than "not found" (e.g. a transient network error):
    // no second by-id confirmation is available, so the RESOLVED kill(id) call stands as the proof
    // of absence. Never fall back to Sandbox.list.
    const sanitizedError = sanitize(toErrorMessage(error));
    recordLifecycle(
      "terminal-lab.cleanup.killed",
      `Sandbox ${sandboxId} reclaimed: ${killNote}; getInfo(id) re-verification errored (${sanitizedError}), so kill(id)'s resolved result is the proof.`,
    );
    return {
      killed: true,
      remaining: 0,
      reason: `reclaimed by id; ${killNote} and getInfo(id) re-verification errored (${sanitizedError}), so kill(id)'s resolved result is the proof`,
    };
  }
}

/**
 * Race a commands.run promise against the maxMinutes wall-clock (safety contract item 2). The E2B
 * commands.run timeoutMs is the primary kill; this injected-clock guard is the belt-and-suspenders
 * backstop so a mock CLI (which ignores timeoutMs) is still bounded and fails closed in CI.
 */
export async function runWithWallClock<T>(
  promise: Promise<T>,
  wallClockMs: number,
  now: () => number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const start = now();
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), wallClockMs);
    timer.unref?.();
  });
  const value = await Promise.race([
    promise.then((v) => ({ timedOut: false as const, value: v })),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  // Guard against a clock that advanced past the budget even if the race resolved on the promise.
  if (!value.timedOut && now() - start >= wallClockMs) {
    return { timedOut: true };
  }
  return value;
}
