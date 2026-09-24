import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ installed: false, daemon: true, kvm: true, endpoint: "unix:///var/run/docker.sock", loads: 0, calls: [] as string[][] }));
vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
  access: async () => { if (!state.kvm) throw new Error("missing device"); }
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => undefined, { [promisify.custom]: async (_file: string, args: string[]) => {
    state.calls.push(args);
    if (!state.daemon) throw new Error("Docker unavailable");
    if (args[0] === "context") return { stdout: JSON.stringify(state.endpoint) };
    if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: "x86_64", SecurityOptions: [] }) };
    if (args[0] === "load") { state.loads++; state.installed = true; return { stdout: "Loaded image" }; }
    if (!state.installed) throw new Error("No such image");
    // Fields read from an actual Docker image inspect response, with synthetic identity.
    return { stdout: JSON.stringify([{ Id: "sha256:" + "a".repeat(64), Os: "linux", Architecture: "amd64",
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
    Object.assign(state, { installed: false, daemon: true, kvm: true, endpoint: "unix:///var/run/docker.sock", loads: 0, calls: [] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
  });
  afterEach(() => vi.unstubAllGlobals());

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
