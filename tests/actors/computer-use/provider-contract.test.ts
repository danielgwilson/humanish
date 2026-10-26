import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { createAnthropicMessagesProvider } from "../../../src/actors/computer-use/anthropic-provider.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaLoopOptions,
  type CuaProvider,
} from "../../../src/actors/computer-use/loop.js";
import { createOpenAiResponsesProvider } from "../../../src/actors/computer-use/openai-provider.js";
import type { FetchLike } from "../../../src/actors/computer-use/provider-http.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { estimateActorCost } from "../../../src/run/pricing.js";

// One scenario table, run through runComputerUseLoop against every API vendor's real provider. A
// FetchLike fake replays each vendor's captured wire shapes; each vendor's column names its
// fixtures (tests/fixtures/*/README.md says which were captured, derived or documented) and how
// its usage bills. A third vendor joins by adding a column.

type Json = Record<string, unknown>;
const read = (path: string): Json =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${path}.json`, import.meta.url), "utf8")) as Json;

/**
 * One answer of the fake transport: a reply body with its status, a request lost in transit, or
 * a 200 whose body was lost while it was read.
 */
type Answer = { readonly status: number; readonly body: Json } | "lost" | "body-lost";
const ok = (body: Json): Answer => ({ status: 200, body });

interface Column {
  readonly vendor: string;
  readonly model: string;
  create(fetchFn: FetchLike): CuaProvider;
  /** A batch of actions; `batchKinds` are the kinds it dispatches, in order. */
  readonly batch: Answer;
  readonly batchKinds: readonly CuaAction["kind"][];
  readonly waitOnly: Answer;
  readonly ending: Answer;
  readonly outputLimit: Answer;
  readonly refusal: Answer;
  /** A completed closing reply that is not the schema's JSON, then a valid closing report. */
  readonly closingProse: Answer;
  readonly closingReport: Answer;
  /** Whether a request body set the closing reply's JSON Schema as its output format. */
  strictClosing(body: Json): boolean;
  /** Every input token a reply billed, read from its usage as the vendor documents it. */
  billedInput(body: Json): number;
}

const noDelay = async (): Promise<void> => undefined;

const openAi = (() => {
  const call = read("openai-closing-report/pending-computer-call");
  const message = (id: string, text: string): Json => {
    const reply = structuredClone(read("openai-closing-report/typed-closing-report"));
    reply.id = id;
    ((reply.output as Json[])[0]!.content as Json[])[0]!.text = text;
    return reply;
  };
  const waitCall = structuredClone(call);
  (waitCall.output as Json[])[0]!.actions = [{ type: "wait" }];
  return {
    vendor: "openai",
    model: "gpt-6.1-sol",
    create: (fetchFn) =>
      // An output limit lets a capped session book a lost request at a bounded worst case.
      createOpenAiResponsesProvider({
        apiKey: "synthetic-key",
        fetchFn,
        delayFn: noDelay,
        env: {},
        maxOutputTokens: 16_000,
      }),
    batch: ok(call),
    batchKinds: ["click", "keypress"],
    waitOnly: ok(waitCall),
    ending: ok(message("fixture-ending", "I added the task. The list was quick to use.")),
    outputLimit: ok(read("openai-incomplete/partial-message")),
    refusal: { status: 400, body: read("openai-invalid-prompt/refusal") },
    closingProse: ok(message("fixture-closing-prose", "It went fine, thanks.")),
    closingReport: ok(read("openai-closing-report/typed-closing-report-impressions")),
    strictClosing: (body) => (body.text as Json | undefined)?.format !== undefined,
    billedInput: (body) => (body.usage as Json).input_tokens as number,
  } satisfies Column;
})();

const anthropic = (() => {
  const fixture = (name: string) => read(`anthropic-messages/${name}`);
  const waitOnly = structuredClone(fixture("batch"));
  waitOnly.content = [
    {
      type: "tool_use",
      id: "toolu_01ContractWait",
      name: "wait",
      input: { duration: 2 },
      toolset_name: "computer",
    },
  ];
  return {
    vendor: "anthropic",
    model: "claude-haiku-5-5",
    create: (fetchFn) =>
      createAnthropicMessagesProvider({
        apiKey: "synthetic-key",
        fetchFn,
        delayFn: noDelay,
        env: {},
      }),
    batch: ok(fixture("batch")),
    batchKinds: ["click", "type", "click", "wait", "screenshot"],
    waitOnly: ok(waitOnly),
    ending: ok(fixture("end-turn")),
    outputLimit: ok(fixture("max-tokens")),
    refusal: ok(fixture("documented-refusal")),
    closingProse: ok(fixture("end-turn")),
    closingReport: ok(fixture("closing-report")),
    strictClosing: (body) => (body.output_config as Json).format !== undefined,
    billedInput: (body) => {
      const usage = body.usage as Record<string, number>;
      return (
        usage.input_tokens! + usage.cache_read_input_tokens! + usage.cache_creation_input_tokens!
      );
    },
  } satisfies Column;
})();

const COLUMNS: readonly Column[] = [openAi, anthropic];

const SCREEN = PNG.sync.write(new PNG({ width: 1440, height: 950 }));

/** The shape of a failed desktop command: a non-zero exit, as the desktop SDK throws it. */
const commandFailure = (): Error =>
  Object.assign(new Error("command failed"), { name: "CommandExitError", exitCode: 1 });

interface Session {
  readonly answers: readonly Answer[];
  /** The dispatched action at this position fails as a desktop command. */
  readonly failAt?: number;
  readonly options?: Partial<CuaLoopOptions>;
}

async function run(column: Column, session: Session) {
  const bodies: Json[] = [];
  // Requests past the scripted answers, such as an impressions request after the participant's
  // own ending, get the vendor's ending reply.
  const billed: Array<Exclude<Answer, string>> = [];
  const fetchFn: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as Json);
    const answer = session.answers[bodies.length - 1] ?? column.ending;
    if (answer === "lost") throw new TypeError("fetch failed");
    if (answer === "body-lost") {
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => {
          throw new TypeError("terminated");
        },
      };
    }
    if (answer.status === 200) billed.push(answer);
    return {
      ok: answer.status === 200,
      status: answer.status,
      text: async () => JSON.stringify(answer.body),
      json: async () => answer.body,
    };
  };
  const dispatched: CuaAction["kind"][] = [];
  const result = await runComputerUseLoop({
    instructions: "You are a busy parent. Add a task called Buy milk.",
    provider: column.create(fetchFn),
    executor: {
      observe: async () => ({
        screenshot: SCREEN,
        stateSignature: `frame-${dispatched.length}`,
        text: dispatched.length > 0 ? "saved" : "",
      }),
      execute: async (action) => {
        dispatched.push(action.kind);
        if (dispatched.length - 1 === session.failAt) throw commandFailure();
      },
    },
    persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
    redaction: defaultRedactionHooks,
    now: Date.now,
    timeoutMs: 60_000,
    ...session.options,
  });
  return { result, bodies, dispatched, billed };
}

describe.each(COLUMNS)("the $vendor provider in the loop", (column) => {
  it("acts on a batch, then ends with a message, priced from what each reply billed", async () => {
    const { result, dispatched, billed } = await run(column, {
      answers: [column.batch, column.ending],
    });
    expect(dispatched).toEqual(column.batchKinds);
    expect(result).toMatchObject({ status: "passed", completionReason: "goal_satisfied" });
    expect(result.trace.counts.turns).toBe(2);
    const usage = result.trace.tokenUsage!;
    expect(usage.input).toBe(
      billed.reduce((sum, answer) => sum + column.billedInput(answer.body), 0),
    );
    expect(usage.turns).toHaveLength(billed.length);
    expect(estimateActorCost(usage, result.trace.ids.model).estimatedCostUsd).toBeGreaterThan(0);
    expect(result.trace.interactionUsageIncomplete).toBeUndefined();
  });

  it("watches a turn that only waits in place of sending the wait", async () => {
    const { result, dispatched } = await run(column, {
      answers: [column.waitOnly, column.ending],
      options: { idleWaitMs: 1000, maxWaitMs: 1000, sleep: async () => undefined },
    });
    expect(dispatched).toEqual([]);
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.counts.turns).toBe(2);
  });

  it("skips a failed desktop command, halting the rest of its batch when the provider asks", async () => {
    const { result, dispatched, bodies } = await run(column, {
      answers: [column.batch, column.ending],
      failAt: 1,
    });
    const halts = column.create(async () => {
      throw new Error("unused");
    }).batchFailure;
    expect(dispatched).toEqual(
      halts === "halt" ? column.batchKinds.slice(0, 2) : column.batchKinds,
    );
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(result.completionReason).toBe("goal_satisfied");
  });

  it("asks once more after a reply cut off at its output limit", async () => {
    const { result, bodies } = await run(column, {
      answers: [column.outputLimit, column.ending],
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(result.completionReason).toBe("goal_satisfied");
  });

  it("stops on a refusal, keeping the usage of a refusal it was billed for", async () => {
    const { result, billed } = await run(column, { answers: [column.refusal] });
    expect(result.trace.stopCause).toBe("provider_refused_prompt");
    expect(result.trace.tokenUsage?.input).toBe(
      billed.length === 0 ? undefined : column.billedInput(billed[0]!.body),
    );
  });

  it("reports usage as incomplete when a billed reply's body is lost, and sends the request again", async () => {
    const { result, bodies } = await run(column, {
      answers: ["body-lost", column.batch, column.ending],
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.interactionUsageIncomplete).toBe(true);
  });

  it("reports usage as incomplete when a dispatched request is cancelled", async () => {
    const controller = new AbortController();
    const provider = column.create(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
          controller.abort();
        }),
    );
    await expect(
      provider.nextTurn(
        {
          instructions: "Add a task called Buy milk.",
          observation: { screenshot: SCREEN, stateSignature: "s" },
        },
        controller.signal,
      ),
    ).rejects.toThrow("aborted");
    expect(provider.interactionUsageIncomplete).toBe(true);
  });

  it("asks for the closing account again with the schema set when the first reply is not its JSON", async () => {
    const { result, bodies } = await run(column, {
      answers: [column.batch, column.closingProse, column.closingReport],
      options: { stopWhen: { any: [{ id: "saved", textIncludes: "saved" }] } },
    });
    expect(bodies.map((body) => column.strictClosing(body))).toEqual([false, false, true]);
    expect(result.trace.debrief).toMatchObject({ status: "completed" });
    expect(result.trace.tokenUsage?.turns).toHaveLength(3);
  });
});

describe("a request lost in transit under a spend cap", () => {
  const capped = (column: Column): Partial<CuaLoopOptions> => ({
    maxUsd: 1,
    estimateTurnCostUsd: (usage) => estimateActorCost(usage, column.model).estimatedCostUsd,
  });

  it("is booked at its worst case and sent again by the OpenAI provider", async () => {
    const { result, bodies } = await run(openAi, {
      answers: ["lost", openAi.batch, openAi.ending],
      options: capped(openAi),
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.items.map((item) => item.title)).toContain(
      "worst case booked for a lost request",
    );
  });

  it("stalled is not sent again by the Anthropic provider; the session stops", async () => {
    let requests = 0;
    const result = await runComputerUseLoop({
      instructions: "You are a busy parent. Add a task called Buy milk.",
      provider: anthropic.create(async (_url, init) => {
        requests += 1;
        if (requests === 2) {
          // The second request never answers, so the turn bound reads it as stalled.
          return new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          );
        }
        const answer = anthropic.batch as { body: Json };
        return { ok: true, status: 200, text: async () => "", json: async () => answer.body };
      }),
      executor: {
        observe: async () => ({ screenshot: SCREEN, stateSignature: `frame-${requests}` }),
        execute: async () => undefined,
      },
      persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
      redaction: defaultRedactionHooks,
      now: Date.now,
      timeoutMs: 60_000,
      turnTimeoutMs: 50,
      ...capped(anthropic),
    });
    expect(requests).toBe(2);
    expect(result.trace).toMatchObject({
      stopCause: "usage_unreported",
      interactionUsageIncomplete: true,
    });
  });

  it("is not sent again by the Anthropic provider, whose worst case the cap cannot bound", async () => {
    const { result, bodies } = await run(anthropic, {
      answers: ["lost", anthropic.batch, anthropic.ending],
      options: capped(anthropic),
    });
    expect(bodies).toHaveLength(1);
    expect(result.status).not.toBe("passed");
    expect(result.trace.interactionUsageIncomplete).toBe(true);
  });
});
