import { describe, expect, it, vi } from "vitest";
import { startE2BDesktopMedia } from "../src/e2b-desktop-media.js";
import type { E2BCommandRunOptions, E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";

// SDK 2.4 streaming lifecycle checked against a live disposable desktop: run with
// background+stdin, onStdout, sendStdin, closeStdin, wait. No provider HTTP fixture.
function fixture() {
  let options: E2BCommandRunOptions | undefined;
  let finish!: () => void;
  const exited = new Promise<void>(resolve => { finish = resolve; });
  const handle = {
    sendStdin: vi.fn(async (data: string | Uint8Array) => {
      const command = JSON.parse(Buffer.from(data).toString());
      await options?.onStdout?.(JSON.stringify({ type: "reply", id: command.id, ok: true }) + "\n");
    }),
    closeStdin: vi.fn(async () => { finish(); }),
    wait: async () => { await exited; return { exitCode: 0 }; },
    kill: vi.fn(async () => { finish(); return true; })
  };
  const run = vi.fn(async (_command: string, given?: E2BCommandRunOptions) => {
    options = given;
    await options?.onStdout?.('{"type":"ready"}\n');
    return handle;
  });
  return { desktop: { commands: { run } } as unknown as E2BDesktopSandbox, handle, run,
    emit: async (value: unknown) => { await options?.onStdout?.(JSON.stringify(value) + "\n"); } };
}

describe("hosted speech transport", () => {
  it("uses the shared worker with native Pulse and sends text through stdin, then closes it", async () => {
    const f = fixture();
    const media = await startE2BDesktopMedia({ desktop: f.desktop, media: { microphone: { source: "speech" } },
      signal: new AbortController().signal, onTerminal: vi.fn(), requestTimeoutMs: 5000 });
    expect(f.run).toHaveBeenCalledWith("node /opt/humanish/media/guest-media-worker.js", expect.objectContaining({
      background: true, stdin: true, envs: expect.objectContaining({ PULSE_SOURCE: "humanish_input", HUMANISH_MEDIA_MICROPHONE: "1" })
    }));
    const executor = media.wrap({ observe: async () => ({ stateSignature: "same" }), execute: async () => {} });
    const text = "Hello. $(not a shell command)";
    await executor.execute({ kind: "speak", text });
    expect(JSON.parse(Buffer.from(f.handle.sendStdin.mock.calls[0]![0]).toString())).toMatchObject({ operation: "speak", text });
    await f.emit({ type: "heard", utterance: { id: "one", source: "speaker_audio", text: "I heard you.", durationMs: 1100 } });
    expect((await executor.observe()).heardSpeech?.[0]?.text).toBe("I heard you.");
    await media.close(); await media.close();
    expect(f.handle.closeStdin).toHaveBeenCalledOnce();
    expect(f.handle.kill).not.toHaveBeenCalled();
  });

  it("settles worker cleanup when EOF stalls and the SDK kill rejects", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.handle.closeStdin.mockImplementation(async () => {});
      f.handle.kill.mockRejectedValue(new Error("sandbox disconnected"));
      const media = await startE2BDesktopMedia({ desktop: f.desktop, media: { microphone: { source: "speech" } },
        signal: new AbortController().signal, onTerminal: vi.fn(), requestTimeoutMs: 5000 });
      const closed = media.close();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(closed).resolves.toBeUndefined();
      expect(f.handle.kill).toHaveBeenCalledOnce();
      await media.close();
      expect(f.handle.closeStdin).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("refuses the conflicting hosted camera before starting a worker", async () => {
    const f = fixture();
    await expect(startE2BDesktopMedia({ desktop: f.desktop, media: { camera: { source: "synthetic" }, microphone: { source: "speech" } },
      signal: new AbortController().signal, onTerminal: vi.fn(), requestTimeoutMs: 5000 })).rejects.toThrow("cannot be combined");
    expect(f.run).not.toHaveBeenCalled();
  });
});
