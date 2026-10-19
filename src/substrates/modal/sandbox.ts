// Modal sandboxes behind the sandbox port the E2B routes already use (E2BDesktopModule and
// E2BDesktopSandbox in src/substrates/e2b/sdk.ts). acquire() in src/substrates/e2b/sandbox.ts,
// the receipts, the release by id and reclaim then work the same on both providers.
//
// Modal runs every exec as root and ignores the image's user setting, so each command drops to the
// sandbox user here, the account E2B runs commands as. Sandboxes use Modal's VM runtime: its
// default gVisor runtime sets no_new_privs on every process, so the user's sudo, which the Node
// bootstrap and product installs run, cannot work there.
import { E2BDesktopStartupError, reportDesktopAllocation } from "../e2b/sdk.js";
import type {
  E2BCommandRunOptions,
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
  E2BListedSandbox,
  E2BNetworkOptions,
} from "../e2b/sdk.js";
import type { E2BAccount } from "../e2b/connection.js";
import {
  readBytes,
  readFile,
  runCommand,
  sandboxPath,
  wholeSeconds,
  writeFile,
} from "./commands.js";
import {
  MODAL_DESKTOP_DISPLAY,
  MODAL_STREAM_PORT,
  modalDesktopSurface,
  startModalDesktop,
} from "./desktop.js";
import { MODAL_SANDBOX_USER, modalDesktopImage, modalShellImage } from "./image.js";
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

/** Modal's own default sandbox lifetime is 5 minutes, as E2B's is. */
const DEFAULT_SANDBOX_TIMEOUT_MS = 5 * 60_000;

/** The size and image of the sandboxes one module creates. */
export interface ModalSandboxProfile {
  image: (client: ModalClient) => ModalImage;
  /** Physical cores; Modal counts one core as two vCPU. */
  cpu: number;
  memoryMiB: number;
  /** Start an X desktop after create and tunnel its stream, as @e2b/desktop's create does. */
  desktop?: true;
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
    const desktop = profile.desktop === true;
    const env = { ...options.envs, ...(desktop ? { DISPLAY: MODAL_DESKTOP_DISPLAY } : {}) };
    const params: ModalSandboxCreateParams = {
      cpu: profile.cpu,
      memoryMiB: profile.memoryMiB,
      timeoutMs: wholeSeconds(options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS),
      runtime: "vm",
      workdir: MODAL_SANDBOX_USER.home,
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(options.metadata === undefined ? {} : { tags: { ...options.metadata } }),
      ...(desktop ? { encryptedPorts: [MODAL_STREAM_PORT] } : {}),
      ...modalNetwork(options.network),
    };
    const sandbox = await client.sandboxes.create(
      await humanishApp(),
      profile.image(client),
      params,
    );
    if (!desktop) return modalSandboxHandle(sandbox, profile, connection, new Map());
    // The id reaches the run's journal before the desktop starts, as E2B's create guard reports it.
    reportDesktopAllocation(options, sandbox.sandboxId);
    try {
      const run = (command: string, runOptions?: E2BCommandRunOptions) =>
        runCommand(sandbox, command, runOptions);
      await startModalDesktop(run, {
        ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
        ...(options.dpi === undefined ? {} : { dpi: options.dpi }),
      });
      const tunnels = await sandbox.tunnels(30_000);
      const hosts = new Map(
        Object.entries(tunnels).map(([port, tunnel]) => [Number(port), new URL(tunnel.url).host]),
      );
      return modalSandboxHandle(sandbox, profile, connection, hosts);
    } catch (error) {
      const gone = await modalSandboxes(client, connection)
        .kill(sandbox.sandboxId)
        .then(() => "killed" as const)
        .catch(() => "unconfirmed" as const);
      throw new E2BDesktopStartupError(error, gone);
    }
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

function modalSandboxHandle(
  sandbox: ModalSandbox,
  profile: ModalSandboxProfile,
  connection: ModalConnection,
  hosts: ReadonlyMap<number, string>,
): E2BDesktopSandbox {
  const run = hidingTokens(connection, (command: string, options?: E2BCommandRunOptions) =>
    runCommand(sandbox, command, options),
  );
  const shell = {
    sandboxId: sandbox.sandboxId,
    // Modal reports no allocation for a sandbox; the create's request is what it bills.
    getInfo: () => Promise.resolve({ cpuCount: profile.cpu * 2, memoryMB: profile.memoryMiB }),
    commands: { run },
    files: {
      write: hidingTokens(connection, (path: string, data: string | ArrayBuffer) =>
        writeFile(sandbox, path, data),
      ),
      read: hidingTokens(connection, (path: string) => readFile(sandbox, path)),
      getInfo: hidingTokens(connection, async (path: string) => {
        const result = await runCommand(
          sandbox,
          `stat -c %s -- '${sandboxPath(path).replaceAll("'", "'\\''")}'`,
        );
        return { size: Number(result.stdout?.trim()) };
      }),
    },
  };
  if (profile.desktop === true)
    return {
      ...shell,
      ...modalDesktopSurface(
        run,
        hidingTokens(connection, (path: string) => readBytes(sandbox, path)),
        hosts,
      ),
    };
  const desktopOnly = (what: string) => () => Promise.reject(new ModalUnsupportedError(what));
  return {
    ...shell,
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

/**
 * The computer-use route's desktop: 4 vCPU and 8 GiB, under E2B's 8 vCPU stock desktop, since a
 * participant's browser and XFCE use little CPU between actions.
 */
const MODAL_DESKTOP_PROFILE: ModalSandboxProfile = {
  image: modalDesktopImage,
  cpu: 2,
  memoryMiB: 8192,
  desktop: true,
};

/** A sandbox port that creates the computer-use route's desktops on the Modal account `env` names. */
export async function loadModalDesktopModule(
  env: Readonly<Record<string, string | undefined>>,
  load: () => Promise<ModalModule> = loadModalModule,
): Promise<E2BDesktopModule> {
  const connection = requireModalConnection(env);
  const { ModalClient: Client } = await load();
  return modalSandboxModule(new Client(connection), connection, MODAL_DESKTOP_PROFILE);
}

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
