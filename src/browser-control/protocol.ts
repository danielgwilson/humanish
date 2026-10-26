import { PNG } from "pngjs";
import { z } from "zod";
import type { CuaAction, CuaActionResult, CuaObservation } from "../actors/computer-use/loop.js";
import { CUA_SPEECH_LIMITS, type HeardSpeech } from "../actors/computer-use/speech.js";
import { EXTERNAL_HANDOFF_LIMITS } from "../actors/computer-use/external-handoff.js";
import {
  ComputerUseExecutorError,
  CUA_REJECTION_REASONS,
  isComputerUseExecutorError,
  type CuaExecutorErrorCode,
  type CuaRejectionReason,
} from "../actors/computer-use/executor-error.js";
import {
  CUA_DIAGNOSTIC_CATEGORIES,
  CUA_DIAGNOSTIC_STEPS,
  type CuaExecutorDiagnostic,
} from "../actors/computer-use/executor-diagnostic.js";
import { desktopRecordingMetadataSchema } from "../evidence/desktop-recording-types.js";

export const BROWSER_CONTROL_VERSION = 1;
export const BROWSER_CONTROL_LIMITS = Object.freeze({
  frameBytes: 12 * 1024 * 1024,
  pngBytes: 8 * 1024 * 1024,
  dimension: 4096,
  pixels: 16_000_000,
  textBytes: 64 * 1024,
  speechCharacters: CUA_SPEECH_LIMITS.characters,
  speechBytes: CUA_SPEECH_LIMITS.bytes,
  heardSpeech: CUA_SPEECH_LIMITS.utterances,
  speechDurationMs: CUA_SPEECH_LIMITS.durationMs,
  chordKeys: 16,
  keyCharacters: 64,
  dragPoints: 1024,
  waitMs: 30_000,
  requestTimeoutMs: 35_000,
  maxRequestTimeoutMs: 60_000,
});
export interface BrowserControlIdentity {
  generation: string;
  challenge: string;
  runtimeRevision: string;
}
const token = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);
const identitySchema = z.strictObject({
  generation: token,
  challenge: token,
  runtimeRevision: token,
});
const text = z
  .string()
  .max(BROWSER_CONTROL_LIMITS.textBytes)
  .refine((value) => Buffer.byteLength(value) <= BROWSER_CONTROL_LIMITS.textBytes);
const speechText = z
  .string()
  .min(1)
  .max(BROWSER_CONTROL_LIMITS.speechCharacters)
  .refine(
    (value) =>
      value.trim().length > 0 && Buffer.byteLength(value) <= BROWSER_CONTROL_LIMITS.speechBytes,
  );
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const point = { x: coordinate, y: coordinate };
const keyName = z.string().min(1).max(BROWSER_CONTROL_LIMITS.keyCharacters);
const chord = z.array(keyName).min(1).max(BROWSER_CONTROL_LIMITS.chordKeys);
const clickAction = z.strictObject({
  kind: z.literal("click"),
  ...point,
  button: z.enum(["left", "right", "middle"]).optional(),
});
const doubleClickAction = z.strictObject({ kind: z.literal("double_click"), ...point });
const moveAction = z.strictObject({ kind: z.literal("move"), ...point });
const scrollAction = z.strictObject({
  kind: z.literal("scroll"),
  ...point,
  dx: coordinate,
  dy: coordinate,
});
const dragAction = z.strictObject({
  kind: z.literal("drag"),
  path: z.array(z.strictObject(point)).min(1).max(BROWSER_CONTROL_LIMITS.dragPoints),
});
const typeAction = z.strictObject({ kind: z.literal("type"), text });
const keypressAction = z.strictObject({ kind: z.literal("keypress"), keys: chord });
const waitMs = z.number().finite().min(0);
// One request carries one wait, so the wire bounds it by the request deadline.
const waitAction = z.strictObject({
  kind: z.literal("wait"),
  ms: waitMs.max(BROWSER_CONTROL_LIMITS.waitMs).optional(),
});
// A participant may ask for any wait: the loop shortens it to the study's longest and sends it in
// steps the wire accepts.
const participantWaitAction = z.strictObject({ kind: z.literal("wait"), ms: waitMs.optional() });
const screenshotAction = z.strictObject({ kind: z.literal("screenshot") });
const speakAction = z.strictObject({ kind: z.literal("speak"), text: speechText });
// The descriptions reach the participant: Codex reads them in its tool schema and Claude Code in
// the reply shape its prompt states.
const tripleClickAction = z
  .strictObject({ kind: z.literal("triple_click"), ...point })
  .describe("Three left clicks at one point, as a person selects a line or a paragraph.");
// A press or release at the pointer, or at a point. The translator refuses one coordinate alone.
const mouseButton = {
  button: z.enum(["left", "right", "middle"]).optional(),
  x: coordinate.optional(),
  y: coordinate.optional(),
};
const mouseDownAction = z
  .strictObject({ kind: z.literal("mouse_down"), ...mouseButton })
  .describe(
    "Press one button (left by default) and keep it down, where the pointer is or at x, y; give both coordinates or neither. It stays down until a mouse_up.",
  );
const mouseUpAction = z
  .strictObject({ kind: z.literal("mouse_up"), ...mouseButton })
  .describe(
    "Release one button (left by default), where the pointer is or at x, y; give both coordinates or neither.",
  );
// The translator refuses a hold longer than one request carries and a region that is not whole
// pixels inside the frame, so every desktop refuses them the same way, as a rejected action.
const holdKeysAction = z
  .strictObject({ kind: z.literal("hold_keys"), keys: chord, ms: coordinate })
  .describe(
    `Hold one key or a chord, named as for keypress, down for ms milliseconds (at most ${BROWSER_CONTROL_LIMITS.waitMs}), then release it.`,
  );
const readPointerAction = z
  .strictObject({ kind: z.literal("read_pointer") })
  .describe("Read where the pointer is. humanish answers with its position in screen pixels.");
const zoomAction = z
  .strictObject({
    kind: z.literal("zoom"),
    region: z.strictObject({ ...point, width: coordinate, height: coordinate }),
  })
  .describe(
    "Look closer at a region of the screen, in whole pixels inside it. humanish answers with an image of that region, captured when the action runs, at the screen's own pixels.",
  );
// The actions a local-agent participant (Codex's humanish_ui tool, Claude Code's JSON reply) may
// propose: every desktop action except held keys on pointer actions, which mirror the OpenAI
// computer tool's `keys` field.
const participantActionSchemas = [
  clickAction,
  doubleClickAction,
  tripleClickAction,
  moveAction,
  scrollAction,
  dragAction,
  mouseDownAction,
  mouseUpAction,
  typeAction,
  keypressAction,
  holdKeysAction,
  participantWaitAction,
  screenshotAction,
  readPointerAction,
  zoomAction,
] as const;
export const participantActionSchema = z
  .discriminatedUnion("kind", participantActionSchemas)
  .transform(toCuaAction);
export const participantSpeechActionSchema = z
  .discriminatedUnion("kind", [...participantActionSchemas, speakAction])
  .transform(toCuaAction);
// What crosses the host-guest wire: the participant actions plus held keys on pointer actions,
// which the OpenAI provider maps from its computer tool, and the desktop actions only API
// providers propose.
const held = { heldKeys: chord.optional() };
const wireActions = z.discriminatedUnion("kind", [
  clickAction.extend(held),
  doubleClickAction.extend(held),
  moveAction.extend(held),
  scrollAction.extend(held),
  typeAction,
  keypressAction,
  dragAction.extend(held),
  waitAction,
  screenshotAction,
  speakAction,
  tripleClickAction.extend(held),
  mouseDownAction,
  mouseUpAction,
  holdKeysAction,
  readPointerAction,
  zoomAction,
]);
const wireActionSchema = wireActions.transform(toCuaAction);

/** Drop absent optional fields, which the CuaAction type does not allow as `undefined`. */
function toCuaAction(action: z.output<typeof wireActions>): CuaAction {
  const heldKeys =
    "heldKeys" in action && action.heldKeys !== undefined ? { heldKeys: action.heldKeys } : {};
  switch (action.kind) {
    case "click":
      return {
        kind: action.kind,
        x: action.x,
        y: action.y,
        ...(action.button !== undefined ? { button: action.button } : {}),
        ...heldKeys,
      };
    case "double_click":
    case "triple_click":
    case "move":
      return { kind: action.kind, x: action.x, y: action.y, ...heldKeys };
    case "mouse_down":
    case "mouse_up":
      return {
        kind: action.kind,
        ...(action.button !== undefined ? { button: action.button } : {}),
        ...(action.x !== undefined ? { x: action.x } : {}),
        ...(action.y !== undefined ? { y: action.y } : {}),
      };
    case "scroll":
      return {
        kind: action.kind,
        x: action.x,
        y: action.y,
        dx: action.dx,
        dy: action.dy,
        ...heldKeys,
      };
    case "drag":
      return { kind: action.kind, path: action.path, ...heldKeys };
    case "wait":
      return { kind: action.kind, ...(action.ms !== undefined ? { ms: action.ms } : {}) };
    default:
      return action;
  }
}
/** A whole pixel position inside the largest frame the wire admits. */
function pixelSchema() {
  return z.number().int().min(0).max(BROWSER_CONTROL_LIMITS.dimension);
}
const heardSpeechSchema = z.strictObject({
  id: token,
  source: z.literal("speaker_audio"),
  text: speechText,
  durationMs: z.number().int().min(1).max(BROWSER_CONTROL_LIMITS.speechDurationMs),
});
const heardSpeechListSchema = z
  .array(heardSpeechSchema)
  .min(1)
  .max(BROWSER_CONTROL_LIMITS.heardSpeech)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length);
// The guest sends a handoff as externalHandoffOf made it: a scheme and a mailto link's recipients.
const externalHandoffListSchema = z
  .array(
    z.strictObject({
      scheme: z.string().regex(/^[a-z][a-z0-9+.-]{0,31}$/),
      recipients: z
        .array(z.string().min(3).max(EXTERNAL_HANDOFF_LIMITS.addressLength))
        .max(EXTERNAL_HANDOFF_LIMITS.recipients)
        .optional(),
    }),
  )
  .min(1)
  .max(EXTERNAL_HANDOFF_LIMITS.perObservation);
const observationSchema = z.strictObject({
  png: z
    .string()
    .min(1)
    .max(4 * Math.ceil(BROWSER_CONTROL_LIMITS.pngBytes / 3))
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((value) => value.length % 4 === 0),
  stateSignature: text,
  url: text.optional(),
  title: text.optional(),
  text: text.optional(),
  scrollY: coordinate.optional(),
  heardSpeech: heardSpeechListSchema.optional(),
  externalHandoffs: externalHandoffListSchema.optional(),
});
type WireObservation = z.infer<typeof observationSchema>;
const common = {
  version: z.literal(BROWSER_CONTROL_VERSION),
  identity: identitySchema,
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestId: token,
};
const requestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...common, type: z.literal("request"), operation: z.literal("HELLO") }),
  z.strictObject({ ...common, type: z.literal("request"), operation: z.literal("OBSERVE") }),
  z.strictObject({
    ...common,
    type: z.literal("request"),
    operation: z.literal("EXECUTE"),
    actionId: token,
    action: wireActionSchema,
  }),
  z.strictObject({
    ...common,
    type: z.literal("request"),
    operation: z.literal("FINISH_RECORDING"),
  }),
]);
const errorCode = z.enum([
  "executor_closed",
  "executor_not_ready",
  "executor_busy",
  "cancelled",
  "invalid_request",
  "invalid_response",
  "protocol_mismatch",
  "session_revoked",
  "transport_failed",
  "deadline_exceeded",
  "action_rejected",
  "execution_failed",
]);
// Two fixed words; a reply never carries browser error text.
const diagnosticSchema = z.strictObject({
  step: z.enum(CUA_DIAGNOSTIC_STEPS),
  category: z.enum(CUA_DIAGNOSTIC_CATEGORIES),
});
const replyBase = {
  ...common,
  type: z.literal("reply"),
  operation: z.enum(["HELLO", "OBSERVE", "EXECUTE", "FINISH_RECORDING"]),
  actionId: token.optional(),
};
const pngBase64 = z
  .string()
  .min(1)
  .max(4 * Math.ceil(BROWSER_CONTROL_LIMITS.pngBytes / 3))
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine((value) => value.length % 4 === 0);
// What an executed action read: read_pointer's position, zoom's frame.
const resultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pointer"), x: pixelSchema(), y: pixelSchema() }),
  z.strictObject({ kind: z.literal("frame"), png: pngBase64 }),
]);
type WireResult = z.infer<typeof resultSchema>;
const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ...replyBase,
    ok: z.literal(true),
    observation: observationSchema.optional(),
    recording: desktopRecordingMetadataSchema.optional(),
    result: resultSchema.optional(),
  }),
  z.strictObject({
    ...replyBase,
    ok: z.literal(false),
    error: z.strictObject({
      code: errorCode,
      disposition: z.enum(["not_dispatched", "outcome_uncertain"]),
      reason: z.enum(CUA_REJECTION_REASONS).optional(),
      diagnostic: diagnosticSchema.optional(),
    }),
  }),
]);
export type BrowserControlRequest = z.infer<typeof requestSchema>;
export type BrowserControlReply = z.infer<typeof replySchema>;
export function validateBrowserControlIdentity(value: unknown): BrowserControlIdentity {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) throw new ComputerUseExecutorError("invalid_request", "not_dispatched");
  return parsed.data;
}
export function sameBrowserControlIdentity(
  a: BrowserControlIdentity,
  b: BrowserControlIdentity,
): boolean {
  return (
    a.generation === b.generation &&
    a.challenge === b.challenge &&
    a.runtimeRevision === b.runtimeRevision
  );
}
export function parseBrowserControlRequest(value: unknown): BrowserControlRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new ComputerUseExecutorError("invalid_request", "not_dispatched");
  const request = parsed.data;
  if (
    request.requestId !== `request-${request.seq}` ||
    (request.operation === "EXECUTE" && request.actionId !== `action-${request.seq}`)
  )
    throw new ComputerUseExecutorError("invalid_request", "not_dispatched");
  return request;
}
export function parseBrowserControlReply(value: unknown): BrowserControlReply {
  const parsed = replySchema.safeParse(value);
  if (!parsed.success) throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  const reply = parsed.data;
  if (
    (reply.operation === "EXECUTE") !== (reply.actionId !== undefined) ||
    (!reply.ok &&
      reply.error.reason !== undefined &&
      (reply.error.code !== "action_rejected" || reply.error.disposition !== "not_dispatched")) ||
    (reply.ok &&
      ((reply.operation === "OBSERVE") !== (reply.observation !== undefined) ||
        (reply.operation === "FINISH_RECORDING") !== (reply.recording !== undefined) ||
        (reply.operation !== "EXECUTE" && reply.result !== undefined)))
  )
    throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  return reply;
}
export function validateBrowserControlAction(value: unknown): CuaAction {
  const parsed = wireActionSchema.safeParse(value);
  if (!parsed.success) throw new ComputerUseExecutorError("invalid_request", "not_dispatched");
  return parsed.data;
}
export function validateHeardSpeech(value: unknown): HeardSpeech[] {
  const parsed = heardSpeechListSchema.safeParse(value);
  if (!parsed.success) throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  return parsed.data;
}

/** Check dimensions before allocating decoder output; v1 accepts browser-style 8-bit, noninterlaced PNG. */
export function validateBrowserControlPng(bytes: Buffer): void {
  const fail = (): never => {
    throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  };
  if (
    bytes.length < 45 ||
    bytes.length > BROWSER_CONTROL_LIMITS.pngBytes ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    fail();
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    width === 0 ||
    height === 0 ||
    width > BROWSER_CONTROL_LIMITS.dimension ||
    height > BROWSER_CONTROL_LIMITS.dimension ||
    width * height > BROWSER_CONTROL_LIMITS.pixels ||
    bytes[24] !== 8 ||
    ![0, 2, 3, 4, 6].includes(bytes[25]!) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] !== 0
  )
    fail();
  // Reject trailing bytes, malformed chunk lengths, duplicate IHDR and absent image data.
  let offset = 8,
    sawData = false,
    sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || (kind === "IHDR" && offset !== 8)) fail();
    if (kind === "IDAT") sawData = true;
    offset += 12 + length;
    if (kind === "IEND") {
      if (length !== 0 || offset !== bytes.length) fail();
      sawEnd = true;
      break;
    }
  }
  if (!sawData || !sawEnd) fail();
  try {
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height) fail();
  } catch {
    fail();
  }
}
export function encodeBrowserControlObservation(observation: CuaObservation): WireObservation {
  // appState has no closed browser schema in v1. Refuse rather than silently drop it.
  if (
    !observation ||
    observation.appState !== undefined ||
    !Buffer.isBuffer(observation.screenshot)
  )
    throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  validateBrowserControlPng(observation.screenshot);
  const parsed = observationSchema.safeParse({
    png: observation.screenshot.toString("base64"),
    stateSignature: observation.stateSignature,
    ...(observation.url !== undefined ? { url: observation.url } : {}),
    ...(observation.title !== undefined ? { title: observation.title } : {}),
    ...(observation.text !== undefined ? { text: observation.text } : {}),
    ...(observation.scrollY !== undefined ? { scrollY: observation.scrollY } : {}),
    ...(observation.heardSpeech !== undefined ? { heardSpeech: observation.heardSpeech } : {}),
    ...(observation.externalHandoffs !== undefined
      ? { externalHandoffs: observation.externalHandoffs }
      : {}),
  });
  if (!parsed.success) throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  return parsed.data;
}
export function decodeBrowserControlObservation(value: unknown): CuaObservation {
  const parsed = observationSchema.safeParse(value);
  if (!parsed.success) throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  const { png, ...state } = parsed.data;
  const screenshot = Buffer.from(png, "base64");
  if (screenshot.toString("base64") !== png)
    throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  validateBrowserControlPng(screenshot);
  return {
    screenshot,
    stateSignature: state.stateSignature,
    ...(state.url !== undefined ? { url: state.url } : {}),
    ...(state.title !== undefined ? { title: state.title } : {}),
    ...(state.text !== undefined ? { text: state.text } : {}),
    ...(state.scrollY !== undefined ? { scrollY: state.scrollY } : {}),
    ...(state.heardSpeech !== undefined ? { heardSpeech: state.heardSpeech } : {}),
    ...(state.externalHandoffs !== undefined
      ? {
          externalHandoffs: state.externalHandoffs.map(({ scheme, recipients }) =>
            recipients === undefined ? { scheme } : { scheme, recipients },
          ),
        }
      : {}),
  };
}
/** An action result as the wire carries it. A frame must pass the PNG admission checks. */
export function encodeBrowserControlResult(result: CuaActionResult): WireResult {
  if (result.kind === "pointer") {
    const parsed = resultSchema.safeParse({ kind: "pointer", x: result.x, y: result.y });
    if (!parsed.success)
      throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
    return parsed.data;
  }
  if (!Buffer.isBuffer(result.screenshot))
    throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  validateBrowserControlPng(result.screenshot);
  return { kind: "frame", png: result.screenshot.toString("base64") };
}
/** The action result a reply carried, with a frame decoded and checked as an observation is. */
export function decodeBrowserControlResult(value: WireResult): CuaActionResult {
  if (value.kind === "pointer") return { kind: "pointer", x: value.x, y: value.y };
  const screenshot = Buffer.from(value.png, "base64");
  if (screenshot.toString("base64") !== value.png)
    throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  validateBrowserControlPng(screenshot);
  return { kind: "frame", screenshot };
}
export function safeBrowserControlFailure(
  error: unknown,
  dispatched: boolean,
): {
  code: CuaExecutorErrorCode;
  disposition: "not_dispatched" | "outcome_uncertain";
  reason?: CuaRejectionReason;
  diagnostic?: CuaExecutorDiagnostic;
} {
  // Only a declared error's fixed diagnostic crosses; an arbitrary exception's text never does.
  if (isComputerUseExecutorError(error))
    return {
      code: error.code,
      disposition: error.disposition,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      ...(error.diagnostic === undefined ? {} : { diagnostic: { ...error.diagnostic } }),
    };
  return {
    code: "action_rejected",
    disposition: dispatched ? "outcome_uncertain" : "not_dispatched",
  };
}
