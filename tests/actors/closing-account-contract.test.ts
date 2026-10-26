// Every participant brain that writes a closing account must carry the participant's impressions
// in it, and every brain that cannot must say so on the trace. Each brain below runs the same
// session through the loop: one action, the study's stop condition matches, and the loop asks for
// the closing account. The Codex participant also ends one session itself, with its final account.
// Each brain the loop drives also runs one session to a session cap in place of the stop condition.
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
import { createAnthropicMessagesProvider } from "../../src/actors/computer-use/anthropic-provider.js";
import { createOpenAiResponsesProvider } from "../../src/actors/computer-use/openai-provider.js";
import { type FetchLike } from "../../src/actors/computer-use/provider-http.js";
import { createLocalAgentProvider, type LocalAgentId } from "../../src/actors/local-agent/cli.js";
import { startClaudeSession } from "../../src/actors/local-agent/claude-session.js";
import { actorRegistry, type ActorId } from "../../src/actors/registry.js";
import { defaultRedactionHooks } from "../../src/evidence/redaction.js";
import { frozenLiveFlush } from "../helpers/frozen-live-flush.js";

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

/**
 * One action saves the task; the study stops when the screen says so, or, `capped`, the session
 * reaches its 2-minute cap after that action: each observation takes a minute. The items pass
 * through the production live flush, which freezes them, so a brain whose session edits a
 * recorded item fails.
 */
async function session(provider: CuaProvider, capped = false): Promise<ActorTrace> {
  let actions = 0;
  let time = 0;
  const live = frozenLiveFlush();
  const result = await runComputerUseLoopWithTaps({
    onTrace: live.onTrace,
    instructions: "Rename the task.",
    provider,
    executor: {
      observe: async () => {
        if (capped) time += 60_000;
        return {
          screenshot: frame(actions),
          stateSignature: `screen-${actions}`,
          text: actions > 0 ? "saved" : "editing",
          url:
            actions > 0
              ? "https://tasks.example.test/tasks?saved=1"
              : "https://tasks.example.test/tasks/edit",
        };
      },
      execute: async () => {
        actions += 1;
      },
    },
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    redaction: defaultRedactionHooks,
    ...(capped
      ? {
          timeoutMs: 7 * 60_000,
          clock: { end: { atMs: 2 * 60_000, windDownMs: 60_000, kind: "session_cap" as const } },
        }
      : { timeoutMs: 60_000, stopWhen: { any: [{ textIncludes: "saved" }] } }),
  });
  await live.stop();
  return result.trace;
}

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/openai-closing-report/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

/**
 * The captured Responses shapes. After a stop: a computer call, then the strict closing report.
 * When the participant ends the session itself: its final answer, then the impressions-only reply.
 */
function openAi(
  zeroDataRetention: boolean,
  endsItself = false,
  capped = false,
): Promise<ActorTrace> {
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { tool_choice?: string };
    const value = fixture(
      body.tool_choice === "none"
        ? endsItself
          ? "impressions-only"
          : "typed-closing-report-impressions"
        : endsItself
          ? "typed-closing-report"
          : "pending-computer-call",
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
    capped,
  );
}

const anthropicFixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/anthropic-messages/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;

/** The OpenAI closing fixture's reply text, which answers the same closing schema. */
function closingText(name: string): string {
  const output = (fixture(name) as { output: { type: string; content?: { text: string }[] }[] })
    .output;
  return output.find((item) => item.type === "message")!.content![0]!.text;
}

/**
 * The captured Messages shapes. After a stop: one left_click, then a closing reply. When the
 * participant ends the session itself: its end_turn message, then the impressions-only reply.
 * The closing replies carry the OpenAI fixtures' text, since both providers ask for one schema.
 */
function anthropic(endsItself = false, capped = false): Promise<ActorTrace> {
  const batch = anthropicFixture("batch");
  const click = {
    ...batch,
    content: [
      (batch.content as unknown[])[0],
      { ...(batch.content as Record<string, unknown>[])[1], input: { coordinate: [1, 1] } },
    ],
  };
  const closing = (text: string) => ({
    ...anthropicFixture("closing-report"),
    content: [{ type: "text", text }],
  });
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { tool_choice?: { type: string } };
    const value =
      body.tool_choice?.type === "none"
        ? closing(closingText(endsItself ? "impressions-only" : "typed-closing-report-impressions"))
        : endsItself
          ? anthropicFixture("end-turn")
          : click;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
  return session(
    createAnthropicMessagesProvider({
      apiKey: "synthetic-key",
      fetchFn,
      delayFn: async () => undefined,
      env: {},
    }),
    capped,
  );
}

async function codexParticipant(endsItself: boolean, capped = false): Promise<ActorTrace> {
  codex.endsItself = endsItself;
  const participant = createRestrictedCodexParticipant();
  try {
    return await session(participant.provider, capped);
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
async function claudeSession(capped = false): Promise<ActorTrace> {
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
    return await session(claude.provider, capped);
  } finally {
    await claude.close();
  }
}

/** `claude -p` once per turn: the restricted init, then the result (tests/actors/local-agent/cli.test.ts). */
function claudeOneShot(capped = false): Promise<ActorTrace> {
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
    capped,
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
  // On OpenAI, computer-use builds the same provider openai-computer-use does (cases below).
  "computer-use": {
    "anthropic, after a stop": { collects: () => anthropic() },
    "anthropic, ending the session itself": { collects: () => anthropic(true) },
  },
  "openai-computer-use": {
    "threaded, after a stop": { collects: () => openAi(false) },
    "threaded, ending the session itself": { collects: () => openAi(false, true) },
    "explicit_context, after a stop": { collects: () => openAi(true) },
    "explicit_context, ending the session itself": { collects: () => openAi(true, true) },
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

/**
 * The brains the loop drives, each run to a session cap. A brain with a closing request writes its
 * closing report there, and the outcome that report declares is the session's; one without records
 * why it was skipped. A new local agent fails typecheck here until it gets a case.
 */
const CAPPED_LOCAL_AGENTS = {
  codex: { collects: true, run: () => codexParticipant(false, true) },
  claude: { collects: false, run: () => claudeSession(true) },
} satisfies Record<LocalAgentId, { collects: boolean; run: () => Promise<ActorTrace> }>;

const CAPPED = Object.entries({
  "openai-computer-use threaded": { collects: true, run: () => openAi(false, false, true) },
  "openai-computer-use explicit_context": { collects: true, run: () => openAi(true, false, true) },
  "computer-use anthropic": { collects: true, run: () => anthropic(false, true) },
  ...Object.fromEntries(
    Object.entries(CAPPED_LOCAL_AGENTS).map(([agent, closing]) => [
      `local-agent ${agent}`,
      closing,
    ]),
  ),
  "local-agent claude one-shot": { collects: false, run: () => claudeOneShot(true) },
}).map(([name, closing]) => ({ name, ...closing }));

describe("each brain at a session cap", () => {
  it.each(CAPPED)("$name ends at the cap with stop cause session_cap", async ({ run }) => {
    const trace = await run();
    expect(trace.status).toBe("passed");
    expect(trace.stopCause).toBe("session_cap");
  });

  it.each(CAPPED.filter((brain) => brain.collects))(
    "$name writes its closing report at the cap",
    async ({ run }) => {
      const trace = await run();
      expect(trace.debrief).toMatchObject({ trigger: "session_cap", status: "completed" });
      expect(trace.impressions?.status).toBe("collected");
    },
  );

  it.each(CAPPED.filter((brain) => !brain.collects))(
    "$name records that it was not asked for a closing report",
    async ({ run }) => {
      const trace = await run();
      expect(trace.debrief).toMatchObject({ trigger: "session_cap", status: "skipped" });
      expect(trace.impressions).toMatchObject({ status: "not_collected" });
      expect(trace.declaredOutcome).toBeUndefined();
    },
  );

  // The OpenAI closing report and the Codex final account both declare it in their outcome field.
  // Neither summary opens with a declared line, so the field is the only source.
  it.each(CAPPED.filter((brain) => brain.collects))(
    "$name records the outcome its closing report declares at the cap",
    async ({ run }) => {
      expect((await run()).declaredOutcome).toBe("reached");
    },
  );
});

describe("the pages in each brain's trace", () => {
  it.each([...cases("collects"), ...cases("notCollected")])(
    "$name lists the page of each observation and the final page",
    async ({ run }) => {
      const trace = await run();
      const origin = "https://tasks.example.test";
      const pages = trace.items
        .filter((item) => item.kind === "screenshot")
        .map((item) => item.page);
      // A brain that ends the session itself takes no action, so it stays on the first page.
      const acted = (trace.counts.actions ?? 0) > 0;
      expect(pages).toEqual(
        acted
          ? [
              { origin, path: "/tasks/edit" },
              { origin, path: "/tasks" },
            ]
          : [{ origin, path: "/tasks/edit" }],
      );
      expect(trace.finalPage).toEqual(pages.at(-1));
    },
  );
});
