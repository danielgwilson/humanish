import {
  type ActorCapabilities,
  type ActorExecutionProfile,
  type ActorTokenUsage,
  type ProviderRequestReceipt,
} from "../contract.js";
import { defaultCodexCliVersion, untestedOperatorReleaseWarning } from "./codex-admission.js";
import type { CuaProvider, CuaTurn, CuaTurnRequest } from "../computer-use/loop.js";
import {
  ComputerUseProviderError,
  isComputerUseProviderError,
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
import { truncatedFrameWarning, unknownNotificationsWarning } from "./restricted-notifications.js";
import { protocolAdditionsWarning, protocolIncompatibilityMessage } from "./protocol-compat.js";

export type ParticipantProviderCloseResult = {
  status: "confirmed" | "unconfirmed";
  /** Run warnings from the native session, such as notification methods humanish does not know. */
  warnings?: string[];
  /** A refusal after the last request, such as a disallowed item outside a turn. It fails the run. */
  refusal?: RestrictedCodexAnalysisErrorCode;
};
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
// prose-check: model prompt (Codex reads this tool description, not a person)
const toolDescription = (speechEnabled: boolean): string =>
  `Act on the participant's browser through humanish. Submit one to four UI actions${speechEnabled ? ", including speak when you need to reply aloud," : ""} and a short public comment; never private reasoning. humanish returns a JSON STRING with execution acknowledgments${speechEnabled ? ", speech heard from the actual participant speaker sink," : ""} and a fresh screenshot. In Code Mode use: const r = JSON.parse(await tools.humanish_ui({narration: "...", actions: [...]})); text({acknowledgments: r.acknowledgments${speechEnabled ? ", heardSpeech: r.heardSpeech" : ""}, contextHint: r.contextHint, closing: r.closing}); image(r.imageUrl). Call serially and inspect each returned screenshot${speechEnabled ? " and heardSpeech array" : ""} before deciding what to do next.${speechEnabled ? " Use speak only after the visible UI shows that you joined the call and your microphone is unmuted; it sends audio into that call." : ""} Acknowledged input does not prove an application outcome. If closing is true, stop calling tools and give your final account.`;

const participantInstructions = (prompt: string, speechEnabled: boolean): string =>
  `${prompt}\n\nYou are the study participant throughout this conversation, including its closing account. Use only the supplied screenshots and humanish_ui tool to interact. The tool returns a JSON string: parse it, inspect acknowledgments${speechEnabled ? " and heardSpeech captured from the actual participant speaker sink" : ""}, and display imageUrl with Code Mode image(). Do not print the image data URL as text. Keep your persona and earlier observations throughout the session.${speechEnabled ? " A speak action plays into the participant microphone; use it only after the visible UI shows that you joined the call and the microphone is unmuted." : ""} Speak publicly about your experience, never reveal private reasoning. Completed inputs do not prove application outcomes; verify on the next screenshot. When the task ends, return only the required final JSON with outcome, summary and frictionReports. Report observed confusion and recovered mistakes as well as blockers. Do not invent observations.`;

type ParticipantEvent = { turn: CuaTurn } | { error: ComputerUseProviderError };
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
    throw new ComputerUseProviderError(
      stopped.failedCleanup ? "cleanup_unconfirmed" : "cancelled",
      receipt,
      usage,
      result.failurePhase,
    );
  if (result.status !== "completed" || result.errorCode !== null)
    throw new ComputerUseProviderError(
      codeOf(result.errorCode),
      receipt,
      usage,
      result.failurePhase,
    );
  let turn: CuaTurn;
  try {
    turn = parseParticipantFinal(result.output);
  } catch {
    throw new ComputerUseProviderError("invalid_response", receipt, usage, "response");
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
/** What doctor's hosted-participant check found, before any turn. */
export interface ParticipantReadiness {
  ready: boolean;
  errorCode: RestrictedCodexAnalysisErrorCode | null;
  /** The release the launch admitted. */
  cliVersion?: string;
  /** How the release's schema differs from the fields humanish reads, when that refused it. */
  protocolIncompatibilities?: readonly string[];
  /** Schema values beyond the baseline, recorded by a launch that passed. */
  protocolAdditions?: readonly string[];
  /** The model thread/start resolved from the operator's configuration or the declared model. */
  resolvedModel?: string;
  authentication?: "chatgpt-account" | "api-key";
}

/**
 * doctor's check for a hosted Codex participant: the operator-auth launch up to an ephemeral
 * thread (the version check, initialize, config/read, account/read and thread/start). It sends no
 * turn, so no model request is made, and its tool is never called.
 */
export async function checkRestrictedCodexParticipantReadiness(options: {
  session?: RestrictedCodexSessionOptions;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
}): Promise<ParticipantReadiness> {
  const session = participantSession(
    {
      authMode: "operator",
      ...(options.session === undefined ? {} : { session: options.session }),
    },
    false,
    options.reasoningEffort ?? "low",
    async () => {
      throw new Error("A readiness check makes no tool call");
    },
  );
  const result = await session.run(
    {
      ...(options.model === undefined ? {} : { model: options.model }),
      instructions: participantInstructions("Readiness check only.", false),
      evidence: "",
      images: [],
      schema: PARTICIPANT_FINAL_SCHEMA,
      maxOutputTokens: null,
      timeoutMs: options.timeoutMs ?? 15_000,
    },
    true,
  );
  const closed = await session.close();
  const errorCode = closed ? result.errorCode : (result.errorCode ?? "codex_cleanup_failed");
  return {
    ready: errorCode === null && result.status === "completed",
    errorCode,
    ...(session.cliVersion === undefined ? {} : { cliVersion: session.cliVersion }),
    ...(session.protocolIncompatibilities === undefined
      ? {}
      : { protocolIncompatibilities: session.protocolIncompatibilities }),
    ...(session.protocolAdditions === undefined || session.protocolAdditions.length === 0
      ? {}
      : { protocolAdditions: session.protocolAdditions }),
    ...(session.resolvedModel === undefined ? {} : { resolvedModel: session.resolvedModel }),
    ...(session.authentication === undefined ? {} : { authentication: session.authentication }),
  };
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
  const cliVersion = session.cliVersion ?? defaultCodexCliVersion();
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

/** What a participant reads and never changes once it is created. */
interface ParticipantSettings {
  readonly options: RestrictedParticipantOptions;
  readonly timeoutMs: number;
  readonly operator: boolean;
  readonly speechEnabled: boolean;
  readonly model: string | undefined;
  readonly effort: ReasoningEffort;
}

/**
 * What changes after a participant is created and more than one of its functions reads. Each
 * field is read at its use, never copied into a local across an await.
 */
interface ParticipantState {
  /** The native session and the turns it yields (constructed once; both hold changing state). */
  session: RestrictedCodexSession;
  readonly events: ParticipantEvents;
  /** Set by revoke; the tool callback and start refuse after it. */
  closed: boolean;
  /** A native cleanup was unconfirmed (session close, a run's receipt; close and each turn read). */
  failedCleanup: boolean;
  /** A dispatched request's usage was incomplete (the native run; the provider's getter). */
  incompleteUsage: boolean;
  /** A native run is in flight (launch; the tool callback, each turn, the provider's getter). */
  active: boolean;
  /** The current request is the debrief (each turn; the tool callback and the native run). */
  closingPhase: boolean;
  /** The conversation's instructions, fixed by its first turn (each turn; the native run). */
  instructions: string | undefined;
  /** How many actions the waiting tool call asked for (the tool callback; each turn). */
  lastActionCount: number | undefined;
  /** The waiting tool call's reply (the tool callback; each turn and revoke). */
  continuation: ReturnType<typeof deferred<string>> | undefined;
  /** The native run (launch; close waits for it). */
  nativeTask: Promise<void> | undefined;
  /** The native run's abort (launch; revoke aborts it). */
  controller: AbortController | undefined;
  /** When revoke first ran, the start of the cleanup budget (revoke; close). */
  abortAt: number | undefined;
  /** The one session close, shared by revoke and close (closeParticipantSession). */
  sessionClosing: Promise<boolean> | undefined;
}

/** The session's tool callback: one native tool call becomes the turn the loop executes. */
async function acceptToolCall(
  settings: ParticipantSettings,
  state: ParticipantState,
  args: unknown,
): Promise<string> {
  if (state.closed || state.closingPhase || state.continuation || !state.active)
    throw new Error("Unexpected participant tool call");
  const turn = parseParticipantTool(args, settings.speechEnabled);
  const reply = deferred<string>();
  state.continuation = reply;
  state.lastActionCount = turn.actions.length;
  state.events.emit({ turn });
  return reply.promise;
}

/** Closes the native session once; an unconfirmed close marks cleanup failed. */
function closeParticipantSession(state: ParticipantState): Promise<boolean> {
  return (state.sessionClosing ??= Promise.resolve()
    .then(() => state.session.close())
    .catch(() => false)
    .then((confirmed) => {
      if (!confirmed) state.failedCleanup = true;
      return confirmed;
    }));
}

/** What the closed native session reports beside cleanup: its run warnings and a late refusal. */
function sessionReport(
  session: RestrictedCodexSession,
  operator: boolean,
): Pick<ParticipantProviderCloseResult, "warnings" | "refusal"> {
  const warnings = [
    // A resolved model means thread/start was admitted: the release actually launched.
    untestedOperatorReleaseWarning(
      session.resolvedModel === undefined ? undefined : session.cliVersion,
      operator,
    ),
    session.protocolIncompatibilities === undefined
      ? undefined
      : protocolIncompatibilityMessage(session.cliVersion, session.protocolIncompatibilities),
    protocolAdditionsWarning(session.cliVersion, session.protocolAdditions),
    unknownNotificationsWarning(session.unknownNotifications, session.cliVersion),
    truncatedFrameWarning(session.truncatedFrameBytes),
  ].filter((warning) => warning !== undefined);
  const refusal = session.policyRefusal;
  return {
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(refusal === undefined ? {} : { refusal }),
  };
}

/** Stops the conversation: abort the native run, reject a waiting tool call, close the session. */
function revokeParticipant(state: ParticipantState): void {
  state.closed = true;
  state.abortAt ??= performance.now();
  state.controller?.abort();
  state.continuation?.reject(new Error("Participant closed"));
  state.continuation = undefined;
  void closeParticipantSession(state);
}

/** Starts the one native run; its final turn or failure arrives as a participant event. */
function launchNativeRun(
  settings: ParticipantSettings,
  state: ParticipantState,
  req: CuaTurnRequest,
  imageUrl: string,
): void {
  state.active = true;
  const signal = (state.controller = new AbortController()).signal;
  state.nativeTask = (async () => {
    let receipt = noDispatch(),
      usage: ActorTokenUsage | undefined;
    try {
      const result = await state.session.run(
        participantRunRequest(req, {
          instructions: state.instructions!,
          closing: state.closingPhase,
          speechEnabled: settings.speechEnabled,
          model: settings.model,
          imageUrl,
          timeoutMs: settings.timeoutMs,
          signal,
        }),
      );
      receipt = runReceipt(result);
      usage = result.usage ?? undefined;
      if (result.dispatched && !result.usageComplete) state.incompleteUsage = true;
      if (receipt.cleanup === "unconfirmed") state.failedCleanup = true;
      const stopped = state.closed || signal.aborted;
      state.events.emit({
        turn: finalTurn(result, receipt, usage, { stopped, failedCleanup: state.failedCleanup }),
      });
    } catch (error) {
      revokeParticipant(state);
      state.events.emit({
        error: isComputerUseProviderError(error)
          ? error
          : new ComputerUseProviderError(
              "process_failed",
              { dispatched: "unknown", usageComplete: false, cleanup: "unconfirmed" },
              usage,
            ),
      });
    } finally {
      state.active = false;
    }
  })();
}

/** One request: answer the waiting tool call, or start the native run, then yield its next turn. */
async function runParticipantTurn(
  settings: ParticipantSettings,
  state: ParticipantState,
  req: CuaTurnRequest,
  signal: AbortSignal,
  debrief: boolean,
): Promise<CuaTurn> {
  if (state.events.waiting) return state.events.next();
  if (signal.aborted) {
    revokeParticipant(state);
    throw new ComputerUseProviderError("cancelled", noDispatch());
  }
  const conversation = {
    instructions: state.instructions,
    speechEnabled: settings.speechEnabled,
    awaitingAcknowledgments: state.continuation !== undefined,
    lastActionCount: state.lastActionCount,
  };
  if (rejectsParticipantRequest(req, conversation))
    throw new ComputerUseProviderError("request_rejected", noDispatch());
  const onAbort = (): void => {
    revokeParticipant(state);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    state.instructions ??= req.instructions;
    state.closingPhase = debrief;
    const imageUrl = `data:image/png;base64,${req.observation.screenshot!.toString("base64")}`;
    if (state.continuation) {
      const reply = state.continuation;
      state.continuation = undefined;
      reply.resolve(toolReply(req, imageUrl, settings.speechEnabled, debrief));
    } else if (!state.active) launchNativeRun(settings, state, req, imageUrl);
    else throw new ComputerUseProviderError("busy", noDispatch());
    return await state.events.next();
  } finally {
    // The shared loop aborts each request's signal after it yields. The native
    // turn must remain alive while humanish executes and records its actions.
    signal.removeEventListener("abort", onAbort);
  }
}

/** The CuaProvider the loop drives; `start` admits one request at a time. */
function participantProvider(
  settings: ParticipantSettings,
  state: ParticipantState,
  start: (req: CuaTurnRequest, signal: AbortSignal, debrief: boolean) => Promise<CuaTurn>,
): CuaProvider {
  const { operator, effort } = settings;
  return {
    id: "codex-participant",
    requiresFrame: true,
    requestPolicy: "fail_closed",
    get version() {
      return state.session.resolvedModel ?? settings.model;
    },
    get executionProfile() {
      return participantExecutionProfile(state.session, operator, effort);
    },
    modelSettings: { reasoningEffort: effort },
    capabilities: participantCapabilities(operator),
    get pendingRequestUsage() {
      const usage = state.session.pendingUsage;
      return usage === undefined
        ? undefined
        : { ...usage, turns: state.session.pendingInferenceUsage ?? [] };
    },
    get interactionUsageIncomplete() {
      return state.incompleteUsage || state.active;
    },
    get historyTurnsOmitted() {
      return 0;
    },
    nextTurn: (req, signal) => start(req, signal, false),
    debrief: (req, signal) => start(req, signal, true),
  };
}

/** One native tool-calling conversation; the existing CUA loop owns every input. */
export function createRestrictedCodexParticipant(options: RestrictedParticipantOptions = {}): {
  provider: CuaProvider;
  close(): Promise<ParticipantProviderCloseResult>;
} {
  const timeoutMs = options.requestTimeoutMs ?? L.requestMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > L.requestMs)
    throw new ComputerUseProviderError("request_rejected", noDispatch());
  const operator = options.authMode === "operator";
  const speechEnabled = options.speechEnabled === true;
  const settings: ParticipantSettings = {
    options,
    timeoutMs,
    operator,
    speechEnabled,
    model: options.model ?? (operator ? undefined : PARTICIPANT_PROFILE.requestedModel),
    effort: options.reasoningEffort ?? "low",
  };
  const state: ParticipantState = {
    // Assigned below: the session's tool callback needs this record.
    session: undefined as unknown as RestrictedCodexSession,
    events: new ParticipantEvents(),
    closed: false,
    failedCleanup: false,
    incompleteUsage: false,
    active: false,
    closingPhase: false,
    instructions: undefined,
    lastActionCount: undefined,
    continuation: undefined,
    nativeTask: undefined,
    controller: undefined,
    abortAt: undefined,
    sessionClosing: undefined,
  };
  state.session = participantSession(options, speechEnabled, settings.effort, (args) =>
    acceptToolCall(settings, state, args),
  );
  let pending: Promise<CuaTurn> | undefined,
    closing: Promise<ParticipantProviderCloseResult> | undefined;
  const start = (req: CuaTurnRequest, signal: AbortSignal, debrief: boolean): Promise<CuaTurn> => {
    if (state.closed && !state.events.waiting)
      return Promise.reject(new ComputerUseProviderError("request_rejected", noDispatch()));
    if (pending) return Promise.reject(new ComputerUseProviderError("busy", noDispatch()));
    const task = runParticipantTurn(settings, state, req, signal, debrief);
    pending = task;
    void task
      .finally(() => {
        if (pending === task) pending = undefined;
      })
      .catch(() => undefined);
    return task;
  };
  return {
    provider: participantProvider(settings, state, start),
    close: () => {
      if (closing) return closing;
      revokeParticipant(state);
      closing = (async () => {
        const work = Promise.all([state.nativeTask, closeParticipantSession(state)]).then(
          ([, ok]) => ok,
        );
        if (!(await withinCleanupBudget(work, state.abortAt!))) state.failedCleanup = true;
        return {
          status: state.failedCleanup ? "unconfirmed" : "confirmed",
          ...sessionReport(state.session, settings.operator),
        };
      })();
      return closing;
    },
  };
}
