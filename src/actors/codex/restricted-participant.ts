import {
  isRecordedCodexCliVersion,
  type ActorCapabilities,
  type ActorExecutionProfile,
  type ActorTokenUsage,
  type ProviderRequestReceipt,
} from "../contract.js";
import { defaultCodexCliVersion } from "./qualified-versions.js";
import type { CuaProvider, CuaTurn, CuaTurnRequest } from "../computer-use/loop.js";
import {
  CuaProviderError,
  isCuaProviderError,
  type CuaProviderErrorCode,
} from "../computer-use/provider-error.js";
import { validateBrowserControlPng, validateHeardSpeech } from "../../browser-control/protocol.js";
import {
  createRestrictedCodexSession,
  type RestrictedCodexSession,
  type RestrictedCodexSessionOptions,
} from "./restricted-session.js";
import type {
  RestrictedCodexAnalysisErrorCode,
  RestrictedCodexRequest,
  RestrictedCodexResult,
} from "./restricted-policy.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import {
  PARTICIPANT_PROFILE,
  PARTICIPANT_LIMITS as L,
  PARTICIPANT_FINAL_SCHEMA,
  participantToolSchema,
  parseParticipantTool,
  parseParticipantFinal,
} from "./restricted-participant-policy.js";

export type ParticipantProviderCloseResult = { status: "confirmed" | "unconfirmed" };
export interface RestrictedParticipantOptions {
  session?: RestrictedCodexSessionOptions;
  requestTimeoutMs?: number;
  authMode?: "operator";
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Admit speech actions and heard-speaker evidence for a speech-capable desktop only. */
  speechEnabled?: boolean;
}
const codeOf = (code: RestrictedCodexAnalysisErrorCode | null): CuaProviderErrorCode => {
  if (code === "cancelled" || code === "timeout" || code === "refusal")
    return code === "refusal" ? "refused" : code;
  if (code === "codex_cleanup_failed") return "cleanup_unconfirmed";
  if (code === "codex_busy") return "busy";
  if (code === "codex_protocol_error" || code === "codex_tool_call") return "protocol_error";
  if (code === "invalid_response" || code === "response_too_large" || code === "output_incomplete")
    return "invalid_response";
  if (code === "invalid_request") return "request_rejected";
  if (code === "codex_process_failed") return "process_failed";
  return "unavailable";
};
const noDispatch = (): ProviderRequestReceipt => ({
  dispatched: false,
  usageComplete: false,
  cleanup: "confirmed",
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A native request can settle during executor work or shutdown, between consumers.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const toolDescription = (speechEnabled: boolean): string =>
  `Act on the participant's browser through humanish. Submit one to four UI actions${speechEnabled ? ", including speak when you need to reply aloud," : ""} and a short public comment; never private reasoning. humanish returns a JSON STRING with execution acknowledgments${speechEnabled ? ", speech heard from the actual participant speaker sink," : ""} and a fresh screenshot. In Code Mode use: const r = JSON.parse(await tools.humanish_ui({narration: "...", actions: [...]})); text({acknowledgments: r.acknowledgments${speechEnabled ? ", heardSpeech: r.heardSpeech" : ""}, contextHint: r.contextHint, closing: r.closing}); image(r.imageUrl). Call serially and inspect each returned screenshot${speechEnabled ? " and heardSpeech array" : ""} before deciding what to do next.${speechEnabled ? " Use speak only after the visible UI shows that you joined the call and your microphone is unmuted; it sends audio into that call." : ""} Acknowledged input does not prove an application outcome. If closing is true, stop calling tools and give your final account.`;

const participantInstructions = (study: string, speechEnabled: boolean): string =>
  `${study}\n\nYou are the study participant throughout this conversation, including its closing account. Use only the supplied screenshots and humanish_ui tool to interact. The tool returns a JSON string: parse it, inspect acknowledgments${speechEnabled ? " and heardSpeech captured from the actual participant speaker sink" : ""}, and display imageUrl with Code Mode image(). Do not print the image data URL as text. Keep your persona and earlier observations throughout the session.${speechEnabled ? " A speak action plays into the participant microphone; use it only after the visible UI shows that you joined the call and the microphone is unmuted." : ""} Speak publicly about your experience, never reveal private reasoning. Completed inputs do not prove application outcomes; verify on the next screenshot. When the task ends, return only the required final JSON with outcome, summary and frictionReports. Report observed confusion and recovered mistakes as well as blockers. Do not invent observations.`;

type ParticipantEvent = { turn: CuaTurn } | { error: CuaProviderError };
/** Turns and failures from the native run, handed in order to the next provider request. */
class ParticipantEvents {
  private readonly queued: ParticipantEvent[] = [];
  private waiter: ReturnType<typeof deferred<ParticipantEvent>> | undefined;
  get waiting(): boolean {
    return this.queued.length > 0;
  }
  emit(event: ParticipantEvent): void {
    if (this.waiter) {
      const current = this.waiter;
      this.waiter = undefined;
      current.resolve(event);
    } else this.queued.push(event);
  }
  async next(): Promise<CuaTurn> {
    const event =
      this.queued.shift() ?? (await (this.waiter ??= deferred<ParticipantEvent>()).promise);
    if ("error" in event) throw event.error;
    return event.turn;
  }
}

/** What a request must agree with: the conversation so far. */
interface ParticipantConversation {
  instructions: string | undefined;
  speechEnabled: boolean;
  /** A native tool call is waiting for this request's acknowledgments. */
  awaitingAcknowledgments: boolean;
  lastActionCount: number | undefined;
}
const ACKNOWLEDGMENT_STATUSES = ["completed", "skipped", "not_dispatched", "outcome_uncertain"];
/**
 * Request validation: true when the request may not enter the conversation. Each case is refused
 * as request_rejected before anything is dispatched.
 */
function rejectsParticipantRequest(
  req: CuaTurnRequest,
  conversation: ParticipantConversation,
): boolean {
  if (
    typeof req.instructions !== "string" ||
    Buffer.byteLength(req.instructions) > L.instructions ||
    (req.contextHint !== undefined &&
      (typeof req.contextHint !== "string" || Buffer.byteLength(req.contextHint) > L.hint)) ||
    req.previousResponseId !== undefined ||
    (req.acknowledgedSafetyChecks?.length ?? 0) > 0 ||
    (conversation.instructions !== undefined && conversation.instructions !== req.instructions)
  )
    return true;
  const frame = req.observation.screenshot;
  try {
    if (!Buffer.isBuffer(frame)) throw new Error();
    validateBrowserControlPng(frame);
  } catch {
    return true;
  }
  if (req.observation.heardSpeech !== undefined) {
    if (!conversation.speechEnabled) return true;
    try {
      validateHeardSpeech(req.observation.heardSpeech);
    } catch {
      return true;
    }
  }
  const acknowledgments = req.previousExecution?.actions;
  return (
    (conversation.awaitingAcknowledgments && acknowledgments === undefined) ||
    (acknowledgments !== undefined &&
      (conversation.lastActionCount === undefined ||
        !Array.isArray(acknowledgments) ||
        acknowledgments.length !== conversation.lastActionCount ||
        acknowledgments.some(
          (a, i) => !a || a.index !== i || !ACKNOWLEDGMENT_STATUSES.includes(a.status),
        )))
  );
}

/** Launch: the one native run a batch of tool calls and its final account share. */
function participantRunRequest(
  req: CuaTurnRequest,
  run: {
    instructions: string;
    closing: boolean;
    speechEnabled: boolean;
    model: string | undefined;
    imageUrl: string;
    timeoutMs: number;
    signal: AbortSignal;
  },
): RestrictedCodexRequest {
  return {
    ...(run.model === undefined ? {} : { model: run.model }),
    instructions: participantInstructions(run.instructions, run.speechEnabled),
    evidence: JSON.stringify({
      phase: run.closing ? "closing" : "interaction",
      contextHint: req.contextHint ?? null,
      instruction: run.closing
        ? "Interaction has ended. Do not call tools; give your closing account."
        : "Use humanish_ui to act. Inspect each result before choosing the next batch. Finish when appropriate.",
      width: req.observation.screenshot!.readUInt32BE(16),
      height: req.observation.screenshot!.readUInt32BE(20),
      previousExecution: req.previousExecution ?? null,
      ...(run.speechEnabled ? { heardSpeech: req.observation.heardSpeech ?? [] } : {}),
    }),
    images: [{ evidenceId: "current-frame", dataUrl: run.imageUrl }],
    schema: PARTICIPANT_FINAL_SCHEMA,
    maxOutputTokens: null,
    timeoutMs: run.timeoutMs,
    signal: run.signal,
  };
}

/** Turn dispatch: the tool result that answers a waiting native tool call. */
function toolReply(
  req: CuaTurnRequest,
  imageUrl: string,
  speechEnabled: boolean,
  closing: boolean,
): string {
  return JSON.stringify({
    acknowledgments: req.previousExecution!.actions.map(({ index, status }) => ({ index, status })),
    imageUrl,
    ...(speechEnabled ? { heardSpeech: req.observation.heardSpeech ?? [] } : {}),
    contextHint: req.contextHint ?? null,
    closing,
  });
}

/** Receipt: what a native run's result records, whatever its outcome. */
const runReceipt = (result: RestrictedCodexResult): ProviderRequestReceipt => ({
  dispatched: result.dispatched,
  usageComplete: result.usageComplete,
  cleanup: result.errorCode === "codex_cleanup_failed" ? "unconfirmed" : "confirmed",
});
/**
 * The final turn a native run's result yields, or the error it fails with. A run that ends after
 * the participant stopped fails as cancelled, or cleanup_unconfirmed once cleanup failed.
 */
function finalTurn(
  result: RestrictedCodexResult,
  receipt: ProviderRequestReceipt,
  usage: ActorTokenUsage | undefined,
  stopped: { stopped: boolean; failedCleanup: boolean },
): CuaTurn {
  if (stopped.stopped)
    throw new CuaProviderError(
      stopped.failedCleanup ? "cleanup_unconfirmed" : "cancelled",
      receipt,
      usage,
      result.failurePhase,
    );
  if (result.status !== "completed" || result.errorCode !== null)
    throw new CuaProviderError(codeOf(result.errorCode), receipt, usage, result.failurePhase);
  let turn: CuaTurn;
  try {
    turn = parseParticipantFinal(result.output);
  } catch {
    throw new CuaProviderError("invalid_response", receipt, usage, "response");
  }
  return {
    ...turn,
    ...(usage === undefined ? {} : { usage: { ...usage, turns: result.inferenceUsage ?? [] } }),
    providerRequest: receipt,
  };
}

/** Drain: resolves false when the work outlasts the cleanup budget counted from the abort. */
async function withinCleanupBudget(work: Promise<boolean>, abortAt: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<false>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          Math.max(0, L.cleanupMs - (performance.now() - abortAt)),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The session whose one tool, humanish_ui, hands each native tool call to `call`. */
function participantSession(
  options: RestrictedParticipantOptions,
  speechEnabled: boolean,
  effort: ReasoningEffort,
  call: (args: unknown) => Promise<string>,
): RestrictedCodexSession {
  return createRestrictedCodexSession({
    ...options.session,
    participant: {
      ...(options.authMode === "operator" ? { authMode: "operator" as const } : {}),
      reasoningEffort: effort,
      tool: {
        name: "humanish_ui",
        description: toolDescription(speechEnabled),
        inputSchema: participantToolSchema(speechEnabled),
        call,
      },
    },
  });
}
/**
 * The profile a run records: the detected release, or the host default before the first launch.
 * An operator-auth session has one only once it resolved a model on a ChatGPT account.
 */
function participantExecutionProfile(
  session: RestrictedCodexSession,
  operator: boolean,
  effort: ReasoningEffort,
): ActorExecutionProfile | undefined {
  const detected = session.cliVersion;
  const cliVersion = isRecordedCodexCliVersion(detected) ? detected : defaultCodexCliVersion();
  if (!operator) return { ...PARTICIPANT_PROFILE, cliVersion };
  return session.authentication === "chatgpt-account" && session.resolvedModel
    ? {
        ...PARTICIPANT_PROFILE,
        cliVersion,
        requestedModel: session.resolvedModel,
        reasoningEffort: effort,
      }
    : undefined;
}
const participantCapabilities = (operator: boolean): ActorCapabilities => ({
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: operator,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "proprietary",
});

/** One native tool-calling conversation; the existing CUA loop owns every input. */
export function createRestrictedCodexParticipant(options: RestrictedParticipantOptions = {}): {
  provider: CuaProvider;
  close(): Promise<ParticipantProviderCloseResult>;
} {
  const timeoutMs = options.requestTimeoutMs ?? L.requestMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > L.requestMs)
    throw new CuaProviderError("request_rejected", noDispatch());
  const operator = options.authMode === "operator";
  const speechEnabled = options.speechEnabled === true;
  const model = options.model ?? (operator ? undefined : PARTICIPANT_PROFILE.requestedModel);
  const effort = options.reasoningEffort ?? "low";
  let closed = false,
    failedCleanup = false,
    incompleteUsage = false,
    active = false,
    closingPhase = false;
  let instructions: string | undefined, lastActionCount: number | undefined;
  let continuation: ReturnType<typeof deferred<string>> | undefined;
  const events = new ParticipantEvents();
  let nativeTask: Promise<void> | undefined, pending: Promise<CuaTurn> | undefined;
  let controller: AbortController | undefined;
  let sessionClosing: Promise<boolean> | undefined,
    closing: Promise<ParticipantProviderCloseResult> | undefined;
  let abortAt: number | undefined;
  const session = participantSession(options, speechEnabled, effort, async (args) => {
    if (closed || closingPhase || continuation || !active)
      throw new Error("Unexpected participant tool call");
    const turn = parseParticipantTool(args, speechEnabled);
    const reply = deferred<string>();
    continuation = reply;
    lastActionCount = turn.actions.length;
    events.emit({ turn });
    return reply.promise;
  });
  const closeSession = (): Promise<boolean> =>
    (sessionClosing ??= Promise.resolve()
      .then(() => session.close())
      .catch(() => false)
      .then((confirmed) => {
        if (!confirmed) failedCleanup = true;
        return confirmed;
      }));
  const revoke = (): void => {
    closed = true;
    abortAt ??= performance.now();
    controller?.abort();
    continuation?.reject(new Error("Participant closed"));
    continuation = undefined;
    void closeSession();
  };
  function launch(req: CuaTurnRequest, imageUrl: string): void {
    active = true;
    const signal = (controller = new AbortController()).signal;
    nativeTask = (async () => {
      let receipt = noDispatch(),
        usage: ActorTokenUsage | undefined;
      try {
        const result = await session.run(
          participantRunRequest(req, {
            instructions: instructions!,
            closing: closingPhase,
            speechEnabled,
            model,
            imageUrl,
            timeoutMs,
            signal,
          }),
        );
        receipt = runReceipt(result);
        usage = result.usage ?? undefined;
        if (result.dispatched && !result.usageComplete) incompleteUsage = true;
        if (receipt.cleanup === "unconfirmed") failedCleanup = true;
        const stopped = closed || signal.aborted;
        events.emit({ turn: finalTurn(result, receipt, usage, { stopped, failedCleanup }) });
      } catch (error) {
        incompleteUsage ||= receipt.dispatched !== false && !receipt.usageComplete;
        revoke();
        events.emit({
          error: isCuaProviderError(error)
            ? error
            : new CuaProviderError(
                "process_failed",
                { dispatched: "unknown", usageComplete: false, cleanup: "unconfirmed" },
                usage,
              ),
        });
      } finally {
        active = false;
      }
    })();
  }
  async function execute(
    req: CuaTurnRequest,
    signal: AbortSignal,
    debrief: boolean,
  ): Promise<CuaTurn> {
    if (events.waiting) return events.next();
    if (signal.aborted) {
      revoke();
      throw new CuaProviderError("cancelled", noDispatch());
    }
    const conversation = {
      instructions,
      speechEnabled,
      awaitingAcknowledgments: continuation !== undefined,
      lastActionCount,
    };
    if (rejectsParticipantRequest(req, conversation))
      throw new CuaProviderError("request_rejected", noDispatch());
    const onAbort = (): void => {
      revoke();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      instructions ??= req.instructions;
      closingPhase = debrief;
      const imageUrl = `data:image/png;base64,${req.observation.screenshot!.toString("base64")}`;
      if (continuation) {
        const reply = continuation;
        continuation = undefined;
        reply.resolve(toolReply(req, imageUrl, speechEnabled, debrief));
      } else if (!active) launch(req, imageUrl);
      else throw new CuaProviderError("busy", noDispatch());
      return await events.next();
    } finally {
      // The shared loop aborts each request's signal after it yields. The native
      // turn must remain alive while humanish executes and records its actions.
      signal.removeEventListener("abort", onAbort);
    }
  }
  const start = (req: CuaTurnRequest, signal: AbortSignal, debrief: boolean): Promise<CuaTurn> => {
    if (closed && !events.waiting)
      return Promise.reject(new CuaProviderError("request_rejected", noDispatch()));
    if (pending) return Promise.reject(new CuaProviderError("busy", noDispatch()));
    const task = execute(req, signal, debrief);
    pending = task;
    void task
      .finally(() => {
        if (pending === task) pending = undefined;
      })
      .catch(() => undefined);
    return task;
  };
  const provider: CuaProvider = {
    id: "codex-participant",
    requiresFrame: true,
    requestPolicy: "fail_closed",
    get version() {
      return session.resolvedModel ?? model;
    },
    get executionProfile() {
      return participantExecutionProfile(session, operator, effort);
    },
    modelSettings: { reasoningEffort: effort },
    capabilities: participantCapabilities(operator),
    get pendingRequestUsage() {
      const usage = session.pendingUsage;
      return usage === undefined
        ? undefined
        : { ...usage, turns: session.pendingInferenceUsage ?? [] };
    },
    get interactionUsageIncomplete() {
      return incompleteUsage || active;
    },
    get historyTurnsOmitted() {
      return 0;
    },
    nextTurn: (req, signal) => start(req, signal, false),
    debrief: (req, signal) => start(req, signal, true),
  };
  return {
    provider,
    close: () => {
      if (closing) return closing;
      revoke();
      closing = (async () => {
        const work = Promise.all([nativeTask, closeSession()]).then(([, ok]) => ok);
        if (!(await withinCleanupBudget(work, abortAt!))) failedCleanup = true;
        return { status: failedCleanup ? "unconfirmed" : "confirmed" };
      })();
      return closing;
    },
  };
}
