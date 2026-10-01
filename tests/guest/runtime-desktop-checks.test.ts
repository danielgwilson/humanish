import { describe, expect, it } from "vitest";
import {
  chromiumLaunchArgs,
  desktopMediaRequest,
  isAdequatelySandboxed,
  isPinnedOpenboxConfig,
  isPrivateGuestDirectory,
  recorderAudio,
} from "../../src/guest/runtime-desktop.js";

const directory = {
  isDirectory: () => true,
  isSymbolicLink: () => false,
  uid: 1000,
  gid: 1000,
  mode: 0o40700,
};
const config = { isFile: () => true, uid: 0, gid: 0, nlink: 1, size: 4096, mode: 0o100444 };
const SANDBOXED =
  "PID namespaces Yes\nNetwork namespaces Yes\nSeccomp-BPF sandbox Yes\nYou are adequately sandboxed.";

describe("guest runtime desktop checks", () => {
  it("admits only a private guest-owned directory", () => {
    expect(isPrivateGuestDirectory(directory)).toBe(true);
    for (const change of [
      { isDirectory: () => false },
      { isSymbolicLink: () => true },
      { uid: 0 },
      { gid: 0 },
      { mode: 0o40750 },
      { mode: 0o40500 },
    ])
      expect(isPrivateGuestDirectory({ ...directory, ...change }), JSON.stringify(change)).toBe(
        false,
      );
  });

  it("admits only the root-owned read-only single-link config up to 4 KiB", () => {
    expect(isPinnedOpenboxConfig(config)).toBe(true);
    for (const change of [
      { isFile: () => false },
      { uid: 1000 },
      { gid: 1000 },
      { nlink: 2 },
      { size: 4097 },
      { mode: 0o100644 },
      { mode: 0o100555 },
    ])
      expect(isPinnedOpenboxConfig({ ...config, ...change }), JSON.stringify(change)).toBe(false);
  });

  it("requires every sandbox feature and the overall verdict", () => {
    expect(isAdequatelySandboxed(SANDBOXED)).toBe(true);
    expect(isAdequatelySandboxed(SANDBOXED.replace("\n", "\t\n"))).toBe(true);
    for (const feature of ["PID namespaces", "Network namespaces", "Seccomp-BPF sandbox"])
      expect(isAdequatelySandboxed(SANDBOXED.replace(`${feature} Yes`, `${feature} No`))).toBe(
        false,
      );
    expect(isAdequatelySandboxed(SANDBOXED.replace("You are adequately", "You are not"))).toBe(
      false,
    );
  });

  it("adds the fake media UI flag only when permission is granted", () => {
    const base = chromiumLaunchArgs(undefined);
    expect(base).toEqual([
      "--window-size=960,680",
      "--window-position=0,20",
      "--disable-background-networking",
      "--disable-component-update",
      "--no-first-run",
    ]);
    const microphone = { source: "speech" } as const;
    expect(chromiumLaunchArgs({ microphone, permission: "prompt" })).toEqual(base);
    expect(chromiumLaunchArgs({ microphone, permission: "granted" })).toEqual([
      ...base,
      "--use-fake-ui-for-media-stream",
    ]);
  });

  it("requests only the declared devices", () => {
    const camera = { source: "synthetic" } as const;
    const microphone = { source: "speech" } as const;
    expect(desktopMediaRequest({ camera, permission: "granted" })).toEqual({ camera });
    expect(desktopMediaRequest({ microphone, permission: "prompt" })).toEqual({ microphone });
    expect(desktopMediaRequest({ camera, microphone, permission: "prompt" })).toEqual({
      camera,
      microphone,
    });
  });

  it("records audio only when asked and marks Pulse ready only with a microphone", () => {
    const microphone = { microphone: { source: "speech" }, permission: "prompt" } as const;
    const camera = { camera: { source: "synthetic" }, permission: "prompt" } as const;
    expect(recorderAudio({ audio: false }, microphone)).toEqual({
      audioSources: [],
      pulseReady: false,
    });
    expect(recorderAudio({ audio: true }, microphone)).toEqual({
      audioSources: ["microphone-input", "speaker-output"],
      pulseReady: true,
    });
    expect(recorderAudio({ audio: true }, camera)).toMatchObject({ pulseReady: false });
    expect(recorderAudio({ audio: true }, undefined)).toMatchObject({ pulseReady: false });
  });
});
