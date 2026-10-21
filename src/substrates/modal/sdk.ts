// The optional `modal` peer: a lazy loader and the structural subset of its JavaScript SDK that
// humanish calls. Like @e2b/desktop it stays out of the published tarball, and these interfaces
// keep its types out of humanish's own declarations.

import { desktopPeerAdvice, humanishInstall } from "../e2b/peer-install.js";

/** Which Modal workspace and environment a call reaches. */
export interface ModalConnection {
  tokenId: string;
  tokenSecret: string;
  /** Modal's own default environment is used when unset. */
  environment?: string;
}

/** The variables a Modal connection is read from, as Modal's own CLI and SDK name them. */
export const MODAL_TOKEN_ID_ENV = "MODAL_TOKEN_ID";
export const MODAL_TOKEN_SECRET_ENV = "MODAL_TOKEN_SECRET";
const MODAL_ENVIRONMENT_ENV = "MODAL_ENVIRONMENT";

/**
 * The connection an env names, or undefined when either token is missing. The SDK would otherwise
 * fall back to process.env and ~/.modal.toml, which a library caller's env may not match, and a
 * release could then reach another workspace than the create.
 */
export function modalConnection(
  env: Readonly<Record<string, string | undefined>>,
): ModalConnection | undefined {
  const tokenId = env[MODAL_TOKEN_ID_ENV]?.trim();
  const tokenSecret = env[MODAL_TOKEN_SECRET_ENV]?.trim();
  if (!tokenId || !tokenSecret) return undefined;
  const environment = env[MODAL_ENVIRONMENT_ENV]?.trim();
  return { tokenId, tokenSecret, ...(environment ? { environment } : {}) };
}

export interface ModalReadStream extends AsyncIterable<string | Uint8Array> {
  readText(): Promise<string>;
  readBytes(): Promise<Uint8Array>;
}

export interface ModalProcess {
  stdout: ModalReadStream;
  stderr: ModalReadStream;
  stdin: {
    writeText(text: string): Promise<void>;
    writeBytes(bytes: Uint8Array): Promise<void>;
    /** End of input after what was written. */
    close(): Promise<void>;
  };
  /** End of input at offset 0: it ends input only before anything was written. */
  closeStdin(): Promise<void>;
  wait(): Promise<number>;
}

export interface ModalExecParams {
  mode?: "text" | "binary";
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
  workdir?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ModalSandbox {
  readonly sandboxId: string;
  exec(command: string[], params?: ModalExecParams): Promise<ModalProcess>;
  terminate(): Promise<void>;
  /** The exit code once the sandbox has finished, null while it runs. */
  poll(): Promise<number | null>;
  /** Resolves with the exit code once the sandbox has finished. */
  wait(): Promise<number>;
  getTags(): Promise<Record<string, string>>;
  tunnels(timeoutMs?: number): Promise<Record<number, { url: string }>>;
  /** A URL to `port` and a token Modal's proxy requires as `Authorization: Bearer <token>`. */
  createConnectToken(params?: { port?: number }): Promise<{ url: string; token: string }>;
}

export interface ModalSandboxCreateParams {
  cpu?: number;
  memoryMiB?: number;
  timeoutMs?: number;
  workdir?: string;
  env?: Record<string, string>;
  encryptedPorts?: number[];
  blockNetwork?: boolean;
  outboundCidrAllowlist?: string[];
  outboundDomainAllowlist?: string[];
  runtime?: "gvisor" | "vm";
  tags?: Record<string, string>;
}

export interface ModalImage {
  dockerfileCommands(commands: string[]): ModalImage;
}

export interface ModalClient {
  apps: {
    fromName(
      name: string,
      params?: { environment?: string; createIfMissing?: boolean },
    ): Promise<{ appId: string }>;
  };
  images: { fromRegistry(tag: string): ModalImage };
  sandboxes: {
    create(
      app: { appId: string },
      image: ModalImage,
      params?: ModalSandboxCreateParams,
    ): Promise<ModalSandbox>;
    fromId(sandboxId: string): Promise<ModalSandbox>;
    list(params?: {
      appId?: string;
      tags?: Record<string, string>;
      environment?: string;
    }): AsyncIterable<ModalSandbox>;
  };
  close?(): void;
}

export interface ModalModule {
  ModalClient: new (params: ModalConnection) => ModalClient;
}

export async function loadModalModule(): Promise<ModalModule> {
  try {
    return (await import("modal")) as unknown as ModalModule;
  } catch (error) {
    const value = error as { code?: string; message?: string };
    if (value.code === "ERR_MODULE_NOT_FOUND" && value.message?.includes("'modal'") === true) {
      const { where, advice } = desktopPeerAdvice(humanishInstall(), "modal");
      throw new Error(`Running on Modal requires the optional peer modal${where}. ${advice}`);
    }
    throw error;
  }
}

/**
 * `error` with the connection's tokens replaced in its message and stack. The SDK can quote a
 * token, for instance when gRPC refuses one with a stray zero-width character as metadata, and a
 * provider error reaches run warnings and reclaim receipts.
 */
export function withoutTokens(error: unknown, connection: ModalConnection): unknown {
  if (!(error instanceof Error)) return error;
  const tokens = [connection.tokenId, connection.tokenSecret];
  const hide = (text: string) =>
    tokens.reduce((hidden, token) => hidden.replaceAll(token, "[REDACTED_MODAL_TOKEN]"), text);
  error.message = hide(error.message);
  if (error.stack !== undefined) error.stack = hide(error.stack);
  return error;
}

/**
 * Whether `error` is Modal's answer that no sandbox has this id: a gRPC NOT_FOUND (code 5), which
 * the SDK raises from the first call on a handle `fromId` returned for an unknown id.
 */
export function isModalNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = error as { name?: unknown; code?: unknown };
  return value.name === "NotFoundError" || value.code === 5;
}

/** Modal ends a sandbox after 24 hours on every plan. */
export const MODAL_MAX_SANDBOX_MS = 24 * 60 * 60_000;
