// E2B sandbox acquisition and release. Every route that allocates an E2B sandbox calls this module,
// so each allocation runs the same steps in the same order: create, one retry on a transient
// provider error, capture of the exact id and kill authority, and a provider-qualified receipt in
// the run directory before the caller gets the handle. The desktop startup guard
// (guardDesktopSandboxCreate) is installed by loadE2BDesktopModule, so a create whose desktop
// startup fails has already reclaimed its handle when the error reaches the retry here.
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import { appendSandboxReceipt } from "../../run/sandbox-receipts.js";
import type { PreparedOutputRoot } from "../../run/contained-output.js";
import {
  ownDesktopAllocation,
  type DesktopReleaseResult,
  type OwnedDesktopAllocation,
} from "../desktop-session.js";
import type { LabConfig } from "../../lab/types.js";
import {
  E2BDesktopStartupError,
  isSandboxNotFoundError,
  type E2BDesktopCreateOptions,
  type E2BDesktopModule,
  type E2BDesktopSandbox,
} from "./sdk.js";

/** Where an allocation's receipt goes: the run's prepared root, under a public-safe lane label. */
interface E2BSandboxReceiptTarget {
  root: PreparedOutputRoot;
  laneId: string;
  /** Clock for the receipt's `at`; defaults to Date.now. */
  now?: () => number;
}

export interface E2BSandboxRequest {
  module: E2BDesktopModule;
  options: E2BDesktopCreateOptions;
  retry?: TransientRetryHooks;
  /**
   * Required so every caller decides. `null` is only for a caller that could not open a journal;
   * that sandbox is reclaimable by its create-time `timeoutMs` alone.
   */
  receipt: E2BSandboxReceiptTarget | null;
}

export interface E2BSandbox {
  /** The mutable SDK handle. Provisioning hooks receive it and may change it. */
  sandbox: E2BDesktopSandbox;
  /** The exact id and release authority, captured before any hook sees the handle. */
  allocation: OwnedDesktopAllocation;
}

/** A desktop sandbox, on the stock `desktop` template or a named one. */
export function acquireE2BDesktopSandbox(
  request: E2BSandboxRequest & { template?: string | undefined },
): Promise<E2BSandbox> {
  return acquire(request, request.template);
}

/** The terminal route's shell sandbox. It always runs on the stock template. */
export function acquireE2BShellSandbox(request: E2BSandboxRequest): Promise<E2BSandbox> {
  return acquire(request, undefined);
}

async function acquire(
  request: E2BSandboxRequest,
  template: string | undefined,
): Promise<E2BSandbox> {
  const { module, options } = request;
  // Without a template the SDK's one-argument create chooses its stock desktop template.
  const sandbox = await withOneRetryOnTransientE2BError(
    () =>
      template === undefined
        ? module.Sandbox.create(options)
        : module.Sandbox.create(template, options),
    request.retry,
  );
  const allocation = ownE2BSandbox(module, sandbox.sandboxId);
  try {
    if (request.receipt !== null) {
      const { root, laneId, now = Date.now } = request.receipt;
      // Best effort by contract: a failed write leaves the TTL as the only backstop and never
      // fails the lane.
      await appendSandboxReceipt(root, {
        at: new Date(now()).toISOString(),
        laneId,
        provider: "e2b",
        sandboxId: allocation.resourceId,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    }
  } catch (error) {
    // The caller never receives this sandbox, so release it here. A throwing or invalid injected
    // clock is the known case.
    await allocation.close();
    throw error;
  }
  return { sandbox, allocation };
}

type SandboxKill = NonNullable<E2BDesktopModule["Sandbox"]["kill"]>;

/** The provider's kill method bound to its class, or undefined when the SDK has none. */
function boundKill(module: E2BDesktopModule): SandboxKill | undefined {
  return typeof module.Sandbox.kill === "function"
    ? module.Sandbox.kill.bind(module.Sandbox)
    : undefined;
}

/**
 * Kill one sandbox by exact id and read the answer in the release vocabulary both callers share.
 * The SDK resolves false for an id it no longer knows, and a not-found error means the same.
 * Any other answer is an incompatible response and cannot prove release. Never list the account.
 */
async function killById(
  kill: SandboxKill | undefined,
  sandboxId: string,
  options: { requestTimeoutMs: number },
): Promise<Exclude<DesktopReleaseResult, { status: "retained" }>> {
  if (kill === undefined) return { status: "unconfirmed", reason: "release_unavailable" };
  try {
    const result: unknown = await kill(sandboxId, options);
    if (result === true) return { status: "released", reason: "terminated" };
    if (result === false) return { status: "released", reason: "already_gone" };
    return { status: "unconfirmed", reason: "invalid_result" };
  } catch (error) {
    if (
      isSandboxNotFoundError(error) ||
      /not.?found|does not exist|404/i.test(toErrorMessage(error))
    )
      return { status: "released", reason: "already_gone" };
    return { status: "unconfirmed", reason: "release_failed", error };
  }
}

function ownE2BSandbox(module: E2BDesktopModule, resourceId: string): OwnedDesktopAllocation {
  // Bind the provider method now, before any hook can replace it on the shared module.
  const kill = boundKill(module);
  return ownDesktopAllocation({
    resourceId,
    release: () => killById(kill, resourceId, { requestTimeoutMs: 60_000 }),
  });
}

/** Reclaim's persisted outcome; run/reclaim.ts writes these strings. */
export type E2BSandboxDestroyOutcome =
  | { state: "killed" | "already-gone" }
  | { state: "kill-failed"; detail: string };

/**
 * Kill one sandbox by its exact recorded id, for reclaim, and map the shared release result onto
 * reclaim's persisted outcome. It never lists the account.
 */
export async function destroyE2BSandbox(
  module: E2BDesktopModule,
  sandboxId: string,
  options: { requestTimeoutMs: number },
): Promise<E2BSandboxDestroyOutcome> {
  const released = await killById(boundKill(module), sandboxId, options);
  if (released.status === "released")
    return { state: released.reason === "terminated" ? "killed" : "already-gone" };
  switch (released.reason) {
    case "release_unavailable":
      return {
        state: "kill-failed",
        detail:
          "installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox",
      };
    case "invalid_result":
      return {
        state: "kill-failed",
        detail: "Sandbox.kill returned neither true nor false, so the kill is unconfirmed",
      };
    case "release_failed":
      return { state: "kill-failed", detail: redactText(toErrorMessage(released.error)) };
  }
}

/** Versioned public template built by runtime/browser-media/e2b-template.mjs. */
export const E2B_SPEECH_TEMPLATE = "7409n13kr83f7g7abx5g";

/** The desktop template a lab asks for; undefined selects the SDK default. */
export function e2bDesktopTemplate(config: LabConfig): string | undefined {
  if (config.execution?.target === "local") return undefined;
  return (
    config.execution?.desktop?.template ??
    (config.execution?.desktop?.media?.microphone?.source === "speech"
      ? E2B_SPEECH_TEMPLATE
      : undefined)
  );
}

/** How a caller hears about the one retry; `sleep` is injectable so tests never wait. */
export interface TransientRetryHooks {
  onRetry?: (reason: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Wall-clock pause before the single retry; envd routing settles within a few seconds. */
export const TRANSIENT_RETRY_DELAY_MS = 3_000;

/**
 * The provider errors worth one retry, by the message the SDK throws. Each is a gap that clears
 * within seconds of sandbox creation:
 *
 * - `12: [unimplemented] HTTP 404` and `[unavailable]`: the sandbox exists but its envd is not
 *   routable yet, so the first request (the desktop SDK's Xvfb start) hits the proxy instead.
 * - `Cannot read properties of undefined (reading 'envdVersion')` / `Response data is missing`:
 *   the create API answered without a body.
 * - `Expected to receive information about written file`: a file write the envd accepted without
 *   describing, the same routing gap seen from the upload side.
 * - transport resets (`fetch failed`, `ECONNRESET`, `socket hang up`, 502/503/504).
 *
 * NOT retried: timeouts (the budget is spent), auth (401/403), quota and rate limits (429: a burst
 * that hit the limit should be spaced, not repeated), and anything that names the request as wrong.
 */
export function isTransientE2BError(error: unknown): boolean {
  if (error instanceof E2BDesktopStartupError && error.cleanup === "unconfirmed") return false;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  if (/timeout|timed out|deadline/i.test(message)) return false;
  if (/\b(401|403|429)\b|unauthorized|forbidden|rate limit|quota/i.test(message)) return false;
  return /\[unimplemented\]|\[unavailable\]|HTTP 404|HTTP 50[234]|\b50[234]\b|reading 'envdVersion'|Response data is missing|Expected to receive information about written file|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|UND_ERR/i.test(
    message,
  );
}

/**
 * Run `attempt`; on a transient provider error, say so through `onRetry`, wait, and run it once
 * more. A second failure, or a non-transient first one, propagates as is. The first attempt may
 * have allocated a sandbox this process never learned the id of (the SDK throws after the API
 * call); the provider's own `timeoutMs` on that sandbox is what reclaims it, which the caller's
 * warning should say.
 */
export async function withOneRetryOnTransientE2BError<T>(
  attempt: () => Promise<T>,
  hooks?: TransientRetryHooks,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isTransientE2BError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    hooks?.onRetry?.(reason);
    await (
      hooks?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    )(TRANSIENT_RETRY_DELAY_MS);
    return attempt();
  }
}
