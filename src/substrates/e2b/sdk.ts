// Shared E2B desktop substrate: the optional-peer loader + the structural interfaces for the
// real @e2b/desktop Sandbox. Every desktop route launches through this one seam; the peer dep is
// optional and lazily loaded, so it stays out of the published tarball and CI.
//
// E2BDesktopSandbox is the command, file, stream, launch and input subset the participants use; `open` is
// optional because older SDKs lack it (the computer-use route then falls back to launch). It
// satisfies the executor's E2BDesktopLike port (src/substrates/e2b/desktop-executor.ts) as is.

import { protectDesktopScreenshotCleanup } from "./desktop-screenshot-cleanup.js";
import { desktopPeerAdvice, humanishInstall } from "./peer-install.js";

export interface E2BDesktopModule {
  Sandbox: {
    /** The stock `desktop` template (no custom image). */
    create(options: E2BDesktopCreateOptions): Promise<E2BDesktopSandbox>;
    /**
     * Launch on a custom E2B desktop template (image) by name or ID: the SDK's
     * `Sandbox.create(template, opts)` overload. Lets a study run on an adopter-maintained image
     * with extra runtimes baked in (e.g. node/bun/a local Postgres the stock `desktop` template
     * lacks), instead of the stock template. The base @e2b/desktop SDK implements this; the
     * wrapper just exposes it. Threaded from `execution.desktop.template`.
     */
    create(template: string, options: E2BDesktopCreateOptions): Promise<E2BDesktopSandbox>;
    /**
     * Kill the sandbox specified by exact id. Returns true iff that sandbox was found and
     * killed, false otherwise (the SDK's own doc comment). This boolean is the primary by-id
     * cleanup proof: a caller never needs to re-list to confirm reclamation.
     */
    kill?(sandboxId: string, options?: { requestTimeoutMs?: number }): Promise<boolean>;
    /**
     * Fetch one sandbox by its exact id (never account-wide). Throws a SandboxNotFoundError-
     * shaped error (see isSandboxNotFoundError below) when the id no longer exists; that thrown
     * error is the by-id confirmation that a killed sandbox is gone. Optional: older SDKs may
     * lack it, so callers fall back to kill()'s own boolean rather than ever calling Sandbox.list.
     */
    getInfo?(sandboxId: string, options?: { requestTimeoutMs?: number }): Promise<E2BSandboxInfo>;
  };
}

interface E2BSandboxInfo {
  id?: string;
  metadata?: Record<string, string>;
  sandboxID?: string;
  sandboxId?: string;
  state?: string;
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
  background?: boolean;
  stdin?: boolean;
  cwd?: string;
  envs?: Record<string, string>;
  onStderr?: (data: string) => void | Promise<void>;
  onStdout?: (data: string) => void | Promise<void>;
  requestTimeoutMs?: number;
  timeoutMs?: number;
}

export interface E2BCommandResult {
  /** Present on the installed SDK's background CommandHandle. */
  pid?: number;
  error?: string;
  exitCode?: number;
  stderr?: string;
  stdout?: string;
  /** Streaming command handle, returned only when background is true. */
  sendStdin?(data: string | Uint8Array, options?: { requestTimeoutMs?: number }): Promise<void>;
  closeStdin?(options?: { requestTimeoutMs?: number }): Promise<void>;
  kill?(): Promise<boolean>;
  wait?(): Promise<E2BCommandResult>;
}

export interface E2BDesktopSandbox {
  sandboxId: string;
  /** Read the owned allocation's actual resources; available on the current E2B SDK. */
  getInfo?(options?: {
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ cpuCount?: number; memoryMB?: number }>;
  commands: {
    run(command: string, options?: E2BCommandRunOptions): Promise<E2BCommandResult>;
  };
  files: {
    read?(
      path: string,
      options: {
        format: "stream";
        requestTimeoutMs?: number;
        streamIdleTimeoutMs?: number;
        signal?: AbortSignal;
      },
    ): Promise<import("node:stream/web").ReadableStream<Uint8Array>>;
    write(
      path: string,
      data: string | ArrayBuffer,
      options?: {
        requestTimeoutMs?: number;
        useOctetStream?: boolean;
      },
    ): Promise<unknown>;
  };
  launch(application: string, uri?: string): Promise<void>;
  /** Open a file or URL with the desktop's default application (present on @e2b/desktop >= 1.x). */
  open?(fileOrUrl: string): Promise<void>;
  /**
   * Map an in-sandbox port to a reachable host URL, `https://<port>-<sandboxId>.e2b.app`,
   * tokenless (no authKey, unlike `stream.getUrl`). The base `e2b` SDK (v2.27.0) implements this;
   * the wrapper just exposes it. Used by the concurrent shared-world topology to
   * expose the one subject service plane to N actor sandboxes. Optional: older SDKs may lack it, so
   * the concurrent backend fails closed when it is absent rather than calling a missing method.
   */
  getHost?(port: number): string;
  screenshot(format?: "bytes"): Promise<Uint8Array>;
  wait(ms: number): Promise<void>;
  // Mouse and keyboard input, as @e2b/desktop's Sandbox declares them. They make the sandbox an
  // E2BDesktopLike, the executor's port, without a cast.
  leftClick(x?: number, y?: number): Promise<void>;
  rightClick(x?: number, y?: number): Promise<void>;
  middleClick(x?: number, y?: number): Promise<void>;
  doubleClick(x?: number, y?: number): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  getCursorPosition?(): Promise<{ x: number; y: number }>;
  scroll(direction?: "up" | "down", amount?: number): Promise<void>;
  write(text: string): Promise<void>;
  press(key: string | string[]): Promise<void>;
  drag(from: [number, number], to: [number, number]): Promise<void>;
  stream: {
    getAuthKey(): string;
    getUrl(options?: {
      authKey?: string;
      autoConnect?: boolean;
      resize?: "off" | "scale" | "remote";
      viewOnly?: boolean;
    }): string;
    start(options?: { requireAuth?: boolean; windowId?: string }): Promise<void>;
  };
}

export async function loadE2BDesktopModule(): Promise<E2BDesktopModule> {
  try {
    return guardDesktopSandboxCreate((await import("@e2b/desktop")) as unknown as E2BDesktopModule);
  } catch (error) {
    if (isMissingE2BDesktopDependency(error)) {
      const { where, advice } = desktopPeerAdvice(humanishInstall());
      throw new Error(
        `Live E2B desktop launch requires the optional peer @e2b/desktop${where}. ${advice}`,
      );
    }

    throw error;
  }
}

export const DESKTOP_CREATE_CLEANUP_TIMEOUT_MS = 10_000;

type DesktopCreateCleanup = "killed" | "already_gone" | "unconfirmed";
interface DesktopCreateCleanupResult {
  cleanup: DesktopCreateCleanup;
  /** Why cleanup is unconfirmed, when the SDK answered but the answer proves nothing. */
  detail?: string;
}
type OwnedDesktop = E2BDesktopSandbox & {
  kill(options: { requestTimeoutMs: number; signal: AbortSignal }): Promise<boolean>;
};
type DesktopSdkClass = E2BDesktopModule["Sandbox"] & {
  new (...args: unknown[]): OwnedDesktop;
};

/** Startup failed after this call acquired a handle. No credentials/options are included here. */
export class E2BDesktopStartupError extends Error {
  constructor(
    error: unknown,
    readonly cleanup: DesktopCreateCleanup,
    readonly cleanupDetail?: string,
  ) {
    const detail = error instanceof Error ? error.message : String(error);
    const cleanupNote =
      cleanup === "killed"
        ? "the allocated sandbox was reclaimed"
        : cleanup === "already_gone"
          ? "the allocated sandbox was already gone"
          : `cleanup of the allocated sandbox was not confirmed${cleanupDetail === undefined ? "" : ` (${cleanupDetail})`}; no retry is allowed and its provider timeout remains the backstop`;
    super(`Desktop startup failed after allocation; ${cleanupNote}. ${detail}`, { cause: error });
    this.name = "E2BDesktopStartupError";
  }
}

/**
 * Preserve ownership before the desktop SDK starts Xvfb/XFCE. Its public generic create
 * constructs `new this(...)` through the base SDK, then awaits desktop startup. Newer SDKs
 * attempt their own kill before rejecting create; older SDKs leave cleanup to the caller.
 * Both paths share one bounded cleanup result so an internal kill cannot delay our deadline
 * or cause a second cleanup request. Successful creation restores normal kill semantics.
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
      options?: E2BDesktopCreateOptions,
    ): Promise<E2BDesktopSandbox> {
      const createOptions = typeof templateOrOptions === "string" ? options : templateOrOptions;
      const requestedTimeout = createOptions?.requestTimeoutMs;
      const timeoutMs =
        requestedTimeout !== undefined && Number.isFinite(requestedTimeout) && requestedTimeout > 0
          ? Math.min(requestedTimeout, DESKTOP_CREATE_CLEANUP_TIMEOUT_MS)
          : DESKTOP_CREATE_CLEANUP_TIMEOUT_MS;
      let cleanupOwned: (() => Promise<DesktopCreateCleanupResult>) | undefined;
      let restoreKill: (() => void) | undefined;
      // oxlint-disable-next-line typescript/no-this-alias -- the attempt subclasses whichever SDK class was called
      const CallingSandbox = this;
      class AttemptSandbox extends CallingSandbox {
        constructor(...args: unknown[]) {
          super(...args);
          const kill = this.kill.bind(this);
          const ownKill = Object.getOwnPropertyDescriptor(this, "kill");
          let receipt: Promise<DesktopCreateCleanupResult> | undefined;
          const reclaim = () => (receipt ??= reclaimFailedDesktopCreate(kill, timeoutMs));
          cleanupOwned = reclaim;
          // SDK 2.4 calls this method before create rejects. Keep its boolean contract while
          // recording unconfirmed cleanup independently of the SDK's catch-and-discard path.
          this.kill = async () => {
            const { cleanup } = await reclaim();
            if (cleanup === "unconfirmed")
              throw new Error("Desktop startup cleanup was not confirmed");
            return cleanup === "killed";
          };
          restoreKill = () => {
            if (ownKill) Object.defineProperty(this, "kill", ownKill);
            else Reflect.deleteProperty(this, "kill");
          };
        }
      }
      try {
        const args =
          typeof templateOrOptions === "string"
            ? [templateOrOptions, options]
            : [templateOrOptions];
        const desktop = (await Reflect.apply(
          SdkSandbox.create,
          AttemptSandbox,
          args,
        )) as E2BDesktopSandbox;
        restoreKill?.();
        // The loader also serves direct Sandbox.create callers, such as the terminal route.
        return protectDesktopScreenshotCleanup(desktop);
      } catch (error) {
        if (cleanupOwned === undefined) throw error;
        const { cleanup, detail } = await cleanupOwned();
        throw new E2BDesktopStartupError(error, cleanup, detail);
      }
    }
  }
  return { ...module, Sandbox: GuardedSandbox };
}

async function reclaimFailedDesktopCreate(
  kill: OwnedDesktop["kill"],
  timeoutMs: number,
): Promise<DesktopCreateCleanupResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The SDK reads the variable when the call starts, so read it at the same point.
  const debug = e2bDebugMode();
  try {
    const result = await Promise.race([
      kill({ requestTimeoutMs: timeoutMs, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("desktop create cleanup deadline reached"));
        }, timeoutMs);
      }),
    ]);
    // A true in debug mode sent no request, so it confirms nothing.
    if (result === true && debug) return { cleanup: "unconfirmed", detail: E2B_DEBUG_KILL_DETAIL };
    // The installed SDK documents false as an exact-id 404: already absent is also reclaimed.
    if (result === true) return { cleanup: "killed" };
    return { cleanup: result === false ? "already_gone" : "unconfirmed" };
  } catch {
    // Do not serialize cleanup options, connection state, or provider errors that may echo auth.
    return { cleanup: "unconfirmed" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isMissingE2BDesktopDependency(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return value.code === "ERR_MODULE_NOT_FOUND" && value.message?.includes("@e2b/desktop") === true;
}

/**
 * Detect a SandboxNotFoundError-shaped error from the real @e2b/desktop SDK, without importing
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
  return (
    value.name === "SandboxNotFoundError" || value.constructor?.name === "SandboxNotFoundError"
  );
}

/** The variable that puts the E2B SDK in debug mode. */
export const E2B_DEBUG_ENV = "E2B_DEBUG";

/**
 * Whether the E2B SDK runs in debug mode, read the way the SDK reads it when a call starts. In
 * debug mode `Sandbox.kill` returns true without sending a request to E2B, so a true confirms
 * nothing.
 */
export function e2bDebugMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[E2B_DEBUG_ENV]?.toLowerCase() === "true";
}

/** Why a kill that returned true in debug mode is unconfirmed. */
export const E2B_DEBUG_KILL_DETAIL = `${E2B_DEBUG_ENV}=true makes the E2B SDK return true from Sandbox.kill without contacting E2B`;
