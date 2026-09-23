import { describe, expect, it } from "vitest";
import { CuaExecutorError } from "../src/cua-executor-error.js";
import { BROWSER_CONTROL_LIMITS, decodeBrowserControlObservation, encodeBrowserControlObservation, parseBrowserControlRequest,
  parseBrowserControlReply, safeBrowserControlFailure, validateBrowserControlAction, validateBrowserControlPng } from "../src/browser-control-protocol.js";
import { observation, png, request, reply } from "./browser-control-fixture.js";

describe("browser control closed v1 protocol", () => {
  it.each([
    { kind: "click", x: 0.125, y: -0.75, button: "right" }, { kind: "double_click", x: 0.125, y: 2.25 },
    { kind: "move", x: -0.25, y: 4.5 }, { kind: "scroll", x: 0.2, y: 0.5, dx: -12.75, dy: 400.5 },
    { kind: "type", text: "héllo" }, { kind: "keypress", keys: ["CTRL", "A"] },
    { kind: "drag", path: [{ x: 0.125, y: 0.25 }, { x: 2.5, y: 3.75 }] }, { kind: "wait", ms: 0.25 }, { kind: "wait" }, { kind: "screenshot" }
  ])("preserves admitted action exactly: $kind", action => expect(validateBrowserControlAction(action)).toEqual(action));
  it.each([
    { kind: "click", x: NaN, y: 1 }, { kind: "move", x: Infinity, y: 0 }, { kind: "click", x: 1, y: 2, url: "https://example.test/" },
    { kind: "navigate", url: "https://example.test/" }, { kind: "type", text: "é".repeat(32769) },
    { kind: "keypress", keys: Array(17).fill("A") }, { kind: "keypress", keys: ["x".repeat(65)] },
    { kind: "drag", path: Array(1025).fill({ x: 0, y: 0 }) }, { kind: "drag", path: [] },
    { kind: "wait", ms: -1 }, { kind: "wait", ms: 30001 }, { kind: "screenshot", args: [] }
  ])("rejects invalid or over-limit action $kind", action => expect(() => validateBrowserControlAction(action)).toThrow(CuaExecutorError));
  it("accepts limits rather than rounding or truncating", () => {
    expect(validateBrowserControlAction({ kind: "type", text: "é".repeat(32768) })).toHaveProperty("text.length", 32768);
    expect(validateBrowserControlAction({ kind: "wait", ms: 30000 })).toEqual({ kind: "wait", ms: 30000 });
  });
  it.each([
    { ...request(), extra: true }, { ...request(), version: 2 }, { ...request(), operation: "CDP" },
    { ...request(), seq: 1.5 }, { ...request(), requestId: "wrong" },
    request(2, "EXECUTE", { actionId: "wrong", action: { kind: "screenshot" } })
  ])("rejects undeclared request shapes", value => expect(() => parseBrowserControlRequest(value)).toThrow(CuaExecutorError));
  it.each([
    reply(1, "HELLO", { actionId: "action-1" }), reply(2, "EXECUTE"), reply(2, "OBSERVE"),
    reply(1, "HELLO", { extra: true }), reply(1, "HELLO", { ok: false, error: { code: "secret text", disposition: "not_dispatched" } })
  ])("rejects inconsistent replies", value => expect(() => parseBrowserControlReply(value)).toThrow(CuaExecutorError));
  it("round trips actual PNG bytes and bounded runtime browser state", () => {
    const original = observation(); expect(decodeBrowserControlObservation(encodeBrowserControlObservation(original))).toEqual(original);
  });
  it.each(["signature", "crc", "dimensions", "pixels", "interlaced", "depth", "trailing", "truncated"])("rejects invalid PNG %s before exposing capture", mode => {
    let bytes = png();
    if (mode === "signature") bytes[0] = 0;
    if (mode === "crc") bytes[29] = bytes[29]! ^ 255;
    if (mode === "dimensions") bytes.writeUInt32BE(4097, 16);
    if (mode === "pixels") { bytes.writeUInt32BE(4096, 16); bytes.writeUInt32BE(4096, 20); }
    if (mode === "interlaced") bytes[28] = 1;
    if (mode === "depth") bytes[24] = 16;
    if (mode === "trailing") bytes = Buffer.concat([bytes, Buffer.from([0])]);
    if (mode === "truncated") bytes = bytes.subarray(0, bytes.length - 5);
    expect(() => validateBrowserControlPng(bytes)).toThrow(CuaExecutorError);
  });
  it("rejects PNG byte and observed text limits, noncanonical base64, and unschematized appState", () => {
    expect(() => validateBrowserControlPng(Buffer.alloc(BROWSER_CONTROL_LIMITS.pngBytes + 1))).toThrow(CuaExecutorError);
    expect(() => encodeBrowserControlObservation({ ...observation(), text: "é".repeat(32769) })).toThrow(CuaExecutorError);
    expect(() => encodeBrowserControlObservation({ ...observation(), appState: {} })).toThrow(CuaExecutorError);
    expect(() => decodeBrowserControlObservation({ ...encodeBrowserControlObservation(observation()), png: "AB==" })).toThrow(CuaExecutorError);
  });
  it("never forwards arbitrary exception prose or forged typed errors", () => {
    const error = new Error("Synthetic private text https://example.test/code");
    expect(safeBrowserControlFailure(error, true)).toEqual({ code: "action_rejected", disposition: "outcome_uncertain" });
    const forged = Object.assign(Object.create(CuaExecutorError.prototype), { code: "cancelled", disposition: "not_dispatched" });
    expect(safeBrowserControlFailure(forged, true)).toEqual({ code: "action_rejected", disposition: "outcome_uncertain" });
  });
});
