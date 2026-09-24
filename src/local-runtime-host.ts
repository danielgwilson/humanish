import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const LIMA_INSTANCE = "humanish-runtime";
export interface RuntimeHostOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  arch?: string;
}
export const usesLima = (options: RuntimeHostOptions = {}): boolean => (options.platform ?? process.platform) === "darwin";
export function runtimeArchitecture(options: RuntimeHostOptions = {}): "amd64" | "arm64" | undefined {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  if (platform === "linux" && arch === "x64") return "amd64";
  if ((platform === "linux" || platform === "darwin") && arch === "arm64") return "arm64";
  return undefined;
}

export async function hostExec(file: string, args: string[], options: RuntimeHostOptions = {}, timeout = 15_000) {
  return exec(file, args, { env: options.env ?? process.env, timeout, maxBuffer: 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}) });
}

/** Commands inside the Linux host. Lima carries argv; no shell interpolation. */
export async function runtimeExec(file: string, args: string[], options: RuntimeHostOptions = {}, timeout = 15_000) {
  return usesLima(options)
    ? hostExec("limactl", ["shell", "--workdir", "/", LIMA_INSTANCE, "--", file, ...args], options, timeout)
    : hostExec(file, args, options, timeout);
}
export async function runtimeDocker(args: string[], options: RuntimeHostOptions = {}, timeout = 15_000) {
  return usesLima(options)
    ? runtimeExec("sudo", ["-n", "docker", "--host", "unix:///var/run/docker.sock", ...args], options, timeout)
    : runtimeExec("docker", args, options, timeout);
}

// No host mounts, agent forwarding or automatic app-port discovery. Per-study
// OpenSSH forwards grant just the selected app and browser-control sockets.
export const LIMA_TEMPLATE = `minimumLimaVersion: 2.2.0
vmType: vz
arch: aarch64
nestedVirtualization: true
cpus: 6
memory: 8GiB
disk: 80GiB
images:
  - location: https://cloud.debian.org/images/cloud/trixie/20260712-2537/debian-13-genericcloud-arm64-20260712-2537.qcow2
    arch: aarch64
    digest: sha512:8543d795f2fde630eb66c492f245a8c1da19dedc636e0a8e7b3d0f95920e1a05aa911ef2d82d177d41cc53ced5fccbd2a3945d07fa5e15018914c4d864bb07ed
mounts: []
containerd:
  system: false
  user: false
ssh:
  forwardAgent: false
portForwards:
  - guestIP: 0.0.0.0
    guestIPMustBeZero: false
    guestPortRange: [1, 65535]
    proto: any
    ignore: true
provision:
  - mode: system
    script: |
      #!/bin/sh
      set -eu
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends docker.io docker-cli ca-certificates
      systemctl enable --now docker
`;

export async function limaStatus(options: RuntimeHostOptions = {}): Promise<{ ready: boolean; exists: boolean; message: string }> {
  const chip = (await hostExec("sysctl", ["-n", "machdep.cpu.brand_string"], options)).stdout.trim();
  const generation = /^Apple M(\d+)/.exec(chip);
  if (!generation || Number(generation[1]) < 3) throw new Error("Local Firecracker on Mac requires an M3 or newer Apple Silicon Mac with nested virtualization.");
  let version: string;
  try { version = (await hostExec("limactl", ["--version"], options)).stdout; }
  catch { throw new Error("Install Lima 2.2 or newer (brew install lima), then run humanish runtime setup. Docker Desktop is not required."); }
  const match = /\b(\d+)\.(\d+)\.\d+/.exec(version);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 2))
    throw new Error("Update Lima to 2.2 or newer (brew upgrade lima), then run humanish runtime setup.");
  const output = (await hostExec("limactl", ["list", "--json"], options)).stdout.trim();
  const instance = output.split("\n").filter(Boolean).map(line => JSON.parse(line))
    .find(value => value.name === LIMA_INSTANCE);
  if (instance && (instance.name !== LIMA_INSTANCE || instance.vmType !== "vz" || instance.arch !== "aarch64"))
    throw new Error(`The existing ${LIMA_INSTANCE} Lima instance is incompatible. Humanish will not replace it.`);
  return { ready: instance?.status === "Running", exists: !!instance,
    message: instance ? "The Humanish Lima host is stopped. Run humanish runtime setup to start it."
      : "Run humanish runtime setup to create the Humanish Lima host and install the browser runtime." };
}

export async function prepareLima(options: RuntimeHostOptions = {}, progress?: (message: string) => void): Promise<void> {
  const status = await limaStatus(options);
  if (status.ready) return;
  progress?.(status.exists ? "Starting the Humanish Lima host…" : "Preparing the Humanish Lima host (first setup downloads Linux and Docker)…");
  if (status.exists) {
    await hostExec("limactl", ["start", "--tty=false", LIMA_INSTANCE], options, 15 * 60_000);
  } else {
    const work = await mkdtemp(path.join(tmpdir(), "humanish-lima-"));
    try {
      const file = path.join(work, "host.yaml");
      await writeFile(file, LIMA_TEMPLATE, { mode: 0o600 });
      await hostExec("limactl", ["start", "--tty=false", "--name", LIMA_INSTANCE, file], options, 15 * 60_000);
    } finally { await rm(work, { recursive: true, force: true }); }
  }
}

/** Copy across the OS boundary explicitly; shared folders cannot carry sockets. */
export async function loadRuntimeArchive(archive: string, options: RuntimeHostOptions): Promise<void> {
  if (!usesLima(options)) { await runtimeDocker(["load", "--input", archive], options, 10 * 60_000); return; }
  const work = (await runtimeExec("mktemp", ["-d", "/tmp/humanish-image-XXXXXX"], options)).stdout.trim();
  try {
    await hostExec("limactl", ["copy", archive, `${LIMA_INSTANCE}:${work}/runtime.tar.gz`], options, 10 * 60_000);
    await runtimeDocker(["load", "--input", `${work}/runtime.tar.gz`], options, 10 * 60_000);
  } finally {
    // Cancellation must not skip removal of this invocation's copied archive.
    const { signal: _signal, ...cleanup } = options;
    await runtimeExec("rm", ["-rf", "--", work], cleanup);
  }
}
