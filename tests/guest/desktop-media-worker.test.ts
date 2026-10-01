import { afterEach, describe, expect, it, vi } from "vitest";
import type { CuaAction, CuaExecutor, CuaObservation } from "../../src/actors/computer-use/loop.js";
import { CUA_SPEECH_LIMITS } from "../../src/actors/computer-use/speech.js";
import {
  startDesktopMedia,
  type DesktopMediaWorkerTransport,
  type GuestDesktopMediaOptions,
} from "../../src/guest/desktop-media.js";

// Characterizes startDesktopMedia through its transport seam: worker framing, message handling,
// readiness, close and the speak path. Nothing here depends on how the function is split.

type Reply = "ok" | "refuse" | "none" | "fail";
class FakeTransport implements DesktopMediaWorkerTransport {
  handlers: { data(bytes: Buffer): void; exit(): void } | undefined;
  env: Readonly<Record<string, string>> | undefined;
  writes: { id: string; operation: string; text: string }[] = [];
  closes = 0;
  reply: Reply = "ok";
  startError: Error | undefined;
  onStart: (() => void) | undefined;
  async start(options: {
    env: Readonly<Record<string, string>>;
    data(bytes: Buffer): void;
    exit(): void;
  }): Promise<void> {
    this.env = options.env;
    this.handlers = options;
    this.onStart?.();
    if (this.startError) throw this.startError;
  }
  async write(bytes: Buffer): Promise<void> {
    if (this.reply === "fail") throw new Error("pipe closed");
    const value = JSON.parse(bytes.toString("utf8")) as {
      id: string;
      operation: string;
      text: string;
    };
    this.writes.push(value);
    if (this.reply === "ok" || this.reply === "refuse")
      queueMicrotask(() => this.send({ type: "reply", id: value.id, ok: this.reply === "ok" }));
  }
  async close(): Promise<void> {
    this.closes++;
  }
  raw(text: string): void {
    this.handlers!.data(Buffer.from(text));
  }
  send(value: unknown): void {
    this.raw(JSON.stringify(value) + "\n");
  }
}

const MICROPHONE = { microphone: { source: "speech" } };
const READY = JSON.stringify({ type: "ready" });
const utterance = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  source: "speaker_audio",
  text: `heard ${id}`,
  durationMs: 500,
  ...extra,
});
const base = (): CuaExecutor => ({
  observe: vi.fn(async () => ({ stateSignature: "screen" })),
  execute: vi.fn(async () => {}),
});
const speak = (text: unknown) => ({ kind: "speak", text }) as unknown as CuaAction;

function begin(options: Partial<GuestDesktopMediaOptions> = {}, transport = new FakeTransport()) {
  const owner = new AbortController();
  const onTerminal = vi.fn();
  const pending = startDesktopMedia({
    media: MICROPHONE,
    env: { HOME: "/home/participant-home" },
    signal: owner.signal,
    onTerminal,
    transport,
    ...options,
  });
  const settled = pending.then(
    (media) => ({ media }),
    (error: unknown) => ({ error }),
  );
  return { pending, settled, owner, onTerminal, transport };
}
async function ready(options: Partial<GuestDesktopMediaOptions> = {}) {
  const started = begin(options);
  await vi.waitFor(() => expect(started.transport.handlers).toBeDefined());
  started.transport.send({ type: "ready" });
  const media = await started.pending;
  return { ...started, media };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop media declarations and env", () => {
  it.each([[{ camera: { source: "clip.y4m" } }], [{ microphone: { source: "file" } }], [{}]])(
    "refuses %j before starting the worker",
    async (media) => {
      const { pending, transport } = begin({ media });
      await expect(pending).rejects.toMatchObject({
        code: "invalid_request",
        disposition: "not_dispatched",
      });
      expect(transport.handlers).toBeUndefined();
    },
  );

  it("refuses a pre-aborted owner before starting the worker", async () => {
    const transport = new FakeTransport();
    const owner = new AbortController();
    owner.abort();
    await expect(
      startDesktopMedia({
        media: MICROPHONE,
        env: {},
        signal: owner.signal,
        onTerminal: vi.fn(),
        transport,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.handlers).toBeUndefined();
  });

  it("sets camera and Pulse variables from the declaration and the runtime dir", async () => {
    const camera = await ready({ media: { camera: { source: "synthetic" } }, env: { A: "1" } });
    expect(camera.transport.env).toEqual({
      A: "1",
      HUMANISH_MEDIA_CAMERA: "1",
      HUMANISH_MEDIA_MICROPHONE: "0",
    });
    expect(camera.media.env).toBe(camera.transport.env);
    const both = await ready({
      media: { camera: { source: "synthetic" }, microphone: { source: "speech" } },
      env: { XDG_RUNTIME_DIR: "/run/xdg-test" },
    });
    expect(both.transport.env).toEqual({
      XDG_RUNTIME_DIR: "/run/xdg-test",
      HUMANISH_MEDIA_CAMERA: "1",
      HUMANISH_MEDIA_MICROPHONE: "1",
      PULSE_SERVER: "unix:/run/xdg-test/pulse/native",
      PULSE_SOURCE: "humanish_input",
      PULSE_SINK: "humanish_speaker",
    });
    const fallback = await ready({ env: {} });
    expect(fallback.transport.env!.PULSE_SERVER).toBe("unix:/run/humanish/xdg/pulse/native");
  });
});

describe("desktop media worker framing", () => {
  it("joins a line split across chunks", async () => {
    const { settled, transport } = begin();
    await vi.waitFor(() => expect(transport.handlers).toBeDefined());
    transport.raw(READY.slice(0, 5));
    transport.raw(READY.slice(5) + "\n");
    expect(await settled).toHaveProperty("media");
  });

  it("accepts an 8192-byte line and terminates on 8193", async () => {
    const exact = begin();
    await vi.waitFor(() => expect(exact.transport.handlers).toBeDefined());
    exact.transport.raw(READY.padEnd(8192, " ") + "\n");
    expect(await exact.settled).toHaveProperty("media");
    const over = await ready();
    over.transport.raw(
      JSON.stringify({ type: "heard", utterance: utterance("a") }).padEnd(8193, " ") + "\n",
    );
    expect(over.onTerminal).toHaveBeenCalledOnce();
  });

  it("terminates on a chunk over 8 KiB with no newline, but not at exactly 8 KiB", async () => {
    const { transport, onTerminal } = await ready();
    transport.raw("x".repeat(8192));
    expect(onTerminal).not.toHaveBeenCalled();
    transport.raw("x");
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("leaves a tail over 8 KiB after a newline until the next chunk", async () => {
    const { settled, transport, onTerminal } = begin();
    await vi.waitFor(() => expect(transport.handlers).toBeDefined());
    transport.raw(READY + "\n" + "x".repeat(9000));
    expect(await settled).toHaveProperty("media");
    expect(onTerminal).not.toHaveBeenCalled();
    transport.raw("y");
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("terminates once on invalid JSON and ignores data after it", async () => {
    const { transport, onTerminal, media } = await ready();
    transport.raw(
      "not json\n" + JSON.stringify({ type: "heard", utterance: utterance("late") }) + "\n",
    );
    transport.send({ type: "heard", utterance: utterance("later") });
    expect(onTerminal).toHaveBeenCalledOnce();
    await expect(media.wrap(base()).observe()).rejects.toMatchObject({ code: "execution_failed" });
  });

  it("reports one terminal when more lines follow a terminal message in the same chunk", async () => {
    const { transport, onTerminal, media } = await ready();
    transport.raw(
      JSON.stringify({ type: "mystery" }) +
        "\n" +
        JSON.stringify({ type: "heard", utterance: utterance("b") }) +
        "\n" +
        "{bad\n",
    );
    expect(onTerminal).toHaveBeenCalledOnce();
    await expect(media.wrap(base()).observe()).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "not_dispatched",
    });
  });
});

describe("desktop media worker messages", () => {
  it.each([
    ["a second ready", { type: "ready" }],
    ["a non-object", 5],
    ["null", null],
    ["an unknown type", { type: "mystery" }],
    ["a reply for an unknown id", { type: "reply", id: "speak-9", ok: true }],
    ["a reply without a boolean ok", { type: "reply", id: "speak-1", ok: "yes" }],
    ["an id with a slash", { type: "heard", utterance: utterance("a/b") }],
    ["a 129-character id", { type: "heard", utterance: utterance("a".repeat(129)) }],
    ["another source", { type: "heard", utterance: utterance("a", { source: "microphone" }) }],
    ["blank text", { type: "heard", utterance: utterance("a", { text: "   " }) }],
    [
      "text over the character limit",
      {
        type: "heard",
        utterance: utterance("a", { text: "x".repeat(CUA_SPEECH_LIMITS.characters + 1) }),
      },
    ],
    ["a zero duration", { type: "heard", utterance: utterance("a", { durationMs: 0 }) }],
    ["a fractional duration", { type: "heard", utterance: utterance("a", { durationMs: 1.5 }) }],
    [
      "a duration over the limit",
      {
        type: "heard",
        utterance: utterance("a", { durationMs: CUA_SPEECH_LIMITS.durationMs + 1 }),
      },
    ],
  ])("terminates on %s after ready", async (_name, value) => {
    const { transport, onTerminal } = await ready();
    transport.send(value);
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("accepts heard speech at the limits", async () => {
    const { transport, onTerminal, media } = await ready();
    transport.send({
      type: "heard",
      utterance: utterance("a".repeat(128), {
        text: "y".repeat(CUA_SPEECH_LIMITS.characters),
        durationMs: CUA_SPEECH_LIMITS.durationMs,
      }),
    });
    transport.send({ type: "heard", utterance: utterance("b", { durationMs: 1 }) });
    expect(onTerminal).not.toHaveBeenCalled();
    const observation = (await media.wrap(base()).observe()) as { heardSpeech?: unknown[] };
    expect(observation.heardSpeech).toHaveLength(2);
  });

  it("rejects startup with outcome_uncertain when a message arrives before ready", async () => {
    const { settled, transport, onTerminal } = begin();
    await vi.waitFor(() => expect(transport.handlers).toBeDefined());
    transport.send({ type: "heard", utterance: utterance("early") });
    expect(await settled).toMatchObject({
      error: { code: "execution_failed", disposition: "outcome_uncertain" },
    });
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(transport.closes).toBe(1);
  });

  it("holds 8 heard utterances and terminates on the 9th", async () => {
    const { transport, onTerminal } = await ready();
    for (let index = 1; index <= 8; index++)
      transport.send({ type: "heard", utterance: utterance(`u${index}`) });
    expect(onTerminal).not.toHaveBeenCalled();
    transport.send({ type: "heard", utterance: utterance("u9") });
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("swallows an onTerminal that throws", async () => {
    const { transport } = await ready({
      onTerminal: () => {
        throw new Error("owner failed");
      },
    });
    expect(() => transport.handlers!.exit()).not.toThrow();
  });
});

describe("desktop media readiness", () => {
  it("times out after 35 s with deadline_exceeded and closes the worker", async () => {
    vi.useFakeTimers();
    const { settled, transport } = begin();
    await vi.advanceTimersByTimeAsync(34_999);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatchObject({
      error: { code: "deadline_exceeded", disposition: "not_dispatched" },
    });
    expect(transport.closes).toBe(1);
  });

  it("rejects with session_revoked when the owner aborts before ready", async () => {
    const { settled, transport, owner, onTerminal } = begin();
    await vi.waitFor(() => expect(transport.handlers).toBeDefined());
    owner.abort();
    expect(await settled).toMatchObject({
      error: { code: "session_revoked", disposition: "not_dispatched" },
    });
    expect(transport.closes).toBe(1);
    transport.handlers!.exit();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("closes the worker and rethrows when start fails or the owner aborts during it", async () => {
    const failing = new FakeTransport();
    failing.startError = new Error("spawn failed");
    const failed = begin({}, failing);
    expect(await failed.settled).toEqual({ error: failing.startError });
    expect(failing.closes).toBe(1);
    const aborting = new FakeTransport();
    const owner = new AbortController();
    aborting.onStart = () => owner.abort(new Error("owner stopped"));
    await expect(
      startDesktopMedia({
        media: MICROPHONE,
        env: {},
        signal: owner.signal,
        onTerminal: vi.fn(),
        transport: aborting,
      }),
    ).rejects.toThrow("owner stopped");
    expect(aborting.closes).toBe(1);
  });

  it("rejects startup with outcome_uncertain when the worker exits before ready", async () => {
    const { settled, transport, onTerminal } = begin();
    await vi.waitFor(() => expect(transport.handlers).toBeDefined());
    transport.handlers!.exit();
    expect(await settled).toMatchObject({
      error: { code: "execution_failed", disposition: "outcome_uncertain" },
    });
    expect(onTerminal).toHaveBeenCalledOnce();
  });
});

describe("desktop media close and terminal", () => {
  it("closes once, on owner abort too, and reports no terminal afterwards", async () => {
    const { media, transport, owner, onTerminal } = await ready();
    await Promise.all([media.close(), media.close()]);
    owner.abort();
    expect(transport.closes).toBe(1);
    transport.handlers!.exit();
    expect(onTerminal).not.toHaveBeenCalled();
    const aborted = await ready();
    aborted.owner.abort();
    await vi.waitFor(() => expect(aborted.transport.closes).toBe(1));
  });

  it("rejects speech in flight with session_revoked when closed", async () => {
    const { media, transport } = await ready();
    transport.reply = "none";
    const speaking = media.wrap(base()).execute(speak("hello"));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    await media.close();
    await expect(speaking).rejects.toMatchObject({
      code: "session_revoked",
      disposition: "outcome_uncertain",
    });
  });

  it("rejects speech in flight and later calls after the worker exits", async () => {
    const { media, transport, onTerminal } = await ready();
    transport.reply = "none";
    const wrapped = media.wrap(base());
    const speaking = wrapped.execute(speak("hello"));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    transport.handlers!.exit();
    await expect(speaking).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "outcome_uncertain",
    });
    expect(onTerminal).toHaveBeenCalledOnce();
    await expect(wrapped.observe()).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "not_dispatched",
    });
    await expect(wrapped.execute({ kind: "wait", ms: 1 } as CuaAction)).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "not_dispatched",
    });
  });
});

describe("desktop media executor", () => {
  it("wraps once and reports speech support from the microphone", async () => {
    const microphone = await ready();
    const wrapped = microphone.media.wrap(base()) as CuaExecutor & { speechEnabled?: boolean };
    expect(wrapped.speechEnabled).toBe(true);
    expect(() => microphone.media.wrap(base())).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
    const camera = await ready({ media: { camera: { source: "synthetic" } } });
    const cameraOnly = camera.media.wrap(base()) as CuaExecutor & { speechEnabled?: boolean };
    expect(cameraOnly.speechEnabled).toBe(false);
    await expect(cameraOnly.execute(speak("hello"))).rejects.toMatchObject({
      code: "action_rejected",
      disposition: "not_dispatched",
    });
    expect(camera.transport.writes).toEqual([]);
  });

  it("fails an observation that the close overtook", async () => {
    const { media } = await ready();
    const inner = base();
    let release!: () => void;
    inner.observe = vi.fn(
      () =>
        new Promise<CuaObservation>(
          (resolve) => (release = () => resolve({ stateSignature: "screen" })),
        ),
    );
    const observing = media.wrap(inner).observe();
    await media.close();
    release();
    await expect(observing).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "not_dispatched",
    });
  });

  it.each([
    ["empty text", speak("")],
    ["blank text", speak("  ")],
    ["a non-string", speak(7)],
    ["text over the byte limit", speak("é".repeat(Math.ceil(CUA_SPEECH_LIMITS.bytes / 2) + 1))],
  ])("rejects %s without writing", async (_name, action) => {
    const { media, transport } = await ready();
    await expect(media.wrap(base()).execute(action)).rejects.toMatchObject({
      code: "action_rejected",
      disposition: "not_dispatched",
    });
    expect(transport.writes).toEqual([]);
  });

  it("rejects speech on an aborted action signal without writing", async () => {
    const { media, transport } = await ready();
    const action = new AbortController();
    action.abort();
    await expect(media.wrap(base()).execute(speak("hello"), action.signal)).rejects.toMatchObject({
      code: "action_rejected",
    });
    expect(transport.writes).toEqual([]);
  });

  it("numbers commands and closes after a refused reply", async () => {
    const { media, transport } = await ready();
    const wrapped = media.wrap(base());
    await wrapped.execute(speak("one"));
    await wrapped.execute(speak("two"));
    expect(transport.writes.map((write) => write.id)).toEqual(["speak-1", "speak-2"]);
    transport.reply = "refuse";
    await expect(wrapped.execute(speak("three"))).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "outcome_uncertain",
    });
    expect(transport.closes).toBe(1);
  });

  it("maps a failed write to execution_failed outcome_uncertain and closes", async () => {
    const { media, transport } = await ready();
    transport.reply = "fail";
    await expect(media.wrap(base()).execute(speak("hello"))).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "outcome_uncertain",
    });
    expect(transport.closes).toBe(1);
  });

  it("times out speech after 30 s and closes", async () => {
    const { media, transport } = await ready();
    vi.useFakeTimers();
    transport.reply = "none";
    const speaking = media.wrap(base()).execute(speak("hello"));
    const result = speaking.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(transport.closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({
      code: "deadline_exceeded",
      disposition: "outcome_uncertain",
    });
    expect(transport.closes).toBe(1);
  });

  it("revokes speech when the action signal aborts after the write", async () => {
    const { media, transport } = await ready();
    transport.reply = "none";
    const action = new AbortController();
    const speaking = media.wrap(base()).execute(speak("hello"), action.signal);
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    action.abort();
    await expect(speaking).rejects.toMatchObject({
      code: "session_revoked",
      disposition: "outcome_uncertain",
    });
    expect(transport.closes).toBe(1);
  });
});
