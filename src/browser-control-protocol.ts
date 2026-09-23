import { PNG } from "pngjs";
import { z } from "zod";
import type { CuaAction, CuaObservation } from "./computer-use.js";
import { CuaExecutorError, isCuaExecutorError, type CuaExecutorErrorCode } from "./cua-executor-error.js";

export const BROWSER_CONTROL_VERSION = 1;
export const BROWSER_CONTROL_LIMITS = Object.freeze({
  frameBytes: 12 * 1024 * 1024, pngBytes: 8 * 1024 * 1024,
  dimension: 4096, pixels: 16_000_000, textBytes: 64 * 1024,
  chordKeys: 16, keyCharacters: 64, dragPoints: 1024, waitMs: 30_000,
  requestTimeoutMs: 35_000, maxRequestTimeoutMs: 60_000
});
export interface BrowserControlIdentity { generation: string; challenge: string; runtimeRevision: string }
const token = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const identitySchema = z.strictObject({ generation: token, challenge: token, runtimeRevision: token });
const text = z.string().max(BROWSER_CONTROL_LIMITS.textBytes).refine(value => Buffer.byteLength(value) <= BROWSER_CONTROL_LIMITS.textBytes);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const point = { x: coordinate, y: coordinate };
export const browserControlActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), ...point, button: z.enum(["left", "right", "middle"]).optional() }),
  z.strictObject({ kind: z.literal("double_click"), ...point }),
  z.strictObject({ kind: z.literal("move"), ...point }),
  z.strictObject({ kind: z.literal("scroll"), ...point, dx: coordinate, dy: coordinate }),
  z.strictObject({ kind: z.literal("type"), text }),
  z.strictObject({ kind: z.literal("keypress"), keys: z.array(z.string().min(1).max(BROWSER_CONTROL_LIMITS.keyCharacters)).min(1).max(BROWSER_CONTROL_LIMITS.chordKeys) }),
  z.strictObject({ kind: z.literal("drag"), path: z.array(z.strictObject(point)).min(1).max(BROWSER_CONTROL_LIMITS.dragPoints) }),
  z.strictObject({ kind: z.literal("wait"), ms: z.number().finite().min(0).max(BROWSER_CONTROL_LIMITS.waitMs).optional() }),
  z.strictObject({ kind: z.literal("screenshot") })
]).transform((action): CuaAction => {
  if (action.kind === "click") return { kind: action.kind, x: action.x, y: action.y, ...(action.button !== undefined ? { button: action.button } : {}) };
  if (action.kind === "wait") return { kind: action.kind, ...(action.ms !== undefined ? { ms: action.ms } : {}) };
  return action;
});
const observationSchema = z.strictObject({
  png: z.string().min(1).max(4 * Math.ceil(BROWSER_CONTROL_LIMITS.pngBytes / 3)).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0),
  stateSignature: text, url: text.optional(), title: text.optional(), text: text.optional(), scrollY: coordinate.optional()
});
type WireObservation = z.infer<typeof observationSchema>;
const common = {
  version: z.literal(BROWSER_CONTROL_VERSION), identity: identitySchema,
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), requestId: token
};
const requestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...common, type: z.literal("request"), operation: z.literal("HELLO") }),
  z.strictObject({ ...common, type: z.literal("request"), operation: z.literal("OBSERVE") }),
  z.strictObject({ ...common, type: z.literal("request"), operation: z.literal("EXECUTE"), actionId: token, action: browserControlActionSchema })
]);
const errorCode = z.enum(["executor_closed", "executor_not_ready", "executor_busy", "cancelled", "invalid_request", "invalid_response", "protocol_mismatch", "session_revoked", "transport_failed", "deadline_exceeded", "action_rejected", "execution_failed"]);
const replyBase = { ...common, type: z.literal("reply"), operation: z.enum(["HELLO", "OBSERVE", "EXECUTE"]), actionId: token.optional() };
const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...replyBase, ok: z.literal(true), observation: observationSchema.optional() }),
  z.strictObject({ ...replyBase, ok: z.literal(false), error: z.strictObject({ code: errorCode, disposition: z.enum(["not_dispatched", "outcome_uncertain"]) }) })
]);
export type BrowserControlRequest = z.infer<typeof requestSchema>;
export type BrowserControlReply = z.infer<typeof replySchema>;
export function validateBrowserControlIdentity(value: unknown): BrowserControlIdentity {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) throw new CuaExecutorError("invalid_request", "not_dispatched");
  return parsed.data;
}
export function sameBrowserControlIdentity(a: BrowserControlIdentity, b: BrowserControlIdentity): boolean {
  return a.generation === b.generation && a.challenge === b.challenge && a.runtimeRevision === b.runtimeRevision;
}
export function parseBrowserControlRequest(value: unknown): BrowserControlRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new CuaExecutorError("invalid_request", "not_dispatched");
  const request = parsed.data;
  if (request.requestId !== `request-${request.seq}` || (request.operation === "EXECUTE" && request.actionId !== `action-${request.seq}`)) throw new CuaExecutorError("invalid_request", "not_dispatched");
  return request;
}
export function parseBrowserControlReply(value: unknown): BrowserControlReply {
  const parsed = replySchema.safeParse(value);
  if (!parsed.success) throw new CuaExecutorError("invalid_response", "outcome_uncertain");
  const reply = parsed.data;
  if ((reply.operation === "EXECUTE") !== (reply.actionId !== undefined)
    || (reply.ok && (reply.operation === "OBSERVE") !== (reply.observation !== undefined))) throw new CuaExecutorError("invalid_response", "outcome_uncertain");
  return reply;
}
export function validateBrowserControlAction(value: unknown): CuaAction {
  const parsed = browserControlActionSchema.safeParse(value);
  if (!parsed.success) throw new CuaExecutorError("invalid_request", "not_dispatched");
  return parsed.data;
}

/** Check dimensions before allocating decoder output; v1 accepts browser-style 8-bit, noninterlaced PNG. */
export function validateBrowserControlPng(bytes: Buffer): void {
  const fail = (): never => { throw new CuaExecutorError("invalid_response", "outcome_uncertain"); };
  if (bytes.length < 45 || bytes.length > BROWSER_CONTROL_LIMITS.pngBytes
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") fail();
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0 || width > BROWSER_CONTROL_LIMITS.dimension || height > BROWSER_CONTROL_LIMITS.dimension
    || width * height > BROWSER_CONTROL_LIMITS.pixels || bytes[24] !== 8 || ![0, 2, 3, 4, 6].includes(bytes[25]!)
    || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) fail();
  // Reject trailing bytes, malformed chunk lengths, duplicate IHDR and absent image data.
  let offset = 8, sawData = false, sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || (kind === "IHDR" && offset !== 8)) fail();
    if (kind === "IDAT") sawData = true;
    offset += 12 + length;
    if (kind === "IEND") { if (length !== 0 || offset !== bytes.length) fail(); sawEnd = true; break; }
  }
  if (!sawData || !sawEnd) fail();
  try {
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height) fail();
  } catch { fail(); }
}
export function encodeBrowserControlObservation(observation: CuaObservation): WireObservation {
  // appState has no closed browser schema in v1. Refuse rather than silently drop it.
  if (!observation || observation.appState !== undefined || !Buffer.isBuffer(observation.screenshot)) throw new CuaExecutorError("invalid_response", "outcome_uncertain");
  validateBrowserControlPng(observation.screenshot);
  const parsed = observationSchema.safeParse({ png: observation.screenshot.toString("base64"), stateSignature: observation.stateSignature,
    ...(observation.url !== undefined ? { url: observation.url } : {}), ...(observation.title !== undefined ? { title: observation.title } : {}),
    ...(observation.text !== undefined ? { text: observation.text } : {}), ...(observation.scrollY !== undefined ? { scrollY: observation.scrollY } : {}) });
  if (!parsed.success) throw new CuaExecutorError("invalid_response", "outcome_uncertain");
  return parsed.data;
}
export function decodeBrowserControlObservation(value: unknown): CuaObservation {
  const parsed = observationSchema.safeParse(value);
  if (!parsed.success) throw new CuaExecutorError("invalid_response", "outcome_uncertain");
  const { png, ...state } = parsed.data;
  const screenshot = Buffer.from(png, "base64");
  if (screenshot.toString("base64") !== png) throw new CuaExecutorError("invalid_response", "outcome_uncertain");
  validateBrowserControlPng(screenshot);
  return { screenshot, stateSignature: state.stateSignature,
    ...(state.url !== undefined ? { url: state.url } : {}), ...(state.title !== undefined ? { title: state.title } : {}),
    ...(state.text !== undefined ? { text: state.text } : {}), ...(state.scrollY !== undefined ? { scrollY: state.scrollY } : {}) };
}
export function safeBrowserControlFailure(error: unknown, dispatched: boolean): { code: CuaExecutorErrorCode; disposition: "not_dispatched" | "outcome_uncertain" } {
  if (isCuaExecutorError(error)) return { code: error.code, disposition: error.disposition };
  return { code: "action_rejected", disposition: dispatched ? "outcome_uncertain" : "not_dispatched" };
}
