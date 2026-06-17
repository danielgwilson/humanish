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

export interface E2BDesktopModule {
  Sandbox: {
    create(options: E2BDesktopCreateOptions): Promise<E2BDesktopSandbox>;
    kill?(sandboxId: string, options?: { requestTimeoutMs?: number }): Promise<unknown>;
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

export interface E2BDesktopCreateOptions {
  apiKey: string;
  dpi?: number;
  envs?: Record<string, string>;
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
    return await import("@e2b/desktop") as unknown as E2BDesktopModule;
  } catch (error) {
    if (isMissingE2BDesktopDependency(error)) {
      throw new Error(
        "Live E2B desktop launch requires optional peer dependency @e2b/desktop. Install it in this project with `npm i -D @e2b/desktop`, or run `mimetic lab run oss --dry-run`."
      );
    }

    throw error;
  }
}

export function isMissingE2BDesktopDependency(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return value.code === "ERR_MODULE_NOT_FOUND" && value.message?.includes("@e2b/desktop") === true;
}
