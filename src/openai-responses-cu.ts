import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ActorCapabilities } from "./actor-contract.js";
import type { CuaAction, CuaProvider, CuaSafetyCheck, CuaTurn, CuaTurnRequest } from "./computer-use.js";
import { redactText } from "./redaction.js";

// A public-safe re-derivation of the OpenAI Responses API computer-use provider,
// behind the CuaProvider port from src/computer-use.ts. It mirrors the
// pure-mapper-plus-injectable-shim pattern proven in src/claude-agent-sdk.ts:
//
//  - PURE mappers (openAiActionToCua, parseOpenAiResponse) and request builders
//    (buildInitialRequest, buildCallOutput, buildContinuationRequest) project the
//    Responses wire shape to/from the provider-neutral CuaAction / CuaTurn types
//    with no network, so they are fully unit-testable in CI (no key, no spend, no
//    SDK); and
//  - the live shim (createOpenAiResponsesProvider) does a RAW POST to the
//    Responses endpoint (no SDK dependency) through an injectable FetchLike seam,
//    so the retry, ZDR fallback, and state threading are testable with a fake.
//
// Public-safety invariants (this is an OSS repo): the apiKey only ever appears in
// the Authorization header, never in a returned object, thrown error, or comment.
// Request bodies (which carry base64 screenshots and the persona instructions)
// and screenshots are never logged or returned; nextTurn returns ONLY a CuaTurn,
// and the engine handles redaction of CuaTurn fields downstream. Error messages
// carry the HTTP status only, never the response body (it can echo the input).
//
// Wire capture (fixture provenance). The 0.6.1 parser incident — the parser read
// `computer_call.action` (singular) while the live API returns `actions` (array),
// and the hand-written fixtures encoded the SAME wrong shape, so tests passed in
// lockstep with the bug while every live action was silently dropped — taught us
// that deterministic fixtures must derive from CAPTURED live wire shapes, never
// from memory. Setting MIMETIC_CUA_WIRE_CAPTURE_DIR makes the live shim persist
// each successful Responses RESPONSE body into that directory as pretty-printed
// JSON, one file per provider call in call order (wire-001.json, wire-002.json,
// ...), for refreshing fixtures. The capture seam is:
//  - OPT-IN: unset (or empty) env means zero behavior change — nothing is written;
//  - RESPONSE-side only: request bodies carry base64 screenshots and the persona
//    instructions and are NEVER captured; non-ok response bodies can echo the
//    request and are never captured either;
//  - REDACTED: every string field (keys and values) passes through the shared
//    redactText (src/redaction.ts) before writing, so a secret-shaped echo in a
//    response cannot persist to disk.
// Point the env var at a gitignored path (e.g. under .mimetic/): raw captures must
// never be committed — fixtures derived from them must be minimal, hand-reviewed
// excerpts checked into tests deliberately.

export const OPENAI_RESPONSES_CU_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: false,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "proprietary"
};

export const DEFAULT_OPENAI_CU_MODEL = "gpt-5.5";

// ---------------------------------------------------------------------------
// Defensive readers. The Responses wire shape is loosely typed (unknown), so we
// read every field defensively: a non-object is treated as empty, a non-number
// coordinate becomes 0, and a non-string text becomes "".
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPoint(value: unknown): { x: number; y: number } {
  const point = asRecord(value);
  return { x: asNumber(point.x), y: asNumber(point.y) };
}

/**
 * Map an OpenAI computer action object to a provider-neutral CuaAction, or null
 * for an unknown type. Every coordinate and field is read defensively so a
 * malformed action never throws and a non-number coordinate becomes 0.
 */
export function openAiActionToCua(action: unknown): CuaAction | null {
  const record = asRecord(action);
  const type = asString(record.type);
  switch (type) {
    case "click": {
      const button = record.button;
      return {
        kind: "click",
        x: asNumber(record.x),
        y: asNumber(record.y),
        button: button === "right" || button === "middle" ? button : "left"
      };
    }
    case "double_click":
      return { kind: "double_click", x: asNumber(record.x), y: asNumber(record.y) };
    case "move":
      return { kind: "move", x: asNumber(record.x), y: asNumber(record.y) };
    case "scroll":
      return {
        kind: "scroll",
        x: asNumber(record.x),
        y: asNumber(record.y),
        dx: asNumber(record.scroll_x),
        dy: asNumber(record.scroll_y)
      };
    case "type":
      return { kind: "type", text: asString(record.text) };
    case "keypress":
      return { kind: "keypress", keys: asArray(record.keys).filter((key): key is string => typeof key === "string") };
    case "drag":
      return { kind: "drag", path: asArray(record.path).map(asPoint) };
    case "wait":
      return { kind: "wait" };
    case "screenshot":
      return { kind: "screenshot" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Response parsing.
// ---------------------------------------------------------------------------

export interface ParsedOpenAiResponse {
  turn: CuaTurn;
  callIds: string[];
  outputItems: unknown[];
}

// Collect plain strings or { text } entries from a reasoning summary/content array.
function collectTextEntries(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry === "string") {
      if (entry.length > 0) out.push(entry);
      continue;
    }
    const text = asString(asRecord(entry).text);
    if (text.length > 0) out.push(text);
  }
  return out;
}

// Collect output_text strings from a message content array.
function collectMessageText(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (asString(record.type) === "output_text") {
      const text = asString(record.text);
      if (text.length > 0) out.push(text);
    }
  }
  return out;
}

/**
 * Parse a Responses API response into a provider-neutral CuaTurn plus the
 * computer_call ids (needed to build the next turn's call outputs) and the raw
 * output items (needed for ZDR explicit-context continuation). Pure: no network,
 * no mutation of the input. Optional CuaTurn fields are only set when present so
 * the result satisfies exactOptionalPropertyTypes.
 */
export function parseOpenAiResponse(raw: unknown): ParsedOpenAiResponse {
  const root = asRecord(raw);
  const responseId = optionalString(root.id);
  const output = asArray(root.output);

  const actions: CuaAction[] = [];
  const callIds: string[] = [];
  const reasoningParts: string[] = [];
  const messageParts: string[] = [];
  const safetyChecks: CuaSafetyCheck[] = [];

  for (const rawItem of output) {
    const item = asRecord(rawItem);
    switch (asString(item.type)) {
      case "reasoning":
        reasoningParts.push(...collectTextEntries(item.summary), ...collectTextEntries(item.content));
        break;
      case "message":
        messageParts.push(...collectMessageText(item.content));
        break;
      case "output_text": {
        const text = asString(item.text);
        if (text.length > 0) messageParts.push(text);
        break;
      }
      case "computer_call": {
        const callId = optionalString(item.call_id);
        if (callId !== undefined) callIds.push(callId);
        // The live Responses API returns the actions as an ARRAY (`item.actions`); a single
        // computer_call can carry several. (An older/alt shape used a singular `item.action` —
        // supported as a fallback.) Reading only `item.action` silently dropped EVERY action,
        // which made the loop see zero actions and stop on a false `goal_satisfied`.
        const rawActions = Array.isArray(item.actions)
          ? item.actions
          : item.action !== undefined
            ? [item.action]
            : [];
        for (const rawAction of rawActions) {
          const mapped = openAiActionToCua(rawAction);
          if (mapped !== null) actions.push(mapped);
        }
        // Preserve the wire triple verbatim: the API matches acknowledgements on
        // `id`, so collapsing to a code string (and fabricating ids on echo)
        // would silently break the proceed path.
        for (const rawCheck of asArray(item.pending_safety_checks)) {
          const check = asRecord(rawCheck);
          const id = asString(check.id);
          const code = asString(check.code);
          safetyChecks.push({
            id: id || code || "safety_check",
            code: code || id || "safety_check",
            message: asString(check.message) || code || id || "safety_check"
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const topText = asString(root.output_text);
  if (topText.length > 0) messageParts.push(topText);

  const reasoning = reasoningParts.filter((part) => part.length > 0).join("\n");
  const message = messageParts.filter((part) => part.length > 0).join("\n");

  const usageRecord = asRecord(root.usage);
  const usageInput = optionalNumber(usageRecord.input_tokens);
  const usageOutput = optionalNumber(usageRecord.output_tokens);
  const usage =
    usageInput === undefined && usageOutput === undefined
      ? undefined
      : { ...(usageInput === undefined ? {} : { input: usageInput }), ...(usageOutput === undefined ? {} : { output: usageOutput }) };

  const turn: CuaTurn = {
    actions,
    pendingSafetyChecks: safetyChecks,
    done: actions.length === 0,
    ...(responseId === undefined ? {} : { responseId }),
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(message.length > 0 ? { message } : {}),
    ...(usage === undefined ? {} : { usage })
  };

  return { turn, callIds, outputItems: output };
}

// ---------------------------------------------------------------------------
// Request builders. Each returns a plain object that is JSON-serialized as the
// POST body. They never carry the apiKey (that lives only in the header).
// ---------------------------------------------------------------------------

export interface OpenAiCuContext {
  model: string;
  instructions: string;
  reasoningEffort: "low" | "medium" | "high";
  safetyIdentifier?: string;
}

// The fields shared by the initial and continuation requests: the tool spec,
// truncation policy, reasoning effort, and (when configured) the safety id.
function sharedRequestFields(ctx: OpenAiCuContext): Record<string, unknown> {
  return {
    model: ctx.model,
    // The Responses API `computer` tool takes no display/environment fields — the model infers
    // resolution from the screenshots it is sent. (Sending display_* returns a 400
    // "Unknown parameter tools[0].display_width", confirmed against the live API 2026-06.)
    tools: [{ type: "computer" }],
    truncation: "auto",
    reasoning: { effort: ctx.reasoningEffort },
    ...(ctx.safetyIdentifier === undefined ? {} : { safety_identifier: ctx.safetyIdentifier })
  };
}

/** Build the first-turn request body: instructions + an initial user text input. */
export function buildInitialRequest(ctx: OpenAiCuContext): Record<string, unknown> {
  return {
    ...sharedRequestFields(ctx),
    instructions: ctx.instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: ctx.instructions }] }]
  };
}

/**
 * Build one computer_call_output for a pending call id, carrying the latest
 * screenshot as an inline data URL. Acknowledged safety checks (if any) are
 * echoed back so the model can proceed past a check the harness approved.
 *
 * The screenshot param is `Buffer | undefined` because CuaObservation.screenshot is now
 * optional (a non-vision executor omits it). This provider is a VISION model (it sets
 * requiresFrame), so a missing frame is a hard error here — defense-in-depth: the loop's
 * per-turn requiresFrame guard already fails closed before this is reached, but throwing keeps
 * the mapper self-validating and isolable.
 */
export function buildCallOutput(callId: string, screenshot: Buffer | undefined, acknowledged?: CuaSafetyCheck[]): Record<string, unknown> {
  if (screenshot === undefined) {
    throw new Error("openai-responses-cu requires observation.screenshot (it is a vision provider; pair a state-only executor with a non-vision provider)");
  }
  return {
    type: "computer_call_output",
    call_id: callId,
    output: {
      type: "computer_screenshot",
      image_url: `data:image/png;base64,${screenshot.toString("base64")}`
    },
    ...(acknowledged && acknowledged.length > 0
      ? { acknowledged_safety_checks: acknowledged.map(({ id, code, message }) => ({ id, code, message })) }
      : {})
  };
}

export interface ContinuationRequestArgs {
  ctx: OpenAiCuContext;
  previousResponseId: string | undefined;
  callOutputs: object[];
  contextHint?: string;
  explicitContextItems?: unknown[];
}

// Turn an optional context-hint string into an input item array (or empty).
function hintItems(contextHint: string | undefined): unknown[] {
  return contextHint ? [{ role: "user", content: [{ type: "input_text", text: contextHint }] }] : [];
}

/**
 * Build a continuation request body. Two modes:
 *  - default: thread server-side state via previous_response_id and send only the
 *    new call outputs (plus an optional hint).
 *  - explicit-context (ZDR): no previous_response_id; the prior output items are
 *    re-sent inline ahead of the new call outputs so the model has full context
 *    without the server retaining any.
 */
export function buildContinuationRequest(args: ContinuationRequestArgs): Record<string, unknown> {
  const { ctx, previousResponseId, callOutputs, contextHint, explicitContextItems } = args;
  if (explicitContextItems === undefined) {
    return {
      ...sharedRequestFields(ctx),
      previous_response_id: previousResponseId,
      input: [...callOutputs, ...hintItems(contextHint)]
    };
  }
  return {
    ...sharedRequestFields(ctx),
    input: [...explicitContextItems, ...callOutputs, ...hintItems(contextHint)]
  };
}

// ---------------------------------------------------------------------------
// Wire capture (see the module header). Pure helpers, exported for unit tests.
// ---------------------------------------------------------------------------

/** The opt-in gate for response wire capture: a directory path, or unset for off. */
export const WIRE_CAPTURE_ENV = "MIMETIC_CUA_WIRE_CAPTURE_DIR";

/**
 * Deep-copy a captured wire value with every string — object keys included —
 * passed through the shared redactText, so a secret-shaped echo in a response
 * can never persist to disk. Pure; non-string primitives pass through unchanged.
 */
export function redactWireJson(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactWireJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [redactText(key), redactWireJson(entry)])
    );
  }
  return value;
}

/** Deterministic ordered capture file name for the 1-based nth provider call. */
export function wireCaptureFileName(callNumber: number): string {
  return `wire-${String(callNumber).padStart(3, "0")}.json`;
}

// ---------------------------------------------------------------------------
// Live shim: a stateful CuaProvider over a raw POST to the Responses endpoint.
// ---------------------------------------------------------------------------

/**
 * The minimal slice of the fetch contract the shim depends on. Injecting this
 * (rather than importing a fetch type) keeps the module dependency-free and lets
 * CI tests run with a fake that never touches the network.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface OpenAiResponsesProviderOptions {
  apiKey: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  safetyIdentifier?: string;
  endpoint?: string;
  fetchFn?: FetchLike;
  maxRetries?: number;
  delayFn?: (ms: number) => Promise<void>;
  zeroDataRetention?: boolean;
  /**
   * Environment for the wire-capture gate (MIMETIC_CUA_WIRE_CAPTURE_DIR — see the
   * module header). Injectable so deterministic tests control the gate without
   * mutating process.env. Defaults to process.env.
   */
  env?: Record<string, string | undefined>;
}

// A typed error so nextTurn can distinguish a ZDR-policy rejection (recoverable
// by switching to explicit-context mode) from any other non-ok status. It never
// carries the apiKey or the response body.
class ZdrError extends Error {
  constructor() {
    super("OpenAI Responses rejected server-side state (zero data retention)");
    this.name = "ZdrError";
  }
}

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/responses";

// A 400 whose body mentions any of these means the account/org cannot use
// server-side response state, so we must fall back to explicit-context mode.
function isZdrRejection(bodyText: string): boolean {
  return (
    bodyText.includes("Zero Data Retention") ||
    bodyText.includes("zero data retention") ||
    bodyText.includes("previous_response_id")
  );
}

function defaultFetch(): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    return {
      ok: res.ok,
      status: res.status,
      text: () => res.text(),
      json: () => res.json() as Promise<unknown>
    };
  };
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * Create a stateful CuaProvider backed by the OpenAI Responses API. The first
 * turn opens a session (buildInitialRequest); subsequent turns send the prior
 * call outputs (with the latest screenshot) and thread state via
 * previous_response_id, transparently falling back to explicit-context mode if
 * the account rejects server-side retention. Transient HTTP failures are retried
 * with exponential backoff. Returns ONLY a CuaTurn from nextTurn; nothing
 * sensitive (the key, the request body, the screenshot, the raw response body)
 * is ever returned or logged.
 */
export function createOpenAiResponsesProvider(options: OpenAiResponsesProviderOptions): CuaProvider {
  const model = options.model ?? DEFAULT_OPENAI_CU_MODEL;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const reasoningEffort = options.reasoningEffort ?? "medium";
  const maxRetries = options.maxRetries ?? 3;
  const fetchFn = options.fetchFn ?? defaultFetch();
  const delayFn = options.delayFn ?? defaultDelay;
  // Opt-in response wire capture (see module header): unset/empty means OFF and
  // zero behavior change. The counter is per-provider, so file order is call order.
  const captureDir = optionalString((options.env ?? process.env)[WIRE_CAPTURE_ENV]?.trim());
  let captureCount = 0;

  // Persist one successful RESPONSE body, redacted and pretty-printed. Fails loud:
  // a silent capture failure would mean missing turns in a fixture refresh — the
  // exact "fixtures drift from the wire" pathology capture exists to prevent.
  const captureResponse = async (raw: unknown): Promise<void> => {
    if (captureDir === undefined) return;
    captureCount += 1;
    await mkdir(captureDir, { recursive: true });
    await writeFile(
      path.join(captureDir, wireCaptureFileName(captureCount)),
      `${JSON.stringify(redactWireJson(raw), null, 2)}\n`,
      "utf8"
    );
  };

  let lastResponseId: string | undefined;
  let pendingCallIds: string[] = [];
  let lastOutputItems: unknown[] = [];
  let mode: "previous_response_id" | "explicit_context" = options.zeroDataRetention ? "explicit_context" : "previous_response_id";

  const buildContext = (instructions: string): OpenAiCuContext => ({
    model,
    instructions,
    reasoningEffort,
    ...(options.safetyIdentifier === undefined ? {} : { safetyIdentifier: options.safetyIdentifier })
  });

  // POST the JSON body and return the parsed JSON on success. Retries on
  // transient statuses (408/409/429/>=500). Maps a ZDR-policy 400 to a typed
  // ZdrError; any other non-ok status throws with the STATUS ONLY (never the
  // body, which can echo the input/screenshot).
  const post = async (body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json"
    };
    const payload = JSON.stringify(body);
    let lastStatus = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers,
        body: payload,
        ...(signal === undefined ? {} : { signal })
      });
      if (res.ok) {
        const parsed: unknown = await res.json();
        // Capture AFTER ok and BEFORE parse-to-CuaTurn: responses only, never the
        // request (screenshots/instructions) and never a non-ok body (input echo).
        await captureResponse(parsed);
        return parsed;
      }
      lastStatus = res.status;
      if (res.status === 400) {
        const bodyText = await res.text();
        if (isZdrRejection(bodyText)) {
          throw new ZdrError();
        }
        throw new Error("OpenAI Responses 400");
      }
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        await delayFn(2 ** attempt * 200);
        continue;
      }
      throw new Error(`OpenAI Responses ${res.status}`);
    }
    throw new Error(`OpenAI Responses ${lastStatus}`);
  };

  return {
    id: "openai-responses-cu",
    version: model,
    capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
    // This is a VISION provider: nextTurn sends the screenshot as the computer_call_output, so
    // it cannot reason over a screenshot-less observation. The loop reads this to fail closed
    // (harness_error) when a state-only executor is paired with it (provider-authoring contract).
    requiresFrame: true,
    async nextTurn(req: CuaTurnRequest, signal: AbortSignal): Promise<CuaTurn> {
      const ctx = buildContext(req.instructions);
      const isFirstTurn = lastResponseId === undefined && pendingCallIds.length === 0;

      let raw: unknown;
      if (isFirstTurn) {
        raw = await post(buildInitialRequest(ctx), signal);
      } else {
        const callOutputs = pendingCallIds.map((id) =>
          buildCallOutput(id, req.observation.screenshot, req.acknowledgedSafetyChecks)
        );
        const buildBody = (explicitContextItems: unknown[] | undefined): Record<string, unknown> =>
          buildContinuationRequest({
            ctx,
            previousResponseId: lastResponseId,
            callOutputs,
            ...(req.contextHint === undefined ? {} : { contextHint: req.contextHint }),
            ...(explicitContextItems === undefined ? {} : { explicitContextItems })
          });
        try {
          raw = await post(buildBody(mode === "explicit_context" ? lastOutputItems : undefined), signal);
        } catch (error) {
          if (error instanceof ZdrError) {
            mode = "explicit_context";
            raw = await post(buildBody(lastOutputItems), signal);
          } else {
            throw error;
          }
        }
      }

      const parsed = parseOpenAiResponse(raw);
      if (parsed.turn.responseId !== undefined) lastResponseId = parsed.turn.responseId;
      pendingCallIds = parsed.callIds;
      lastOutputItems = parsed.outputItems;
      return parsed.turn;
    }
  };
}
