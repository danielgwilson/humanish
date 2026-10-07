// Every participant brain that writes a closing account must carry the participant's impressions
// in it, and every brain that cannot must say so on the trace. Each brain below runs the same
// session through the loop: one action, the study's stop condition matches, and the loop asks for
// the closing account. The Codex participant also ends one session itself, with its final account.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";

import { createRestrictedCodexParticipant } from "../../src/actors/codex/restricted-participant.js";
import type { ActorTrace } from "../../src/actors/contract.js";
import {
  runComputerUseLoopWithTaps,
  type CuaProvider,
} from "../../src/actors/computer-use/loop.js";
import {
  createOpenAiResponsesProvider,
  type FetchLike,
} from "../../src/actors/computer-use/openai-provider.js";
import { createLocalAgentProvider, type LocalAgentId } from "../../src/actors/local-agent/cli.js";
import { startClaudeSession } from "../../src/actors/local-agent/claude-session.js";
import { actorRegistry, type ActorId } from "../../src/actors/registry.js";
import { defaultRedactionHooks } from "../../src/evidence/redaction.js";

// The impressions in typed-closing-report-impressions.json, which the Codex fake gives as well.
const codex = vi.hoisted(() => ({
  endsItself: false,
  impressions: [
    {
      kind: "unclear",
      text: "The Save button looked the same as the task text, so I could not tell it was a button at first.",
    },
    {
      kind: "unlike_my_work",
      text: "On my paper list I cross out the old name and write the new one beside it. Here the old name just disappeared, so I could not check what I had changed.",
    },
  ],
}));

// The native Codex task, faked at the session boundary. It acts once and gives its final account
// when humanish says the interaction is closing, or gives it at once when it ends itself.
vi.mock("../../src/actors/codex/restricted-session.js", () => ({
  createRestrictedCodexSession: vi.fn(
    (options: { participant: { tool: { call: (args: unknown) => Promise<string> } } }) => ({
      run: async () => {
        const final = {
          status: "completed",
          output: {
            outcome: "reached",
            summary: "I renamed the task.",
            frictionReports: [],
            impressions: codex.impressions,
          },
          usage: { input: 20, output: 5 },
          inferenceUsage: [{ input: 20, output: 5 }],
          usageComplete: true,
          dispatched: true,
          errorCode: null,
        };
        if (codex.endsItself) return final;
        for (;;) {
          const reply = JSON.parse(
            await options.participant.tool.call({
              narration: "I will click Save.",
              actions: [{ kind: "click", x: 1, y: 1 }],
            }),
          ) as { closing?: boolean };
          if (reply.closing) return final;
        }
      },
      close: async () => true,
      resolvedModel: undefined,
      authentication: undefined,
      pendingUsage: undefined,
      pendingInferenceUsage: undefined,
      cliVersion: undefined,
      unknownNotifications: {},
      policyRefusal: undefined,
      truncatedFrameBytes: undefined,
      protocolIncompatibilities: undefined,
      protocolAdditions: undefined,
    }),
  ),
}));

function frame(shade: number): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data[0] = shade;
  image.data[3] = 255;
  return PNG.sync.write(image);
}

/** One action saves the task; the study stops when the screen says so. */
async function session(provider: CuaProvider): Promise<ActorTrace> {
  let actions = 0;
  let time = 0;
  const result = await runComputerUseLoopWithTaps({
    instructions: "Rename the task.",
    provider,
    executor: {
      observe: async () => ({
        screenshot: frame(actions),
        stateSignature: `screen-${actions}`,
        text: actions > 0 ? "saved" : "editing",
      }),
      execute: async () => {
        actions += 1;
      },
    },
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    timeoutMs: 60_000,
    redaction: defaultRedactionHooks,
    stopWhen: { any: [{ textIncludes: "saved" }] },
  });
  return result.trace;
}

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/openai-closing-report/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

/** The captured Responses shapes: a computer call, then the strict closing report. */
function openAi(zeroDataRetention: boolean): Promise<ActorTrace> {
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { tool_choice?: string };
    const value = fixture(
      body.tool_choice === "none" ? "typed-closing-report-impressions" : "pending-computer-call",
    );
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
  return session(
    createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      fetchFn,
      delayFn: async () => undefined,
      zeroDataRetention,
      env: {},
    }),
  );
}

async function codexParticipant(endsItself: boolean): Promise<ActorTrace> {
  codex.endsItself = endsItself;
  const participant = createRestrictedCodexParticipant();
  try {
    return await session(participant.provider);
  } finally {
    await participant.close();
  }
}

const CLICK = {
  reasoning: "I will click Save.",
  done: false,
  message: null,
  actions: [{ kind: "click", x: 1, y: 1 }],
};

/** One `claude` process answering every turn with one click, as memory-contract.test.ts fakes it. */
async function claudeSession(): Promise<ActorTrace> {
  const spawnFn = (() => {
    const stdout = new PassThrough();
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    let started = false;
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, done) {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const message = JSON.parse(line) as { type: string; uuid?: string };
          if (message.type !== "user") continue;
          if (!started)
            stdout.write(
              `${JSON.stringify({ type: "system", subtype: "init", tools: ["Read"], mcp_servers: [], permissionMode: "dontAsk" })}\n`,
            );
          started = true;
          stdout.write(
            `${JSON.stringify({ type: "result", subtype: "success", is_error: false, user_message_uuid: message.uuid, result: JSON.stringify(CLICK) })}\n`,
          );
        }
        done();
      },
    });
    Object.assign(child, {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => {
        child.emit("close", 0, null);
        return true;
      },
    });
    return child;
  }) as unknown as typeof spawn;
  const claude = await startClaudeSession({ spawnFn });
  try {
    return await session(claude.provider);
  } finally {
    await claude.close();
  }
}

/** `claude -p` once per turn: the restricted init, then the result (tests/actors/local-agent/cli.test.ts). */
function claudeOneShot(): Promise<ActorTrace> {
  const stdout = [
    {
      type: "system",
      subtype: "init",
      tools: ["Read"],
      mcp_servers: [],
      permissionMode: "dontAsk",
    },
    { type: "result", subtype: "success", is_error: false, result: JSON.stringify(CLICK) },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");
  return session(
    createLocalAgentProvider({
      agent: "claude",
      spawnFn: async () => ({ code: 0, stdout, stderr: "" }),
    }),
  );
}

type ClosingCase =
  | { collects: () => Promise<ActorTrace> }
  | { notCollected: () => Promise<ActorTrace> }
  | { noClosingAccount: string };

const LOCAL_AGENT_BRAINS = {
  codex: { collects: () => codexParticipant(false) },
  claude: { notCollected: claudeSession },
} satisfies Record<LocalAgentId, ClosingCase>;

/**
 * Every actor in the registry, and every brain behind it. A new actor id, or a new local agent,
 * fails typecheck here until it gets a closing-account case.
 */
const BRAINS: Record<ActorId, Record<string, ClosingCase>> = {
  "openai-computer-use": {
    threaded: { collects: () => openAi(false) },
    "explicit_context, which keeps no session for a closing report": {
      notCollected: () => openAi(true),
    },
  },
  "local-agent": {
    ...LOCAL_AGENT_BRAINS,
    "codex ending the session itself": { collects: () => codexParticipant(true) },
    "claude one-shot": { notCollected: claudeOneShot },
  },
  "codex-app-server": {
    "one thread": {
      noClosingAccount: "Codex runs its own loop; humanish asks for no closing account.",
    },
  },
  "codex-exec": {
    "one exec per session": {
      noClosingAccount:
        "The terminal route records the agent's output; there is no closing account.",
    },
  },
  "scripted-browser": {
    replay: { noClosingAccount: "No model: it replays a fixed journey." },
  },
};

/** The brains whose closing account collects impressions, or records that it did not. */
function cases(outcome: "collects" | "notCollected") {
  return Object.entries(BRAINS).flatMap(([actor, brains]) =>
    Object.entries(brains).flatMap(([brain, closing]) =>
      outcome in closing
        ? [
            {
              name: `${actor} ${brain}`,
              run: (closing as Record<typeof outcome, () => Promise<ActorTrace>>)[outcome],
            },
          ]
        : [],
    ),
  );
}

describe("participant impressions in each brain's closing account", () => {
  it("names every registered actor", () => {
    expect(Object.keys(BRAINS).sort()).toEqual(Object.keys(actorRegistry).sort());
  });

  it.each(cases("collects"))("$name carries the participant's impressions", async ({ run }) => {
    const trace = await run();
    expect(trace.impressions).toEqual({
      status: "collected",
      items: codex.impressions.map((impression) => ({
        ...impression,
        messageId: expect.any(String),
      })),
    });
    const quoted = new Set(
      trace.impressions?.status === "collected"
        ? trace.impressions.items.map((impression) => impression.messageId)
        : [],
    );
    expect(trace.items.filter((item) => quoted.has(item.id)).map((item) => item.kind)).toEqual([
      "message",
      "message",
    ]);
  });

  it.each(cases("notCollected"))(
    "$name records that impressions were not collected",
    async ({ run }) => {
      expect((await run()).impressions).toMatchObject({
        status: "not_collected",
        reason: expect.stringMatching(/\S/),
      });
    },
  );
});
