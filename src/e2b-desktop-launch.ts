// Shared E2B desktop substrate: the optional-peer loader + the structural interfaces for the
// real @e2b/desktop Sandbox. Hoisted out of oss-meta-lab.ts so both the OSS meta-lab and the
// computer-use lab (cua-actor-lab.ts) launch desktops through one seam (the peer dep is
// optional and lazily loaded, so neither path pulls @e2b/desktop into the published tarball
// or CI).
//
// E2BDesktopSandbox stays shape-compatible with what the meta path has always used (so meta is
// unchanged); `open` is declared optional because older SDKs may lack it (the CUA lab falls
// back to launch). The CUA executor needs the additional mouse/keyboard methods (E2BDesktopLike
// in e2b-desktop-executor.ts); the live Sandbox has them, so the CUA call site casts the
// launched sandbox to E2BDesktopLike rather than widening this interface across the whole
// meta file.

import { sep } from "node:path";
import { fileURLToPath } from "node:url";

import { protectDesktopScreenshotCleanup } from "./e2b-desktop-screenshot-cleanup.js";

export interface E2BDesktopModule {
  Sandbox: {
    /** Default `desktop` template (no custom image). The historical, byte-stable call shape. */
    create(options: E2BDesktopCreateOptions): Promise<E2BDesktopSandbox>;
    /**
     * Launch on a CUSTOM E2B desktop template (image) by NAME or ID — the SDK's
     * `Sandbox.create(template, opts)` overload. Lets a lab run on an adopter-maintained image
     * with extra runtimes baked in (e.g. node/bun/a local Postgres the stock `desktop` template
     * lacks), instead of the stock template. The base @e2b/desktop SDK implements this; the
     * wrapper just exposes it. Threaded from `execution.desktop.template`.
     */
    create(template: string, options: E2BDesktopCreateOptions): Promise<E2BDesktopSandbox>;
    /**
     * Kill the sandbox specified by exact id. Returns true iff THAT sandbox was found and
     * killed, false otherwise (the SDK's own doc comment). This boolean is the PRIMARY by-id
     * cleanup proof: a caller never needs to re-list to confirm reclamation.
     */
    kill?(sandboxId: string, options?: { requestTimeoutMs?: number }): Promise<boolean>;
    /**
     * Fetch ONE sandbox by its exact id (never account-wide). Throws a SandboxNotFoundError-
     * shaped error (see isSandboxNotFoundError below) when the id no longer exists; that thrown
     * error IS the by-id confirmation that a killed sandbox is gone. Optional: older SDKs may
     * lack it, so callers fall back to kill()'s own boolean rather than ever calling Sandbox.list.
     */
    getInfo?(sandboxId: string, options?: { requestTimeoutMs?: number }): Promise<E2BSandboxInfo>;
    /**
     * ACCOUNT-WIDE enumeration. Kept only for the routes that already avoid it for cleanup
     * (shared-world/scripted/cua/preflight kill by exact id and never call this); no cleanup
     * proof in this codebase should call it (see e2b-terminal-lab.ts teardownSandbox and
     * oss-meta-lab.ts, both of which reclaim and verify by id, never by listing).
     */
    list?(options: E2BSandboxListOptions): E2BSandboxPaginator;
  };
}

export interface E2BSandboxListOptions {
  metadata?: Record<string, string>;
  requestTimeoutMs?: number;
}

export interface E2BSandboxInfo {
  id?: string;
  metadata?: Record<string, string>;
  sandboxID?: string;
  sandboxId?: string;
  state?: string;
}

export interface E2BSandboxPaginator {
  hasNext: boolean;
  nextItems(options?: { requestTimeoutMs?: number }): Promise<E2BSandboxInfo[]>;
}

/** Sandbox egress policy. Domain filtering works for HTTP on :80 (Host header) and TLS on :443
 *  (SNI); other ports need IPs. Passed straight through to the E2B SDK's `network` option. */
export interface E2BNetworkOptions {
  /** Hosts (or CIDRs) the sandbox may reach. Wildcards like `*.example.com` cover subdomains at
   *  any depth; the apex is separate and needs its own entry. */
  allowOut?: string[];
  /** Denied traffic. `["0.0.0.0/0"]` with a populated allowOut is the deny-all-but shape. */
  denyOut?: string[];
  /** Static per-host HTTPS header transforms (E2B network rules). Header values override the
   *  outbound request's values. These may contain secrets: never persist or log this object.
   *  This is a structural subset of the installed SDK's SandboxNetworkRules contract. */
  rules?: Record<string, { transform?: { headers?: Record<string, string> } }[]>;
}

export interface E2BDesktopCreateOptions {
  apiKey: string;
  dpi?: number;
  envs?: Record<string, string>;
  /** Routing and optional header transforms; absent allowOut/denyOut retains unrestricted egress. */
  network?: E2BNetworkOptions;
  lifecycle?: {
    onTimeout: "kill" | "pause";
  };
  metadata?: Record<string, string>;
  requestTimeoutMs?: number;
  resolution?: [number, number];
  timeoutMs?: number;
}

export interface E2BCommandRunOptions {
  background?: false;
  cwd?: string;
  envs?: Record<string, string>;
  onStderr?: (data: string) => void | Promise<void>;
  onStdout?: (data: string) => void | Promise<void>;
  requestTimeoutMs?: number;
  timeoutMs?: number;
}

export interface E2BCommandResult {
  error?: string;
  exitCode?: number;
  stderr?: string;
  stdout?: string;
}

export interface E2BDesktopSandbox {
  sandboxId: string;
  /** Read the owned allocation's actual resources; available on the current E2B SDK. */
  getInfo?(options?: { requestTimeoutMs?: number; signal?: AbortSignal }): Promise<{ cpuCount?: number; memoryMB?: number }>;
  commands: {
    run(command: string, options?: E2BCommandRunOptions): Promise<E2BCommandResult>;
  };
  files: {
    write(path: string, data: string | ArrayBuffer, options?: {
      requestTimeoutMs?: number;
      useOctetStream?: boolean;
    }): Promise<unknown>;
  };
  launch(application: string, uri?: string): Promise<void>;
  /** Open a file or URL with the desktop's default application (present on @e2b/desktop >= 1.x). */
  open?(fileOrUrl: string): Promise<void>;
  /**
   * Map an in-sandbox port to a reachable host URL — `https://<port>-<sandboxId>.e2b.app`,
   * TOKENLESS (no authKey, unlike `stream.getUrl`). The base `e2b` SDK (v2.27.0) implements this;
   * the wrapper just exposes it. Used by the CONCURRENT shared-world topology (#164 phase 2) to
   * expose the ONE subject service plane to N actor sandboxes. Optional: older SDKs may lack it, so
   * the concurrent backend fails closed when it is absent rather than calling a missing method.
   */
  getHost?(port: number): string;
  screenshot(format?: "bytes"): Promise<Uint8Array>;
  wait(ms: number): Promise<void>;
  stream: {
    getAuthKey(): string;
    getUrl(options?: {
      authKey?: string;
      autoConnect?: boolean;
      resize?: "off" | "scale" | "remote";
      viewOnly?: boolean;
    }): string;
    start(options?: {
      requireAuth?: boolean;
      windowId?: string;
    }): Promise<void>;
  };
}

export async function loadE2BDesktopModule(): Promise<E2BDesktopModule> {
  try {
    return guardDesktopSandboxCreate(await import("@e2b/desktop") as unknown as E2BDesktopModule);
  } catch (error) {
    if (isMissingE2BDesktopDependency(error)) {
      throw new Error(
        runningFromProject()
          ? "Live E2B desktop launch requires the optional peer @e2b/desktop. Install it beside humanish "
            + "in this project: `npm i -D @e2b/desktop`."
          : "Live E2B desktop launch requires the optional peer @e2b/desktop, and humanish is running from an "
            + "npx cache rather than from this project — so installing the peer here cannot help, because Node "
            + "resolves it relative to humanish itself. Install BOTH into the project and run it from there: "
            + "`npm i -D humanish @e2b/desktop` then `npx humanish run <lab>`."
      );
    }

    throw error;
  }
}

export const DESKTOP_CREATE_CLEANUP_TIMEOUT_MS = 10_000;

type DesktopCreateCleanup = "killed" | "already_gone" | "unconfirmed";
type OwnedDesktop = E2BDesktopSandbox & {
  kill(options: { requestTimeoutMs: number; signal: AbortSignal }): Promise<boolean>;
};
type DesktopSdkClass = E2BDesktopModule["Sandbox"] & {
  new (...args: unknown[]): OwnedDesktop;
};

/** Startup failed after this call acquired a handle. No credentials/options are included here. */
export class E2BDesktopStartupError extends Error {
  constructor(error: unknown, readonly cleanup: DesktopCreateCleanup) {
    const detail = error instanceof Error ? error.message : String(error);
    const cleanupNote = cleanup === "killed"
      ? "the allocated sandbox was reclaimed"
      : cleanup === "already_gone"
        ? "the allocated sandbox was already gone"
        : "cleanup of the allocated sandbox was not confirmed; no retry is allowed and its provider timeout remains the backstop";
    super(`Desktop startup failed after allocation; ${cleanupNote}. ${detail}`, { cause: error });
    this.name = "E2BDesktopStartupError";
  }
}

/**
 * Preserve ownership before the desktop SDK starts Xvfb/XFCE (#581). Its public generic create
 * constructs `new this(...)` through the base SDK, then awaits desktop startup without a catch.
 * Each call gets a separate subclass/closure so concurrent attempts cannot exchange handles.
 *
 * This deliberately depends on SDK construction order, not a copied private `_start` method.
 * The real installed SDK's debug-mode conformance test must pass on dependency updates: the
 * constructor must run before bootstrap and public create must preserve its subclass type.
 * Failures before a constructor returns still have no acquired handle and remain unproven.
 */
export function guardDesktopSandboxCreate(module: E2BDesktopModule): E2BDesktopModule {
  const SdkSandbox = module.Sandbox as DesktopSdkClass;
  class GuardedSandbox extends SdkSandbox {
    static override async create(
      templateOrOptions: string | E2BDesktopCreateOptions,
      options?: E2BDesktopCreateOptions
    ): Promise<E2BDesktopSandbox> {
      let cleanupOwned: OwnedDesktop["kill"] | undefined;
      const CallingSandbox = this;
      class AttemptSandbox extends CallingSandbox {
        constructor(...args: unknown[]) {
          super(...args);
          cleanupOwned = this.kill.bind(this);
        }
      }
      try {
        const args = typeof templateOrOptions === "string" ? [templateOrOptions, options] : [templateOrOptions];
        const desktop = await Reflect.apply(SdkSandbox.create, AttemptSandbox, args) as E2BDesktopSandbox;
        // The loader also serves direct Sandbox.create callers (terminal/legacy meta routes).
        return protectDesktopScreenshotCleanup(desktop);
      } catch (error) {
        if (cleanupOwned === undefined) throw error;
        const createOptions = typeof templateOrOptions === "string" ? options : templateOrOptions;
        const requestedTimeout = createOptions?.requestTimeoutMs;
        const timeoutMs = requestedTimeout !== undefined && Number.isFinite(requestedTimeout) && requestedTimeout > 0
          ? Math.min(requestedTimeout, DESKTOP_CREATE_CLEANUP_TIMEOUT_MS)
          : DESKTOP_CREATE_CLEANUP_TIMEOUT_MS;
        const cleanup = await reclaimFailedDesktopCreate(cleanupOwned, timeoutMs);
        throw new E2BDesktopStartupError(error, cleanup);
      }
    }
  }
  return { ...module, Sandbox: GuardedSandbox };
}

async function reclaimFailedDesktopCreate(
  kill: OwnedDesktop["kill"], timeoutMs: number
): Promise<DesktopCreateCleanup> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      kill({ requestTimeoutMs: timeoutMs, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("desktop create cleanup deadline reached"));
        }, timeoutMs);
      })
    ]);
    // The installed SDK documents false as an exact-id 404: already absent is also reclaimed.
    return result === true ? "killed" : result === false ? "already_gone" : "unconfirmed";
  } catch {
    // Do not serialize cleanup options, connection state, or provider errors that may echo auth.
    return "unconfirmed";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Is humanish running from this project's node_modules, or from an npx cache?
 *
 * It decides which advice is TRUE. `npx humanish@latest` resolves its optional peer relative to
 * ITSELF, so "install @e2b/desktop in this project" is advice that cannot work there — and that
 * message cost two cold verification runs before the difference was noticed. A one-shot npx
 * invocation cannot do a live desktop run at all; humanish has to be installed alongside the peer.
 */
function runningFromProject(): boolean {
  const here = fileURLToPath(import.meta.url);
  return here.startsWith(`${process.cwd()}${sep}node_modules${sep}`);
}

export function isMissingE2BDesktopDependency(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return value.code === "ERR_MODULE_NOT_FOUND" && value.message?.includes("@e2b/desktop") === true;
}

/**
 * Detect a SandboxNotFoundError-shaped error from the real @e2b/desktop SDK, WITHOUT importing
 * its class (this module stays optional-peer / lazily-loaded, same as everything else here).
 * The real SDK sets `this.name = "SandboxNotFoundError"` on the class (it extends the
 * deprecated NotFoundError), so checking `.name` is the stable, import-free detection contract.
 * The constructor-name fallback covers a bundler/transpile shape where `.name` was not copied
 * onto the instance. A thrown SandboxNotFoundError from Sandbox.getInfo(id) is the by-id proof
 * that the exact sandbox humanish created is gone (confirmed reclaimed), never a re-list.
 */
export function isSandboxNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = error as { name?: unknown; constructor?: { name?: unknown } };
  return value.name === "SandboxNotFoundError" || value.constructor?.name === "SandboxNotFoundError";
}

/**
 * Create an E2B desktop sandbox, optionally on a CUSTOM template (image). The ONE seam every
 * desktop-creating route calls so the default and custom-template paths are decided in a single
 * place.
 *
 * When `template` is undefined (the default — no `execution.desktop.template` configured), this is
 * BYTE-STABLE with the historical `Sandbox.create(options)` call: the stock `desktop` template, the
 * options object passed as the sole argument. When `template` is a non-empty name/id, it selects
 * the SDK's `Sandbox.create(template, options)` overload so the lab runs on an adopter's image.
 * The template (when set) is a public-safe label, never a secret.
 */
export async function createDesktopSandbox(
  module: E2BDesktopModule,
  options: E2BDesktopCreateOptions,
  template?: string,
  retry?: TransientRetryHooks
): Promise<E2BDesktopSandbox> {
  const create = () => (template === undefined ? module.Sandbox.create(options) : module.Sandbox.create(template, options));
  return withOneRetryOnTransientE2BError(create, retry);
}

/** How a caller hears about the one retry; `sleep` is injectable so tests never wait. */
export interface TransientRetryHooks {
  onRetry?: (reason: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Wall-clock pause before the single retry; envd routing settles within a few seconds. */
export const TRANSIENT_RETRY_DELAY_MS = 3_000;

/**
 * The provider errors worth exactly ONE retry, by the message the SDK throws. Measured
 * 2026-09-04: six lanes created within 100 s lost five to these three shapes, and a probe of the
 * same SDK a minute later created a sandbox, wrote 7 MB into it and killed it in 6 s.
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
    message
  );
}

/**
 * Run `attempt`; on a transient provider error, say so through `onRetry`, wait, and run it once
 * more. A second failure, or a non-transient first one, propagates as is. The first attempt may
 * have allocated a sandbox this process never learned the id of (the SDK throws after the API
 * call); the provider's own `timeoutMs` on that sandbox is what reclaims it, which the caller's
 * warning should say.
 */
export async function withOneRetryOnTransientE2BError<T>(attempt: () => Promise<T>, hooks?: TransientRetryHooks): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isTransientE2BError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    hooks?.onRetry?.(reason);
    await (hooks?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(TRANSIENT_RETRY_DELAY_MS);
    return attempt();
  }
}
