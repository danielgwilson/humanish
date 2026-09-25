import type { ActorTokenUsage, ProviderRequestReceipt } from "./actor-contract.js";
import { describeCuaAction, type CuaProvider, type CuaTurn, type CuaTurnRequest } from "./computer-use.js";
import { CuaProviderError, isCuaProviderError, type CuaProviderErrorCode } from "./cua-provider-error.js";
import { validateBrowserControlPng } from "./browser-control-protocol.js";
import { runRestrictedCodexSession, type RestrictedCodexSessionOptions } from "./restricted-codex-session.js";
import type { RestrictedCodexAnalysisErrorCode, RestrictedCodexResult } from "./restricted-codex-policy.js";
import { PARTICIPANT_PROFILE, PARTICIPANT_LIMITS as L, PARTICIPANT_TURN_SCHEMA, PARTICIPANT_CLOSING_SCHEMA,
  parseParticipantTurn, parseParticipantClosing } from "./restricted-codex-participant-policy.js";

export type ParticipantProviderCloseResult = { status: "confirmed" | "unconfirmed" };
export interface RestrictedParticipantOptions { session?: RestrictedCodexSessionOptions; requestTimeoutMs?: number }
type Memory = { narration: string; actions: string[]; execution?: CuaTurnRequest["previousExecution"] };
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

/** Fresh single turns over an already-owned executor. No desktop or login acquisition here. */
export function createRestrictedCodexParticipant(options: RestrictedParticipantOptions = {}): {
  provider: CuaProvider; close(): Promise<ParticipantProviderCloseResult>;
} {
  const timeoutMs = options.requestTimeoutMs ?? L.requestMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > L.requestMs) throw new CuaProviderError("request_rejected", noDispatch());
  let closed = false, failedCleanup = false, incompleteUsage = false, omitted = 0;
  let instructions: string | undefined;
  let history: Memory[] = [];
  let controller: AbortController | undefined;
  let pending: Promise<CuaTurn> | undefined;
  let closing: Promise<ParticipantProviderCloseResult> | undefined;
  let abortAt: number | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const revoke = (): void => {
    closed = true;
    abortAt ??= performance.now();
    controller?.abort();
    cleanupTimer ??= setTimeout(() => { if (pending) failedCleanup = true; }, Math.max(0, L.cleanupMs - (performance.now() - abortAt)));
  };
  const trim = (): void => {
    while (history.length > L.historyTurns || Buffer.byteLength(JSON.stringify(history)) > L.history) { history.shift(); omitted++; }
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
      instructions ??= req.instructions;
      const last = history.at(-1);
      if (last && req.previousExecution !== undefined) {
        if (req.previousExecution.actions.length !== last.actions.length || req.previousExecution.actions.some((a, i) =>
          a.index !== i || !["completed", "skipped", "not_dispatched", "outcome_uncertain"].includes(a.status))) {
          throw new CuaProviderError("request_rejected", receipt);
        }
        last.execution = { actions: req.previousExecution.actions.map(a => ({ ...a })) };
      }
      trim();
      const result: RestrictedCodexResult = await runRestrictedCodexSession({ model: PARTICIPANT_PROFILE.requestedModel,
        instructions: `${instructions}\n\nYou are the study participant. Use only the current screenshot and explicit recent history. Describe your experience as public participant speech, never private reasoning. History contains proposals and input acknowledgments, not independent proof of success. A completed input does not prove its application outcome. Never use tools or request integrations. ${debrief ? "The interaction has ended. Give only a closing summary and frictionReports about what you observed; do not propose actions." : "Return the supplied JSON schema. Continue with one to four browser actions, or explicitly finish with no actions and your outcome. Preserve uncertainty and do not invent observations."}`,
        evidence: JSON.stringify({ phase: debrief ? "closing" : "interaction", width: frame!.readUInt32BE(16), height: frame!.readUInt32BE(20),
          contextHint: req.contextHint ?? null, memoryPolicy: PARTICIPANT_PROFILE.memoryPolicy, omittedTurns: omitted, history }),
        images: [{ evidenceId: "current-frame", dataUrl: `data:image/png;base64,${frame!.toString("base64")}` }],
        schema: debrief ? PARTICIPANT_CLOSING_SCHEMA : PARTICIPANT_TURN_SCHEMA, maxOutputTokens: null, timeoutMs, signal: own.signal
      }, options.session);
      receipt = { dispatched: result.dispatched, usageComplete: result.usageComplete,
        cleanup: result.errorCode === "codex_cleanup_failed" ? "unconfirmed" : "confirmed" };
      usage = result.usage ?? undefined;
      if (receipt.cleanup === "unconfirmed") { failedCleanup = true; closed = true; }
      if (result.dispatched && !result.usageComplete && !debrief) incompleteUsage = true;
      if (closed || own.signal.aborted) throw new CuaProviderError(receipt.cleanup === "unconfirmed" ? "cleanup_unconfirmed" : "cancelled", receipt, usage, result.failurePhase);
      if (result.status !== "completed" || result.errorCode !== null) throw new CuaProviderError(codeOf(result.errorCode), receipt, usage, result.failurePhase);
      let turn: CuaTurn;
      try {
        turn = debrief ? { actions: [], pendingSafetyChecks: [], done: true, closingReport: parseParticipantClosing(result.output) }
          : parseParticipantTurn(result.output);
      } catch { throw new CuaProviderError("invalid_response", receipt, usage, "response"); }
      if (!debrief) { history.push({ narration: turn.message ?? "", actions: turn.actions.map(describeCuaAction) }); trim(); }
      return { ...turn, ...(usage === undefined ? {} : { usage }), providerRequest: receipt };
    } catch (error) {
      if (isCuaProviderError(error)) throw error;
      failedCleanup = true; closed = true; incompleteUsage = true;
      throw new CuaProviderError("process_failed", { dispatched: "unknown", usageComplete: false, cleanup: "unconfirmed" }, usage);
    } finally { signal.removeEventListener("abort", onAbort); }
  }
  const start = (req: CuaTurnRequest, signal: AbortSignal, debrief: boolean): Promise<CuaTurn> => {
    if (closed) return Promise.reject(new CuaProviderError("request_rejected", noDispatch()));
    if (pending) return Promise.reject(new CuaProviderError("busy", noDispatch()));
    const own = new AbortController(); controller = own;
    const task = execute(req, signal, debrief, own);
    pending = task;
    void task.finally(() => { if (pending === task) { pending = undefined; controller = undefined; clearTimeout(cleanupTimer); } }).catch(() => undefined);
    return task;
  };
  const provider: CuaProvider = {
    id: "restricted-codex-participant", version: PARTICIPANT_PROFILE.requestedModel, requiresFrame: true, requestPolicy: "fail_closed",
    executionProfile: PARTICIPANT_PROFILE, modelSettings: { reasoningEffort: "low" },
    capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: true, byoModel: false,
      preGrantableApprovals: false, inProcessTools: false, license: "proprietary" },
    get interactionUsageIncomplete() { return incompleteUsage; }, get historyTurnsOmitted() { return omitted; },
    nextTurn: (req, signal) => start(req, signal, false), debrief: (req, signal) => start(req, signal, true)
  };
  return { provider, close: () => {
    if (closing) return closing;
    revoke(); history = []; instructions = undefined;
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = !pending || await Promise.race([pending.then(() => true, () => true), new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), Math.max(0, L.cleanupMs - (performance.now() - abortAt!)));
        })]);
        if (!settled) failedCleanup = true;
        return { status: failedCleanup ? "unconfirmed" : "confirmed" } as ParticipantProviderCloseResult;
      } finally { clearTimeout(timer); clearTimeout(cleanupTimer); history = []; instructions = undefined; }
    })();
    return closing;
  } };
}
