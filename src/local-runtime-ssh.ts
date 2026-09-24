import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hostExec, LIMA_INSTANCE } from "./local-runtime-host.js";

/** Standard OpenSSH streamlocal forwarding; no browser-control protocol here. */
export async function openRuntimeSshTunnel(options: {
  config: string; destination: string; localSocket: string; remoteSocket: string;
  appSocket: string; appHost: string; appPort: number; signal: AbortSignal;
}): Promise<{ close(): Promise<boolean> }> {
  options.signal.throwIfAborted();
  const child = spawn("ssh", ["-F", options.config, "-T", "-a", "-o", "BatchMode=yes",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=15", "-o", "StreamLocalBindMask=0177",
    "-L", `${options.localSocket}:${options.remoteSocket}`,
    "-R", `${options.appSocket}:${options.appHost}:${options.appPort}`,
    options.destination, "sh -c 'printf \"HUMANISH_SSH_READY\\n\"; exec cat'"],
  { stdio: ["pipe", "pipe", "pipe"] });
  let exited = false;
  const closed = new Promise<void>(resolve => child.once("close", () => { exited = true; resolve(); }));
  child.stdin.on("error", () => {});
  let closing: Promise<boolean> | undefined;
  const close = (): Promise<boolean> => closing ??= (async () => {
    options.signal.removeEventListener("abort", aborted);
    // EOF also closes the remote cat if the parent dies unexpectedly. Do not
    // detach/multiplex this SSH child into Lima's persistent control connection.
    child.stdin.end();
    await Promise.race([closed, delay(1000)]);
    if (!exited) child.kill("SIGTERM");
    await Promise.race([closed, delay(1000)]);
    if (!exited) child.kill("SIGKILL");
    await Promise.race([closed, delay(1000)]);
    return exited;
  })();
  const aborted = (): void => { void close(); };
  options.signal.addEventListener("abort", aborted, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Lima SSH forwarding timed out.")), 20_000);
      let bytes = 0, output = "", ready = false;
      const finish = (error?: Error): void => {
        if (ready) return;
        ready = true; clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      child.once("error", () => finish(new Error("Could not start SSH for the Lima browser.")));
      child.once("close", () => finish(new Error("Lima SSH forwarding closed before it was ready.")));
      child.stderr.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 64 * 1024) { finish(new Error("Lima SSH forwarding failed.")); void close(); }
      });
      child.stdout.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 64 * 1024) { finish(new Error("Lima SSH forwarding failed.")); void close(); return; }
        if (!ready) { output += data.toString(); if (output === "HUMANISH_SSH_READY\n") finish(); }
      });
    });
    options.signal.throwIfAborted();
    return { close };
  } catch (error) { await close(); throw error; }
}

export async function openLimaTunnel(options: {
  work: string; socketRoot: string; appUrl: URL; signal: AbortSignal;
}): Promise<{ close(): Promise<boolean> }> {
  const settings = await hostExec("limactl", ["list", "--format={{.SSHConfigFile}}", LIMA_INSTANCE], { signal: options.signal });
  const config = settings.stdout.trim();
  if (!path.isAbsolute(config)) throw new Error("Lima did not return its SSH configuration path.");
  return openRuntimeSshTunnel({ config, destination: `lima-${LIMA_INSTANCE}`,
    localSocket: path.join(options.work, "vsock.sock"), remoteSocket: `${options.socketRoot}/vsock.sock`,
    appSocket: `${options.socketRoot}/vsock.sock_8000`, appHost: options.appUrl.hostname,
    appPort: Number(options.appUrl.port), signal: options.signal });
}
