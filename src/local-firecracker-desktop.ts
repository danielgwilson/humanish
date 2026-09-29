import type { Writable } from "node:stream";
import {
  desktopRecordingConfigSchema,
  type DesktopRecordingConfig,
  type DesktopRecordingMetadata,
} from "./desktop-recording-types.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectGuestBootstrap, validateGuestInitialUrl } from "./guest-bootstrap.js";
import { ownDesktopAllocation, type DesktopSession } from "./desktop-session.js";
import { runtimeDocker, runtimeExec, usesLima } from "./local-runtime-host.js";
import { openLimaTunnel } from "./local-runtime-ssh.js";
import { guestMediaConfigSchema, type GuestMediaConfig } from "./guest-media-config.js";

const docker = async (args: string[]): Promise<string> =>
  (await runtimeDocker(args, {}, 60_000)).stdout.trim();
const readLogs = async (id: string): Promise<string> => {
  const result = await runtimeDocker(["logs", "--tail", "100", id], {}, 10_000);
  return result.stdout + result.stderr;
};

/** Internal development assets; setup/distribution chooses these, never a participant. */
export interface LocalFirecrackerAssets {
  image: string;
  runtimeRevision: string;
  media?: boolean;
}

export interface LocalFirecrackerDesktop extends DesktopSession {
  finishRecording(destination: Writable): Promise<DesktopRecordingMetadata>;
}

/** One VM with opaque TCP forwards to the selected app and optional scoped inbox. */
export async function createLocalFirecrackerDesktop(options: {
  assets: LocalFirecrackerAssets;
  appUrl: string;
  outputRoot: string;
  signal?: AbortSignal;
  media?: GuestMediaConfig;
  recording?: DesktopRecordingConfig;
  inboxUrl?: string;
}): Promise<LocalFirecrackerDesktop> {
  if (options.media !== undefined) {
    guestMediaConfigSchema.parse(options.media);
    if (options.assets.media !== true)
      throw new Error(
        "This local runtime does not include media. Run humanish runtime setup --media.",
      );
  }
  if (options.recording !== undefined) {
    desktopRecordingConfigSchema.parse(options.recording);
    if (options.assets.media !== true)
      throw new Error(
        "This runtime does not include the recorder. Run humanish runtime setup --media.",
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
  options.signal?.throwIfAborted();
  await mkdir(options.outputRoot, { recursive: true, mode: 0o700 });
  // Unix socket paths have a small fixed limit; project paths may be much longer.
  const work = await mkdtemp("/tmp/humanish-fc-");
  const lima = usesLima();
  const sockets = new Set<Socket>();
  let container: string | undefined;
  let client: Awaited<ReturnType<typeof connectGuestBootstrap>> | undefined;
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  let remoteWork: string | undefined;
  let tunnel: Awaited<ReturnType<typeof openLimaTunnel>> | undefined;
  let socketRoot = path.join(work, "vm"),
    cidfile = path.join(work, "container-id");
  let controlSocket = path.join(socketRoot, "vsock.sock");
  const forwards = [{ url, port: 8000 }, ...(inbox ? [{ url: inbox, port: 8001 }] : [])].map(
    (endpoint) => ({
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
    }),
  );
  let closing: ReturnType<DesktopSession["close"]> | undefined;
  const close: DesktopSession["close"] = () =>
    (closing ??= (async () => {
      stop.abort();
      client?.close();
      for (const socket of sockets) socket.destroy();
      for (const forward of forwards) if (forward.server.listening) forward.server.close();
      options.signal?.removeEventListener("abort", aborted);
      // Docker can create the container before its command's reply is interrupted.
      // Only this invocation's private cidfile is cleanup authority.
      container ??= await (
        lima
          ? runtimeExec("cat", [cidfile]).then((result) => result.stdout)
          : readFile(cidfile, "utf8")
      ).then(
        (value) => (/^[a-f0-9]{64}$/.test(value.trim()) ? value.trim() : undefined),
        () => undefined,
      );
      if (container) {
        try {
          await docker(["rm", "--force", "--volumes", container]);
        } catch (error) {
          const stderr = (error as { stderr?: string }).stderr ?? "";
          if (!stderr.includes(`No such container: ${container}`))
            return { status: "unconfirmed", reason: "release_failed" };
        }
      }
      if (tunnel && !(await tunnel.close()))
        return { status: "unconfirmed", reason: "release_failed" };
      try {
        if (remoteWork) await runtimeExec("rm", ["-rf", "--", remoteWork]);
        await rm(work, { recursive: true, force: true });
      } catch {
        return { status: "unconfirmed", reason: "release_failed" };
      }
      return { status: "released", reason: "terminated" };
    })());
  const aborted = (): void => {
    void close();
  };
  try {
    let uid = process.getuid?.() || 1000,
      gid = process.getgid?.() || 1000;
    if (lima) {
      remoteWork = (await runtimeExec("mktemp", ["-d", "/tmp/humanish-fc-XXXXXX"])).stdout.trim();
      socketRoot = remoteWork;
      cidfile = `${remoteWork}/container-id`;
      controlSocket = path.join(work, "vsock.sock");
      uid = Number((await runtimeExec("id", ["-u"])).stdout.trim());
      gid = Number((await runtimeExec("id", ["-g"])).stdout.trim());
      tunnel = await openLimaTunnel({
        work,
        socketRoot,
        appUrl: url,
        ...(inbox ? { inboxUrl: inbox } : {}),
        signal,
      });
    } else {
      await mkdir(socketRoot, { mode: 0o700 });
    }
    if (!lima)
      for (const { server, port } of forwards)
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(path.join(socketRoot, `vsock.sock_${port}`), () => {
            server.off("error", reject);
            resolve();
          });
        });
    const created = await docker([
      "create",
      "--rm",
      "--cidfile",
      cidfile,
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
      `type=bind,src=${socketRoot},dst=/run/vm`,
      "--mount",
      "type=volume,dst=/run/state,volume-nocopy",
      options.assets.image,
      url.port,
      String(uid),
      String(gid),
      ...(inbox ? [inbox.port] : []),
    ]);
    if (!/^[a-f0-9]{64}$/.test(created)) throw new Error("Docker did not return a container ID.");
    container = created;
    signal.throwIfAborted();
    await docker(["start", container]);
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
    const identity = {
      generation: randomUUID(),
      challenge: randomUUID(),
      runtimeRevision: options.assets.runtimeRevision,
    };
    try {
      client = await connectGuestBootstrap(
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
    const recorderClient = client;
    return {
      ...session,
      finishRecording: (destination) => recorderClient.finishRecording(destination),
    };
  } catch (error) {
    if (container) {
      const logs = await readLogs(container).catch(() => "");
      // Development-only diagnostics stay in the caller's private output directory.
      await writeFile(path.join(options.outputRoot, `startup-${path.basename(work)}.log`), logs, {
        mode: 0o600,
      }).catch(() => undefined);
    }
    await close();
    throw error;
  }
}
