import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  abort: new AbortController(), replyLost: false, started: false,
  containers: new Set<string>(), volumes: new Set<string>(), remoteDirectory: false,
  localDirectory: "", tunnelClosed: false,
  id: "a".repeat(64), remote: "/tmp/humanish-fc-synthetic"
}));

vi.mock("../src/local-runtime-host.js", () => ({
  usesLima: () => true,
  runtimeExec: async (file: string, args: string[]) => {
    if (file === "mktemp") { state.remoteDirectory = true; return { stdout: state.remote }; }
    if (file === "id") return { stdout: "1000" };
    if (file === "cat" && args[0] === `${state.remote}/container-id`) return { stdout: state.id };
    if (file === "rm" && args.at(-1) === state.remote) { state.remoteDirectory = false; return { stdout: "" }; }
    throw new Error("Unexpected remote operation");
  },
  runtimeDocker: async (args: string[]) => {
    if (args[0] === "create") {
      state.containers.add(state.id); state.volumes.add("owned-state");
      if (state.replyLost) throw new Error("Docker create reply interrupted");
      state.abort.abort(new Error("Cancelled during startup"));
      return { stdout: state.id };
    }
    if (args[0] === "start") { state.started = true; throw new Error("Cancelled VM must not start"); }
    if (args[0] === "logs") return { stdout: "", stderr: "" };
    if (args.join(" ") === `rm --force --volumes ${state.id}`) {
      state.containers.delete(state.id); state.volumes.delete("owned-state");
      return { stdout: "" };
    }
    throw new Error("Unexpected Docker operation");
  }
}));
vi.mock("../src/local-runtime-ssh.js", () => ({
  openLimaTunnel: async ({ work }: { work: string }) => {
    state.localDirectory = work;
    return { close: async () => { state.tunnelClosed = true; return true; } };
  }
}));

import { createLocalFirecrackerDesktop } from "../src/local-firecracker-desktop.js";

let output: string;
beforeEach(async () => {
  Object.assign(state, { abort: new AbortController(), replyLost: false, started: false,
    containers: new Set(["unrelated"]), volumes: new Set(["unrelated-state"]),
    remoteDirectory: false, localDirectory: "", tunnelClosed: false });
  output = await mkdtemp(path.join(tmpdir(), "humanish-startup-test-"));
});
afterEach(async () => {
  await rm(output, { recursive: true, force: true });
  if (state.localDirectory) await rm(state.localDirectory, { recursive: true, force: true });
});

describe("Lima interrupted desktop startup", () => {
  it.each([false, true])("releases owned resources when create reply is lost: %s", async replyLost => {
    state.replyLost = replyLost;
    await expect(createLocalFirecrackerDesktop({
      assets: { image: "synthetic-runtime", runtimeRevision: "guest-api1-synthetic" },
      appUrl: "http://127.0.0.1:3000/", outputRoot: output, signal: state.abort.signal
    })).rejects.toThrow(replyLost ? "Docker create reply interrupted" : "Cancelled during startup");
    expect(state.started).toBe(false);
    expect(state.containers).toEqual(new Set(["unrelated"]));
    expect(state.volumes).toEqual(new Set(["unrelated-state"]));
    expect(state.remoteDirectory).toBe(false);
    expect(state.tunnelClosed).toBe(true);
    await expect(readdir(state.localDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
