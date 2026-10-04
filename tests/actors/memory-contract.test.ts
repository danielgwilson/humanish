// Every participant brain humanish ships must still hold turn 1 when it decides turn N. Memory
// broke four times, each time in a different brain: the Codex local agent ran a fresh exec per
// turn, the Claude local agent spawned per turn, the Claude one-shot path stopped answering, and
// OpenAI computer-use in explicit_context mode carried only the last reply. Each fake below models
// where its brain keeps the conversation (the server-side response chain, one CLI process, one
// native Codex task) and records what the model holds when it answers each turn.
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";

import { createRestrictedCodexParticipant } from "../../src/actors/codex/restricted-participant.js";
import type { CuaProvider, CuaTurnRequest } from "../../src/actors/computer-use/loop.js";
import {
  createOpenAiResponsesProvider,
  type FetchLike,
} from "../../src/actors/computer-use/openai-provider.js";
import type { LocalAgentId } from "../../src/actors/local-agent/cli.js";
import { startClaudeSession } from "../../src/actors/local-agent/claude-session.js";
import { actorRegistry, type ActorId } from "../../src/actors/registry.js";

/** What the participant said on turn 1. A brain that remembers still holds it on every later turn. */
const TURN_ONE = "TURN-ONE: I created the account and wrote down the code 4417.";
const TURNS = 4;

const codex = vi.hoisted(() => ({ views: [] as string[], runs: 0 }));

// The native Codex task, faked at the session boundary: one run() is one native conversation, and
// each tool call returns the next turn's observation into it. A provider that started a new run
// per turn would start a new conversation without turn 1.
vi.mock("../../src/actors/codex/restricted-session.js", () => ({
  createRestrictedCodexSession: vi.fn(
    (options: { participant: { tool: { call: (args: unknown) => Promise<string> } } }) => ({
      run: async () => {
        codex.runs += 1;
        const conversation: string[] = [];
        for (let call = 1; ; call += 1) {
          codex.views.push(conversation.join("\n"));
          const narration =
            call === 1 ? "TURN-ONE: I created the account and wrote down the code 4417." : "Next.";
          conversation.push(narration);
          conversation.push(
            await options.participant.tool.call({
              narration,
              actions: [{ kind: "click", x: 1, y: 1 }],
            }),
          );
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

function frame(turn: number): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data[0] = turn;
  image.data[3] = 255;
  return PNG.sync.write(image);
}

/** Turn N's request, shaped as the loop sends it: from turn 2 on it reports the last action ran. */
function request(turn: number): CuaTurnRequest {
  return {
    instructions: "Sign up as a new user and finish onboarding.",
    observation: { screenshot: frame(turn), stateSignature: `screen-${turn}` },
    ...(turn === 1 ? {} : { previousExecution: { actions: [{ index: 0, status: "completed" }] } }),
  };
}

async function drive(provider: CuaProvider): Promise<void> {
  const signal = new AbortController().signal;
  for (let turn = 1; turn <= TURNS; turn += 1) await provider.nextTurn(request(turn), signal);
}

/**
 * A Responses API that keeps what it was sent: a request's context is the chain its
 * previous_response_id names, plus its own input. Returns what the model held on each turn.
 */
async function openAiViews(zeroDataRetention: boolean): Promise<string[]> {
  const chains = new Map<string, unknown[]>();
  const views: string[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { input?: unknown[]; previous_response_id?: string };
    const prior =
      body.previous_response_id === undefined ? [] : (chains.get(body.previous_response_id) ?? []);
    const context = [...prior, ...(body.input ?? [])];
    views.push(JSON.stringify(context));
    const turn = views.length;
    const output = [
      {
        type: "message",
        content: [{ type: "output_text", text: turn === 1 ? TURN_ONE : "Next." }],
      },
      { type: "computer_call", call_id: `call_${turn}`, actions: [{ type: "click", x: 1, y: 1 }] },
    ];
    chains.set(`resp_${turn}`, [...context, ...output]);
    const value = {
      id: `resp_${turn}`,
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
  await drive(
    createOpenAiResponsesProvider({
      apiKey: "test-key",
      fetchFn,
      delayFn: async () => undefined,
      zeroDataRetention,
    }),
  );
  return views;
}

/** One `claude` process is one session; its transcript is what the model holds. */
async function claudeSessionViews(): Promise<string[]> {
  const views: string[] = [];
  const spawnFn = (() => {
    const transcript: string[] = [];
    const stdout = new PassThrough();
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, done) {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const message = JSON.parse(line) as { type: string; uuid?: string; message?: unknown };
          if (message.type !== "user") continue;
          // A restricted Claude Code reports its tools before its first answer
          // (tests/fixtures/claude-code-stream-json/restricted-denial.ndjson).
          if (transcript.length === 0)
            stdout.write(
              `${JSON.stringify({ type: "system", subtype: "init", tools: ["Read"], mcp_servers: [], permissionMode: "dontAsk" })}\n`,
            );
          transcript.push(JSON.stringify(message.message));
          views.push(transcript.join("\n"));
          const reply = {
            reasoning: views.length === 1 ? TURN_ONE : "Next.",
            done: false,
            message: null,
            actions: [{ kind: "click", x: 1, y: 1 }],
          };
          transcript.push(JSON.stringify(reply));
          stdout.write(
            `${JSON.stringify({
              type: "result",
              subtype: "success",
              is_error: false,
              user_message_uuid: message.uuid,
              result: JSON.stringify(reply),
            })}\n`,
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
  const session = await startClaudeSession({ spawnFn });
  try {
    await drive(session.provider);
  } finally {
    await session.close();
  }
  return views;
}

async function codexViews(): Promise<string[]> {
  codex.views.length = 0;
  codex.runs = 0;
  const participant = createRestrictedCodexParticipant();
  try {
    await drive(participant.provider);
  } finally {
    await participant.close();
  }
  return codex.views;
}

type BrainCase = { views: () => Promise<string[]> } | { noCrossTurnMemory: string };

/** Each local agent a study can name, with its default path. */
const LOCAL_AGENT_BRAINS = {
  codex: { views: codexViews },
  claude: { views: claudeSessionViews },
} satisfies Record<LocalAgentId, BrainCase>;

/**
 * Every actor in the registry, and every brain behind it. A new actor id, or a new local agent,
 * fails typecheck here until it gets a memory case.
 */
const BRAINS: Record<ActorId, Record<string, BrainCase>> = {
  "openai-computer-use": {
    "threaded (previous_response_id)": { views: () => openAiViews(false) },
    explicit_context: { views: () => openAiViews(true) },
  },
  "local-agent": {
    ...LOCAL_AGENT_BRAINS,
    "claude one-shot": {
      noCrossTurnMemory:
        "HUMANISH_LOCAL_AGENT_ONE_SHOT keeps a memoryless path on purpose, to measure remembering against not (#593).",
    },
  },
  "codex-app-server": {
    "one thread": {
      noCrossTurnMemory:
        "humanish sends one prompt on one thread; Codex runs its own loop and humanish sends no second turn.",
    },
  },
  "codex-exec": {
    "one exec per session": {
      noCrossTurnMemory:
        "The terminal route runs one agent process for the whole session and sends it one task.",
    },
  },
  "scripted-browser": {
    replay: { noCrossTurnMemory: "No model: it replays a fixed journey." },
  },
};

describe("participant memory across turns", () => {
  it("names every registered actor", () => {
    expect(Object.keys(BRAINS).sort()).toEqual(Object.keys(actorRegistry).sort());
  });

  for (const [actor, brains] of Object.entries(BRAINS)) {
    for (const [brain, memory] of Object.entries(brains)) {
      if ("noCrossTurnMemory" in memory) continue;
      it(`${actor} ${brain} still holds turn 1 on turn ${TURNS}`, async () => {
        const views = await memory.views();
        expect(views).toHaveLength(TURNS);
        for (let turn = 2; turn <= TURNS; turn += 1)
          expect(views[turn - 1], `turn ${turn}`).toContain("4417");
      });
    }
  }
});
