import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { createRestrictedCodexParticipant } from "../../../src/actors/codex/restricted-participant.js";
import {
  PARTICIPANT_FINAL_SCHEMA,
  PARTICIPANT_LIMITS,
  PARTICIPANT_TOOL_SCHEMA,
  participantToolSchema,
  parseParticipantFinal,
  parseParticipantTool,
} from "../../../src/actors/codex/restricted-participant-policy.js";
import { createRestrictedCodexSession } from "../../../src/actors/codex/restricted-session.js";
import { defaultCodexCliVersion } from "../../../src/actors/codex/codex-admission.js";
import { validActorExecutionProfile } from "../../../src/actors/contract.js";
import type {
  RestrictedCodexRequest,
  RestrictedCodexResult,
} from "../../../src/actors/codex/restricted-policy.js";

const { run, sessionClose, metadata } = vi.hoisted(() => ({
  metadata: {
    resolvedModel: undefined as string | undefined,
    authentication: undefined as "chatgpt-account" | "api-key" | undefined,
    pendingUsage: undefined as { input: number; output: number } | undefined,
    pendingInferenceUsage: undefined as { input: number; output: number }[] | undefined,
    cliVersion: undefined as string | undefined,
    unknownNotifications: {} as Record<string, number>,
    policyRefusal: undefined as string | undefined,
    truncatedFrameBytes: undefined as number | undefined,
    protocolIncompatibilities: undefined as string[] | undefined,
    protocolAdditions: undefined as string[] | undefined,
  },
  run: vi.fn<(request: RestrictedCodexRequest) => Promise<RestrictedCodexResult>>(),
  sessionClose: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("../../../src/actors/codex/restricted-session.js", () => ({
  createRestrictedCodexSession: vi.fn(() => ({
    run,
    close: sessionClose,
    get resolvedModel() {
      return metadata.resolvedModel;
    },
    get authentication() {
      return metadata.authentication;
    },
    get pendingUsage() {
      return metadata.pendingUsage;
    },
    get pendingInferenceUsage() {
      return metadata.pendingInferenceUsage;
    },
    get cliVersion() {
      return metadata.cliVersion;
    },
    get unknownNotifications() {
      return metadata.unknownNotifications;
    },
    get policyRefusal() {
      return metadata.policyRefusal;
    },
    get truncatedFrameBytes() {
      return metadata.truncatedFrameBytes;
    },
    get protocolIncompatibilities() {
      return metadata.protocolIncompatibilities;
    },
    get protocolAdditions() {
      return metadata.protocolAdditions;
    },
  })),
}));
const createSession = vi.mocked(createRestrictedCodexSession);

function frame(red = 0): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data[0] = red;
  image.data[3] = 255;
  return PNG.sync.write(image);
}
const request = (screenshot = frame()) => ({
  instructions: "Use the synthetic page as a cautious newcomer.",
  observation: {
    screenshot,
    stateSignature: "synthetic",
    appState: { hidden: "DO_NOT_SEND" },
    text: "DO_NOT_SEND",
    url: "DO_NOT_SEND",
  },
});
const finalOutput = (changes: Record<string, unknown> = {}) => ({
  outcome: "reached",
  summary: "I saved the note.",
  frictionReports: ["The first click was skipped, so I retried."],
  ...changes,
});
const result = (
  output: unknown = finalOutput(),
  changes: Partial<RestrictedCodexResult> = {},
): RestrictedCodexResult => ({
  status: "completed",
  output,
  usage: { input: 20, output: 5 },
  inferenceUsage: [{ input: 20, output: 5 }],
  usageComplete: true,
  dispatched: true,
  errorCode: null,
  ...changes,
});

type NativeTool = (args: unknown) => Promise<string>;
function nativeTool(): NativeTool {
  const options = createSession.mock.calls.at(-1)?.[0] as unknown as {
    participant?: { tool?: { call?: NativeTool } };
  };
  if (!options?.participant?.tool?.call) throw new Error("participant tool was not configured");
  return options.participant.tool.call;
}

beforeEach(() => {
  run.mockReset();
  metadata.resolvedModel = undefined;
  metadata.authentication = undefined;
  metadata.pendingUsage = undefined;
  metadata.pendingInferenceUsage = undefined;
  metadata.cliVersion = undefined;
  metadata.unknownNotifications = {};
  metadata.policyRefusal = undefined;
  metadata.truncatedFrameBytes = undefined;
  metadata.protocolIncompatibilities = undefined;
  metadata.protocolAdditions = undefined;
  sessionClose.mockReset().mockResolvedValue(true);
  createSession.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("restricted participant conversation", () => {
  it.each(["chatgpt-account", "api-key"] as const)(
    "records resolved operator model and %s billing truthfully",
    async (authentication) => {
      run.mockImplementation(async () => {
        metadata.resolvedModel = "gpt-5.6-sol";
        metadata.authentication = authentication;
        return result();
      });
      const h = createRestrictedCodexParticipant({ authMode: "operator", reasoningEffort: "high" });
      expect(h.provider.version).toBeUndefined();
      expect(h.provider.executionProfile).toBeUndefined();
      await h.provider.nextTurn(request(), new AbortController().signal);
      expect(run.mock.calls[0]![0].model).toBeUndefined();
      expect(h.provider.version).toBe("gpt-5.6-sol");
      if (authentication === "chatgpt-account")
        expect(h.provider.executionProfile).toMatchObject({
          requestedModel: "gpt-5.6-sol",
          reasoningEffort: "high",
          billing: "account-unknown",
        });
      else expect(h.provider.executionProfile).toBeUndefined();
      await h.close();
    },
  );
  it("records the release that launched, including one no admission list names, and the default before", async () => {
    run.mockImplementation(async () => {
      // A candidate admitted through the qualifier's cliVersions seam.
      metadata.cliVersion = "0.161.0";
      return result();
    });
    const h = createRestrictedCodexParticipant();
    expect(h.provider.executionProfile).toMatchObject({ cliVersion: defaultCodexCliVersion() });
    await h.provider.nextTurn(request(), new AbortController().signal);
    expect(h.provider.executionProfile).toMatchObject({ cliVersion: "0.161.0" });
    expect(validActorExecutionProfile(h.provider.executionProfile)).toBe(true);
    await h.close();
  });
  it("strictly validates native tool batches and final accounts without rounding or filtering", () => {
    expect(
      parseParticipantTool({
        narration: "I will click Save.",
        actions: [{ kind: "click", x: 1.5, y: 2.25 }],
      }),
    ).toMatchObject({
      actions: [{ kind: "click", x: 1.5, y: 2.25 }],
      done: false,
      providerRequestPending: true,
    });
    expect(() =>
      parseParticipantTool({
        narration: "I will answer.",
        actions: [{ kind: "speak", text: "Hello" }],
      }),
    ).toThrow();
    expect(
      parseParticipantTool(
        { narration: "I will answer.", actions: [{ kind: "speak", text: "Hello" }] },
        true,
      ),
    ).toMatchObject({ actions: [{ kind: "speak", text: "Hello" }] });
    for (const value of [
      { narration: "x", actions: [], extra: true },
      { narration: "x", actions: [] },
      { narration: "x", actions: [{ kind: "shell", command: "invalid" }] },
      { narration: "x", actions: Array(5).fill({ kind: "wait", ms: 1 }) },
      { narration: "🙂".repeat(1000), actions: [{ kind: "wait", ms: 1 }] },
      { narration: "x", actions: [{ kind: "type", text: "x".repeat(65537) }] },
    ])
      expect(() => parseParticipantTool(value)).toThrow();
    for (const action of [
      { kind: "click", x: 1.5, y: 2.25, button: null },
      { kind: "click", x: 1, y: 2, heldKeys: ["SHIFT"] },
      { kind: "wait", ms: null },
      { kind: "wait", ms: -1 },
      { kind: "wait", ms: 60_000, extra: true },
      { kind: "type", text: null },
    ])
      expect(() => parseParticipantTool({ narration: "x", actions: [action] })).toThrow();
    // A wait is admitted as asked, however long: the loop shortens and steps it, so a long wait
    // never fails the tool call that would end the native run.
    expect(
      parseParticipantTool({
        narration: "I will wait for the other person.",
        actions: [{ kind: "wait", ms: 30_000 }, { kind: "wait", ms: 90_000.5 }, { kind: "wait" }],
      }).actions,
    ).toEqual([{ kind: "wait", ms: 30_000 }, { kind: "wait", ms: 90_000.5 }, { kind: "wait" }]);
    expect(parseParticipantFinal(finalOutput()).closingReport).toEqual({
      summary: "I saved the note.",
      frictionReports: ["The first click was skipped, so I retried."],
    });
    for (const value of [
      { ...finalOutput(), actions: [] },
      { ...finalOutput(), outcome: "maybe" },
      { outcome: "reached", summary: "", frictionReports: [] },
    ])
      expect(() => parseParticipantFinal(value)).toThrow();
  });

  it("keeps the impressions in a final account and asks for them in its instructions", async () => {
    const impressions = [
      { kind: "liked", text: "The note saved without a page reload." },
      {
        kind: "unlike_my_work",
        text: "In my notebook the date comes first; here it is at the bottom of the note.",
      },
    ];
    expect(parseParticipantFinal(finalOutput({ impressions })).closingReport).toEqual({
      summary: "I saved the note.",
      frictionReports: ["The first click was skipped, so I retried."],
      impressions,
    });
    expect(parseParticipantFinal(finalOutput({ impressions })).message).toBe(
      "I saved the note.\nThe first click was skipped, so I retried.",
    );
    for (const invalid of [
      [{ kind: "annoying", text: "Slow." }],
      [{ kind: "liked", text: "" }],
      Array(7).fill({ kind: "liked", text: "Fast." }),
    ])
      expect(() => parseParticipantFinal(finalOutput({ impressions: invalid }))).toThrow(
        "invalid_response",
      );

    run.mockResolvedValueOnce(result(finalOutput({ impressions })));
    const h = createRestrictedCodexParticipant();
    await h.provider.nextTurn(request(), new AbortController().signal);
    const instructions = String(run.mock.calls[0]![0].instructions);
    expect(instructions).toContain("impressions");
    expect(instructions).toContain("own work or life");
    await h.close();
  });

  it("publishes strict native tool and final schemas", () => {
    expect(PARTICIPANT_TOOL_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["narration", "actions"],
      properties: {
        narration: { type: "string" },
        actions: { type: "array", minItems: 1, maxItems: 4 },
      },
    });
    // The final schema Codex participants have been sent, keyword for keyword.
    expect(PARTICIPANT_FINAL_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["outcome", "summary", "frictionReports", "impressions"],
      properties: {
        outcome: { type: "string", enum: ["reached", "not_reached", "blocked"] },
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        frictionReports: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 2000 },
        },
        impressions: {
          type: "array",
          maxItems: 6,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "text"],
            properties: {
              kind: {
                type: "string",
                enum: [
                  "unclear",
                  "unfinished",
                  "untrustworthy",
                  "liked",
                  "missing",
                  "unlike_my_work",
                ],
              },
              text: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
        },
      },
    });
    // A wait has no published maximum: the tool description states the study's longest wait.
    for (const schema of [PARTICIPANT_TOOL_SCHEMA, participantToolSchema(true)]) {
      const { oneOf } = (schema.properties as { actions: { items: { oneOf: unknown[] } } }).actions
        .items;
      expect(oneOf).toContainEqual({
        type: "object",
        properties: { kind: { type: "string", const: "wait" }, ms: { type: "number", minimum: 0 } },
        required: ["kind"],
        additionalProperties: false,
      });
    }
    expect(JSON.stringify(PARTICIPANT_TOOL_SCHEMA)).not.toContain('"speak"');
    expect(JSON.stringify(participantToolSchema(true))).toContain('"speak"');
    expect(JSON.stringify(participantToolSchema(true))).not.toContain("heldKeys");
  });

  it("keeps heard speaker evidence and spoken replies in the same admitted conversation", async () => {
    let toolReply: Record<string, unknown> | undefined;
    run.mockImplementationOnce(async () => {
      toolReply = JSON.parse(
        await nativeTool()({
          narration: "I will answer aloud.",
          actions: [{ kind: "speak", text: "Yes, I can hear you." }],
        }),
      );
      return result();
    });
    const firstSpeech = [
      {
        id: "utterance-1",
        source: "speaker_audio" as const,
        text: "Can you hear me?",
        durationMs: 800,
      },
    ];
    const secondSpeech = [
      {
        id: "utterance-2",
        source: "speaker_audio" as const,
        text: "Yes, thanks.",
        durationMs: 600,
      },
    ];
    const h = createRestrictedCodexParticipant({ speechEnabled: true });
    const signal = new AbortController().signal;
    const proposal = await h.provider.nextTurn(
      {
        ...request(frame(1)),
        observation: {
          ...request(frame(1)).observation,
          heardSpeech: firstSpeech,
        },
      },
      signal,
    );
    expect(proposal.actions).toEqual([{ kind: "speak", text: "Yes, I can hear you." }]);
    expect(JSON.parse(run.mock.calls[0]![0].evidence)).toMatchObject({ heardSpeech: firstSpeech });
    const terminal = await h.provider.nextTurn(
      {
        ...request(frame(2)),
        observation: {
          ...request(frame(2)).observation,
          heardSpeech: secondSpeech,
        },
        previousExecution: { actions: [{ index: 0, status: "completed" }] },
      },
      signal,
    );
    expect(terminal.done).toBe(true);
    expect(toolReply).toMatchObject({
      heardSpeech: secondSpeech,
      acknowledgments: [{ index: 0, status: "completed" }],
    });
    await h.close();
  });

  it("keeps one native run across tool callbacks, returns acknowledgments and fresh screenshots, then closes in the same persona session", async () => {
    const replies: Record<string, unknown>[] = [];
    run
      .mockImplementationOnce(async () => {
        replies.push(
          JSON.parse(
            await nativeTool()({
              narration: "I will try Save.",
              actions: [{ kind: "click", x: 1.5, y: 2.25 }],
            }),
          ),
        );
        replies.push(
          JSON.parse(
            await nativeTool()({
              narration: "That missed; I will retry.",
              actions: [{ kind: "click", x: 1.75, y: 2.5 }],
            }),
          ),
        );
        return result();
      })
      .mockResolvedValueOnce(
        result(finalOutput({ summary: "As the same cautious newcomer, I saved the note." })),
      );
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;

    const first = await h.provider.nextTurn(
      { ...request(frame(1)), contextHint: "FIRST_SCREEN" },
      signal,
    );
    expect(first).toMatchObject({
      providerRequestPending: true,
      actions: [{ kind: "click", x: 1.5, y: 2.25 }],
    });
    await expect(
      h.provider.nextTurn(
        {
          ...request(frame(2)),
          previousExecution: {
            actions: [{ index: 0, status: "rejected" as never }],
          },
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "request_rejected", receipt: { dispatched: false } });
    const second = await h.provider.nextTurn(
      {
        ...request(frame(2)),
        contextHint: "RETRY_AFTER_SKIP",
        previousExecution: {
          actions: [{ index: 0, status: "skipped" as const }],
        },
      },
      signal,
    );
    expect(second).toMatchObject({
      providerRequestPending: true,
      actions: [{ kind: "click", x: 1.75, y: 2.5 }],
    });
    const terminal = await h.provider.nextTurn(
      {
        ...request(frame(3)),
        previousExecution: {
          actions: [{ index: 0, status: "completed" as const }],
        },
      },
      signal,
    );
    expect(terminal).toMatchObject({
      done: true,
      outcome: "reached",
      providerRequest: { dispatched: true, usageComplete: true },
      closingReport: { summary: "I saved the note." },
    });
    expect(terminal.usage).toEqual({ input: 20, output: 5, turns: [{ input: 20, output: 5 }] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(replies[0]).toEqual({
      acknowledgments: [{ index: 0, status: "skipped" }],
      imageUrl: `data:image/png;base64,${frame(2).toString("base64")}`,
      contextHint: "RETRY_AFTER_SKIP",
      closing: false,
    });
    expect(replies[1]).toEqual({
      acknowledgments: [{ index: 0, status: "completed" }],
      imageUrl: `data:image/png;base64,${frame(3).toString("base64")}`,
      contextHint: null,
      closing: false,
    });
    expect(JSON.stringify(run.mock.calls[0]![0])).not.toContain("DO_NOT_SEND");

    const closingExecution = { actions: [{ index: 0, status: "completed" as const }] };
    const closing = await h.provider.debrief!(
      { ...request(frame(4)), contextHint: "Closing only.", previousExecution: closingExecution },
      signal,
    );
    expect(closing.closingReport?.summary).toContain("same cautious newcomer");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(new Set(run.mock.calls.map(([native]) => native.instructions)).size).toBe(1);
    expect(JSON.parse(run.mock.calls[1]![0].evidence)).toMatchObject({
      phase: "closing",
      contextHint: "Closing only.",
      previousExecution: closingExecution,
    });
    expect(run.mock.calls[0]![0].schema).toBe(PARTICIPANT_FINAL_SCHEMA);
    expect(run.mock.calls[1]![0].schema).toBe(PARTICIPANT_FINAL_SCHEMA);
    await h.close();
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("refuses changed instructions, unsupported continuation fields and invalid evidence without launching another native turn", async () => {
    run.mockResolvedValue(result());
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;
    await h.provider.nextTurn(request(), signal);
    for (const candidate of [
      { ...request(), instructions: "different" },
      { ...request(), previousResponseId: "unsupported" },
      { ...request(), contextHint: "x".repeat(8193) },
      { ...request(), observation: { stateSignature: "no-frame" } },
    ]) {
      await expect(h.provider.nextTurn(candidate, signal)).rejects.toMatchObject({
        code: "request_rejected",
      });
    }
    expect(run).toHaveBeenCalledTimes(1);
    expect(sessionClose).not.toHaveBeenCalled();
    await h.close();
  });

  it("retains malformed-final usage and incomplete accounting without claiming completion", async () => {
    run
      .mockResolvedValueOnce(result({ unexpected: true }))
      .mockResolvedValueOnce(result(finalOutput(), { usage: null, usageComplete: false }));
    const malformed = createRestrictedCodexParticipant();
    await expect(
      malformed.provider.nextTurn(request(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "invalid_response",
      failurePhase: "response",
      receipt: { dispatched: true, cleanup: "confirmed" },
      usage: { input: 20, output: 5 },
    });
    await expect(
      malformed.provider.nextTurn(request(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "request_rejected" });
    await malformed.close();

    const incomplete = createRestrictedCodexParticipant();
    const turn = await incomplete.provider.nextTurn(request(), new AbortController().signal);
    expect(turn.providerRequest).toEqual({
      dispatched: true,
      usageComplete: false,
      cleanup: "confirmed",
    });
    expect(turn.usage).toBeUndefined();
    expect(incomplete.provider.interactionUsageIncomplete).toBe(true);
    await incomplete.close();
  });

  it("delivers a native failure that arrives while the yielded action is executing on the next continuation", async () => {
    let nativeSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      nativeSettled = resolve;
    });
    run.mockImplementation(async () => {
      void nativeTool()({
        narration: "I will click Save.",
        actions: [{ kind: "click", x: 1, y: 1 }],
      }).catch(() => undefined);
      const failure = result(null, {
        status: "failed",
        errorCode: "codex_process_failed",
        failurePhase: "response",
        usage: { input: 7, output: 1 },
        usageComplete: false,
      });
      nativeSettled();
      return failure;
    });
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;
    const proposal = await h.provider.nextTurn(request(frame(1)), signal);
    expect(proposal).toMatchObject({
      providerRequestPending: true,
      actions: [{ kind: "click", x: 1, y: 1 }],
    });
    await settled;
    await vi.waitFor(() => expect(h.provider.interactionUsageIncomplete).toBe(true));

    await expect(
      h.provider.nextTurn(
        {
          ...request(frame(2)),
          previousExecution: {
            actions: [{ index: 0, status: "completed" as const }],
          },
        },
        signal,
      ),
    ).rejects.toMatchObject({
      code: "process_failed",
      failurePhase: "response",
      receipt: { dispatched: true, usageComplete: false, cleanup: "confirmed" },
      usage: { input: 7, output: 1 },
    });
    expect(run).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it("cancels the native request, starts cleanup immediately and waits for native settlement plus cleanup", async () => {
    let finish!: (value: RestrictedCodexResult) => void;
    let confirmCleanup!: (value: boolean) => void;
    run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    sessionClose.mockImplementation(
      () =>
        new Promise((resolve) => {
          confirmCleanup = resolve;
        }),
    );
    const h = createRestrictedCodexParticipant();
    const abort = new AbortController();
    const turn = h.provider.nextTurn(request(), abort.signal);
    void turn.catch(() => undefined);
    abort.abort();
    await vi.waitFor(() => expect(sessionClose).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![0].signal?.aborted).toBe(true);
    const closing = h.close();
    expect(h.close()).toBe(closing);
    finish(result());
    await expect(turn).rejects.toMatchObject({
      code: "cancelled",
      usage: { input: 20, output: 5 },
    });
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    confirmCleanup(true);
    expect(await closing).toEqual({ status: "confirmed" });
    await expect(
      h.provider.nextTurn(request(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "request_rejected" });
  });

  it.each([false, "throws"])(
    "does not claim native cleanup confirmation when close returns %s",
    async (mode) => {
      if (mode === false) sessionClose.mockResolvedValue(false);
      else sessionClose.mockRejectedValue(new Error("synthetic"));
      const h = createRestrictedCodexParticipant();
      const closing = h.close();
      expect(h.close()).toBe(closing);
      expect(await closing).toEqual({ status: "unconfirmed" });
      expect(run).not.toHaveBeenCalled();
      expect(sessionClose).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a concurrent continuation while one provider request is pending", async () => {
    let finish!: (value: RestrictedCodexResult) => void;
    run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;
    const first = h.provider.nextTurn(request(), signal);
    await expect(h.provider.nextTurn(request(), signal)).rejects.toMatchObject({
      code: "busy",
      receipt: { dispatched: false },
    });
    finish(result());
    await expect(first).resolves.toMatchObject({ done: true, outcome: "reached" });
    await h.close();
  });
});

describe("restricted participant refusals", () => {
  const speech = [
    { id: "utterance-1", source: "speaker_audio" as const, text: "Hello?", durationMs: 500 },
  ];
  const rejected = { code: "request_rejected", receipt: { dispatched: false } };

  it.each([
    ["a non-string instruction", { ...request(), instructions: 42 }, {}],
    [
      "instructions over the limit",
      { ...request(), instructions: "x".repeat(PARTICIPANT_LIMITS.instructions + 1) },
      {},
    ],
    ["a non-string context hint", { ...request(), contextHint: 7 }, {}],
    [
      "acknowledged safety checks",
      { ...request(), acknowledgedSafetyChecks: [{ id: "s", code: "c", message: "m" }] },
      {},
    ],
    ["a frame that is not a PNG", request(Buffer.from("not a png")), {}],
    [
      "heard speech on a desktop without speech",
      { ...request(), observation: { ...request().observation, heardSpeech: speech } },
      {},
    ],
    [
      "malformed heard speech",
      { ...request(), observation: { ...request().observation, heardSpeech: [{ id: 1 }] } },
      { speechEnabled: true },
    ],
    [
      "acknowledgments with no tool call waiting",
      { ...request(), previousExecution: { actions: [{ index: 0, status: "completed" }] } },
      {},
    ],
  ])("refuses %s before launching a native turn", async (_, candidate, options) => {
    run.mockResolvedValue(result());
    const h = createRestrictedCodexParticipant(options);
    await expect(
      h.provider.nextTurn(candidate as never, new AbortController().signal),
    ).rejects.toMatchObject(rejected);
    expect(run).not.toHaveBeenCalled();
    await h.close();
  });

  it("refuses acknowledgments that do not match the waiting tool call, then accepts matching ones", async () => {
    let reply: Record<string, unknown> | undefined;
    run.mockImplementationOnce(async () => {
      reply = JSON.parse(
        await nativeTool()({ narration: "Saving.", actions: [{ kind: "click", x: 1, y: 1 }] }),
      );
      return result();
    });
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;
    await h.provider.nextTurn(request(frame(1)), signal);
    for (const previousExecution of [
      undefined,
      // A one-character string has the waiting batch's length but is not an array.
      { actions: "x" },
      {
        actions: [
          { index: 0, status: "completed" },
          { index: 1, status: "completed" },
        ],
      },
      { actions: [null] },
      { actions: [{ index: 1, status: "completed" }] },
    ]) {
      await expect(
        h.provider.nextTurn(
          { ...request(frame(2)), ...(previousExecution ? { previousExecution } : {}) } as never,
          signal,
        ),
      ).rejects.toMatchObject(rejected);
    }
    expect(reply).toBeUndefined();
    const terminal = await h.provider.nextTurn(
      { ...request(frame(2)), previousExecution: { actions: [{ index: 0, status: "completed" }] } },
      signal,
    );
    expect(terminal.done).toBe(true);
    expect(reply).toMatchObject({ acknowledgments: [{ index: 0, status: "completed" }] });
    expect(run).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it("reports a native cleanup failure in the receipt and at close", async () => {
    run.mockResolvedValue(
      result(null, { status: "failed", errorCode: "codex_cleanup_failed", usageComplete: false }),
    );
    const h = createRestrictedCodexParticipant();
    await expect(
      h.provider.nextTurn(request(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "cleanup_unconfirmed", receipt: { cleanup: "unconfirmed" } });
    expect(await h.close()).toEqual({ status: "unconfirmed" });
  });

  it("fails a turn that settles after cancellation as cleanup_unconfirmed once cleanup failed", async () => {
    let finish!: (value: RestrictedCodexResult) => void;
    run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    sessionClose.mockResolvedValue(false);
    const h = createRestrictedCodexParticipant();
    const abort = new AbortController();
    const turn = h.provider.nextTurn(request(), abort.signal);
    void turn.catch(() => undefined);
    abort.abort();
    await vi.waitFor(() => expect(sessionClose).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    finish(result());
    await expect(turn).rejects.toMatchObject({ code: "cleanup_unconfirmed" });
    expect(await h.close()).toEqual({ status: "unconfirmed" });
  });

  it("stops waiting for native cleanup after the cleanup budget", async () => {
    vi.useFakeTimers();
    sessionClose.mockReturnValue(new Promise<boolean>(() => undefined));
    const h = createRestrictedCodexParticipant();
    const closing = h.close();
    await vi.advanceTimersByTimeAsync(PARTICIPANT_LIMITS.cleanupMs + 1);
    expect(await closing).toEqual({ status: "unconfirmed" });
  });
});

// Paths the participant split moved that no earlier test pinned. Each case fails if the refusal,
// receipt or teardown it names changes.
describe("restricted participant guards and receipts", () => {
  const tool = { narration: "I will try Save.", actions: [{ kind: "click", x: 1, y: 1 }] };
  /** A native run that asks for one tool call, then waits for `finish`. */
  function oneToolCallRun() {
    let finish!: (value: RestrictedCodexResult) => void;
    const finished = new Promise<RestrictedCodexResult>((resolve) => {
      finish = resolve;
    });
    let toolReply: Promise<string> | undefined;
    run.mockImplementationOnce(async () => {
      toolReply = nativeTool()(tool);
      void toolReply.catch(() => undefined);
      await toolReply.catch(() => undefined);
      return finished;
    });
    return { finish, reply: () => toolReply! };
  }

  it("refuses a request timeout outside 1 ms to the participant limit", () => {
    for (const requestTimeoutMs of [0, 1.5, PARTICIPANT_LIMITS.requestMs + 1])
      expect(() => createRestrictedCodexParticipant({ requestTimeoutMs })).toThrow(
        expect.objectContaining({ code: "request_rejected" }),
      );
  });

  it("refuses a native tool call when no native run is active", async () => {
    createRestrictedCodexParticipant();
    await expect(nativeTool()(tool)).rejects.toThrow("Unexpected participant tool call");
  });

  it("refuses a second native tool call while one waits for its acknowledgments", async () => {
    let second: Promise<string> | undefined;
    run.mockImplementationOnce(async () => {
      const first = nativeTool()(tool);
      void first.catch(() => undefined);
      second = nativeTool()(tool);
      void second.catch(() => undefined);
      return new Promise<RestrictedCodexResult>(() => undefined);
    });
    const h = createRestrictedCodexParticipant();
    await h.provider.nextTurn(request(), new AbortController().signal);
    await expect(second!).rejects.toThrow("Unexpected participant tool call");
    await h.close();
  });

  it("refuses a native tool call during the debrief and after close", async () => {
    let debriefCall: Promise<string> | undefined;
    run.mockImplementationOnce(async () => {
      debriefCall = nativeTool()(tool);
      void debriefCall.catch(() => undefined);
      return result();
    });
    const h = createRestrictedCodexParticipant();
    await h.provider.debrief!(request(), new AbortController().signal);
    await expect(debriefCall!).rejects.toThrow("Unexpected participant tool call");
    await h.close();
    await expect(nativeTool()(tool)).rejects.toThrow("Unexpected participant tool call");
  });

  it("refuses a native tool call after close while the native run is still active", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let lateCall: Promise<string> | undefined;
    run.mockImplementationOnce(async () => {
      await nativeTool()(tool);
      await gate;
      lateCall = nativeTool()(tool);
      void lateCall.catch(() => undefined);
      return result();
    });
    const h = createRestrictedCodexParticipant();
    await h.provider.nextTurn(request(), new AbortController().signal);
    const pending = h.provider.nextTurn(
      { ...request(), previousExecution: { actions: [{ index: 0, status: "completed" }] } },
      new AbortController().signal,
    );
    void pending.catch(() => undefined);
    const closed = h.close();
    openGate();
    await vi.waitFor(() => expect(lateCall).toBeDefined());
    await expect(lateCall!).rejects.toThrow("Unexpected participant tool call");
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await closed;
  });

  it("rejects the waiting tool call when the participant closes", async () => {
    const native = oneToolCallRun();
    const h = createRestrictedCodexParticipant();
    await h.provider.nextTurn(request(), new AbortController().signal);
    const closed = h.close();
    await expect(native.reply()).rejects.toThrow("Participant closed");
    native.finish(result());
    await closed;
  });

  it("confirms a native cleanup that finishes inside the cleanup budget", async () => {
    sessionClose
      .mockReset()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(true), 50)));
    const h = createRestrictedCodexParticipant();
    await expect(h.close()).resolves.toEqual({ status: "confirmed" });
  });

  it("reports unknown notification methods and a refusal after the last request on close", async () => {
    metadata.cliVersion = "0.160.0";
    metadata.unknownNotifications = { "thread/futureProgress/updated": 3 };
    metadata.policyRefusal = "codex_tool_call";
    metadata.truncatedFrameBytes = 40;
    const h = createRestrictedCodexParticipant();
    await expect(h.close()).resolves.toEqual({
      status: "confirmed",
      warnings: [
        "Codex CLI 0.160.0 sent notification methods humanish does not know: thread/futureProgress/updated ×3. They carried no item and were ignored.",
        "Codex output was cut off when humanish stopped the app-server: 40 bytes of an unfinished last frame were not checked.",
      ],
      refusal: "codex_tool_call",
    });
  });

  it("warns on close when a hosted participant ran an untested release", async () => {
    // Detected but refused before thread/start (no resolved model): it never ran, so no warning.
    metadata.cliVersion = "0.161.0";
    await expect(
      createRestrictedCodexParticipant({ authMode: "operator" }).close(),
    ).resolves.toEqual({ status: "confirmed" });
    metadata.resolvedModel = "operator-model";
    const hosted = createRestrictedCodexParticipant({ authMode: "operator" });
    await expect(hosted.close()).resolves.toEqual({
      status: "confirmed",
      warnings: [
        "Codex CLI 0.161.0 has not been tested with humanish; this hosted participant's evidence rests on the checks each launch makes.",
      ],
    });
    // An isolated participant on the same release, and a hosted one on a tested release, do not.
    await expect(createRestrictedCodexParticipant().close()).resolves.toEqual({
      status: "confirmed",
    });
    metadata.cliVersion = defaultCodexCliVersion();
    await expect(
      createRestrictedCodexParticipant({ authMode: "operator" }).close(),
    ).resolves.toEqual({ status: "confirmed" });
  });

  it("reports the protocol check's refusal detail and recorded additions on close", async () => {
    metadata.cliVersion = "0.161.0";
    metadata.protocolIncompatibilities = ["turn/start response turn.id is no longer in the schema"];
    metadata.protocolAdditions = ["item/completed item.type now also allows futureItem"];
    const h = createRestrictedCodexParticipant();
    await expect(h.close()).resolves.toEqual({
      status: "confirmed",
      warnings: [
        "Codex CLI 0.161.0 changed the app-server protocol humanish uses: turn/start response turn.id is no longer in the schema.",
        "Codex CLI 0.161.0's app-server schema has values humanish has not seen: item/completed item.type now also allows futureItem. humanish recorded them and continued.",
      ],
    });
  });

  it("refuses an already-aborted request as cancelled and closes the conversation", async () => {
    const h = createRestrictedCodexParticipant();
    const controller = new AbortController();
    controller.abort();
    await expect(h.provider.nextTurn(request(), controller.signal)).rejects.toMatchObject({
      code: "cancelled",
      receipt: { dispatched: false },
    });
    await expect(
      h.provider.nextTurn(request(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "request_rejected" });
    expect(run).not.toHaveBeenCalled();
    await h.close();
  });

  it("keeps the conversation alive when a request's signal aborts after it yielded", async () => {
    const native = oneToolCallRun();
    const h = createRestrictedCodexParticipant();
    const first = new AbortController();
    await h.provider.nextTurn(request(), first.signal);
    // The shared loop aborts each request's signal after the request yields.
    first.abort();
    const next = h.provider.nextTurn(
      { ...request(), previousExecution: { actions: [{ index: 0, status: "completed" }] } },
      new AbortController().signal,
    );
    await native.reply();
    native.finish(result());
    await expect(next).resolves.toMatchObject({ done: true, outcome: "reached" });
    await h.close();
  });

  it("refuses any request as busy while one is pending, before checking its acknowledgments", async () => {
    run.mockImplementationOnce(() => new Promise<RestrictedCodexResult>(() => undefined));
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;
    void h.provider.nextTurn(request(), signal).catch(() => undefined);
    await expect(
      h.provider.nextTurn(
        { ...request(), previousExecution: { actions: [{ index: 0, status: "completed" }] } },
        signal,
      ),
    ).rejects.toMatchObject({ code: "busy" });
    await h.close();
  });

  it("reports usage as incomplete while a native run is active, with its pending turns", async () => {
    const native = oneToolCallRun();
    const h = createRestrictedCodexParticipant();
    expect(h.provider.interactionUsageIncomplete).toBe(false);
    await h.provider.nextTurn(request(), new AbortController().signal);
    expect(h.provider.interactionUsageIncomplete).toBe(true);
    metadata.pendingUsage = { input: 7, output: 2 };
    metadata.pendingInferenceUsage = [{ input: 7, output: 2 }];
    expect(h.provider.pendingRequestUsage).toEqual({
      input: 7,
      output: 2,
      turns: [{ input: 7, output: 2 }],
    });
    native.finish(result());
    await h.close();
  });

  it("keeps the conversation's instructions without rereading a later request's", async () => {
    run.mockResolvedValueOnce(result()).mockResolvedValueOnce(result());
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;
    const base = request();
    await h.provider.nextTurn(base, signal);
    // Admission reads instructions three times; a fourth read would see the changed value.
    let reads = 0;
    const later = {
      ...request(),
      get instructions() {
        return ++reads <= 3 ? base.instructions : "Changed after admission.";
      },
    };
    await h.provider.nextTurn(later, signal);
    const sent = run.mock.calls[1]![0].instructions;
    expect(sent).toContain(base.instructions);
    expect(sent).not.toContain("Changed after admission.");
    await h.close();
  });

  it("refuses a request as busy while the native run is active and no tool call waits", async () => {
    const native = oneToolCallRun();
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;
    await h.provider.nextTurn(request(), signal);
    // Admission reads previousExecution once; the tool reply's reread throws after the waiting
    // tool call was taken, so that request fails and the native run stays active.
    let reads = 0;
    const acknowledging = {
      ...request(),
      get previousExecution() {
        if (++reads > 1) throw new Error("synthetic acknowledgment read failure");
        return { actions: [{ index: 0, status: "completed" as const }] };
      },
    };
    await expect(h.provider.nextTurn(acknowledging, signal)).rejects.toThrow(
      "synthetic acknowledgment read failure",
    );
    await expect(h.provider.nextTurn(request(), signal)).rejects.toMatchObject({
      code: "busy",
      receipt: { dispatched: false, usageComplete: false, cleanup: "confirmed" },
    });
    native.finish(result());
    await h.close();
  });
});
