import { describe, expect, it } from "vitest";

import type { CuaObservation } from "../src/computer-use.js";
import {
  createLocalAgentProvider,
  detectLocalAgents,
  localAgentDoctorMessage,
  localAgentTurnSchema,
  parseAgentJson,
  toCuaActions,
  type SpawnLike
} from "../src/local-agent-cli.js";

const FRAME = Buffer.from("89504e470d0a1a0a", "hex"); // enough to be a file; the fake never reads it

function observation(): CuaObservation {
  return { screenshot: FRAME, stateSignature: "s1" };
}

/** A CLI that answers with whatever text the test hands it. Nothing is spawned, nothing is spent. */
function fakeCli(reply: string, code = 0): SpawnLike {
  return async (_bin, args, _options) => {
    // Codex writes its answer to --output-last-message; the provider reads that file back.
    const outIndex = args.indexOf("--output-last-message");
    if (outIndex >= 0) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[outIndex + 1]!, reply, "utf8");
      return { code, stdout: "", stderr: "" };
    }
    return { code, stdout: reply, stderr: "" };
  };
}

describe("the action vocabulary a local agent answers in", () => {
  it("maps the kinds it is allowed to use", () => {
    expect(toCuaActions([{ kind: "click", x: 10.4, y: 20.6 }])).toEqual([{ kind: "click", x: 10, y: 21 }]);
    expect(toCuaActions([{ kind: "type", text: "hello" }])).toEqual([{ kind: "type", text: "hello" }]);
    expect(toCuaActions([{ kind: "keypress", keys: ["Control", "a"] }])).toEqual([
      { kind: "keypress", keys: ["Control", "a"] }
    ]);
  });

  it("DROPS an action it cannot honour rather than inventing the missing half", () => {
    // A click with no coordinates is not a click at (0,0). Filling that in would record a
    // coordinate the participant never chose, in evidence someone is meant to trust.
    expect(toCuaActions([{ kind: "click" }])).toEqual([]);
    expect(toCuaActions([{ kind: "type", text: "" }])).toEqual([]);
    expect(toCuaActions([{ kind: "keypress", keys: [] }])).toEqual([]);
    expect(toCuaActions([{ kind: "teleport", x: 1, y: 2 }])).toEqual([]);
  });

  it("keeps the schema strict-mode legal", () => {
    // OpenAI structured outputs reject a schema whose `required` omits any property — measured as
    // a 400 before any thinking happened, which is how this rule was learned.
    const schema = localAgentTurnSchema() as Record<string, any>;
    const walk = (node: Record<string, any>): void => {
      if (node?.type === "object") {
        expect(Object.keys(node.properties ?? {}).sort()).toEqual([...(node.required ?? [])].sort());
        for (const child of Object.values(node.properties ?? {})) walk(child as Record<string, any>);
      }
      if (node?.type === "array" && node.items) walk(node.items as Record<string, any>);
    };
    walk(schema);
  });
});

describe("reading the agent's answer", () => {
  it("accepts clean JSON and JSON wrapped in a fence", () => {
    // Codex returns the first; Claude Code returns the second. One parser, because a surface where
    // one adapter works and the other silently does not is worse than either.
    expect(parseAgentJson('{"done":true}')).toEqual({ done: true });
    expect(parseAgentJson('here you go\n```json\n{"done":false}\n```\n')).toEqual({ done: false });
  });

  it("treats an answer with no JSON as a turn ERROR, never as an empty turn", () => {
    // An empty turn reads to the loop as "the participant chose to do nothing", which is a
    // finding. A CLI that returned prose is a broken turn, which is not.
    expect(() => parseAgentJson("I could not see the screenshot.")).toThrow(/did not return a JSON object/);
  });
});

describe("the provider", () => {
  it("turns a codex answer into a CuaTurn", async () => {
    const provider = createLocalAgentProvider({
      agent: "codex",
      spawnFn: fakeCli('{"reasoning":"menu top-left","done":false,"message":null,"actions":[{"kind":"click","x":52,"y":12,"text":null,"keys":null,"ms":null}]}')
    });
    const turn = await provider.nextTurn({ instructions: "be a new user", observation: observation() }, new AbortController().signal);
    expect(turn.actions).toEqual([{ kind: "click", x: 52, y: 12 }]);
    expect(turn.done).toBe(false);
    expect(turn.reasoning).toContain("menu");
    // No token usage is claimed: a subscription CLI reports nothing we could price, and a number
    // invented here is what would make the run's cost line a lie.
    expect(turn.usage).toBeUndefined();
  });

  it("unwraps Claude Code's envelope and its code fence", async () => {
    const provider = createLocalAgentProvider({
      agent: "claude",
      spawnFn: fakeCli(JSON.stringify({
        result: '```json\n{"reasoning":"done here","done":true,"message":"I finished","actions":[]}\n```'
      }))
    });
    const turn = await provider.nextTurn({ instructions: "be a new user", observation: observation() }, new AbortController().signal);
    expect(turn.done).toBe(true);
    expect(turn.message).toBe("I finished");
    expect(turn.actions).toEqual([]);
  });

  it("declares that it needs a frame, and refuses a turn without one", async () => {
    const provider = createLocalAgentProvider({ agent: "codex", spawnFn: fakeCli("{}") });
    expect(provider.requiresFrame).toBe(true);
    await expect(provider.nextTurn({ instructions: "x", observation: { stateSignature: "s" } }, new AbortController().signal))
      .rejects.toThrow(/needs a screenshot/);
  });

  it("surfaces the CLI's own words when it exits non-zero", async () => {
    // A rate-limited plan says so here. "turn failed" would throw away the one sentence the
    // operator can act on.
    const provider = createLocalAgentProvider({
      agent: "codex",
      spawnFn: async () => ({ code: 1, stdout: "", stderr: "rate limit reached for your plan" })
    });
    await expect(provider.nextTurn({ instructions: "x", observation: observation() }, new AbortController().signal))
      .rejects.toThrow(/rate limit reached/);
  });

  it("records the effort it ran at, and defaults it LOW", async () => {
    // Codex defaults to high, which timed out at 240s on a single action; low answered the same
    // screenshot correctly in 9s, and a run is sixty of these.
    const provider = createLocalAgentProvider({ agent: "codex", spawnFn: fakeCli("{}") });
    expect(provider.modelSettings?.reasoningEffort).toBe("low");
  });


  it("kills the CLI when the run is stopped mid-turn", async () => {
    // Stop shipped in 0.54.0 and a local agent can hold a terminal for minutes. A stop that
    // leaves it thinking is not a stop.
    const controller = new AbortController();
    let sawSignal: AbortSignal | undefined;
    const provider = createLocalAgentProvider({
      agent: "codex",
      spawnFn: async (_bin, _args, options) => {
        sawSignal = options.signal;
        return { code: 0, stdout: '{"done":true,"actions":[],"reasoning":"x","message":null}', stderr: "" };
      }
    });
    // The fake never writes codex's answer file, so the turn throws after the spawn — irrelevant
    // here: what is under test is that the run's abort signal reaches the child process.
    await provider.nextTurn({ instructions: "x", observation: observation() }, controller.signal)
      .catch(() => undefined);
    expect(sawSignal).toBe(controller.signal);
  });

  it("restricts the agent's own tools — it is here to look at a picture", async () => {
    const seen: string[][] = [];
    const spy: SpawnLike = async (_bin, args, _o) => {
      seen.push([...args]);
      return { code: 0, stdout: '{"done":true,"actions":[],"reasoning":"x","message":null}', stderr: "" };
    };
    const codex = createLocalAgentProvider({ agent: "codex", spawnFn: spy });
    await codex.nextTurn({ instructions: "x", observation: observation() }, new AbortController().signal).catch(() => undefined);
    expect(seen[0]).toContain("--sandbox");
    expect(seen[0]).toContain("read-only");

    seen.length = 0;
    const claude = createLocalAgentProvider({ agent: "claude", spawnFn: spy });
    await claude.nextTurn({ instructions: "x", observation: observation() }, new AbortController().signal).catch(() => undefined);
    expect(seen[0]).toContain("--allowedTools");
    expect(seen[0]).toContain("Read");
  });
});

describe("telling the operator what they already have", () => {
  const detect = (present: string[], creds: string[]) =>
    detectLocalAgents({
      home: "/home/dev",
      which: async (bin) => (present.includes(bin) ? `/usr/bin/${bin}` : undefined),
      exists: async (file) => creds.some((c) => file.endsWith(c))
    });

  it("finds an installed, signed-in agent and says a run can use it", async () => {
    const found = await detect(["codex"], [".codex/auth.json"]);
    expect(found.map((a) => a.id)).toEqual(["codex"]);
    expect(localAgentDoctorMessage(found)).toContain("instead of a provider API key");
  });

  it("distinguishes installed-but-signed-out from absent", async () => {
    const signedOut = await detect(["claude"], []);
    expect(localAgentDoctorMessage(signedOut)).toContain("not signed in");
    const none = await detect([], []);
    expect(localAgentDoctorMessage(none)).toContain("needs a provider API key");
  });

  it("only ever checks that a credential file EXISTS", async () => {
    // humanish must never read these. The boolean is the entire entitlement.
    const found = await detect(["codex"], [".codex/auth.json"]);
    expect(found[0]?.credentialsPresent).toBe(true);
    expect(Object.keys(found[0] ?? {})).not.toContain("token");
  });
});
