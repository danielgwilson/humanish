import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_MAX_OUTPUT_BYTES,
  CODEX_MAX_REQUEST_BYTES,
} from "../../../src/actors/codex/restricted-policy.js";
import { RestrictedCodexDeadline } from "../../../src/actors/codex/restricted-transport.js";
import { RestrictedCodexTurn } from "../../../src/actors/codex/restricted-turn.js";

const THREAD = "thread-1",
  TURN = "turn-1",
  TOOL = "humanish_ui";
const deadlines: RestrictedCodexDeadline[] = [];
afterEach(() => {
  for (const deadline of deadlines.splice(0)) deadline.close();
});

function setup(
  options: { analyst?: boolean; dispatched?: boolean; reply?: () => Promise<unknown> } = {},
) {
  const deadline = new RestrictedCodexDeadline(60_000);
  deadlines.push(deadline);
  const call = options.reply ?? (async () => '{"ok":true}');
  const turn = new RestrictedCodexTurn({
    deadline,
    threadId: () => THREAD,
    tool: options.analyst ? undefined : { name: TOOL, call: call as () => Promise<string> },
    usageBaseline: { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 },
    toolCallIds: new Set(),
    reportUsage: () => undefined,
    turnStarted: () => undefined,
  });
  turn.dispatched = options.dispatched ?? true;
  return { turn, deadline };
}
const event = (item: Record<string, unknown>, turnId = TURN) => ({
  threadId: THREAD,
  turnId,
  item,
});
const answer = (changes: Record<string, unknown> = {}) => ({
  type: "agentMessage",
  id: "answer-1",
  text: '{"ok":true}',
  phase: "final_answer",
  delivery: null,
  ...changes,
});
const completion = (changes: Record<string, unknown> = {}) => ({
  threadId: THREAD,
  turn: { id: TURN, status: "completed", error: null, ...changes },
});
const toolRequest = (changes: Record<string, unknown> = {}) => ({
  threadId: THREAD,
  turnId: TURN,
  namespace: null,
  tool: TOOL,
  callId: "call-1",
  arguments: {},
  ...changes,
});
function thrownCode(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

describe("restricted Codex turn notifications", () => {
  it("ignores notifications until the request is dispatched", () => {
    const { turn, deadline } = setup({ dispatched: false });
    turn.onNotification("item/started", { ...event(answer()), threadId: "other-thread" });
    expect(deadline.code).toBeNull();
  });

  it("refuses an event from another thread before turn/start's reply arrives", () => {
    const { turn, deadline } = setup();
    turn.onNotification("item/started", { ...event(answer()), threadId: "other-thread" });
    expect(deadline.code).toBe("codex_protocol_error");
  });

  it("refuses a delta that is not a string", () => {
    const { turn, deadline } = setup();
    turn.acknowledge(TURN);
    expect(() =>
      turn.onNotification("item/agentMessage/delta", { threadId: THREAD, turnId: TURN, delta: 5 }),
    ).not.toThrow();
    expect(deadline.code).toBe("codex_protocol_error");
  });

  it("refuses an early event for a turn other than the acknowledged one", () => {
    const { turn, deadline } = setup();
    turn.onNotification("item/started", event({ type: "reasoning" }, "turn-2"));
    expect(deadline.code).toBeNull();
    turn.acknowledge(TURN);
    expect(deadline.code).toBe("codex_protocol_error");
  });

  it("stops on a model refusal", () => {
    const { turn, deadline } = setup();
    turn.acknowledge(TURN);
    turn.onNotification(
      "rawResponseItem/completed",
      event({ type: "message", content: [{ type: "refusal" }] }),
    );
    expect(deadline.code).toBe("refusal");
  });

  it.each([
    ["an analyst's dynamic tool item", true, { type: "dynamicToolCall" }],
    ["a participant's command item", false, { type: "commandExecution" }],
  ])("refuses %s outside the item allowlist", (_, analyst, item) => {
    const { turn, deadline } = setup({ analyst });
    turn.acknowledge(TURN);
    turn.onNotification("item/started", event(item));
    expect(deadline.code).toBe("codex_tool_call");
  });

  const dynamic = { type: "dynamicToolCall", tool: TOOL, namespace: null };
  it.each([
    ["another tool", "item/started", { ...dynamic, tool: "other", status: "inProgress" }],
    ["a namespace", "item/started", { ...dynamic, namespace: "ns", status: "inProgress" }],
    ["a start that is not in progress", "item/started", { ...dynamic, status: "completed" }],
    [
      "a completion that did not complete",
      "item/completed",
      { ...dynamic, status: "failed", success: true },
    ],
    [
      "a completion that did not succeed",
      "item/completed",
      { ...dynamic, status: "completed", success: false },
    ],
  ])("refuses a dynamic tool item with %s", (_, method, item) => {
    const { turn, deadline } = setup();
    turn.acknowledge(TURN);
    turn.onNotification(method, event(item));
    expect(deadline.code).toBe("codex_tool_call");
  });

  it("admits the participant's own dynamic tool item", () => {
    const { turn, deadline } = setup();
    turn.acknowledge(TURN);
    turn.onNotification("item/started", event({ ...dynamic, status: "inProgress" }));
    turn.onNotification(
      "item/completed",
      event({ ...dynamic, status: "completed", success: true }),
    );
    expect(deadline.code).toBeNull();
  });

  it.each([
    ["a non-string id", { id: 5 }],
    ["non-string text", { text: 5 }],
    ["text over the output cap", { text: "x".repeat(CODEX_MAX_OUTPUT_BYTES + 1) }],
    ["an unknown phase", { phase: "draft" }],
    ["a delivery mode", { delivery: "later" }],
  ])("refuses a final answer with %s", (_, changes) => {
    const { turn, deadline } = setup();
    turn.acknowledge(TURN);
    expect(() => turn.onNotification("item/completed", event(answer(changes)))).not.toThrow();
    expect(deadline.code).toBe("invalid_response");
  });
});

describe("restricted Codex turn completion", () => {
  it("resolves a completed turn with its validated answer", async () => {
    const { turn, deadline } = setup();
    turn.acknowledge(TURN);
    turn.onNotification("item/completed", event(answer()));
    turn.onNotification("turn/completed", completion());
    await expect(turn.finished).resolves.toMatchObject({
      status: "completed",
      output: { ok: true },
    });
    expect(deadline.code).toBeNull();
  });

  it("refuses a second completion", () => {
    const { turn, deadline } = setup();
    turn.acknowledge(TURN);
    turn.onNotification("item/completed", event(answer()));
    turn.onNotification("turn/completed", completion());
    turn.onNotification("turn/completed", completion());
    expect(deadline.code).toBe("codex_protocol_error");
  });

  it.each([
    ["a failed status", { status: "failed" }],
    ["an error", { error: { message: "synthetic" } }],
  ])("refuses a completion with %s", (_, changes) => {
    const { turn, deadline } = setup();
    turn.acknowledge(TURN);
    turn.onNotification("item/completed", event(answer()));
    turn.onNotification("turn/completed", completion(changes));
    expect(deadline.code).toBe("invalid_response");
  });
});

describe("restricted Codex turn acknowledgment", () => {
  it.each([
    ["a non-string id", 5],
    ["an empty id", ""],
    ["an id over 200 characters", "x".repeat(201)],
  ])("refuses a reply with %s", (_, id) => {
    const { turn } = setup();
    expect(thrownCode(() => turn.acknowledge(id))).toBe("codex_protocol_error");
  });

  it("refuses a reply that names a different turn than turn/started did", () => {
    const { turn } = setup();
    turn.onNotification("turn/started", { threadId: THREAD, turn: { id: TURN } });
    expect(thrownCode(() => turn.acknowledge("turn-2"))).toBe("codex_protocol_error");
  });
});

describe("restricted Codex turn tool requests", () => {
  it("answers the participant's own tool request", async () => {
    const { turn } = setup();
    turn.acknowledge(TURN);
    await expect(turn.onRequest("item/tool/call", toolRequest())).resolves.toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: '{"ok":true}' }],
    });
  });

  it.each([
    ["an analyst's request", { analyst: true }, "item/tool/call", toolRequest()],
    ["another method", {}, "item/other/call", toolRequest()],
    ["a non-string call id", {}, "item/tool/call", toolRequest({ callId: 5 })],
    ["an empty call id", {}, "item/tool/call", toolRequest({ callId: "" })],
    [
      "a call id over 200 characters",
      {},
      "item/tool/call",
      toolRequest({ callId: "x".repeat(201) }),
    ],
    ["a request for another turn", {}, "item/tool/call", toolRequest({ turnId: "turn-2" })],
  ])("refuses %s", async (_, options, method, params) => {
    const { turn } = setup(options);
    turn.acknowledge(TURN);
    await expect(turn.onRequest(method, params)).rejects.toMatchObject({ code: "codex_tool_call" });
  });

  it("refuses a second request while one is pending", async () => {
    const { turn } = setup({ reply: () => new Promise(() => undefined) });
    turn.acknowledge(TURN);
    void turn.onRequest("item/tool/call", toolRequest()).catch(() => undefined);
    await Promise.resolve();
    await expect(
      turn.onRequest("item/tool/call", toolRequest({ callId: "call-2" })),
    ).rejects.toMatchObject({ code: "codex_tool_call" });
  });

  it.each([
    ["over the request cap", async () => JSON.stringify("x".repeat(CODEX_MAX_REQUEST_BYTES))],
    ["that is not a string", async () => 5],
    ["that is not JSON", async () => "not json"],
  ])("refuses a tool reply %s", async (_, reply) => {
    const { turn } = setup({ reply });
    turn.acknowledge(TURN);
    await expect(turn.onRequest("item/tool/call", toolRequest())).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
