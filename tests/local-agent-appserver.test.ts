import { describe, expect, it, vi } from "vitest";

import type { CuaObservation } from "../src/computer-use.js";
import {
  startAppServerSession,
  turnFromNotification,
  turnOutputSchema,
  type AppServerTransport
} from "../src/local-agent-appserver.js";

const FRAME = Buffer.from("89504e470d0a1a0a", "hex");
const observation = (): CuaObservation => ({ screenshot: FRAME, stateSignature: "s1" });

/** A fake app-server. Nothing spawns, nothing is spent, and every call is recorded. */
function fakeServer(reply: unknown) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport: AppServerTransport = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "th_1" } };
      return {};
    },
    notify: (method, params) => { calls.push({ method, params }); },
    awaitNotification: async () => ({ params: { turn: { items: [{ type: "agentMessage", text: JSON.stringify(reply) }] } } }),
    close: () => { calls.push({ method: "close", params: {} }); }
  };
  return { transport, calls };
}

describe("a codex app-server thread as the computer-use brain", () => {
  it("handshakes once and keeps ONE thread for the whole run", async () => {
    // The point of the rewrite. `codex exec` booted a CLI, its config, its agents and its MCP
    // servers on EVERY turn — measured at ~9s each — and handed the model a conversation that
    // started fresh every time.
    const { transport, calls } = fakeServer({ reasoning: "r", done: false, message: null, actions: [] });
    const session = await startAppServerSession({ transport });
    await session.provider.nextTurn({ instructions: "i", observation: observation() }, new AbortController().signal);
    await session.provider.nextTurn({ instructions: "i", observation: observation() }, new AbortController().signal);

    expect(calls.filter((c) => c.method === "initialize")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "thread/start")).toHaveLength(1);
    // Two turns, one thread — so the participant REMEMBERS what it already tried.
    const turns = calls.filter((c) => c.method === "turn/start");
    expect(turns).toHaveLength(2);
    expect(new Set(turns.map((t) => t.params.threadId))).toEqual(new Set(["th_1"]));
  });

  it("sends the screenshot as a localImage and constrains the reply", async () => {
    const { transport, calls } = fakeServer({ reasoning: "r", done: false, message: null, actions: [] });
    const session = await startAppServerSession({ transport });
    await session.provider.nextTurn({ instructions: "i", observation: observation() }, new AbortController().signal);

    const turn = calls.find((c) => c.method === "turn/start")!;
    const input = turn.params.input as Array<Record<string, unknown>>;
    expect(input[0]?.type).toBe("localImage");
    expect(typeof input[0]?.path).toBe("string");
    // outputSchema means the answer is constrained rather than scraped out of prose.
    expect(turn.params.outputSchema).toBeDefined();
  });

  it("puts the persona on the THREAD and the ask on the turn", async () => {
    // Re-sending a persona every turn is both wasteful and a subtly different participant.
    const { transport, calls } = fakeServer({ reasoning: "r", done: true, message: "bye", actions: [] });
    const session = await startAppServerSession({ transport, baseInstructions: "You are an impatient expert." });
    await session.provider.nextTurn({ instructions: "ignored here", observation: observation() }, new AbortController().signal);

    expect(calls.find((c) => c.method === "thread/start")!.params.baseInstructions)
      .toContain("impatient expert");
    const text = (calls.find((c) => c.method === "turn/start")!.params.input as Array<Record<string, unknown>>)[1];
    expect(String(text?.text)).not.toContain("impatient expert");
  });

  it("carries model and effort per turn, defaulting effort LOW", async () => {
    // Codex defaults to high, which timed out at 240s on a single action. And the protocol says
    // `effort` applies to "this turn and subsequent turns", so a lane that raises it, raises it.
    const { transport, calls } = fakeServer({ reasoning: "r", done: true, message: "x", actions: [] });
    const session = await startAppServerSession({ transport, model: "gpt-5.6-sol", reasoningEffort: "high" });
    await session.provider.nextTurn({ instructions: "i", observation: observation() }, new AbortController().signal);

    const turn = calls.find((c) => c.method === "turn/start")!;
    expect(turn.params.effort).toBe("high");
    expect(turn.params.model).toBe("gpt-5.6-sol");
    expect(session.provider.modelSettings?.reasoningEffort).toBe("high");

    const { transport: t2 } = fakeServer({ reasoning: "r", done: true, message: "x", actions: [] });
    const plain = await startAppServerSession({ transport: t2 });
    expect(plain.provider.modelSettings?.reasoningEffort).toBe("low");
  });

  it("keeps the thread off the operator's machine and out of their history", async () => {
    const { transport, calls } = fakeServer({ reasoning: "r", done: true, message: "x", actions: [] });
    await startAppServerSession({ transport });
    const start = calls.find((c) => c.method === "thread/start")!;
    // It is here to look at a picture, not to touch this machine.
    expect(start.params.sandbox).toBe("read-only");
    expect(start.params.approvalPolicy).toBe("never");
    // And nothing about a study belongs in someone's codex history.
    expect(start.params.ephemeral).toBe(true);
  });

  it("maps a constrained answer into harness actions", () => {
    const turn = turnFromNotification({
      params: { turn: { items: [{ type: "agentMessage", text: JSON.stringify({
        reasoning: "menu top-left", done: false, message: null,
        actions: [{ kind: "click", x: 52, y: 12, text: null, keys: null, ms: null }]
      }) }] } }
    });
    expect(turn.actions).toEqual([{ kind: "click", x: 52, y: 12 }]);
    expect(turn.reasoning).toContain("menu");
    expect(turn.usage).toBeUndefined();
  });

  it("treats a turn with no structured output as BROKEN, not as an empty turn", () => {
    // An empty turn reads to the loop as "the participant chose to do nothing", which is a finding.
    expect(() => turnFromNotification({ params: { turn: { items: [{ type: "agentMessage", text: "I could not see it" }] } } }))
      .toThrow(/no structured turn output/);
  });

  it("keeps the output schema strict-mode legal", () => {
    const walk = (node: Record<string, any>): void => {
      if (node?.type === "object") {
        expect(Object.keys(node.properties ?? {}).sort()).toEqual([...(node.required ?? [])].sort());
        for (const child of Object.values(node.properties ?? {})) walk(child as Record<string, any>);
      }
      if (node?.type === "array" && node.items) walk(node.items as Record<string, any>);
    };
    walk(turnOutputSchema() as Record<string, any>);
  });

  it("fails closed when no thread comes back", async () => {
    const transport: AppServerTransport = {
      request: async () => ({}),
      notify: () => undefined,
      awaitNotification: async () => ({}),
      close: vi.fn()
    };
    await expect(startAppServerSession({ transport })).rejects.toThrow(/did not return a thread id/);
    expect(transport.close).toHaveBeenCalled();
  });
});

describe("a turn that does nothing is not a finished study", () => {
  it("requires done to be EXPLICIT", () => {
    // The bug this pins, caught on a live run: the model narrated the screen, chose no action, and
    // an inference ("no actions + a message means finished") ended the study on turn one with a
    // 7-second `goal_satisfied`. The output schema guarantees a boolean; nothing needs inferring.
    const narrated = turnFromNotification({
      params: { turn: { items: [{ type: "agentMessage", text: JSON.stringify({
        reasoning: "I can see a desktop", done: false, message: "The screen shows a desktop", actions: []
      }) }] } }
    });
    expect(narrated.done).toBe(false);

    const finished = turnFromNotification({
      params: { turn: { items: [{ type: "agentMessage", text: JSON.stringify({
        reasoning: "task complete", done: true, message: "All done", actions: []
      }) }] } }
    });
    expect(finished.done).toBe(true);
  });
});

describe("the participant's declared outcome (#570)", () => {
  it("is constrained by the schema and read off the turn", () => {
    const schema = turnOutputSchema() as { required: string[]; properties: Record<string, { enum?: unknown[] }> };
    expect(schema.required).toContain("outcome");
    expect(schema.properties.outcome?.enum).toEqual(["reached", "not_reached", "blocked", null]);
    const note = (outcome: unknown) => ({ params: { turn: { items: [{ type: "agentMessage", text: JSON.stringify({ reasoning: "r", done: true, message: "m", outcome, actions: [] }) }] } } });
    expect(turnFromNotification(note("not_reached")).outcome).toBe("not_reached");
    expect(turnFromNotification(note(null)).outcome).toBeUndefined();
  });
});
