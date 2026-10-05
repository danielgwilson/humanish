import type { Writable } from "node:stream";
import {
  desktopRecordingConfigSchema,
  type DesktopRecordingConfig,
  type DesktopRecordingMetadata,
} from "../../evidence/desktop-recording-types.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectGuestBootstrap, validateGuestInitialUrl } from "../../guest/bootstrap.js";
import {
  ownDesktopAllocation,
  type DesktopReleaseResult,
  type DesktopSession,
} from "../desktop-session.js";
import { runtimeDocker, runtimeExec, usesLima } from "./runtime-host.js";
import { openLimaTunnel } from "./runtime-ssh.js";
import { guestMediaConfigSchema, type GuestMediaConfig } from "../../guest/media-config.js";
import { cli } from "../../cli/invocation.js";

const docker = async (args: string[]): Promise<string> =>
  (await runtimeDocker(args, {}, 60_000)).stdout.trim();
const readLogs = async (id: string): Promise<string> => {
  const result = await runtimeDocker(["logs", "--tail", "100", id], {}, 10_000);
  return result.stdout + result.stderr;
};

/** The installed runtime image; `humanish runtime setup` chooses it, never a participant. */
export interface LocalFirecrackerAssets {
  image: string;
  runtimeRevision: string;
  media?: boolean;
}

export interface LocalFirecrackerDesktop extends DesktopSession {
  finishRecording(destination: Writable): Promise<DesktopRecordingMetadata>;
}

type GuestClient = Awaited<ReturnType<typeof connectGuestBootstrap>>;

interface LocalFirecrackerOptions {
  assets: LocalFirecrackerAssets;
  appUrl: string;
  outputRoot: string;
  signal?: AbortSignal;
  media?: GuestMediaConfig;
  recording?: DesktopRecordingConfig;
  inboxUrl?: string;
}

interface Forward {
  readonly port: number;
  readonly server: ReturnType<typeof createServer>;
}

/** What one VM holds on the host. Release frees exactly these and nothing it did not create. */
interface VmHost {
  readonly work: string;
  readonly lima: boolean;
  readonly sockets: Set<Socket>;
  readonly forwards: Forward[];
  socketRoot: string;
  cidfile: string;
  controlSocket: string;
  remoteWork?: string;
  tunnel?: Awaited<ReturnType<typeof openLimaTunnel>>;
  container?: string | undefined;
  client?: GuestClient;
}

function checkDesktopOptions(options: LocalFirecrackerOptions): { url: URL; inbox?: URL } {
  if (options.media !== undefined) {
    guestMediaConfigSchema.parse(options.media);
    if (options.assets.media !== true)
      throw new Error(
        `This local runtime does not include media. Run ${cli("runtime setup --media")}.`,
      );
  }
  if (options.recording !== undefined) {
    desktopRecordingConfigSchema.parse(options.recording);
    if (options.assets.media !== true)
      throw new Error(
        `This runtime does not include the recorder. Run ${cli("runtime setup --media")}.`,
      );
  }
  let url: URL;
  try {
    url = new URL(validateGuestInitialUrl(options.appUrl));
  } catch {
    throw new Error("Local Firecracker requires a loopback HTTP(S) app on a port above 1023.");
  }
  const inbox =
    options.inboxUrl === undefined ? undefined : new URL(validateGuestInitialUrl(options.inboxUrl));
  if (inbox && (inbox.protocol !== "http:" || inbox.port === url.port)) {
    throw new Error("The local inbox requires its own loopback HTTP port.");
  }
  return inbox ? { url, inbox } : { url };
}

/** One opaque TCP forward per guest port, from the VM's vsock listener to a loopback endpoint. */
function createForwards(
  endpoints: { url: URL; port: number }[],
  signal: AbortSignal,
  sockets: Set<Socket>,
): Forward[] {
  return endpoints.map((endpoint) => ({
    port: endpoint.port,
    server: createServer((incoming) => {
      if (signal.aborted) {
        incoming.destroy();
        return;
      }
      const target = connect({
        host: endpoint.url.hostname,
        port: Number(endpoint.url.port),
        autoSelectFamily: true,
      });
      for (const socket of [incoming, target]) {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {
          incoming.destroy();
          target.destroy();
        });
      }
      incoming.pipe(target);
      target.pipe(incoming);
      incoming.once("close", () => target.destroy());
      target.once("close", () => incoming.destroy());
    }),
  }));
}

async function releaseVm(host: VmHost): Promise<DesktopReleaseResult> {
  host.client?.close();
  for (const socket of host.sockets) socket.destroy();
  for (const forward of host.forwards) if (forward.server.listening) forward.server.close();
  // Docker can create the container before its command's reply is interrupted.
  // Only this invocation's private cidfile is cleanup authority.
  host.container ??= await (
    host.lima
      ? runtimeExec("cat", [host.cidfile]).then((result) => result.stdout)
      : readFile(host.cidfile, "utf8")
  ).then(
    (value) => (/^[a-f0-9]{64}$/.test(value.trim()) ? value.trim() : undefined),
    () => undefined,
  );
  if (host.container) {
    try {
      await docker(["rm", "--force", "--volumes", host.container]);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (!stderr.includes(`No such container: ${host.container}`))
        return { status: "unconfirmed", reason: "release_failed" };
    }
  }
  if (host.tunnel && !(await host.tunnel.close()))
    return { status: "unconfirmed", reason: "release_failed" };
  try {
    if (host.remoteWork) await runtimeExec("rm", ["-rf", "--", host.remoteWork]);
    await rm(host.work, { recursive: true, force: true });
  } catch {
    return { status: "unconfirmed", reason: "release_failed" };
  }
  return { status: "released", reason: "terminated" };
}

/**
 * Set up the socket directory the VM binds and the forwards into it: a Lima tunnel when the
 * runtime runs in Lima, otherwise local vsock listeners. Returns the uid and gid the VM runs as.
 */
async function prepareVmHost(
  host: VmHost,
  url: URL,
  inbox: URL | undefined,
  signal: AbortSignal,
): Promise<{ uid: number; gid: number }> {
  let uid = process.getuid?.() || 1000,
    gid = process.getgid?.() || 1000;
  if (host.lima) {
    host.remoteWork = (
      await runtimeExec("mktemp", ["-d", "/tmp/humanish-fc-XXXXXX"])
    ).stdout.trim();
    host.socketRoot = host.remoteWork;
    host.cidfile = `${host.remoteWork}/container-id`;
    host.controlSocket = path.join(host.work, "vsock.sock");
    uid = Number((await runtimeExec("id", ["-u"])).stdout.trim());
    gid = Number((await runtimeExec("id", ["-g"])).stdout.trim());
    host.tunnel = await openLimaTunnel({
      work: host.work,
      socketRoot: host.socketRoot,
      appUrl: url,
      ...(inbox ? { inboxUrl: inbox } : {}),
      signal,
    });
    return { uid, gid };
  }
  await mkdir(host.socketRoot, { mode: 0o700 });
  for (const { server, port } of host.forwards)
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path.join(host.socketRoot, `vsock.sock_${port}`), () => {
        server.off("error", reject);
        resolve();
      });
    });
  return { uid, gid };
}

function dockerCreateArgs(options: {
  cidfile: string;
  socketRoot: string;
  image: string;
  url: URL;
  inbox: URL | undefined;
  uid: number;
  gid: number;
}): string[] {
  return [
    "create",
    "--rm",
    "--cidfile",
    options.cidfile,
    "--init",
    "--user",
    "0:0",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "CHOWN",
    "--device",
    "/dev/kvm",
    "--device",
    "/dev/net/tun",
    "--security-opt",
    "no-new-privileges",
    "--sysctl",
    "net.ipv4.ip_forward=1",
    "--memory",
    "3g",
    "--memory-swap",
    "3g",
    "--cpus",
    "2",
    "--pids-limit",
    "128",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=16m",
    "--stop-timeout",
    "5",
    "--mount",
    `type=bind,src=${options.socketRoot},dst=/run/vm`,
    "--mount",
    "type=volume,dst=/run/state,volume-nocopy",
    options.image,
    options.url.port,
    String(options.uid),
    String(options.gid),
    ...(options.inbox ? [options.inbox.port] : []),
  ];
}

/** Create and start the VM container. The id is recorded on the host before start can fail. */
async function startContainer(host: VmHost, args: string[], signal: AbortSignal): Promise<string> {
  const created = await docker(args);
  if (!/^[a-f0-9]{64}$/.test(created)) throw new Error("Docker did not return a container ID.");
  host.container = created;
  signal.throwIfAborted();
  await docker(["start", created]);
  return created;
}

/** Wait for the guest's listening marker, then for its control socket, within one deadline. */
async function waitForGuestSocket(
  container: string,
  controlSocket: string,
  signal: AbortSignal,
): Promise<Socket> {
  const deadline = performance.now() + 45_000;
  while (!(await readLogs(container)).includes("HUMANISH_GUEST_LISTENING_V1")) {
    signal.throwIfAborted();
    if ((await docker(["inspect", "--format", "{{.State.Running}}", container])) !== "true")
      throw new Error("Firecracker exited during startup.");
    if (performance.now() >= deadline) throw new Error("Firecracker guest did not become ready.");
    await delay(200, undefined, { signal });
  }
  let stream: Socket | undefined;
  while (!stream) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error("Firecracker browser startup timed out.");
    stream = await new Promise<Socket | undefined>((resolve) => {
      const socket = connect(controlSocket);
      socket.once("connect", () => resolve(socket));
      socket.once("error", () => {
        socket.destroy();
        resolve(undefined);
      });
    });
    if (!stream) await delay(100, undefined, { signal });
  }
  return stream;
}

async function bootstrapGuest(
  stream: Socket,
  options: LocalFirecrackerOptions,
  url: URL,
  signal: AbortSignal,
): Promise<GuestClient> {
  const identity = {
    generation: randomUUID(),
    challenge: randomUUID(),
    runtimeRevision: options.assets.runtimeRevision,
  };
  try {
    return await connectGuestBootstrap(
      stream,
      identity,
      signal,
      url.href,
      options.media,
      options.recording,
    );
  } catch (error) {
    signal.throwIfAborted();
    throw new Error("Local browser startup or initial page navigation failed or timed out.", {
      cause: error,
    });
  }
}

// Startup diagnostics stay in the caller's private output directory.
async function saveStartupLogs(container: string, outputRoot: string, work: string): Promise<void> {
  const logs = await readLogs(container).catch(() => "");
  await writeFile(path.join(outputRoot, `startup-${path.basename(work)}.log`), logs, {
    mode: 0o600,
  }).catch(() => undefined);
}

/** One VM with opaque TCP forwards to the selected app and optional scoped inbox. */
export async function createLocalFirecrackerDesktop(
  options: LocalFirecrackerOptions,
): Promise<LocalFirecrackerDesktop> {
  const { url, inbox } = checkDesktopOptions(options);
  options.signal?.throwIfAborted();
  await mkdir(options.outputRoot, { recursive: true, mode: 0o700 });
  // Unix socket paths have a small fixed limit; project paths may be much longer.
  const work = await mkdtemp("/tmp/humanish-fc-");
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  const sockets = new Set<Socket>();
  const host: VmHost = {
    work,
    lima: usesLima(),
    sockets,
    forwards: createForwards(
      [{ url, port: 8000 }, ...(inbox ? [{ url: inbox, port: 8001 }] : [])],
      signal,
      sockets,
    ),
    socketRoot: path.join(work, "vm"),
    cidfile: path.join(work, "container-id"),
    controlSocket: path.join(work, "vm", "vsock.sock"),
  };
  let closing: Promise<DesktopReleaseResult> | undefined;
  const close = (): Promise<DesktopReleaseResult> =>
    (closing ??= (async () => {
      stop.abort();
      options.signal?.removeEventListener("abort", aborted);
      return releaseVm(host);
    })());
  const aborted = (): void => {
    void close();
  };
  try {
    const { uid, gid } = await prepareVmHost(host, url, inbox, signal);
    const container = await startContainer(
      host,
      dockerCreateArgs({
        cidfile: host.cidfile,
        socketRoot: host.socketRoot,
        image: options.assets.image,
        url,
        inbox,
        uid,
        gid,
      }),
      signal,
    );
    const stream = await waitForGuestSocket(container, host.controlSocket, signal);
    const client = await bootstrapGuest(stream, options, url, signal);
    host.client = client;
    await client.ready();
    signal.throwIfAborted();
    options.signal?.addEventListener("abort", aborted, { once: true });
    const session = ownDesktopAllocation({
      resourceId: container,
      release: async () => {
        const result = await close();
        return result.status === "retained"
          ? { status: "unconfirmed", reason: "invalid_result" }
          : result;
      },
    }).open(client.executor);
    return {
      ...session,
      finishRecording: (destination) => client.finishRecording(destination),
    };
  } catch (error) {
    if (host.container) await saveStartupLogs(host.container, options.outputRoot, work);
    await close();
    throw error;
  }
}
