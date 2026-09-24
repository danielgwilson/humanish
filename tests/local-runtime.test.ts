import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ installed: false, daemon: true, kvm: true, endpoint: "unix:///var/run/docker.sock", loads: 0, chip: "Apple M5 Max", lima: "Running", arch: "amd64", commands: [] as string[], calls: [] as string[][] }));
vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
  access: async () => { if (!state.kvm) throw new Error("missing device"); }
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => undefined, { [promisify.custom]: async (_file: string, args: string[]) => {
    state.commands.push(_file + " " + args.join(" "));
    if (_file === "sysctl") return { stdout: state.chip };
    if (_file === "limactl") {
      if (args[0] === "--version") return { stdout: "limactl version 2.2.0" };
      if (args[0] === "list") return { stdout: state.lima === "missing" ? "" : JSON.stringify({ name: "humanish-runtime", status: state.lima, vmType: "vz", arch: "aarch64" }) };
      if (args[0] === "shell") {
        if (args.includes("test -c /dev/kvm && test -c /dev/net/tun")) { if (!state.kvm) throw new Error("missing device"); return { stdout: "" }; }
        args = args.slice(args.indexOf("docker") + 3);
      }
    }
    state.calls.push(args);
    if (!state.daemon) throw new Error("Docker unavailable");
    if (args[0] === "context") return { stdout: JSON.stringify(state.endpoint) };
    if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: state.arch === "amd64" ? "x86_64" : "aarch64", SecurityOptions: [] }) };
    if (args[0] === "load") { state.loads++; state.installed = true; return { stdout: "Loaded image" }; }
    if (!state.installed) throw new Error("No such image");
    // Fields read from an actual Docker image inspect response, with synthetic identity.
    return { stdout: JSON.stringify([{ Id: "sha256:" + "a".repeat(64), Os: "linux", Architecture: state.arch,
      Config: { Labels: { "to.humanish.runtime.api": "1", "to.humanish.runtime.revision": "guest-api1-" + "b".repeat(64) } } }]) };
  } });
  return { execFile };
});
import { localRuntimeStatus, prepareLocalRuntime } from "../src/local-runtime.js";

const bytes = Buffer.from("synthetic Docker archive; Docker itself is mocked");
const release = { url: "https://example.test/runtime.tar.gz", image: "sha256:" + "a".repeat(64),
  bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const options = { env: {}, release };

describe("local runtime preparation", () => {
  beforeEach(() => {
    Object.assign(state, { installed: false, daemon: true, kvm: true, endpoint: "unix:///var/run/docker.sock", loads: 0, chip: "Apple M5 Max", lima: "Running", arch: "amd64", commands: [], calls: [] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("inspects the Lima Docker engine without using a Mac Docker context", async () => {
    state.arch = "arm64"; state.installed = true;
    expect(await localRuntimeStatus({ ...options, platform: "darwin", arch: "arm64",
      env: { DOCKER_HOST: "ssh://unrelated.example.test" } })).toMatchObject({ ok: true, installed: true });
    expect(state.commands.some(command => command.startsWith("docker "))).toBe(false);
    expect(state.commands.some(command => command.includes("sudo -n docker --host unix:///var/run/docker.sock"))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["missing", "Stopped"])("keeps %s Lima status read-only", async lima => {
    state.lima = lima;
    expect(await localRuntimeStatus({ ...options, platform: "darwin", arch: "arm64" }))
      .toMatchObject({ ok: true, installed: false, message: expect.stringContaining("runtime setup") });
    expect(state.calls).toEqual([]);
    expect(state.commands.some(command => command.includes("start"))).toBe(false);
  });
  it("refuses Macs without nested virtualization before starting Lima", async () => {
    state.chip = "Apple M2 Max";
    await expect(prepareLocalRuntime({ ...options, platform: "darwin", arch: "arm64" })).rejects.toThrow("M3");
    expect(state.commands).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a Rosetta or Intel Node process before preparing a Lima host", async () => {
    await expect(prepareLocalRuntime({ ...options, platform: "darwin", arch: "x64" })).rejects.toThrow("M3");
    expect(state.commands).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("read-only status reports preparation without downloading or loading", async () => {
    expect(await localRuntimeStatus(options)).toMatchObject({ ok: true, installed: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(state.loads).toBe(0);
  });
  it("verifies an archive before Docker load and reuses the installed image", async () => {
    expect(await prepareLocalRuntime(options)).toMatchObject({ image: release.image });
    expect(state.loads).toBe(1);
    await prepareLocalRuntime(options);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.loads).toBe(1);
  });
  it.each(["checksum", "size"])("refuses a %s mismatch without invoking Docker load", async mismatch => {
    await expect(prepareLocalRuntime({ ...options, release: { ...release,
      ...(mismatch === "checksum" ? { sha256: "f".repeat(64) } : { bytes: bytes.length - 1 }) } })).rejects.toThrow();
    expect(state.loads).toBe(0);
  });
  it("reports a missing device before any Docker call", async () => {
    state.kvm = false;
    expect(await localRuntimeStatus(options)).toMatchObject({ ok: false, message: expect.stringContaining("KVM") });
    expect(state.calls).toEqual([]);
  });
  it("reports an unavailable daemon without attempting a download", async () => {
    state.daemon = false;
    await expect(prepareLocalRuntime(options)).rejects.toThrow("Docker is unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a remote Docker context before downloading or starting a container", async () => {
    state.endpoint = "ssh://example.test";
    await expect(prepareLocalRuntime(options)).rejects.toThrow("local Docker context");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not replace a missing explicitly selected source-build image with a release", async () => {
    await expect(prepareLocalRuntime({ ...options, env: { HUMANISH_LOCAL_RUNTIME_IMAGE: "local-build:test" } })).rejects.toThrow("already-built");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not invoke Docker load after a cancelled download", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareLocalRuntime({ ...options, signal: controller.signal })).rejects.toThrow();
    expect(state.loads).toBe(0);
  });
});
