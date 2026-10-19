// Modal sandboxes behind the sandbox port the E2B routes already use (E2BDesktopModule and
// E2BDesktopSandbox in src/substrates/e2b/sdk.ts). acquire() in src/substrates/e2b/sandbox.ts,
// the receipts, the release by id and reclaim then work the same on both providers.
//
// Modal runs every exec as root and ignores the image's user setting, so each command drops to the
// sandbox user here, the account E2B runs commands as. Sandboxes use Modal's VM runtime: its
// default gVisor runtime sets no_new_privs on every process, so the user's sudo, which the Node
// bootstrap and product installs run, cannot work there.
import type {
  E2BCommandResult,
  E2BCommandRunOptions,
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
  E2BListedSandbox,
  E2BNetworkOptions,
} from "../e2b/sdk.js";
import type { E2BAccount } from "../e2b/connection.js";
import { MODAL_SANDBOX_USER, modalShellImage } from "./image.js";
import {
  isModalNotFoundError,
  loadModalModule,
  modalConnection,
  MODAL_TOKEN_ID_ENV,
  MODAL_TOKEN_SECRET_ENV,
  type ModalClient,
  type ModalConnection,
  type ModalImage,
  type ModalModule,
  type ModalSandbox,
  type ModalSandboxCreateParams,
  withoutTokens,
} from "./sdk.js";

/** The Modal App every humanish sandbox is created in, inside the connection's environment. */
const MODAL_APP_NAME = "humanish";

/** How long a release waits for Modal to report a terminated sandbox finished; about 130 ms seen. */
const TERMINATE_WAIT_MS = 30_000;

/** Modal takes sandbox and command timeouts in whole seconds; a shorter one is rounded up. */
const wholeSeconds = (ms: number): number => Math.ceil(ms / 1000) * 1000;

/** `fn`, with any error it throws stripped of the connection's tokens. */
function hidingTokens<A extends unknown[], R>(
  connection: ModalConnection,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw withoutTokens(error, connection);
    }
  };
}

/** E2B's commands.run default, kept so a caller that sets no timeout gets the same bound. */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
/** Modal's own default sandbox lifetime is 5 minutes, as E2B's is. */
const DEFAULT_SANDBOX_TIMEOUT_MS = 5 * 60_000;

/** The size and image of the sandboxes one module creates. */
export interface ModalSandboxProfile {
  image: (client: ModalClient) => ModalImage;
  /** Physical cores; Modal counts one core as two vCPU. */
  cpu: number;
  memoryMiB: number;
}

/** A Modal sandbox was asked for something only an E2B sandbox has. */
class ModalUnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} is not available on Modal sandboxes in this version of humanish.`);
    this.name = "ModalUnsupportedError";
  }
}

/**
 * A sandbox port over one Modal account. `create` maps E2B's create options onto Modal's; `kill`,
 * `getInfo` and `list` keep the E2B SDK's contracts, which release and reclaim read.
 */
export function modalSandboxModule(
  client: ModalClient,
  connection: ModalConnection,
  profile: ModalSandboxProfile,
): E2BDesktopModule {
  const humanishApp = appLookup(client, connection, true);

  // The E2B SDK's second overload names a template first; Modal sandboxes have no templates.
  async function create(
    templateOrOptions: string | E2BDesktopCreateOptions,
  ): Promise<E2BDesktopSandbox> {
    if (typeof templateOrOptions === "string")
      throw new ModalUnsupportedError("A desktop template");
    const options = templateOrOptions;
    const params: ModalSandboxCreateParams = {
      cpu: profile.cpu,
      memoryMiB: profile.memoryMiB,
      timeoutMs: wholeSeconds(options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS),
      runtime: "vm",
      workdir: MODAL_SANDBOX_USER.home,
      ...(options.envs === undefined ? {} : { env: { ...options.envs } }),
      ...(options.metadata === undefined ? {} : { tags: { ...options.metadata } }),
      ...modalNetwork(options.network),
    };
    const sandbox = await client.sandboxes.create(
      await humanishApp(),
      profile.image(client),
      params,
    );
    return modalSandboxHandle(sandbox, profile, connection);
  }

  return {
    Sandbox: {
      create: hidingTokens(connection, create),
      ...modalSandboxes(client, connection),
    },
  };
}

/** The humanish App in the connection's environment; only a create may make it. */
function appLookup(client: ModalClient, connection: ModalConnection, createIfMissing: boolean) {
  let app: Promise<{ appId: string }> | undefined;
  return () =>
    (app ??= client.apps.fromName(MODAL_APP_NAME, {
      ...(connection.environment === undefined ? {} : { environment: connection.environment }),
      createIfMissing,
    }));
}

/** A Modal request's default deadline, as E2B's SDK sets its own. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** How often a release asks whether a terminated sandbox has finished. */
const TERMINATE_POLL_MS = 500;

/**
 * `request`, or a rejection once `ms` pass. The SDK takes no deadline of its own, so a stalled
 * RPC would otherwise hold a release or reclaim with no end.
 */
async function within<T>(request: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Modal did not answer ${what} within ${ms} ms.`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The calls on sandboxes that already exist, with the E2B SDK's contracts: `kill` is true when it
 * ended a running sandbox and false when the sandbox was gone, `getInfo` throws an error named
 * SandboxNotFoundError for a gone id, and `list` filters by every given tag. None of them creates
 * anything, so `reclaim --check` stays read-only.
 */
export function modalSandboxes(
  client: ModalClient,
  connection: ModalConnection,
): Required<E2BAccount> {
  const existingApp = appLookup(client, connection, false);
  type Options = { requestTimeoutMs?: number } | undefined;
  const deadline = (options: Options) => options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  /** The sandbox's exit code, null while it runs, or undefined when Modal has no such id. */
  async function exitOf(sandboxId: string, ms: number): Promise<number | null | undefined> {
    try {
      const sandbox = await within(client.sandboxes.fromId(sandboxId), ms, "a sandbox lookup");
      return await within(sandbox.poll(), ms, "a sandbox poll");
    } catch (error) {
      if (isModalNotFoundError(error)) return undefined;
      throw error;
    }
  }

  async function kill(sandboxId: string, options?: Options): Promise<boolean> {
    const ms = deadline(options);
    if ((await exitOf(sandboxId, ms)) !== null) return false;
    const sandbox = await within(client.sandboxes.fromId(sandboxId), ms, "a sandbox lookup");
    await within(sandbox.terminate(), ms, "a terminate");
    // terminate returns before the sandbox stops. Polling, unlike the SDK's wait, ends when this
    // loop does; a sandbox still running at the end leaves the kill unconfirmed.
    for (const end = Date.now() + TERMINATE_WAIT_MS; Date.now() < end;) {
      if ((await exitOf(sandboxId, ms)) !== null) return true;
      await new Promise((resolve) => setTimeout(resolve, TERMINATE_POLL_MS));
    }
    throw new Error(
      `Modal had not reported the sandbox finished ${TERMINATE_WAIT_MS / 1000} s after it was terminated.`,
    );
  }

  async function getInfo(
    sandboxId: string,
    options?: Options,
  ): Promise<{ sandboxId: string; state: string }> {
    if ((await exitOf(sandboxId, deadline(options))) !== null) throw sandboxNotFound(sandboxId);
    return { sandboxId, state: "running" };
  }

  /** One page: Modal filters by tags server-side, and a run tags a few dozen sandboxes at most. */
  async function listed(
    tags: Record<string, string> | undefined,
    ms: number,
  ): Promise<E2BListedSandbox[]> {
    let app: { appId: string };
    try {
      app = await within(existingApp(), ms, "an app lookup");
    } catch (error) {
      // No humanish App in this environment: no sandbox of any run is there.
      if (isModalNotFoundError(error)) return [];
      throw error;
    }
    const found: E2BListedSandbox[] = [];
    const search = async () => {
      for await (const sandbox of client.sandboxes.list({
        appId: app.appId,
        ...(tags === undefined ? {} : { tags }),
        ...(connection.environment === undefined ? {} : { environment: connection.environment }),
      }))
        found.push({
          sandboxId: sandbox.sandboxId,
          metadata: await sandbox.getTags(),
          state: "running",
        });
    };
    await within(search(), ms, "a sandbox list");
    return found;
  }

  return {
    kill: hidingTokens(connection, kill),
    getInfo: hidingTokens(connection, getInfo),
    list: (options) => {
      let read = false;
      return {
        get hasNext() {
          return !read;
        },
        nextItems: hidingTokens(connection, () => {
          read = true;
          return listed(options?.query?.metadata, deadline(options));
        }),
      };
    },
  };
}

function sandboxNotFound(sandboxId: string): Error {
  const error = new Error(`Modal has no running sandbox ${sandboxId}.`);
  error.name = "SandboxNotFoundError";
  return error;
}

const CIDR = /^[0-9a-f:.]+\/\d{1,3}$/i;

/**
 * E2B's egress shapes that Modal can express: unrestricted, or deny-all with an allowlist of hosts
 * and CIDRs. Header transforms and other deny lists have no Modal form, so plan validation refuses
 * them first and this throws if one gets through.
 */
function modalNetwork(
  network: E2BNetworkOptions | undefined,
): Pick<
  ModalSandboxCreateParams,
  "blockNetwork" | "outboundCidrAllowlist" | "outboundDomainAllowlist"
> {
  if (network === undefined) return {};
  if (network.rules !== undefined && Object.keys(network.rules).length > 0)
    throw new ModalUnsupportedError("An outbound header transform");
  const allow = network.allowOut ?? [];
  const deny = network.denyOut ?? [];
  if (deny.length === 0 && allow.length === 0) return {};
  if (deny.length !== 1 || deny[0] !== "0.0.0.0/0")
    throw new ModalUnsupportedError("An egress deny list other than 0.0.0.0/0");
  if (allow.length === 0) return { blockNetwork: true };
  const cidrs = allow.filter((entry) => CIDR.test(entry));
  const domains = allow.filter((entry) => !CIDR.test(entry));
  return {
    ...(cidrs.length === 0 ? {} : { outboundCidrAllowlist: cidrs }),
    ...(domains.length === 0 ? {} : { outboundDomainAllowlist: domains }),
  };
}

/** The argv that runs `command` in a login shell as the sandbox user, in their home. */
function asSandboxUser(command: string): string[] {
  const { uid } = MODAL_SANDBOX_USER;
  return [
    "setpriv",
    `--reuid=${uid}`,
    `--regid=${uid}`,
    "--init-groups",
    "--",
    "bash",
    "-lc",
    command,
  ];
}

const USER_ENV = {
  HOME: MODAL_SANDBOX_USER.home,
  USER: MODAL_SANDBOX_USER.name,
  LOGNAME: MODAL_SANDBOX_USER.name,
};

/** The E2B SDK throws this shape on a non-zero exit; src/substrates/command-failure.ts reads it. */
class ModalCommandExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`Command exited with code ${exitCode}${stderr ? ` and error:\n${stderr}` : ""}`);
    this.name = "CommandExitError";
  }
  get error(): string {
    return this.stderr;
  }
}

async function collect(
  stream: AsyncIterable<string | Uint8Array>,
  onData: ((data: string) => void | Promise<void>) | undefined,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    const data = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    text += data;
    if (onData !== undefined && data !== "") await onData(data);
  }
  return text;
}

async function run(
  sandbox: ModalSandbox,
  command: string,
  options: E2BCommandRunOptions = {},
): Promise<E2BCommandResult> {
  if (options.background === true || options.stdin === true)
    throw new ModalUnsupportedError("A background command");
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    const child = await sandbox.exec(asSandboxUser(command), {
      env: { ...USER_ENV, ...options.envs },
      ...(options.cwd === undefined ? {} : { workdir: options.cwd }),
      ...(timeoutMs > 0 ? { timeoutMs: wholeSeconds(timeoutMs) } : {}),
    });
    // E2B starts a command with no stdin; a Modal exec keeps the pipe open, and a reader such as
    // codex exec would wait on it until its timeout.
    await child.closeStdin();
    [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout, options.onStdout),
      collect(child.stderr, options.onStderr),
      child.wait(),
    ]);
  } catch (error) {
    // Modal ends a command at its timeout and reports it as a deadline; E2B names it TimeoutError.
    if (error instanceof Error && /deadline exceeded/i.test(error.message)) {
      const timeout = new Error(`Command did not finish within ${timeoutMs} ms.`, { cause: error });
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw error;
  }
  if (exitCode !== 0) throw new ModalCommandExitError(exitCode, stdout, stderr);
  return { exitCode, stdout, stderr };
}

/** Relative paths are under the sandbox user's home, as on E2B. */
function sandboxPath(path: string): string {
  return path.startsWith("/") ? path : `${MODAL_SANDBOX_USER.home}/${path}`;
}

async function writeFile(sandbox: ModalSandbox, path: string, data: string | ArrayBuffer) {
  const target = sandboxPath(path);
  const child = await sandbox.exec(
    asSandboxUser('mkdir -p -- "$(dirname -- "$0")" && cat > "$0"').concat(target),
    { mode: "binary", env: USER_ENV },
  );
  await child.stdin.writeBytes(
    typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
  );
  await child.closeStdin();
  const [stderr, exitCode] = await Promise.all([child.stderr.readBytes(), child.wait()]);
  if (exitCode !== 0)
    throw new ModalCommandExitError(exitCode, "", new TextDecoder().decode(stderr));
  return { path: target };
}

function modalSandboxHandle(
  sandbox: ModalSandbox,
  profile: ModalSandboxProfile,
  connection: ModalConnection,
): E2BDesktopSandbox {
  const desktopOnly = (what: string) => () => Promise.reject(new ModalUnsupportedError(what));
  return {
    sandboxId: sandbox.sandboxId,
    // Modal reports no allocation for a sandbox; the create's request is what it bills.
    getInfo: () => Promise.resolve({ cpuCount: profile.cpu * 2, memoryMB: profile.memoryMiB }),
    commands: {
      run: hidingTokens(connection, (command: string, options?: E2BCommandRunOptions) =>
        run(sandbox, command, options),
      ),
    },
    files: {
      write: hidingTokens(connection, (path: string, data: string | ArrayBuffer) =>
        writeFile(sandbox, path, data),
      ),
      getInfo: hidingTokens(connection, async (path: string) => {
        const result = await run(
          sandbox,
          `stat -c %s -- '${sandboxPath(path).replaceAll("'", "'\\''")}'`,
        );
        return { size: Number(result.stdout?.trim()) };
      }),
    },
    wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    launch: desktopOnly("A desktop application launch"),
    screenshot: desktopOnly("A desktop screenshot"),
    leftClick: desktopOnly("Desktop input"),
    rightClick: desktopOnly("Desktop input"),
    middleClick: desktopOnly("Desktop input"),
    doubleClick: desktopOnly("Desktop input"),
    moveMouse: desktopOnly("Desktop input"),
    scroll: desktopOnly("Desktop input"),
    write: desktopOnly("Desktop input"),
    press: desktopOnly("Desktop input"),
    drag: desktopOnly("Desktop input"),
    stream: {
      getAuthKey: () => {
        throw new ModalUnsupportedError("A desktop stream");
      },
      getUrl: () => {
        throw new ModalUnsupportedError("A desktop stream");
      },
      start: desktopOnly("A desktop stream"),
    },
  };
}

/** The Modal account `env` names, for release by id and reclaim. Throws when it names none. */
export async function modalAccount(
  env: Readonly<Record<string, string | undefined>>,
  load: () => Promise<ModalModule> = loadModalModule,
): Promise<Required<E2BAccount>> {
  const connection = requireModalConnection(env);
  const { ModalClient: Client } = await load();
  return modalSandboxes(new Client(connection), connection);
}

/** The terminal route's shell: Codex needs little CPU, so it runs smaller than E2B's 8 vCPU desktop. */
const MODAL_SHELL_PROFILE: ModalSandboxProfile = {
  image: modalShellImage,
  cpu: 2,
  memoryMiB: 4096,
};

/** A sandbox port that creates the terminal route's shell sandboxes on the Modal account `env` names. */
export async function loadModalShellModule(
  env: Readonly<Record<string, string | undefined>>,
  load: () => Promise<ModalModule> = loadModalModule,
): Promise<E2BDesktopModule> {
  const connection = requireModalConnection(env);
  const { ModalClient: Client } = await load();
  return modalSandboxModule(new Client(connection), connection, MODAL_SHELL_PROFILE);
}

function requireModalConnection(
  env: Readonly<Record<string, string | undefined>>,
): ModalConnection {
  const connection = modalConnection(env);
  if (connection === undefined)
    throw new Error(
      `No Modal credentials: set ${MODAL_TOKEN_ID_ENV} and ${MODAL_TOKEN_SECRET_ENV}, or run \`modal token new\`.`,
    );
  return connection;
}
