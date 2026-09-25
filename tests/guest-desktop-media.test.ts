import { describe, expect, it, vi } from "vitest";
import type { CuaAction, CuaExecutor, CuaObservation } from "../src/computer-use.js";
import { startDesktopMedia, type DesktopMediaWorkerTransport } from "../src/guest-desktop-media.js";

class FakeTransport implements DesktopMediaWorkerTransport {
  handlers: { data(bytes: Buffer): void; exit(): void } | undefined;
  writes: unknown[] = [];
  closed = false;
  async start(options: { env: Readonly<Record<string, string>>; data(bytes: Buffer): void; exit(): void }): Promise<void> {
    expect(options.env).toMatchObject({ HUMANISH_MEDIA_MICROPHONE: "1" });
    this.handlers = options;
  }
  async write(bytes: Buffer): Promise<void> {
    const value = JSON.parse(bytes.toString("utf8")) as { id: string };
    this.writes.push(value);
    queueMicrotask(() => this.send({ type: "reply", id: value.id, ok: true }));
  }
  async close(): Promise<void> { this.closed = true; }
  send(value: unknown): void { this.handlers!.data(Buffer.from(JSON.stringify(value) + "\n")); }
}

function executor(): CuaExecutor {
  return { observe: vi.fn(async () => ({ stateSignature: "screen" })), execute: vi.fn(async () => {}) };
}

async function start(transport: FakeTransport, terminal = vi.fn()) {
  const pending = startDesktopMedia({ media: { microphone: { source: "speech" } }, env: { HOME: "/home/humanish" },
    signal: new AbortController().signal, onTerminal: terminal, transport });
  transport.send({ type: "ready" });
  return { media: await pending, terminal };
}

describe("guest desktop media", () => {
  it("sets native Pulse environment, speaks through the worker and drains bounded heard speech", async () => {
    const transport = new FakeTransport(), { media } = await start(transport), base = executor(), wrapped = media.wrap(base);
    expect(media.env).toMatchObject({ PULSE_SOURCE: "humanish_input", PULSE_SINK: "humanish_speaker", HUMANISH_MEDIA_MICROPHONE: "1" });
    expect((wrapped as CuaExecutor & { speechEnabled?: boolean }).speechEnabled).toBe(true);
    for (let index = 1; index <= 6; index++) transport.send({ type: "heard", utterance: {
      id: `speech-${index}`, source: "speaker_audio", text: `heard ${index}`, durationMs: 800 } });
    const first = await wrapped.observe() as CuaObservation & { heardSpeech?: unknown[] };
    const second = await wrapped.observe() as CuaObservation & { heardSpeech?: unknown[] };
    expect(first.heardSpeech).toHaveLength(4); expect(second.heardSpeech).toHaveLength(2);
    await wrapped.execute({ kind: "speak", text: "Hello from the participant." } as unknown as CuaAction);
    expect(transport.writes).toEqual([{ id: "speak-1", operation: "speak", text: "Hello from the participant." }]);
    expect(base.execute).not.toHaveBeenCalled();
    await media.close(); expect(transport.closed).toBe(true);
  });

  it("passes ordinary actions through and fails closed on an invalid worker event", async () => {
    const transport = new FakeTransport(), terminal = vi.fn(), { media } = await start(transport, terminal), base = executor(), wrapped = media.wrap(base);
    const action = { kind: "wait", ms: 10 } as CuaAction; await wrapped.execute(action);
    expect(base.execute).toHaveBeenCalledWith(action, undefined);
    transport.send({ type: "heard", utterance: { id: "bad", source: "speaker_audio", text: "", durationMs: 0 } });
    expect(terminal).toHaveBeenCalledOnce();
    await expect(wrapped.execute({ kind: "speak", text: "after failure" } as unknown as CuaAction)).rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
  });

  it("rejects unsupported declarations before starting the worker", async () => {
    const transport = new FakeTransport();
    await expect(startDesktopMedia({ media: { camera: { source: "clip.y4m" } }, env: {},
      signal: new AbortController().signal, onTerminal: vi.fn(), transport })).rejects.toMatchObject({ code: "invalid_request" });
    expect(transport.handlers).toBeUndefined();
  });
});
