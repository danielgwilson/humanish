import { describe, expect, it, vi } from "vitest";
import {
  KNOWN_CODEX_NOTIFICATIONS,
  idleNotificationHandler,
  itemPolicyOf,
  itemPolicyViolation,
  notificationItems,
  notificationPolicyOf,
  unknownNotificationsWarning,
} from "../../../src/actors/codex/restricted-notifications.js";

const analyst = notificationPolicyOf(undefined);
const participant = notificationPolicyOf({ tool: { name: "humanish_ui" } });
const command = { type: "commandExecution", id: "cmd-1", command: "true" };
const answer = { type: "agentMessage", id: "msg-1", text: "{}", phase: "final_answer" };
const tool = { type: "dynamicToolCall", id: "call-1", tool: "humanish_ui", namespace: null };

describe("notificationItems", () => {
  it("finds items wherever the schema nests them, and nothing without an item", () => {
    const m = "thread/x";
    expect(notificationItems(m, { item: command })).toEqual([{ method: m, item: command }]);
    expect(notificationItems(m, { item: [command] })).toEqual([{ method: m, item: command }]);
    expect(notificationItems(m, { items: [command] })).toEqual([{ method: m, item: command }]);
    const nested = { method: "item/completed", item: command };
    expect(notificationItems("turn/completed", { turn: { items: [command] } })).toEqual([nested]);
    expect(
      notificationItems("thread/started", { thread: { turns: [{ items: [command] }] } }),
    ).toEqual([nested]);
    for (const params of [{}, { item: null }, { items: "x" }, { turn: { items: [] } }])
      expect(notificationItems(m, params)).toEqual([]);
  });

  it("returns null when an item is malformed", () => {
    for (const item of ["commandExecution", { type: 1 }, {}, [{}]])
      expect(notificationItems("thread/x", { item })).toBeNull();
    expect(notificationItems("turn/completed", { turn: { items: [null] } })).toBeNull();
  });
});

describe("itemPolicyOf", () => {
  it("refuses a disallowed or malformed item in any position", () => {
    expect(itemPolicyOf("turn/completed", { turn: { items: [answer, command] } }, analyst)).toBe(
      "violation",
    );
    expect(itemPolicyOf("thread/x", { items: [command] }, analyst)).toBe("violation");
    expect(itemPolicyOf("thread/x", { item: { kind: "commandExecution" } }, analyst)).toBe(
      "violation",
    );
    expect(itemPolicyOf("turn/completed", { turn: { items: [answer] } }, analyst)).toBe("allowed");
    expect(itemPolicyOf("thread/x", { progress: 1 }, analyst)).toBe("none");
  });
});

describe("itemPolicyViolation", () => {
  it.each([
    "item/completed",
    "thread/sideEffect/completed",
    "thread/realtime/itemAdded",
    "rawResponseItem/completed",
  ])("refuses a native command item under %s", (method) => {
    expect(itemPolicyViolation(method, command, analyst)).toBe(true);
    expect(itemPolicyViolation(method, command, participant)).toBe(true);
  });

  it("admits an allowed thread item whatever its method", () => {
    expect(itemPolicyViolation("item/completed", answer, analyst)).toBe(false);
    expect(itemPolicyViolation("thread/sideEffect/completed", answer, analyst)).toBe(false);
  });

  it("refuses an agent message that delivers asynchronously or asks a question", () => {
    for (const method of ["item/started", "thread/sideEffect/completed"]) {
      expect(itemPolicyViolation(method, { ...answer, delivery: "async" }, analyst)).toBe(true);
      const question = { ...answer, questions: [{ title: "?" }] };
      expect(itemPolicyViolation(method, question, analyst)).toBe(true);
    }
  });

  it("admits only the participant's own dynamic tool, without a namespace", () => {
    expect(itemPolicyViolation("item/started", tool, participant)).toBe(false);
    expect(itemPolicyViolation("thread/sideEffect/completed", tool, participant)).toBe(false);
    expect(itemPolicyViolation("item/started", { ...tool, tool: "other" }, participant)).toBe(true);
    expect(itemPolicyViolation("item/started", { ...tool, namespace: "x" }, participant)).toBe(
      true,
    );
    expect(itemPolicyViolation("item/started", tool, analyst)).toBe(true);
  });

  it("applies the raw-item policy to a raw type under any method but the thread-item ones", () => {
    const exec = { type: "custom_tool_call", name: "exec" };
    const patch = { type: "custom_tool_call", name: "apply_patch" };
    const message = { type: "message" };
    expect(itemPolicyViolation("thread/sideEffect/completed", exec, participant)).toBe(false);
    expect(itemPolicyViolation("thread/sideEffect/completed", patch, participant)).toBe(true);
    expect(itemPolicyViolation("thread/sideEffect/completed", exec, analyst)).toBe(true);
    expect(itemPolicyViolation("rawResponseItem/completed", message, analyst)).toBe(false);
    // item/started and item/completed carry thread items, so a raw type there is unknown.
    expect(itemPolicyViolation("item/completed", message, analyst)).toBe(true);
  });
});

describe("idleNotificationHandler", () => {
  const handler = () => {
    const recordUnknown = vi.fn<(method: string) => void>();
    const refuse = vi.fn<(code: string) => void>();
    const handle = idleNotificationHandler(analyst, recordUnknown, refuse);
    return { recordUnknown, refuse, handle };
  };

  it("refuses a disallowed item, known method or not", () => {
    for (const method of ["item/completed", "thread/sideEffect/completed"]) {
      const h = handler();
      h.handle(method, { item: command });
      expect(h.refuse).toHaveBeenCalledWith("codex_tool_call");
      expect(h.recordUnknown).not.toHaveBeenCalled();
    }
  });

  it("ignores an allowed item and a known method without an item", () => {
    const h = handler();
    h.handle("item/completed", { item: answer });
    h.handle("thread/tokenUsage/updated", {});
    expect(h.refuse).not.toHaveBeenCalled();
    expect(h.recordUnknown).not.toHaveBeenCalled();
  });

  it("records an unknown method without an item and does not refuse", () => {
    const h = handler();
    h.handle("thread/futureProgress/updated", { progress: 1 });
    expect(h.recordUnknown).toHaveBeenCalledWith("thread/futureProgress/updated");
    expect(h.refuse).not.toHaveBeenCalled();
  });
});

describe("unknownNotificationsWarning", () => {
  it("names each method and its count, sorted, or returns nothing", () => {
    expect(unknownNotificationsWarning(undefined, "0.160.0")).toBeUndefined();
    expect(unknownNotificationsWarning({}, "0.160.0")).toBeUndefined();
    expect(unknownNotificationsWarning({ "b/x": 2, "a/y": 1 }, "0.160.0")).toBe(
      "Codex CLI 0.160.0 sent notification methods humanish does not know: a/y ×1, b/x ×2. They carried no item and were ignored.",
    );
    expect(unknownNotificationsWarning({ "a/y": 1 }, undefined)).toMatch(/^Codex CLI sent /);
  });

  it("knows the 0.160.0 schema's 83 methods and the two it sends outside them", () => {
    expect(KNOWN_CODEX_NOTIFICATIONS.size).toBe(85);
    expect(KNOWN_CODEX_NOTIFICATIONS.has("rawResponseItem/completed")).toBe(true);
    expect(KNOWN_CODEX_NOTIFICATIONS.has("rawResponse/completed")).toBe(true);
  });
});
