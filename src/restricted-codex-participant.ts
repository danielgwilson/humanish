import type { ActorTokenUsage, ProviderRequestReceipt } from "./actor-contract.js";
import type { CuaProvider, CuaTurn, CuaTurnRequest } from "./computer-use.js";
import { CuaProviderError, isCuaProviderError, type CuaProviderErrorCode } from "./cua-provider-error.js";
import { validateBrowserControlPng, validateHeardSpeech } from "./browser-control-protocol.js";
import { createRestrictedCodexSession, type RestrictedCodexSessionOptions } from "./restricted-codex-session.js";
import type { RestrictedCodexAnalysisErrorCode, RestrictedCodexResult } from "./restricted-codex-policy.js";
import type { ReasoningEffort } from "./reasoning-effort.js";
import { PARTICIPANT_PROFILE, PARTICIPANT_LIMITS as L, PARTICIPANT_FINAL_SCHEMA,
  participantToolSchema, parseParticipantTool, parseParticipantFinal } from "./restricted-codex-participant-policy.js";

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
  if (code === "cancelled" || code === "timeout" || code === "refusal") return code === "refusal" ? "refused" : code;
  if (code === "codex_cleanup_failed") return "cleanup_unconfirmed";
  if (code === "codex_busy") return "busy";
  if (code === "codex_protocol_error" || code === "codex_tool_call") return "protocol_error";
  if (code === "invalid_response" || code === "response_too_large" || code === "output_incomplete") return "invalid_response";
  if (code === "invalid_request") return "request_rejected";
  if (code === "codex_process_failed") return "process_failed";
  return "unavailable";
};
const noDispatch = (): ProviderRequestReceipt => ({ dispatched: false, usageComplete: false, cleanup: "confirmed" });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A native request can settle during executor work or shutdown, between consumers.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const toolDescription = (speechEnabled: boolean): string => `Act on the participant's browser through Humanish. Submit one to four UI actions${speechEnabled ? ", including speak when you need to reply aloud," : ""} and a short public comment; never private reasoning. Humanish returns a JSON STRING with execution acknowledgments${speechEnabled ? ", speech heard from the actual participant speaker sink," : ""} and a fresh screenshot. In Code Mode use: const r = JSON.parse(await tools.humanish_ui({narration: "...", actions: [...]})); text({acknowledgments: r.acknowledgments${speechEnabled ? ", heardSpeech: r.heardSpeech" : ""}, contextHint: r.contextHint, closing: r.closing}); image(r.imageUrl). Call serially and inspect each returned screenshot${speechEnabled ? " and heardSpeech array" : ""} before deciding what to do next.${speechEnabled ? " Use speak only after the visible UI shows that you joined the call and your microphone is unmuted; it sends audio into that call." : ""} Acknowledged input does not prove an application outcome. If closing is true, stop calling tools and give your final account.`;

/** One native tool-calling conversation; the existing CUA loop owns every input. */
export function createRestrictedCodexParticipant(options: RestrictedParticipantOptions = {}): {
  provider: CuaProvider; close(): Promise<ParticipantProviderCloseResult>;
} {
  const timeoutMs = options.requestTimeoutMs ?? L.requestMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > L.requestMs) throw new CuaProviderError("request_rejected", noDispatch());
  const operator = options.authMode === "operator";
  const speechEnabled = options.speechEnabled === true;
  const model = options.model ?? (operator ? undefined : PARTICIPANT_PROFILE.requestedModel);
  const effort = options.reasoningEffort ?? "low";
  let closed = false, failedCleanup = false, incompleteUsage = false, active = false, closingPhase = false;
  let instructions: string | undefined, lastActionCount: number | undefined;
  let continuation: ReturnType<typeof deferred<string>> | undefined;
  type Event = { turn: CuaTurn } | { error: CuaProviderError };
  const events: Event[] = [];
  let waiter: ReturnType<typeof deferred<Event>> | undefined;
  const emit = (event: Event): void => {
    if (waiter) { const current = waiter; waiter = undefined; current.resolve(event); }
    else events.push(event);
  };
  const nextEvent = async (): Promise<CuaTurn> => {
    const event = events.shift() ?? await (waiter ??= deferred<Event>()).promise;
    if ("error" in event) throw event.error;
    return event.turn;
  };
  let nativeTask: Promise<void> | undefined, pending: Promise<CuaTurn> | undefined;
  let controller: AbortController | undefined;
  let sessionClosing: Promise<boolean> | undefined, closing: Promise<ParticipantProviderCloseResult> | undefined;
  let abortAt: number | undefined;
  const session = createRestrictedCodexSession({ ...options.session, participant: {
    ...(operator ? { authMode: "operator" as const } : {}), reasoningEffort: effort,
    tool: { name: "humanish_ui", description: toolDescription(speechEnabled), inputSchema: participantToolSchema(speechEnabled),
      async call(args) {
        if (closed || closingPhase || continuation || !active) throw new Error("Unexpected participant tool call");
        const turn = parseParticipantTool(args, speechEnabled);
        const reply = deferred<string>(); continuation = reply; lastActionCount = turn.actions.length;
        emit({ turn });
        return reply.promise;
      } }
  } });
  const closeSession = (): Promise<boolean> => sessionClosing ??= Promise.resolve().then(() => session.close()).catch(() => false).then(confirmed => {
    if (!confirmed) failedCleanup = true;
    return confirmed;
  });
  const revoke = (): void => {
    closed = true; abortAt ??= performance.now();
    controller?.abort();
    continuation?.reject(new Error("Participant closed")); continuation = undefined;
    void closeSession();
  };
  function launch(req: CuaTurnRequest, imageUrl: string): void {
    active = true; controller = new AbortController();
    nativeTask = (async () => {
      let receipt = noDispatch(), usage: ActorTokenUsage | undefined;
      try {
        const result: RestrictedCodexResult = await session.run({ ...(model === undefined ? {} : { model }),
          instructions: `${instructions}\n\nYou are the study participant throughout this conversation, including its closing account. Use only the supplied screenshots and humanish_ui tool to interact. The tool returns a JSON string: parse it, inspect acknowledgments${speechEnabled ? " and heardSpeech captured from the actual participant speaker sink" : ""}, and display imageUrl with Code Mode image(). Do not print the image data URL as text. Keep your persona and earlier observations throughout the session.${speechEnabled ? " A speak action plays into the participant microphone; use it only after the visible UI shows that you joined the call and the microphone is unmuted." : ""} Speak publicly about your experience, never reveal private reasoning. Completed inputs do not prove application outcomes; verify on the next screenshot. When the task ends, return only the required final JSON with outcome, summary and frictionReports. Report observed confusion and recovered mistakes as well as blockers. Do not invent observations.`,
          evidence: JSON.stringify({ phase: closingPhase ? "closing" : "interaction", contextHint: req.contextHint ?? null,
            instruction: closingPhase ? "Interaction has ended. Do not call tools; give your closing account."
              : "Use humanish_ui to act. Inspect each result before choosing the next batch. Finish when appropriate.",
            width: req.observation.screenshot!.readUInt32BE(16), height: req.observation.screenshot!.readUInt32BE(20),
            previousExecution: req.previousExecution ?? null,
            ...(speechEnabled ? { heardSpeech: req.observation.heardSpeech ?? [] } : {}) }),
          images: [{ evidenceId: "current-frame", dataUrl: imageUrl }], schema: PARTICIPANT_FINAL_SCHEMA,
          maxOutputTokens: null, timeoutMs, signal: controller!.signal });
        receipt = { dispatched: result.dispatched, usageComplete: result.usageComplete,
          cleanup: result.errorCode === "codex_cleanup_failed" ? "unconfirmed" : "confirmed" };
        usage = result.usage ?? undefined;
        if (result.dispatched && !result.usageComplete) incompleteUsage = true;
        if (receipt.cleanup === "unconfirmed") failedCleanup = true;
        if (closed || controller!.signal.aborted) throw new CuaProviderError(failedCleanup ? "cleanup_unconfirmed" : "cancelled", receipt, usage, result.failurePhase);
        if (result.status !== "completed" || result.errorCode !== null) throw new CuaProviderError(codeOf(result.errorCode), receipt, usage, result.failurePhase);
        let turn: CuaTurn;
        try { turn = parseParticipantFinal(result.output); }
        catch { throw new CuaProviderError("invalid_response", receipt, usage, "response"); }
        emit({ turn: { ...turn, ...(usage === undefined ? {} : { usage: { ...usage, turns: result.inferenceUsage ?? [] } }), providerRequest: receipt } });
      } catch (error) {
        incompleteUsage ||= receipt.dispatched !== false && !receipt.usageComplete;
        revoke();
        emit({ error: isCuaProviderError(error) ? error
          : new CuaProviderError("process_failed", { dispatched: "unknown", usageComplete: false, cleanup: "unconfirmed" }, usage) });
      } finally { active = false; }
    })();
  }
  async function execute(req: CuaTurnRequest, signal: AbortSignal, debrief: boolean): Promise<CuaTurn> {
    if (events.length) return nextEvent();
    if (signal.aborted) { revoke(); throw new CuaProviderError("cancelled", noDispatch()); }
    if (typeof req.instructions !== "string" || Buffer.byteLength(req.instructions) > L.instructions ||
      (req.contextHint !== undefined && (typeof req.contextHint !== "string" || Buffer.byteLength(req.contextHint) > L.hint)) ||
      req.previousResponseId !== undefined || (req.acknowledgedSafetyChecks?.length ?? 0) > 0 ||
      (instructions !== undefined && instructions !== req.instructions)) throw new CuaProviderError("request_rejected", noDispatch());
    const frame = req.observation.screenshot;
    try { if (!Buffer.isBuffer(frame)) throw new Error(); validateBrowserControlPng(frame); }
    catch { throw new CuaProviderError("request_rejected", noDispatch()); }
    if (req.observation.heardSpeech !== undefined) {
      if (!speechEnabled) throw new CuaProviderError("request_rejected", noDispatch());
      try { validateHeardSpeech(req.observation.heardSpeech); }
      catch { throw new CuaProviderError("request_rejected", noDispatch()); }
    }
    const acknowledgments = req.previousExecution?.actions;
    if ((continuation && acknowledgments === undefined) || (acknowledgments !== undefined &&
      (lastActionCount === undefined || !Array.isArray(acknowledgments) || acknowledgments.length !== lastActionCount ||
        acknowledgments.some((a, i) => !a || a.index !== i || !["completed", "skipped", "not_dispatched", "outcome_uncertain"].includes(a.status))))) {
      throw new CuaProviderError("request_rejected", noDispatch());
    }
    const onAbort = (): void => { revoke(); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      instructions ??= req.instructions; closingPhase = debrief;
      const imageUrl = `data:image/png;base64,${frame!.toString("base64")}`;
      if (continuation) {
        const reply = continuation; continuation = undefined;
        reply.resolve(JSON.stringify({ acknowledgments: acknowledgments!.map(({ index, status }) => ({ index, status })), imageUrl,
          ...(speechEnabled ? { heardSpeech: req.observation.heardSpeech ?? [] } : {}),
          contextHint: req.contextHint ?? null, closing: debrief }));
      } else if (!active) launch(req, imageUrl);
      else throw new CuaProviderError("busy", noDispatch());
      return await nextEvent();
    } finally {
      // The shared loop aborts each request's signal after it yields. The native
      // turn must remain alive while Humanish executes and records its actions.
      signal.removeEventListener("abort", onAbort);
    }
  }
  const start = (req: CuaTurnRequest, signal: AbortSignal, debrief: boolean): Promise<CuaTurn> => {
    if (closed && events.length === 0) return Promise.reject(new CuaProviderError("request_rejected", noDispatch()));
    if (pending) return Promise.reject(new CuaProviderError("busy", noDispatch()));
    const task = execute(req, signal, debrief); pending = task;
    void task.finally(() => { if (pending === task) pending = undefined; }).catch(() => undefined);
    return task;
  };
  const provider: CuaProvider = {
    id: "codex-participant", requiresFrame: true, requestPolicy: "fail_closed",
    get version() { return session.resolvedModel ?? model; },
    get executionProfile() {
      if (!operator) return PARTICIPANT_PROFILE;
      return session.authentication === "chatgpt-account" && session.resolvedModel
        ? { ...PARTICIPANT_PROFILE, requestedModel: session.resolvedModel, reasoningEffort: effort } : undefined;
    },
    modelSettings: { reasoningEffort: effort },
    capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: true, byoModel: operator,
      preGrantableApprovals: false, inProcessTools: false, license: "proprietary" },
    get pendingRequestUsage() {
      const usage = session.pendingUsage;
      return usage === undefined ? undefined : { ...usage, turns: session.pendingInferenceUsage ?? [] };
    },
    get interactionUsageIncomplete() { return incompleteUsage || active; }, get historyTurnsOmitted() { return 0; },
    nextTurn: (req, signal) => start(req, signal, false), debrief: (req, signal) => start(req, signal, true)
  };
  return { provider, close: () => {
    if (closing) return closing;
    revoke();
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const confirmed = await Promise.race([Promise.all([nativeTask, closeSession()]).then(([, ok]) => ok),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, L.cleanupMs - (performance.now() - abortAt!))); })]);
        if (!confirmed) failedCleanup = true;
        return { status: failedCleanup ? "unconfirmed" : "confirmed" } as ParticipantProviderCloseResult;
      } finally { clearTimeout(timer); }
    })();
    return closing;
  } };
}
