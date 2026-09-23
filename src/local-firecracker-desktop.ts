import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { connectGuestBootstrap } from "./guest-bootstrap.js";
import { ownDesktopAllocation, type DesktopSession } from "./desktop-session.js";

const exec = promisify(execFile);
const docker = async (args: string[]): Promise<string> => (await exec("docker", args, {
  timeout: 60_000, maxBuffer: 1024 * 1024
})).stdout.trim();
const readLogs = async (id: string): Promise<string> => {
  const result = await exec("docker", ["logs", "--tail", "100", id], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return result.stdout + result.stderr;
};

/** Internal development assets; setup/distribution chooses these, never a participant. */
export interface LocalFirecrackerAssets {
  firecracker: string; kernel: string; rootfs: string; stateTemplate: string;
  runtimeRevision: string; runnerImage: string;
}

/** One VM and an opaque TCP forward to the explicitly selected loopback app. */
export async function createLocalFirecrackerDesktop(options: {
  assets: LocalFirecrackerAssets; appUrl: string; outputRoot: string; signal?: AbortSignal;
}): Promise<DesktopSession> {
  const url = new URL(options.appUrl);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname)
    || url.username || url.password || !/^\d+$/.test(url.port) || Number(url.port) < 1024) {
    throw new Error("Local Firecracker requires a loopback HTTP(S) app on a port above 1023.");
  }
  options.signal?.throwIfAborted();
  await mkdir(options.outputRoot, { recursive: true, mode: 0o700 });
  // Unix socket paths have a small fixed limit; project paths may be much longer.
  const work = await mkdtemp(path.join(tmpdir(), "humanish-fc-"));
  const sockets = new Set<Socket>();
  let container: string | undefined;
  let client: Awaited<ReturnType<typeof connectGuestBootstrap>> | undefined;
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  const socketRoot = path.join(work, "vm");
  const cidfile = path.join(work, "container-id");
  await mkdir(socketRoot, { mode: 0o700 });
  const forward = createServer(incoming => {
    if (signal.aborted) { incoming.destroy(); return; }
    const target = connect({ host: url.hostname, port: Number(url.port), autoSelectFamily: true });
    for (const socket of [incoming, target]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => { incoming.destroy(); target.destroy(); });
    }
    incoming.pipe(target); target.pipe(incoming);
    incoming.once("close", () => target.destroy()); target.once("close", () => incoming.destroy());
  });
  let closing: ReturnType<DesktopSession["close"]> | undefined;
  const close: DesktopSession["close"] = () => closing ??= (async () => {
    stop.abort(); client?.close();
    for (const socket of sockets) socket.destroy();
    if (forward.listening) forward.close();
    options.signal?.removeEventListener("abort", aborted);
    // Docker can create the container before its command's reply is interrupted.
    // Only this invocation's private cidfile is cleanup authority.
    container ??= await readFile(cidfile, "utf8").then(value => /^[a-f0-9]{64}$/.test(value.trim()) ? value.trim() : undefined, () => undefined);
    if (container) {
      try {
        await docker(["rm", "--force", container]);
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr ?? "";
        if (!stderr.includes(`No such container: ${container}`)) return { status: "unconfirmed", reason: "release_failed" };
      }
    }
    try { await rm(work, { recursive: true, force: true }); }
    catch { return { status: "unconfirmed", reason: "release_failed" }; }
    return { status: "released", reason: "terminated" };
  })();
  const aborted = (): void => { void close(); };
  try {
    await copyFile(options.assets.stateTemplate, path.join(work, "state.ext4"), constants.COPYFILE_FICLONE);
    await chmod(path.join(work, "state.ext4"), 0o600);
    await new Promise<void>((resolve, reject) => {
      forward.once("error", reject);
      forward.listen(path.join(socketRoot, "vsock.sock_8000"), () => { forward.off("error", reject); resolve(); });
    });
    const mounts = [
      [options.assets.firecracker, "/firecracker", true], [options.assets.kernel, "/kernel", true],
      [options.assets.rootfs, "/root.ext4", true], [path.join(work, "state.ext4"), "/state.ext4", false],
      [socketRoot, "/run/vm", false]
    ] as const;
    const created = await docker(["create", "--rm", "--cidfile", cidfile, "--init", "--user", "0:0", "--read-only", "--cap-drop", "ALL",
      "--cap-add", "NET_ADMIN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "CHOWN",
      "--device", "/dev/kvm", "--device", "/dev/net/tun", "--security-opt", "no-new-privileges",
      "--sysctl", "net.ipv4.ip_forward=1", "--memory", "3g", "--memory-swap", "3g", "--cpus", "2", "--pids-limit", "128",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m", "--stop-timeout", "5",
      ...mounts.flatMap(([source, target, readonly]) => ["--mount", `type=bind,src=${path.resolve(source)},dst=${target}${readonly ? ",readonly" : ""}`]),
      options.assets.runnerImage, url.port, String(process.getuid?.() || 1000), String(process.getgid?.() || 1000)]);
    if (!/^[a-f0-9]{64}$/.test(created)) throw new Error("Docker did not return a container ID.");
    container = created;
    signal.throwIfAborted();
    await docker(["start", container]);
    const deadline = performance.now() + 45_000;
    while (!(await readLogs(container)).includes("HUMANISH_GUEST_LISTENING_V1")) {
      signal.throwIfAborted();
      if (await docker(["inspect", "--format", "{{.State.Running}}", container]) !== "true") throw new Error("Firecracker exited during startup.");
      if (performance.now() >= deadline) throw new Error("Firecracker guest did not become ready.");
      await delay(200, undefined, { signal });
    }
    let stream: Socket | undefined;
    while (!stream) {
      signal.throwIfAborted();
      if (performance.now() >= deadline) throw new Error("Firecracker browser startup timed out.");
      stream = await new Promise<Socket | undefined>(resolve => {
        const socket = connect(path.join(socketRoot, "vsock.sock"));
        socket.once("connect", () => resolve(socket));
        socket.once("error", () => { socket.destroy(); resolve(undefined); });
      });
      if (!stream) await delay(100, undefined, { signal });
    }
    const identity = { generation: randomUUID(), challenge: randomUUID(), runtimeRevision: options.assets.runtimeRevision };
    client = await connectGuestBootstrap(stream, identity, signal);
    await client.ready();
    for (const action of [
      { kind: "keypress", keys: ["CTRL", "l"] }, { kind: "type", text: url.href },
      { kind: "keypress", keys: ["ENTER"] }, { kind: "wait", ms: 500 }
    ] as const) await client.executor.execute(action.kind === "keypress" ? { ...action, keys: [...action.keys] } : action, signal);
    signal.throwIfAborted();
    options.signal?.addEventListener("abort", aborted, { once: true });
    return ownDesktopAllocation({ resourceId: container, release: async () => {
      const result = await close();
      return result.status === "retained" ? { status: "unconfirmed", reason: "invalid_result" } : result;
    } }).open(client.executor);
  } catch (error) {
    if (container) {
      const logs = await readLogs(container).catch(() => "");
      // Development-only diagnostics stay in the caller's private output directory.
      await writeFile(path.join(options.outputRoot, `startup-${path.basename(work)}.log`), logs, { mode: 0o600 }).catch(() => undefined);
    }
    await close();
    throw error;
  }
}
