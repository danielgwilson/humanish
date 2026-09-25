import type { ActorTokenUsage, ProviderRequestReceipt } from "./actor-contract.js";
import type { CuaProvider, CuaTurn, CuaTurnRequest } from "./computer-use.js";
import { CuaProviderError, isCuaProviderError, type CuaProviderErrorCode } from "./cua-provider-error.js";
import { validateBrowserControlPng } from "./browser-control-protocol.js";
import { createRestrictedCodexSession, type RestrictedCodexSessionOptions } from "./restricted-codex-session.js";
import type { RestrictedCodexAnalysisErrorCode, RestrictedCodexResult } from "./restricted-codex-policy.js";
import { PARTICIPANT_PROFILE, PARTICIPANT_LIMITS as L, PARTICIPANT_TURN_SCHEMA, PARTICIPANT_CLOSING_SCHEMA,
  parseParticipantTurn, parseParticipantClosing } from "./restricted-codex-participant-policy.js";

export type ParticipantProviderCloseResult = { status: "confirmed" | "unconfirmed" };
export interface RestrictedParticipantOptions { session?: RestrictedCodexSessionOptions; requestTimeoutMs?: number }
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

/** One continuing participant conversation over an already-owned executor. */
export function createRestrictedCodexParticipant(options: RestrictedParticipantOptions = {}): {
  provider: CuaProvider; close(): Promise<ParticipantProviderCloseResult>;
} {
  const timeoutMs = options.requestTimeoutMs ?? L.requestMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > L.requestMs) throw new CuaProviderError("request_rejected", noDispatch());
  const session = createRestrictedCodexSession(options.session);
  let closed = false, failedCleanup = false, incompleteUsage = false;
  let instructions: string | undefined;
  let lastActionCount: number | undefined;
  let sessionClosing: Promise<boolean> | undefined;
  let sessionSettled = false;
  let controller: AbortController | undefined;
  let pending: Promise<CuaTurn> | undefined;
  let closing: Promise<ParticipantProviderCloseResult> | undefined;
  let abortAt: number | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSession = (): Promise<boolean> => sessionClosing ??= Promise.resolve().then(() => session.close()).catch(() => false).then(confirmed => {
    sessionSettled = true;
    if (!confirmed) failedCleanup = true;
    return confirmed;
  });
  const revoke = (): void => {
    closed = true;
    abortAt ??= performance.now();
    controller?.abort();
    void closeSession();
    cleanupTimer ??= setTimeout(() => { if (pending || !sessionSettled) failedCleanup = true; }, Math.max(0, L.cleanupMs - (performance.now() - abortAt)));
  };
  async function execute(req: CuaTurnRequest, signal: AbortSignal, debrief: boolean, own: AbortController): Promise<CuaTurn> {
    let receipt = noDispatch();
    let usage: ActorTokenUsage | undefined;
    const onAbort = (): void => { revoke(); own.abort(); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      if (own.signal.aborted || closed) throw new CuaProviderError("cancelled", receipt);
      if (typeof req.instructions !== "string" || Buffer.byteLength(req.instructions) > L.instructions ||
        (req.contextHint !== undefined && (typeof req.contextHint !== "string" || Buffer.byteLength(req.contextHint) > L.hint)) ||
        req.previousResponseId !== undefined || (req.acknowledgedSafetyChecks?.length ?? 0) > 0 ||
        (instructions !== undefined && instructions !== req.instructions)) throw new CuaProviderError("request_rejected", receipt);
      const frame = req.observation.screenshot;
      try { if (!Buffer.isBuffer(frame)) throw new Error(); validateBrowserControlPng(frame); }
      catch { throw new CuaProviderError("request_rejected", receipt); }
      let previousExecution: CuaTurnRequest["previousExecution"];
      if (req.previousExecution !== undefined) {
        const actions = req.previousExecution?.actions;
        if (lastActionCount === undefined || !Array.isArray(actions) || actions.length !== lastActionCount || actions.some((a, i) =>
          !a || a.index !== i || !["completed", "skipped", "not_dispatched", "outcome_uncertain"].includes(a.status))) {
          throw new CuaProviderError("request_rejected", receipt);
        }
        previousExecution = { actions: actions.map(({ index, status }) => ({ index, status })) };
      }
      instructions ??= req.instructions;
      const result: RestrictedCodexResult = await session.run({ model: PARTICIPANT_PROFILE.requestedModel,
        instructions: `${instructions}\n\nYou are the study participant throughout this conversation, including its closing account. Use the screenshots, your conversation history and explicit input acknowledgments. Describe your experience as public participant speech, never private reasoning. Earlier proposals and completed inputs are not independent proof of their application outcomes. Preserve uncertainty and do not invent observations. Never use tools or request integrations. Follow the current phase instruction and supplied JSON schema.`,
        evidence: JSON.stringify({ phase: debrief ? "closing" : "interaction",
          instruction: debrief ? "The interaction has ended. Give only a closing summary and frictionReports about what you observed; do not propose actions."
            : "Continue with one to four browser actions, or explicitly finish with no actions and your outcome.",
          width: frame!.readUInt32BE(16), height: frame!.readUInt32BE(20),
          contextHint: req.contextHint ?? null, memoryPolicy: PARTICIPANT_PROFILE.memoryPolicy, previousExecution: previousExecution ?? null }),
        images: [{ evidenceId: "current-frame", dataUrl: `data:image/png;base64,${frame!.toString("base64")}` }],
        schema: debrief ? PARTICIPANT_CLOSING_SCHEMA : PARTICIPANT_TURN_SCHEMA, maxOutputTokens: null, timeoutMs, signal: own.signal
      });
      receipt = { dispatched: result.dispatched, usageComplete: result.usageComplete,
        cleanup: result.errorCode === "codex_cleanup_failed" ? "unconfirmed" : "confirmed" };
      usage = result.usage ?? undefined;
      if (receipt.cleanup === "unconfirmed") { failedCleanup = true; revoke(); }
      if (result.dispatched && !result.usageComplete && !debrief) incompleteUsage = true;
      if (closed || own.signal.aborted) throw new CuaProviderError(receipt.cleanup === "unconfirmed" ? "cleanup_unconfirmed" : "cancelled", receipt, usage, result.failurePhase);
      if (result.status !== "completed" || result.errorCode !== null) {
        revoke();
        throw new CuaProviderError(codeOf(result.errorCode), receipt, usage, result.failurePhase);
      }
      let turn: CuaTurn;
      try {
        turn = debrief ? { actions: [], pendingSafetyChecks: [], done: true, closingReport: parseParticipantClosing(result.output) }
          : parseParticipantTurn(result.output);
      } catch { revoke(); throw new CuaProviderError("invalid_response", receipt, usage, "response"); }
      // A done turn has no new input batch. Closing acknowledgments still refer
      // to the last proposed actions, even after the participant reports done.
      if (!debrief && turn.actions.length) lastActionCount = turn.actions.length;
      return { ...turn, ...(usage === undefined ? {} : { usage }), providerRequest: receipt };
    } catch (error) {
      if (isCuaProviderError(error)) throw error;
      failedCleanup = true; incompleteUsage = true; revoke();
      throw new CuaProviderError("process_failed", { dispatched: "unknown", usageComplete: false, cleanup: "unconfirmed" }, usage);
    } finally { signal.removeEventListener("abort", onAbort); }
  }
  const start = (req: CuaTurnRequest, signal: AbortSignal, debrief: boolean): Promise<CuaTurn> => {
    if (closed) return Promise.reject(new CuaProviderError("request_rejected", noDispatch()));
    if (pending) return Promise.reject(new CuaProviderError("busy", noDispatch()));
    const own = new AbortController(); controller = own;
    const task = execute(req, signal, debrief, own);
    pending = task;
    void task.finally(() => { if (pending === task) { pending = undefined; controller = undefined; } }).catch(() => undefined);
    return task;
  };
  const provider: CuaProvider = {
    id: "restricted-codex-participant", version: PARTICIPANT_PROFILE.requestedModel, requiresFrame: true, requestPolicy: "fail_closed",
    executionProfile: PARTICIPANT_PROFILE, modelSettings: { reasoningEffort: "low" },
    capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: true, byoModel: false,
      preGrantableApprovals: false, inProcessTools: false, license: "proprietary" },
    get interactionUsageIncomplete() { return incompleteUsage; }, get historyTurnsOmitted() { return 0; },
    nextTurn: (req, signal) => start(req, signal, false), debrief: (req, signal) => start(req, signal, true)
  };
  return { provider, close: () => {
    if (closing) return closing;
    revoke();
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([Promise.all([pending?.then(() => undefined, () => undefined), closeSession()])
          .then(([, confirmed]) => confirmed), new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), Math.max(0, L.cleanupMs - (performance.now() - abortAt!)));
        })]);
        if (!settled) failedCleanup = true;
        return { status: failedCleanup ? "unconfirmed" : "confirmed" } as ParticipantProviderCloseResult;
      } finally { clearTimeout(timer); clearTimeout(cleanupTimer); lastActionCount = undefined; instructions = undefined; }
    })();
    return closing;
  } };
}
