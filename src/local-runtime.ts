import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LocalFirecrackerAssets } from "./local-firecracker-desktop.js";
import { LOCAL_RUNTIME_RELEASES } from "./local-runtime-release.js";
import { limaStatus, loadRuntimeArchive, prepareLima, runtimeArchitecture, runtimeDocker, runtimeExec, usesLima, type RuntimeHostOptions } from "./local-runtime-host.js";

export interface LocalRuntimeRelease { url: string; sha256: string; bytes: number; image: string }
export interface LocalRuntimeStatus {
  ok: boolean;
  installed: boolean;
  message: string;
  assets?: LocalFirecrackerAssets;
}
interface RuntimeOptions extends RuntimeHostOptions {
  progress?: (message: string) => void;
  /** Explicit source-build/test override; never provided by a participant. */
  release?: LocalRuntimeRelease;
}
const docker = async (args: string[], options: RuntimeOptions): Promise<string> =>
  (await runtimeDocker(args, options)).stdout.trim();
const runtimeRelease = (options: RuntimeOptions): LocalRuntimeRelease | undefined =>
  options.release ?? LOCAL_RUNTIME_RELEASES[runtimeArchitecture(options) ?? "amd64"];

/** Read-only host and cache inspection. Never pulls an image or starts a container. */
export async function localRuntimeStatus(options: RuntimeOptions = {}): Promise<LocalRuntimeStatus> {
  const architecture = runtimeArchitecture(options), lima = usesLima(options);
  if (!architecture) return { ok: false, installed: false, message: "Local browsers need Linux x64/ARM64 or an M3-or-newer Mac with Lima." };
  if (lima) {
    try {
      const status = await limaStatus(options);
      if (!status.ready) return { ok: true, installed: false, message: status.message };
    } catch (error) { return { ok: false, installed: false, message: (error as Error).message }; }
  }
  const env = options.env ?? process.env;
  if (!lima && env.DOCKER_HOST && !env.DOCKER_HOST.startsWith("unix://")) {
    return { ok: false, installed: false, message: "Local browsers need Docker on this machine; a remote DOCKER_HOST cannot reach the local app and control socket." };
  }
  try {
    if (lima) await runtimeExec("sh", ["-c", "test -c /dev/kvm && test -c /dev/net/tun"], options);
    else { await access("/dev/kvm"); await access("/dev/net/tun"); }
  }
  catch { return { ok: false, installed: false, message: "Local browsers need Linux KVM (/dev/kvm) and TUN (/dev/net/tun). Enable virtualization on this host." }; }
  try {
    if (!lima && (env.DOCKER_CONTEXT || !env.DOCKER_HOST)) {
      const endpoint = JSON.parse(await docker(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], options));
      if (typeof endpoint !== "string" || !endpoint.startsWith("unix://")) {
        return { ok: false, installed: false, message: "Select a local Docker context. Remote Docker cannot reach the local app and control socket." };
      }
    }
    const info = JSON.parse(await docker(["info", "--format", "{{json .}}"], options));
    if (info.OSType !== "linux" || !(architecture === "amd64" ? ["x86_64", "amd64"] : ["aarch64", "arm64"]).includes(info.Architecture) ||
      info.SecurityOptions?.some((value: string) => value.includes("rootless"))) {
      return { ok: false, installed: false, message: "Local browsers need a local, rootful Linux Docker engine of the matching architecture with KVM access." };
    }
  } catch {
    return { ok: false, installed: false, message: lima
      ? "Docker is unavailable inside the Humanish Lima host. Check limactl shell humanish-runtime -- sudo systemctl status docker; Docker Desktop is not used."
      : "Docker is unavailable. Install/start Docker Engine and give your account access, then run humanish runtime setup." };
  }
  const release = runtimeRelease(options);
  const reference = env.HUMANISH_LOCAL_RUNTIME_IMAGE?.trim() || release?.image;
  if (!reference) return { ok: false, installed: false, message: "This build does not include a published local runtime. Source builds can set HUMANISH_LOCAL_RUNTIME_IMAGE." };
  let images;
  try { images = JSON.parse(await docker(["image", "inspect", reference], options)); }
  catch {
    return env.HUMANISH_LOCAL_RUNTIME_IMAGE?.trim()
      ? { ok: false, installed: false, message: "HUMANISH_LOCAL_RUNTIME_IMAGE must name an already-built local image. Build or load it before running." }
      : { ok: true, installed: false, message: "Local runtime will download before the first live run. Run humanish runtime setup to prepare it now." };
  }
  const image = images[0];
  const labels = image?.Config?.Labels ?? {};
  const revision = labels["to.humanish.runtime.revision"];
  if (image?.Os !== "linux" || image.Architecture !== architecture || labels["to.humanish.runtime.api"] !== "1" ||
    typeof revision !== "string" || !/^guest-api1-[a-f0-9]{64}$/.test(revision)) {
    return { ok: false, installed: false, message: "The cached image is not a compatible Humanish local browser runtime." };
  }
  return { ok: true, installed: true, message: "Local browser runtime is installed. No E2B key is needed.",
    assets: { image: image.Id, runtimeRevision: revision } };
}

/** Docker owns the installed image/cache. The archive is verified before docker load. */
export async function prepareLocalRuntime(options: RuntimeOptions = {}): Promise<LocalFirecrackerAssets> {
  if (usesLima(options)) await prepareLima(options, options.progress);
  const before = await localRuntimeStatus(options);
  if (!before.ok) throw new Error(before.message);
  if (before.assets) return before.assets;
  const release = runtimeRelease(options);
  if (!release) throw new Error(before.message);
  options.progress?.(`Downloading local browser runtime (${Math.ceil(release.bytes / 1024 / 1024)} MiB)…`);
  const work = await mkdtemp(path.join(tmpdir(), "humanish-runtime-download-"));
  const archive = path.join(work, "runtime.tar.gz");
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(options.signal ? [options.signal] : [])]);
  try {
    const response = await fetch(release.url, { signal });
    if (!response.ok || !response.body) throw new Error(`Runtime download failed (HTTP ${response.status}). Run humanish runtime setup to retry.`);
    let bytes = 0;
    const hash = createHash("sha256");
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > release.bytes) { done(new Error("Runtime archive exceeds its published size.")); return; }
        hash.update(chunk); done(null, chunk);
      }
    }), createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal });
    if (bytes !== release.bytes || hash.digest("hex") !== release.sha256) throw new Error("Runtime archive integrity check failed; it was not installed.");
    options.progress?.("Installing the local browser image…");
    await loadRuntimeArchive(archive, { ...options, signal });
    const after = await localRuntimeStatus(options);
    if (!after.assets) throw new Error("Downloaded runtime did not provide the expected image. Run humanish runtime setup to retry.");
    return after.assets;
  } finally { await rm(work, { recursive: true, force: true }); }
}
