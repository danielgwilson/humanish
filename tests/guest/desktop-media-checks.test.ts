import { describe, expect, it } from "vitest";
import { CuaExecutorError } from "../../src/actors/computer-use/executor-error.js";
import { CUA_SPEECH_LIMITS } from "../../src/actors/computer-use/speech.js";
import {
  classifyWorkerMessage,
  desktopMediaEnv,
  dispositionAfterWrite,
  isSpeakableText,
  isSupportedMediaDeclaration,
  nextWorkerLine,
  parseHeardSpeech,
  speakFailure,
  workerBufferOverflow,
} from "../../src/guest/desktop-media.js";

const utterance = { id: "u-1.a_b", source: "speaker_audio", text: "hello", durationMs: 1 };

describe("desktop media checks", () => {
  it("supports only the synthetic camera and the speech microphone, and needs one", () => {
    expect(isSupportedMediaDeclaration({ camera: { source: "synthetic" } })).toBe(true);
    expect(isSupportedMediaDeclaration({ microphone: { source: "speech" } })).toBe(true);
    expect(
      isSupportedMediaDeclaration({
        camera: { source: "synthetic" },
        microphone: { source: "speech" },
      }),
    ).toBe(true);
    for (const media of [
      {},
      { camera: { source: "clip.y4m" } },
      { microphone: { source: "file" } },
      { camera: { source: "synthetic" }, microphone: { source: "file" } },
    ])
      expect(isSupportedMediaDeclaration(media), JSON.stringify(media)).toBe(false);
  });

  it("adds Pulse routing only with a microphone", () => {
    expect(desktopMediaEnv({ A: "1" }, { camera: { source: "synthetic" } })).toEqual({
      A: "1",
      HUMANISH_MEDIA_CAMERA: "1",
      HUMANISH_MEDIA_MICROPHONE: "0",
    });
    expect(
      desktopMediaEnv({ XDG_RUNTIME_DIR: "/x" }, { microphone: { source: "speech" } }),
    ).toMatchObject({
      HUMANISH_MEDIA_CAMERA: "0",
      HUMANISH_MEDIA_MICROPHONE: "1",
      PULSE_SERVER: "unix:/x/pulse/native",
      PULSE_SOURCE: "humanish_input",
      PULSE_SINK: "humanish_speaker",
    });
  });

  it("frames lines at the 8 KiB limit", () => {
    expect(workerBufferOverflow(Buffer.alloc(8192, 120))).toBe(false);
    expect(workerBufferOverflow(Buffer.alloc(8193, 120))).toBe(true);
    expect(workerBufferOverflow(Buffer.concat([Buffer.alloc(9000, 120), Buffer.from("\n")]))).toBe(
      false,
    );
    expect(nextWorkerLine(Buffer.from("abc"))).toBe("incomplete");
    expect(nextWorkerLine(Buffer.concat([Buffer.alloc(8193, 120), Buffer.from("\n")]))).toBe(
      "overflow",
    );
    const exact = nextWorkerLine(Buffer.concat([Buffer.alloc(8192, 120), Buffer.from("\nrest")]));
    expect(exact).not.toBeTypeOf("string");
    const split = nextWorkerLine(Buffer.from("one\ntwo"));
    expect(split).toEqual({ line: Buffer.from("one"), rest: Buffer.from("two") });
  });

  it("classifies worker messages by readiness", () => {
    expect(classifyWorkerMessage({ type: "ready" }, false)).toEqual({ kind: "ready" });
    expect(classifyWorkerMessage({ type: "ready" }, true)).toEqual({ kind: "terminal" });
    expect(classifyWorkerMessage({ type: "heard", utterance }, false)).toEqual({
      kind: "terminal",
    });
    expect(classifyWorkerMessage({ type: "heard", utterance }, true)).toEqual({
      kind: "heard",
      utterance,
    });
    expect(
      classifyWorkerMessage({ type: "heard", utterance: { ...utterance, id: "a b" } }, true),
    ).toEqual({ kind: "terminal" });
    expect(classifyWorkerMessage({ type: "reply", id: "speak-1", ok: false }, true)).toEqual({
      kind: "reply",
      id: "speak-1",
      ok: false,
    });
    for (const value of [
      null,
      0,
      "ready",
      [],
      { type: "reply", id: 1, ok: true },
      { type: "reply", id: "x", ok: 1 },
      { type: "other" },
    ])
      expect(classifyWorkerMessage(value, true), JSON.stringify(value)).toEqual({
        kind: "terminal",
      });
  });

  it("checks speech text and heard utterances against the speech limits", () => {
    expect(isSpeakableText("hi")).toBe(true);
    expect(isSpeakableText("x".repeat(CUA_SPEECH_LIMITS.characters))).toBe(true);
    for (const value of ["", "  ", 1, "x".repeat(CUA_SPEECH_LIMITS.characters + 1), "\ud800"])
      expect(isSpeakableText(value), JSON.stringify(value)).toBe(false);
    expect(parseHeardSpeech(utterance)).toBe(utterance);
    for (const change of [
      { id: "" },
      { id: "a".repeat(129) },
      { source: "other" },
      { durationMs: 0 },
      { durationMs: CUA_SPEECH_LIMITS.durationMs + 1 },
      { text: "" },
    ])
      expect(parseHeardSpeech({ ...utterance, ...change }), JSON.stringify(change)).toBeUndefined();
    expect(parseHeardSpeech(null)).toBeUndefined();
  });

  it("maps speak failures by whether the command was written", () => {
    expect(dispositionAfterWrite(true)).toBe("outcome_uncertain");
    expect(dispositionAfterWrite(false)).toBe("not_dispatched");
    const own = new CuaExecutorError("deadline_exceeded", "outcome_uncertain");
    expect(speakFailure(own, false)).toBe(own);
    expect(speakFailure(new Error("pipe"), true)).toMatchObject({
      code: "execution_failed",
      disposition: "outcome_uncertain",
    });
    expect(speakFailure("x", false)).toMatchObject({
      code: "execution_failed",
      disposition: "not_dispatched",
    });
  });
});
