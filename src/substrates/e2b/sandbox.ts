// E2B sandbox acquisition and release. Every route that allocates an E2B sandbox calls this module,
// so each allocation runs the same steps in the same order: create, one retry on a transient
// provider error, capture of the exact id and kill authority, and a provider-qualified receipt in
// the run directory before the caller gets the handle. The desktop startup guard
// (guardDesktopSandboxCreate) is installed by loadE2BDesktopModule, so a create whose desktop
// startup fails has already reclaimed its handle when the error reaches the retry here.
import { redactText } from "../../evidence/redaction.js";
import { appendSandboxReceipt } from "../../run/sandbox-receipts.js";
import type { PreparedOutputRoot } from "../../run/selected-output-paths.js";
import { toErrorMessage } from "../command-failure.js";
import { ownDesktopAllocation, type OwnedDesktopAllocation } from "../desktop-session.js";
import {
  withOneRetryOnTransientE2BError,
  type E2BDesktopCreateOptions,
  type E2BDesktopModule,
  type E2BDesktopSandbox,
  type TransientRetryHooks,
} from "./desktop-launch.js";

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
   * Required so every caller decides. `null` is only for a caller with no run directory; that
   * sandbox is reclaimable by its create-time `timeoutMs` alone.
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
  // Without a template this is the historical `Sandbox.create(options)` call, byte for byte.
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

function ownE2BSandbox(module: E2BDesktopModule, resourceId: string): OwnedDesktopAllocation {
  // Bind the provider method now, before any hook can replace it on the shared module.
  const kill =
    typeof module.Sandbox.kill === "function"
      ? module.Sandbox.kill.bind(module.Sandbox)
      : undefined;
  return ownDesktopAllocation({
    resourceId,
    release: async () => {
      if (kill === undefined) return { status: "unconfirmed", reason: "release_unavailable" };
      const result = await kill(resourceId, { requestTimeoutMs: 60_000 });
      // SDK false means 404/already absent, not an unconfirmed request. Anything else is
      // an incompatible response and cannot prove release. Never list the account.
      if (result === true) return { status: "released", reason: "terminated" };
      if (result === false) return { status: "released", reason: "already_gone" };
      return { status: "unconfirmed", reason: "invalid_result" };
    },
  });
}

export type E2BSandboxDestroyOutcome =
  | { state: "killed" | "already-gone" }
  | { state: "kill-failed"; detail: string };

/**
 * Kill one sandbox by its exact recorded id, for reclaim. It never lists the account. A lane's own
 * release goes through its allocation instead, which also refuses a malformed kill result.
 */
export async function destroyE2BSandbox(
  module: E2BDesktopModule,
  sandboxId: string,
  options: { requestTimeoutMs: number },
): Promise<E2BSandboxDestroyOutcome> {
  const kill = module.Sandbox.kill;
  if (typeof kill !== "function") {
    return {
      state: "kill-failed",
      detail:
        "installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox",
    };
  }
  try {
    const killed = (await kill.call(module.Sandbox, sandboxId, options)) === true;
    return { state: killed ? "killed" : "already-gone" };
  } catch (error) {
    const detail = redactText(toErrorMessage(error));
    return /not.?found|does not exist|404/i.test(detail)
      ? { state: "already-gone" }
      : { state: "kill-failed", detail };
  }
}
