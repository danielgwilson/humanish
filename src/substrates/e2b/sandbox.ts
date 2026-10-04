// E2B sandbox acquisition and release. Every route that allocates an E2B sandbox calls this module,
// so each allocation runs the same steps in the same order: register the create with the run's
// in-process registry, tag the sandbox with the run's owner tags, create, one retry on a transient
// provider error, capture of the exact id and kill authority, and a provider-qualified receipt in
// the run directory before the caller gets the handle. The desktop startup guard
// (guardDesktopSandboxCreate) is installed by loadE2BDesktopModule, so a create whose desktop
// startup fails has already reclaimed its handle when the error reaches the retry here, and it
// reports the id to the registry before desktop startup begins.
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import {
  beginSandboxCreate,
  recordSandboxOwnerOnce,
  SandboxCreateRefusedError,
  sandboxOwnerTags,
  type SandboxCreateTicket,
} from "../../run/sandbox-creates.js";
import { appendSandboxOwner, appendSandboxReceipt } from "../../run/sandbox-receipts.js";
import type { PreparedOutputRoot } from "../../run/contained-output.js";
import {
  ownDesktopAllocation,
  type DesktopReleaseResult,
  type OwnedDesktopAllocation,
} from "../desktop-session.js";
import type { StudyConfig } from "../../study/types.js";
import {
  E2B_DEBUG_KILL_DETAIL,
  E2BDesktopStartupError,
  e2bDebugMode,
  isSandboxNotFoundError,
  observeDesktopAllocation,
  type E2BDesktopCreateOptions,
  type E2BDesktopModule,
  type E2BDesktopSandbox,
  type E2BListedSandbox,
} from "./sdk.js";

/** Where an allocation's receipt goes: the run's prepared root, under a public-safe participant
 *  label. The receipt line saves it as `laneId`. */
interface E2BSandboxReceiptTarget {
  root: PreparedOutputRoot;
  participantId: string;
  /** Clock for the receipt's `at`; defaults to Date.now. */
  now?: () => number;
}

export interface E2BSandboxRequest {
  module: E2BDesktopModule;
  options: E2BDesktopCreateOptions;
  retry?: TransientRetryHooks;
  /**
   * Required so every caller decides. `null` is only for a caller that could not open a journal;
   * that sandbox carries no owner tags and is reclaimable by its create-time `timeoutMs` alone.
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
  const { module } = request;
  const target = request.receipt;
  // Refused before any provider call once the run is stopping.
  const ticket =
    target === null ? undefined : beginSandboxCreate(target.root, target.participantId);
  try {
    // The owner tags let reclaim find this sandbox on E2B even if its id never reaches this
    // process: a create that throws after E2B allocated, or a process that dies mid-create. The
    // journal records them first, so reclaim knows which tags to search for.
    const owner = target === null ? undefined : sandboxOwnerTags(target.root);
    if (target !== null && owner !== undefined)
      await recordSandboxOwnerOnce(target.root, () => appendSandboxOwner(target.root, owner));
    const options: E2BDesktopCreateOptions =
      owner === undefined
        ? request.options
        : { ...request.options, metadata: { ...request.options.metadata, ...owner } };
    if (ticket !== undefined)
      observeDesktopAllocation(options, (sandboxId) => ticket.created(sandboxId));
    const sandbox = await withOneRetryOnTransientE2BError(
      () => {
        if (ticket?.stopping()) throw new SandboxCreateRefusedError();
        // Without a template the SDK's one-argument create chooses its stock desktop template.
        return template === undefined
          ? module.Sandbox.create(options)
          : module.Sandbox.create(template, options);
      },
      { ...request.retry, canRetry: () => ticket?.stopping() !== true },
    );
    ticket?.created(sandbox.sandboxId);
    const allocation = ownE2BSandbox(module, sandbox.sandboxId, ticket);
    try {
      if (target !== null) {
        const { root, participantId, now = Date.now } = target;
        // Best effort by contract: a failed write leaves the owner tags and the TTL as the
        // backstops and never fails the participant.
        await appendSandboxReceipt(root, {
          at: new Date(now()).toISOString(),
          laneId: participantId,
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
  } finally {
    ticket?.settled();
  }
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
 * The SDK resolves false for an id it no longer knows (a 404), and a SandboxNotFoundError,
 * recognized by type, means the same. Every other throw is unconfirmed, whatever its message
 * says: the SDK answers a 404 with false before it throws, so "not found" or "404" in a thrown
 * message comes from some other failure, such as a trace id. A true in debug mode sent no
 * request, so it confirms nothing.
 */
async function killById(
  kill: SandboxKill | undefined,
  sandboxId: string,
  options: { requestTimeoutMs: number },
): Promise<Exclude<DesktopReleaseResult, { status: "retained" }>> {
  if (kill === undefined) return { status: "unconfirmed", reason: "release_unavailable" };
  // The SDK reads the variable when the call starts, so read it at the same point.
  const debug = e2bDebugMode();
  try {
    const result: unknown = await kill(sandboxId, options);
    if (result === true && debug)
      return {
        status: "unconfirmed",
        reason: "release_unavailable",
        detail: E2B_DEBUG_KILL_DETAIL,
      };
    if (result === true) return { status: "released", reason: "terminated" };
    if (result === false) return { status: "released", reason: "already_gone" };
    return { status: "unconfirmed", reason: "invalid_result" };
  } catch (error) {
    if (isSandboxNotFoundError(error)) return { status: "released", reason: "already_gone" };
    return { status: "unconfirmed", reason: "release_failed", error };
  }
}

function ownE2BSandbox(
  module: E2BDesktopModule,
  resourceId: string,
  ticket: SandboxCreateTicket | undefined,
): OwnedDesktopAllocation {
  // Bind the provider method now, before any hook can replace it on the shared module.
  const kill = boundKill(module);
  return ownDesktopAllocation({
    resourceId,
    release: async () => {
      const released = await killById(kill, resourceId, { requestTimeoutMs: 60_000 });
      // The signal handler skips a sandbox its route already released.
      if (released.status === "released") ticket?.released(resourceId);
      return released;
    },
  });
}

/** A route's reading of one sandbox release: whether it is gone, and the warning to record. */
export interface E2BReleaseReading {
  released: boolean;
  warning?: string;
}

/**
 * Read a release result the same way on every route. `label` names the sandbox in the warning
 * ("Sandbox", "Subject sandbox"). `costSpan` adds that desktop cost uses the observed span when
 * the sandbox was already gone, for routes that price its minutes. A retained sandbox is the
 * caller's to describe.
 */
export function readE2BRelease(
  result: DesktopReleaseResult,
  options: { label: string; scrub: (text: string) => string; costSpan?: boolean },
): E2BReleaseReading {
  const { label, scrub } = options;
  if (result.status === "retained") return { released: false };
  if (result.status === "released") {
    if (result.reason === "terminated") return { released: true };
    return {
      released: true,
      warning: `${label} was already absent when cleanup ran; its exact termination time is unknown.${
        options.costSpan ? " Desktop cost uses the observed acquisition-to-cleanup span." : ""
      }`,
    };
  }
  switch (result.reason) {
    case "release_unavailable":
      return {
        released: false,
        warning:
          result.detail === undefined
            ? `Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the ${label.toLowerCase()}.`
            : `${label} release is unconfirmed: ${result.detail}. If it exists, server-side kill-on-timeout will reclaim it.`,
      };
    case "release_failed":
      return {
        released: false,
        warning: `${label} teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrub(toErrorMessage(result.error)))}`,
      };
    case "invalid_result":
      return {
        released: false,
        warning: `${label} teardown returned an unexpected result; release is unconfirmed and server-side kill-on-timeout remains the backstop.`,
      };
  }
}

/** A release_unavailable result as one lowercase line, for routes and reclaim that report it. */
export function releaseUnavailableDetail(detail: string | undefined): string {
  return detail === undefined
    ? "installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox"
    : `${detail}; if the sandbox exists, server-side kill-on-timeout will reclaim it`;
}

/** Reclaim's persisted outcome; run/reclaim.ts writes these strings. */
export type E2BSandboxDestroyOutcome =
  | { state: "killed" | "already-gone" }
  | { state: "kill-failed"; detail: string };

/** Kill one sandbox by its exact id, for reclaim, and map the shared release result onto
 *  reclaim's persisted outcome. */
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
      return { state: "kill-failed", detail: releaseUnavailableDetail(released.detail) };
    case "invalid_result":
      return {
        state: "kill-failed",
        detail: "Sandbox.kill returned neither true nor false, so the kill is unconfirmed",
      };
    case "release_failed":
      return { state: "kill-failed", detail: redactText(toErrorMessage(released.error)) };
  }
}

/** What `reclaim --check` learned about one sandbox by its exact id. */
export type E2BSandboxPresence =
  | { state: "running" | "already-gone" }
  | { state: "check-failed"; detail: string };

/**
 * Ask E2B whether one sandbox still exists, by exact id. A SandboxNotFoundError, recognized by
 * type, means gone; any other error leaves the answer open.
 */
export async function inspectE2BSandbox(
  module: E2BDesktopModule,
  sandboxId: string,
  options: { requestTimeoutMs: number },
): Promise<E2BSandboxPresence> {
  if (typeof module.Sandbox.getInfo !== "function")
    return {
      state: "check-failed",
      detail: "the installed @e2b/desktop SDK has no Sandbox.getInfo",
    };
  try {
    await module.Sandbox.getInfo(sandboxId, options);
    return { state: "running" };
  } catch (error) {
    if (isSandboxNotFoundError(error)) return { state: "already-gone" };
    return { state: "check-failed", detail: redactText(toErrorMessage(error)) };
  }
}

/** What E2B listed for a run's owner tags. `sandboxes` holds exact matches only. */
export interface E2BTagSearch {
  status: "done" | "unavailable" | "failed";
  sandboxes: E2BListedSandbox[];
  detail?: string;
}

const TAG_SEARCH_PAGE_SIZE = 100;
// One run tags at most a few dozen sandboxes. More pages than this means the filter was not
// applied, and reading on would walk the whole account.
const TAG_SEARCH_MAX_PAGES = 3;

/**
 * List the sandboxes E2B matches to every one of `tags`, filtered server-side. Each result is
 * checked against every tag again, so a server that ignored the filter still cannot hand back
 * another run's sandbox, and the search stops after a few pages instead of walking the account.
 */
export async function findE2BSandboxesByTags(
  module: E2BDesktopModule,
  tags: Record<string, string>,
  options: { requestTimeoutMs: number },
): Promise<E2BTagSearch> {
  if (typeof module.Sandbox.list !== "function")
    return {
      status: "unavailable",
      sandboxes: [],
      detail: "the installed @e2b/desktop SDK has no Sandbox.list",
    };
  const sandboxes: E2BListedSandbox[] = [];
  try {
    const pages = module.Sandbox.list({
      query: { metadata: tags },
      limit: TAG_SEARCH_PAGE_SIZE,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    for (let page = 0; pages.hasNext; page += 1) {
      if (page === TAG_SEARCH_MAX_PAGES)
        return {
          status: "failed",
          sandboxes,
          detail: `E2B returned more than ${TAG_SEARCH_MAX_PAGES * TAG_SEARCH_PAGE_SIZE} sandboxes for one run's tags, so the search stopped before reading the rest`,
        };
      for (const listed of await pages.nextItems()) {
        const metadata = listed.metadata ?? {};
        if (Object.entries(tags).every(([key, value]) => metadata[key] === value))
          sandboxes.push(listed);
      }
    }
    return { status: "done", sandboxes };
  } catch (error) {
    return { status: "failed", sandboxes, detail: redactText(toErrorMessage(error)) };
  }
}

/** Versioned public template built by runtime/browser-media/e2b-template.mjs. */
export const E2B_SPEECH_TEMPLATE = "7409n13kr83f7g7abx5g";

/** The desktop template a study asks for; undefined selects the SDK default. */
export function e2bDesktopTemplate(config: {
  readonly execution?: Pick<NonNullable<StudyConfig["execution"]>, "target" | "desktop">;
}): string | undefined {
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
  /** False skips the retry, as when the run started stopping during the first attempt. */
  canRetry?: () => boolean;
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
 * Not retried: timeouts (the budget is spent), auth (401/403), quota and rate limits (429: a burst
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
    if (!isTransientE2BError(error) || hooks?.canRetry?.() === false) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    hooks?.onRetry?.(reason);
    await (
      hooks?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    )(TRANSIENT_RETRY_DELAY_MS);
    return attempt();
  }
}
