import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_MAX_OUTPUT_BYTES,
  CODEX_MAX_REQUEST_BYTES,
} from "../../../src/actors/codex/restricted-policy.js";
import { RestrictedCodexDeadline } from "../../../src/actors/codex/restricted-transport.js";
import { RestrictedCodexTurn } from "../../../src/actors/codex/restricted-turn.js";
import { notificationPolicyOf } from "../../../src/actors/codex/restricted-notifications.js";

const THREAD = "thread-1",
  TURN = "turn-1",
  TOOL = "humanish_ui";
const deadlines: RestrictedCodexDeadline[] = [];
afterEach(() => {
  for (const deadline of deadlines.splice(0)) deadline.close();
});

type Tool = { name: string; call(args: unknown): Promise<string> };
function setup(
  options: {
    analyst?: boolean;
    dispatched?: boolean;
    reply?: () => Promise<unknown>;
    timeoutMs?: number;
  } = {},
) {
  const deadline = new RestrictedCodexDeadline(options.timeoutMs ?? 60_000);
  deadlines.push(deadline);
  const holder: { tool: Tool } = {
    tool: {
      name: TOOL,
      call: (options.reply ?? (async () => '{"ok":true}')) as Tool["call"],
    },
  };
  const reported: unknown[] = [];
  const idle: string[] = [];
  const unknown: string[] = [];
  const turn = new RestrictedCodexTurn({
    deadline,
    threadId: () => THREAD,
    participant: !options.analyst,
    tool: () => holder.tool,
    usageBaseline: { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 },
    toolCallIds: new Set(),
    reportUsage: (usage, inference) => reported.push({ usage, inference }),
    turnStarted: () => undefined,
    policy: notificationPolicyOf(options.analyst ? undefined : holder),
    idle: (method) => idle.push(method),
    recordUnknown: (method) => unknown.push(method),
    refuse: (code) => deadline.stop(code),
  });
  turn.dispatched = options.dispatched ?? true;
  return { turn, deadline, holder, reported, idle, unknown };
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

describe("restricted Codex turn review cases", () => {
  it.each([
    ["a non-string turn id", 5],
    ["an empty turn id", ""],
    ["a turn id over 200 characters", "x".repeat(201)],
  ])("refuses a tool request with %s before the turn is known", async (_, turnId) => {
    // No turn/started and no acknowledgment: a request that passed would wait for the turn and
    // then time out, so the refusal code shows which check fired.
    const { turn } = setup({ timeoutMs: 500 });
    await expect(turn.onRequest("item/tool/call", toolRequest({ turnId }))).rejects.toMatchObject({
      code: "codex_tool_call",
    });
  });

  it("refuses a request and an item for a tool the host renamed mid-request", async () => {
    const { turn, deadline, holder } = setup();
    turn.acknowledge(TURN);
    holder.tool = { name: "renamed_tool", call: async () => '{"ok":true}' };
    await expect(turn.onRequest("item/tool/call", toolRequest())).rejects.toMatchObject({
      code: "codex_tool_call",
    });
    turn.onNotification(
      "item/started",
      event({ type: "dynamicToolCall", tool: TOOL, namespace: null, status: "inProgress" }),
    );
    expect(deadline.code).toBe("codex_tool_call");
  });

  it("calls the tool the host holds when the request arrives", async () => {
    const { turn, holder } = setup();
    turn.acknowledge(TURN);
    holder.tool = { name: TOOL, call: async () => '{"replaced":true}' };
    await expect(turn.onRequest("item/tool/call", toolRequest())).resolves.toMatchObject({
      contentItems: [{ type: "inputText", text: '{"replaced":true}' }],
    });
  });

  it("keeps pending usage when a turn completes without an answer", () => {
    const { turn, deadline, reported } = setup();
    turn.acknowledge(TURN);
    turn.onNotification("thread/tokenUsage/updated", {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: {
        total: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      },
    });
    turn.onNotification("turn/completed", completion());
    expect(deadline.code).toBe("invalid_response");
    expect(reported.at(-1)).toMatchObject({ usage: { input: 10, output: 2 } });
  });
});

describe("restricted Codex turn notification policy", () => {
  it("refuses a disallowed item nested in turn/completed's items", () => {
    const { turn, deadline } = setup({ analyst: true });
    turn.acknowledge(TURN);
    turn.onNotification("item/completed", event(answer()));
    turn.onNotification(
      "turn/completed",
      completion({ items: [answer(), { type: "commandExecution" }] }),
    );
    expect(deadline.code).toBe("codex_tool_call");
  });

  it("counts an unknown method that names the turn before the acknowledgment", () => {
    const { turn, deadline, unknown } = setup();
    turn.onNotification("thread/futureProgress/updated", { threadId: THREAD, turnId: TURN });
    turn.acknowledge(TURN);
    expect(deadline.code).toBeNull();
    expect(unknown).toEqual(["thread/futureProgress/updated"]);
  });

  it("refuses an early unknown method for another turn once the turn is acknowledged", () => {
    const { turn, deadline } = setup();
    turn.onNotification("thread/futureProgress/updated", { threadId: THREAD, turnId: "turn-2" });
    expect(deadline.code).toBeNull();
    turn.acknowledge(TURN);
    expect(deadline.code).toBe("codex_protocol_error");
  });

  it("refuses a tool request before dispatch without calling the tool", async () => {
    let called = false;
    const { turn, deadline } = setup({
      dispatched: false,
      reply: async () => {
        called = true;
        return '{"ok":true}';
      },
    });
    await expect(turn.onRequest("item/tool/call", toolRequest())).rejects.toMatchObject({
      code: "codex_tool_call",
    });
    expect(deadline.code).toBe("codex_tool_call");
    expect(called).toBe(false);
  });

  it("refuses a tool request after the turn completed without calling the tool", async () => {
    let called = false;
    const { turn, deadline } = setup({
      reply: async () => {
        called = true;
        return '{"ok":true}';
      },
    });
    turn.acknowledge(TURN);
    turn.onNotification("item/completed", event(answer()));
    turn.onNotification("turn/completed", completion());
    await expect(turn.finished).resolves.toMatchObject({ status: "completed" });
    await expect(turn.onRequest("item/tool/call", toolRequest())).rejects.toMatchObject({
      code: "codex_tool_call",
    });
    expect(deadline.code).toBe("codex_tool_call");
    expect(called).toBe(false);
  });
});
