import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import type { CuaObservation, CuaTurnRequest } from "../src/computer-use.js";
import {
  DEFAULT_OPENAI_CU_MODEL,
  OPENAI_RESPONSES_CU_CAPABILITIES,
  buildCallOutput,
  buildContinuationRequest,
  buildInitialRequest,
  createOpenAiResponsesProvider,
  openAiActionToCua,
  parseOpenAiResponse,
  type FetchLike,
  type OpenAiCuContext
} from "../src/openai-responses-cu.js";

// A tiny real PNG so buildCallOutput produces a genuine data URL.
function tinyPng(): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < 4; i += 1) {
    const o = i * 4;
    png.data[o] = 10;
    png.data[o + 1] = 20;
    png.data[o + 2] = 30;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

const SCREENSHOT = tinyPng();

function observation(): CuaObservation {
  return { screenshot: SCREENSHOT, stateSignature: "sig" };
}

function request(overrides: Partial<CuaTurnRequest> = {}): CuaTurnRequest {
  return { instructions: "Act as a new user and sign in.", observation: observation(), ...overrides };
}

const ctx: OpenAiCuContext = {
  model: DEFAULT_OPENAI_CU_MODEL,
  instructions: "Do the thing.",
  reasoningEffort: "medium"
};

const neverAbort = new AbortController().signal;

// A fetch fake that returns scripted ok JSON responses in sequence and records
// every request body it received so a test can assert on the wire shape.
function scriptedFetch(responses: unknown[]): { fetchFn: FetchLike; bodies: string[]; urls: string[] } {
  const bodies: string[] = [];
  const urls: string[] = [];
  let i = 0;
  const fetchFn: FetchLike = async (url, init) => {
    urls.push(url);
    bodies.push(init.body);
    const value = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
  };
  return { fetchFn, bodies, urls };
}

const noDelay = async (): Promise<void> => undefined;

describe("openAiActionToCua", () => {
  it("maps click with a recognized button", () => {
    expect(openAiActionToCua({ type: "click", x: 5, y: 6, button: "right" })).toEqual({
      kind: "click",
      x: 5,
      y: 6,
      button: "right"
    });
  });

  it("defaults an unknown or missing button to left", () => {
    expect(openAiActionToCua({ type: "click", x: 1, y: 2, button: "back" })).toEqual({ kind: "click", x: 1, y: 2, button: "left" });
    expect(openAiActionToCua({ type: "click", x: 1, y: 2 })).toEqual({ kind: "click", x: 1, y: 2, button: "left" });
  });

  it("maps double_click and move", () => {
    expect(openAiActionToCua({ type: "double_click", x: 3, y: 4 })).toEqual({ kind: "double_click", x: 3, y: 4 });
    expect(openAiActionToCua({ type: "move", x: 7, y: 8 })).toEqual({ kind: "move", x: 7, y: 8 });
  });

  it("maps scroll's scroll_x/scroll_y onto dx/dy", () => {
    expect(openAiActionToCua({ type: "scroll", x: 10, y: 20, scroll_x: 3, scroll_y: -4 })).toEqual({
      kind: "scroll",
      x: 10,
      y: 20,
      dx: 3,
      dy: -4
    });
  });

  it("maps type, coercing a missing text to an empty string", () => {
    expect(openAiActionToCua({ type: "type", text: "hello@example.test" })).toEqual({ kind: "type", text: "hello@example.test" });
    expect(openAiActionToCua({ type: "type" })).toEqual({ kind: "type", text: "" });
  });

  it("maps keypress keeping only string keys", () => {
    expect(openAiActionToCua({ type: "keypress", keys: ["Control", 5, "a", null] })).toEqual({
      kind: "keypress",
      keys: ["Control", "a"]
    });
  });

  it("maps drag points defensively", () => {
    expect(
      openAiActionToCua({ type: "drag", path: [{ x: 1, y: 2 }, { x: "nope", y: 4 }] })
    ).toEqual({ kind: "drag", path: [{ x: 1, y: 2 }, { x: 0, y: 4 }] });
  });

  it("maps wait and screenshot", () => {
    expect(openAiActionToCua({ type: "wait" })).toEqual({ kind: "wait" });
    expect(openAiActionToCua({ type: "screenshot" })).toEqual({ kind: "screenshot" });
  });

  it("coerces non-number coordinates to 0", () => {
    expect(openAiActionToCua({ type: "click", x: "12", y: null })).toEqual({ kind: "click", x: 0, y: 0, button: "left" });
  });

  it("returns null for an unknown type or a non-object", () => {
    expect(openAiActionToCua({ type: "teleport" })).toBeNull();
    expect(openAiActionToCua(null)).toBeNull();
    expect(openAiActionToCua("click")).toBeNull();
  });
});

describe("parseOpenAiResponse", () => {
  it("parses reasoning + message + a single computer_call(click)", () => {
    const parsed = parseOpenAiResponse({
      id: "resp_1",
      output: [
        { type: "reasoning", summary: ["thinking about the login"], content: [{ text: "more thought" }] },
        { type: "message", content: [{ type: "output_text", text: "Clicking sign in." }] },
        { type: "computer_call", call_id: "call_1", actions: [{ type: "click", x: 100, y: 200 }] }
      ],
      usage: { input_tokens: 42, output_tokens: 9 }
    });

    expect(parsed.turn.actions).toEqual([{ kind: "click", x: 100, y: 200, button: "left" }]);
    expect(parsed.callIds).toEqual(["call_1"]);
    expect(parsed.turn.done).toBe(false);
    expect(parsed.turn.responseId).toBe("resp_1");
    expect(parsed.turn.reasoning).toContain("thinking about the login");
    expect(parsed.turn.reasoning).toContain("more thought");
    expect(parsed.turn.message).toBe("Clicking sign in.");
    expect(parsed.turn.usage).toEqual({ input: 42, output: 9 });
    expect(parsed.outputItems.length).toBe(3);
  });

  it("maps the REAL Responses shape: computer_call.actions is an ARRAY (a call can carry several)", () => {
    // This is the live API shape (verified against gpt-5.5). The parser previously read a
    // singular `action`, dropping every action → the loop saw zero actions and false-passed.
    const parsed = parseOpenAiResponse({
      output: [
        { type: "computer_call", call_id: "call_x", actions: [
          { type: "screenshot" },
          { type: "click", x: 11, y: 22 },
          { type: "type", text: "hi" }
        ] }
      ]
    });
    expect(parsed.turn.actions).toEqual([
      { kind: "screenshot" },
      { kind: "click", x: 11, y: 22, button: "left" },
      { kind: "type", text: "hi" }
    ]);
    expect(parsed.turn.done).toBe(false);
    expect(parsed.callIds).toEqual(["call_x"]);
  });

  it("still maps a singular computer_call.action as a fallback (older/alt shape)", () => {
    const parsed = parseOpenAiResponse({
      output: [{ type: "computer_call", call_id: "c1", action: { type: "click", x: 5, y: 6 } }]
    });
    expect(parsed.turn.actions).toEqual([{ kind: "click", x: 5, y: 6, button: "left" }]);
    expect(parsed.callIds).toEqual(["c1"]);
    expect(parsed.turn.done).toBe(false);
  });

  it("marks a message-only response as done with no actions", () => {
    const parsed = parseOpenAiResponse({
      id: "resp_done",
      output: [{ type: "message", content: [{ type: "output_text", text: "All set." }] }]
    });
    expect(parsed.turn.actions).toEqual([]);
    expect(parsed.turn.done).toBe(true);
    expect(parsed.turn.message).toBe("All set.");
    expect(parsed.callIds).toEqual([]);
  });

  it("collects pending_safety_check triples verbatim, with fallbacks for partial shapes", () => {
    const parsed = parseOpenAiResponse({
      output: [
        {
          type: "computer_call",
          call_id: "call_x",
          actions: [{ type: "click", x: 1, y: 1 }],
          pending_safety_checks: [
            { id: "sc_1", code: "malicious_instructions", message: "be careful" },
            { code: "code_only" },
            { id: "fallback_id" },
            {}
          ]
        }
      ]
    });
    expect(parsed.turn.pendingSafetyChecks).toEqual([
      { id: "sc_1", code: "malicious_instructions", message: "be careful" },
      { id: "code_only", code: "code_only", message: "code_only" },
      { id: "fallback_id", code: "fallback_id", message: "fallback_id" },
      { id: "safety_check", code: "safety_check", message: "safety_check" }
    ]);
  });

  it("collects a top-level output_text into the message", () => {
    const parsed = parseOpenAiResponse({ output: [], output_text: "Done via shortcut." });
    expect(parsed.turn.message).toBe("Done via shortcut.");
    expect(parsed.turn.done).toBe(true);
  });

  it("omits optional fields when absent", () => {
    const parsed = parseOpenAiResponse({ output: [] });
    expect(parsed.turn.responseId).toBeUndefined();
    expect(parsed.turn.reasoning).toBeUndefined();
    expect(parsed.turn.message).toBeUndefined();
    expect(parsed.turn.usage).toBeUndefined();
  });
});

describe("request builders", () => {
  it("buildInitialRequest carries the tool spec, reasoning, and an input_text user item", () => {
    const body = buildInitialRequest(ctx);
    expect(body.model).toBe(DEFAULT_OPENAI_CU_MODEL);
    // The live `computer` tool takes no display/environment fields (verified against the API
    // 2026-06; sending them returns 400 "Unknown parameter tools[0].display_width").
    expect(body.tools).toEqual([{ type: "computer" }]);
    expect(body.truncation).toBe("auto");
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.instructions).toBe("Do the thing.");
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Do the thing." }] }]);
    expect(body.safety_identifier).toBeUndefined();
  });

  it("buildInitialRequest includes safety_identifier only when configured", () => {
    const body = buildInitialRequest({ ...ctx, safetyIdentifier: "persona-dana" });
    expect(body.safety_identifier).toBe("persona-dana");
  });

  it("buildCallOutput produces a computer_call_output with a png data url", () => {
    const out = buildCallOutput("call_42", SCREENSHOT) as {
      type: string;
      call_id: string;
      output: { type: string; image_url: string };
      acknowledged_safety_checks?: unknown;
    };
    expect(out.type).toBe("computer_call_output");
    expect(out.call_id).toBe("call_42");
    expect(out.output.type).toBe("computer_screenshot");
    expect(out.output.image_url.startsWith("data:image/png;base64,")).toBe(true);
    expect(out.output.image_url.length).toBeGreaterThan("data:image/png;base64,".length);
    expect(out.acknowledged_safety_checks).toBeUndefined();
  });

  it("buildCallOutput echoes acknowledged safety checks verbatim (wire id preserved, never fabricated)", () => {
    const out = buildCallOutput("call_42", SCREENSHOT, [
      { id: "sc_123", code: "malicious_instructions", message: "be careful" }
    ]) as {
      acknowledged_safety_checks: Array<{ id: string; code: string; message: string }>;
    };
    expect(out.acknowledged_safety_checks).toEqual([
      { id: "sc_123", code: "malicious_instructions", message: "be careful" }
    ]);
  });

  it("buildContinuationRequest threads previous_response_id in normal mode", () => {
    const callOutput = buildCallOutput("call_1", SCREENSHOT);
    const body = buildContinuationRequest({
      ctx,
      previousResponseId: "resp_prev",
      callOutputs: [callOutput],
      contextHint: "You seem stuck; try another control."
    });
    expect(body.previous_response_id).toBe("resp_prev");
    const input = body.input as unknown[];
    expect(input[0]).toBe(callOutput);
    expect(input[input.length - 1]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "You seem stuck; try another control." }]
    });
  });

  it("buildContinuationRequest drops previous_response_id and spreads explicit context in ZDR mode", () => {
    const callOutput = buildCallOutput("call_1", SCREENSHOT);
    const priorItems = [{ type: "reasoning", summary: ["earlier"] }];
    const body = buildContinuationRequest({
      ctx,
      previousResponseId: "resp_prev",
      callOutputs: [callOutput],
      explicitContextItems: priorItems
    });
    expect(body.previous_response_id).toBeUndefined();
    const input = body.input as unknown[];
    expect(input[0]).toBe(priorItems[0]);
    expect(input[1]).toBe(callOutput);
  });
});

describe("createOpenAiResponsesProvider", () => {
  it("declares its identity and capabilities", () => {
    const provider = createOpenAiResponsesProvider({ apiKey: "test-key", fetchFn: scriptedFetch([]).fetchFn });
    expect(provider.id).toBe("openai-responses-cu");
    expect(provider.version).toBe(DEFAULT_OPENAI_CU_MODEL);
    expect(provider.capabilities).toEqual(OPENAI_RESPONSES_CU_CAPABILITIES);
  });

  it("drives multiple turns and threads call output + previous_response_id", async () => {
    const { fetchFn, bodies } = scriptedFetch([
      { id: "resp_1", output: [{ type: "computer_call", call_id: "call_1", actions: [{ type: "click", x: 11, y: 22 }] }] },
      { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Finished." }] }] }
    ]);
    const provider = createOpenAiResponsesProvider({ apiKey: "test-key", fetchFn });

    const turn1 = await provider.nextTurn(request(), neverAbort);
    expect(turn1.actions).toEqual([{ kind: "click", x: 11, y: 22, button: "left" }]);
    expect(turn1.done).toBe(false);

    const turn2 = await provider.nextTurn(request(), neverAbort);
    expect(turn2.done).toBe(true);
    expect(turn2.message).toBe("Finished.");

    // The second request must carry the call output (with the screenshot) and
    // thread the first response's id.
    const second = JSON.parse(bodies[1] ?? "{}") as { previous_response_id?: string; input: unknown[] };
    expect(second.previous_response_id).toBe("resp_1");
    const callOutput = second.input[0] as { type: string; call_id: string; output: { image_url: string } };
    expect(callOutput.type).toBe("computer_call_output");
    expect(callOutput.call_id).toBe("call_1");
    expect(callOutput.output.image_url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("falls back to explicit_context mode when the account rejects server-side state", async () => {
    let call = 0;
    const bodies: string[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(init.body);
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({
            id: "resp_1",
            output: [{ type: "computer_call", call_id: "call_1", actions: [{ type: "click", x: 1, y: 1 }] }]
          })
        };
      }
      if (call === 2) {
        // The first continuation POST is rejected for ZDR.
        return { ok: false, status: 400, text: async () => "Error: Zero Data Retention is enabled for this org.", json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] })
      };
    };
    const provider = createOpenAiResponsesProvider({ apiKey: "test-key", fetchFn, delayFn: noDelay });

    await provider.nextTurn(request(), neverAbort);
    const turn2 = await provider.nextTurn(request(), neverAbort);
    expect(turn2.done).toBe(true);
    expect(turn2.message).toBe("Done.");

    // Three POSTs: initial, rejected continuation, retried continuation.
    expect(call).toBe(3);
    const retried = JSON.parse(bodies[2] ?? "{}") as { previous_response_id?: string; input: unknown[] };
    expect(retried.previous_response_id).toBeUndefined();
    // The retried body re-sends the prior output items (the computer_call) inline.
    const firstItem = retried.input[0] as { type: string };
    expect(firstItem.type).toBe("computer_call");
  });

  it("retries a transient 429 and then succeeds", async () => {
    let call = 0;
    const fetchFn: FetchLike = async () => {
      call += 1;
      if (call === 1) {
        return { ok: false, status: 429, text: async () => "rate limited", json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
      };
    };
    const provider = createOpenAiResponsesProvider({ apiKey: "test-key", fetchFn, delayFn: noDelay });
    const turn = await provider.nextTurn(request(), neverAbort);
    expect(call).toBe(2);
    expect(turn.done).toBe(true);
    expect(turn.message).toBe("ok");
  });

  it("never leaks the api key in a returned turn", async () => {
    const apiKey = "super-secret-key-do-not-leak";
    const { fetchFn } = scriptedFetch([
      { id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "fine" }] }] }
    ]);
    const provider = createOpenAiResponsesProvider({ apiKey, fetchFn });
    const turn = await provider.nextTurn(request(), neverAbort);
    expect(JSON.stringify(turn)).not.toContain(apiKey);
  });

  it("does not leak the api key or the response body in a non-ok error", async () => {
    const apiKey = "super-secret-key-do-not-leak";
    const responseBody = "internal failure detail that may echo the screenshot input";
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 503,
      text: async () => responseBody,
      json: async () => ({})
    });
    const provider = createOpenAiResponsesProvider({ apiKey, fetchFn, maxRetries: 0, delayFn: noDelay });
    let thrown: unknown;
    try {
      await provider.nextTurn(request(), neverAbort);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe("OpenAI Responses 503");
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(responseBody);
  });
});
