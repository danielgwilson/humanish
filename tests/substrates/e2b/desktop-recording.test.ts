import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { startE2BDesktopRecording } from "../../../src/substrates/e2b/desktop-recording.js";
import type { E2BCommandResult, E2BDesktopSandbox } from "../../../src/substrates/e2b/sdk.js";

function destination(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
}

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MAP:URI="init.mp4"
#EXTINF:0.250000,
seg000000.m4s
#EXT-X-ENDLIST
`;

function recordingDesktop(playlist = PLAYLIST): {
  hangPlaylist: () => void;
  desktop: E2BDesktopSandbox;
  commands: string[];
  kill: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
} {
  let finishProcess: ((result: E2BCommandResult) => void) | undefined;
  const processExit = new Promise<E2BCommandResult>((resolve) => {
    finishProcess = resolve;
  });
  const commands: string[] = [];
  const kill = vi.fn(async () => {
    finishProcess?.({ exitCode: 137 });
    return true;
  });
  let playlistHangs = false;
  const run = vi.fn(async (command: string): Promise<E2BCommandResult> => {
    commands.push(command);
    if (playlistHangs && command.includes("index.m3u8") && command.startsWith("cat "))
      return new Promise<E2BCommandResult>(() => {});
    if (command.includes("'/usr/bin/ffmpeg' '-nostdin'")) {
      return { pid: 741, wait: () => processExit, kill };
    }
    if (command === "cat '/tmp/humanish-desktop-recording.pid'")
      return { exitCode: 0, stdout: "742\n" };
    if (command === "kill -INT -- 742") {
      finishProcess?.({ exitCode: 255 });
      return { exitCode: 0 };
    }
    if (command === "cat '/tmp/humanish-desktop-recording/index.m3u8'")
      return { exitCode: 0, stdout: playlist };
    return { exitCode: 0 };
  });
  const desktop = {
    sandboxId: "fake-sandbox-owned",
    commands: { run },
    files: {
      read: vi.fn(
        async (path: string) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from(path.endsWith("init.mp4") ? "abc" : "def"));
              controller.close();
            },
          }),
      ),
      write: vi.fn(),
    },
    wait: vi.fn(async () => {}),
    launch: vi.fn(),
    screenshot: vi.fn(),
    stream: { getAuthKey: vi.fn(), getUrl: vi.fn(), start: vi.fn() },
  } as unknown as E2BDesktopSandbox;
  return {
    desktop,
    commands,
    kill,
    run,
    hangPlaylist: () => {
      playlistHangs = true;
    },
  };
}

describe("E2B desktop recording", () => {
  it("finalizes the exact owned FFmpeg process and streams an audio recording", async () => {
    const { desktop, commands, kill } = recordingDesktop();
    const recording = await startE2BDesktopRecording({
      desktop,
      width: 960,
      height: 720,
      audio: true,
      requestTimeoutMs: 10_000,
    });
    const chunks: Buffer[] = [];
    const metadata = await recording.finish(destination(chunks));

    expect(Buffer.concat(chunks).toString()).toBe("abcdef");
    expect(metadata).toMatchObject({
      mimeType: "video/mp4",
      durationMs: 250,
      bytes: 6,
      audioSources: ["microphone-input", "speaker-output"],
      complete: true,
    });
    const ffmpeg = commands.find((command) => command.includes("'/usr/bin/ffmpeg' '-nostdin'"));
    expect(ffmpeg).toContain("'humanish_recording.monitor'");
    expect(ffmpeg).not.toContain("amix");
    expect(
      commands.some((command) =>
        command.includes("'module-loopback' 'source=humanish_mic.monitor'"),
      ),
    ).toBe(true);
    expect(
      commands.some((command) =>
        command.includes("'module-loopback' 'source=humanish_speaker.monitor'"),
      ),
    ).toBe(true);
    expect(commands).toContain("kill -INT -- 742");
    expect(commands.indexOf("kill -INT -- 742")).toBeLessThan(
      commands.lastIndexOf("cat '/tmp/humanish-desktop-recording/index.m3u8'"),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("delivers the segments it copied when the sandbox dies before the stop", async () => {
    vi.useFakeTimers();
    try {
      const { desktop, run, kill, commands } = recordingDesktop();
      const recording = await startE2BDesktopRecording({
        desktop,
        width: 960,
        height: 720,
        audio: false,
        requestTimeoutMs: 10_000,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() =>
        expect(commands.some((command) => command.startsWith("rm -f --"))).toBe(true),
      );
      run.mockRejectedValue(new Error("sandbox is gone"));
      kill.mockRejectedValue(new Error("sandbox is gone"));
      const chunks: Buffer[] = [];
      const finished = recording.finish(destination(chunks));
      await vi.advanceTimersByTimeAsync(20_000);
      vi.useRealTimers();
      const metadata = await finished;

      expect(Buffer.concat(chunks).toString()).toBe("abcdef");
      expect(metadata).toMatchObject({ bytes: 6, durationMs: 250, complete: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the recorder when the copied video reaches its size limit", async () => {
    vi.useFakeTimers();
    try {
      const { desktop, commands } = recordingDesktop(
        PLAYLIST.replace("#EXT-X-ENDLIST\n", "#EXTINF:0.25,\nseg000001.m4s\n"),
      );
      const recording = await startE2BDesktopRecording({
        desktop,
        width: 960,
        height: 720,
        audio: false,
        requestTimeoutMs: 10_000,
        maxBytes: 6,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(commands).toContain("kill -INT -- 742"));
      vi.useRealTimers();
      const chunks: Buffer[] = [];
      const metadata = await recording.finish(destination(chunks));
      expect(Buffer.concat(chunks).toString()).toBe("abcdef");
      expect(metadata).toMatchObject({ bytes: 6, complete: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes when a sandbox call never answers", async () => {
    vi.useFakeTimers();
    try {
      const { desktop, hangPlaylist, commands } = recordingDesktop(
        PLAYLIST.replace("#EXT-X-ENDLIST\n", ""),
      );
      const recording = await startE2BDesktopRecording({
        desktop,
        width: 960,
        height: 720,
        audio: false,
        requestTimeoutMs: 10_000,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() =>
        expect(commands.some((command) => command.startsWith("rm -f --"))).toBe(true),
      );
      hangPlaylist();
      const chunks: Buffer[] = [];
      const finished = recording.finish(destination(chunks));
      await vi.advanceTimersByTimeAsync(20_000);
      vi.useRealTimers();
      const metadata = await finished;
      expect(Buffer.concat(chunks).toString()).toBe("abcdef");
      expect(metadata.complete).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("E2B desktop recording setup", () => {
  it("records video without starting Pulse or adding audio inputs", async () => {
    const { desktop, commands } = recordingDesktop();
    const recording = await startE2BDesktopRecording({
      desktop,
      width: 640,
      height: 480,
      audio: false,
      requestTimeoutMs: 10_000,
    });
    const metadata = await recording.finish(destination([]));

    expect(commands.some((command) => command.includes("pulseaudio"))).toBe(false);
    const ffmpeg = commands.find((command) => command.includes("'/usr/bin/ffmpeg' '-nostdin'"));
    expect(ffmpeg).not.toContain("humanish_mic.monitor");
    expect(ffmpeg).not.toContain("humanish_speaker.monitor");
    expect(metadata.audioSources).toEqual([]);
  });

  it("fails before launch when streamed retrieval is unavailable", async () => {
    const { desktop, commands } = recordingDesktop();
    delete desktop.files.read;
    await expect(
      startE2BDesktopRecording({
        desktop,
        width: 960,
        height: 720,
        audio: false,
        requestTimeoutMs: 10_000,
      }),
    ).rejects.toThrow("does not support streamed recording retrieval");
    expect(commands).toEqual([]);
  });

  it("reclaims partially started owned Pulse when audio setup fails", async () => {
    const { desktop, commands, run } = recordingDesktop();
    run.mockRejectedValueOnce(new Error("setup failed"));
    await expect(
      startE2BDesktopRecording({
        desktop,
        width: 960,
        height: 720,
        audio: true,
        requestTimeoutMs: 10_000,
      }),
    ).rejects.toThrow("setup failed");
    expect(commands.at(-1)).toBe("pulseaudio --kill");
  });
});
