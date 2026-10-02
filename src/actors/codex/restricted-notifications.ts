// The policy every app-server notification passes, whenever it arrives: during the launch
// handshake, before a turn is dispatched, during a turn, or between requests. A notification that
// carries an item is checked against the item policy whatever its method, so a new method cannot
// carry a native operation past it. A method this humanish does not know that carries no item is
// counted and reported, not refused, so a release's new progress events do not break a run.
import {
  codexRecord,
  toolPolicyViolation,
  type RestrictedCodexAnalysisErrorCode,
} from "./restricted-policy.js";
import {
  RestrictedCodexStop,
  type RestrictedCodexDeadline,
  type RestrictedCodexTransport,
} from "./restricted-transport.js";

const rawCompactionTypes = ["compaction", "compaction_summary", "context_compaction"] as const;
/** Raw response item types an analyst turn may produce. */
export const ANALYST_RAW_ITEM_TYPES: readonly string[] = [
  "message",
  "reasoning",
  ...rawCompactionTypes,
];
/** A participant also runs Code Mode: `exec` custom tool calls and `wait` function calls. */
export const PARTICIPANT_RAW_ITEM_TYPES: readonly string[] = [
  ...ANALYST_RAW_ITEM_TYPES,
  "custom_tool_call",
  "custom_tool_call_output",
  "function_call",
  "function_call_output",
];
/** Thread item types an analyst turn may produce. */
export const ANALYST_ITEM_TYPES: readonly string[] = [
  "userMessage",
  "agentMessage",
  "reasoning",
  "contextCompaction",
];
/** A participant also has its one dynamic tool. */
export const PARTICIPANT_ITEM_TYPES: readonly string[] = [...ANALYST_ITEM_TYPES, "dynamicToolCall"];

/**
 * Server notification methods in Codex CLI 0.160.0's app-server schema
 * (`codex app-server generate-json-schema --experimental`, ServerNotification), plus two it sends
 * outside that union: rawResponseItem/completed, and rawResponse/completed, whose v2 definition
 * (RawResponseCompletedNotification) carries only a response id and usage.
 */
export const KNOWN_CODEX_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "account/gatewayOAuth/changed",
  "account/login/completed",
  "account/rateLimits/updated",
  "account/updated",
  "app/list/updated",
  "autoApprovalReview/strictReviewRequired",
  "command/exec/outputDelta",
  "configWarning",
  "deprecationNotice",
  "error",
  "externalAgentConfig/import/completed",
  "externalAgentConfig/import/progress",
  "fs/changed",
  "fuzzyFileSearch/sessionCompleted",
  "fuzzyFileSearch/sessionUpdated",
  "guardianWarning",
  "hook/completed",
  "hook/started",
  "item/agentMessage/delta",
  "item/autoApprovalReview/completed",
  "item/autoApprovalReview/started",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/completed",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "mcpServer/event/stream/notification",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "model/rerouted",
  "model/safetyBuffering/updated",
  "model/verification",
  "modelProvider/authRecoveryCompleted",
  "modelProvider/authRecoveryStarted",
  "process/exited",
  "process/outputDelta",
  "project/changed",
  "rawResponse/completed",
  "rawResponseItem/completed",
  "remoteControl/status/changed",
  "serverRequest/resolved",
  "skills/changed",
  "thread/archived",
  "thread/attachment/updated",
  "thread/closed",
  "thread/compacted",
  "thread/deleted",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/goal/cleared",
  "thread/goal/updated",
  "thread/name/updated",
  "thread/project/updated",
  "thread/queue/changed",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/item/completed",
  "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/itemAdded",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/started",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/reverted",
  "thread/settings/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "thread/unarchived",
  "turn/completed",
  "turn/diff/updated",
  "turn/moderationMetadata",
  "turn/plan/updated",
  "turn/started",
  "warning",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
]);

/** What the item policy depends on: the session's role and, for a participant, its tool. */
export interface NotificationPolicy {
  readonly participant: boolean;
  /** The participant's tool name, read at each use; undefined for an analyst. */
  toolName(): string | undefined;
}

/** The item policy for a session: a participant's tool name is read at each use. */
export function notificationPolicyOf(
  participant: { readonly tool: { readonly name: string } } | undefined,
): NotificationPolicy {
  return { participant: participant !== undefined, toolName: () => participant?.tool.name };
}

/** Adds one notification of `method` to a session's unknown-method counts. */
export function countUnknownNotification(counts: Map<string, number>, method: string): void {
  counts.set(method, (counts.get(method) ?? 0) + 1);
}

const isItem = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>).type === "string";

/**
 * The items a notification carries, each with the method whose policy it takes, or null when one
 * is malformed. 0.160.0's schema puts a ThreadItem in `params.item` (item/started,
 * item/completed), `params.turn.items` (turn/started, turn/completed) and
 * `params.thread.turns[].items` (thread/started). An `item` array and an `items` array are read
 * too, for a release that adds them. A nested ThreadItem takes the item/completed policy.
 */
export function notificationItems(
  method: string,
  params: Record<string, unknown>,
): { method: string; item: Record<string, unknown> }[] | null {
  const found: { method: string; item: Record<string, unknown> }[] = [];
  let malformed = false;
  const add = (value: unknown, itemMethod: string): void => {
    if (isItem(value)) found.push({ method: itemMethod, item: value });
    else malformed = true;
  };
  const addAll = (value: unknown, itemMethod: string): void => {
    if (Array.isArray(value)) for (const item of value) add(item, itemMethod);
  };
  if (Array.isArray(params.item)) addAll(params.item, method);
  else if (params.item !== undefined && params.item !== null) add(params.item, method);
  addAll(params.items, method);
  addAll(codexRecord(params.turn).items, "item/completed");
  const turns = codexRecord(params.thread).turns;
  if (Array.isArray(turns))
    for (const turn of turns) addAll(codexRecord(turn).items, "item/completed");
  return malformed ? null : found;
}

/**
 * How a notification fares under the item policy: it carries no item, only allowed items, or a
 * disallowed or malformed one.
 */
export function itemPolicyOf(
  method: string,
  params: Record<string, unknown>,
  policy: NotificationPolicy,
): "none" | "allowed" | "violation" {
  const found = notificationItems(method, params);
  if (found === null) return "violation";
  if (found.length === 0) return "none";
  return found.some((entry) => itemPolicyViolation(entry.method, entry.item, policy))
    ? "violation"
    : "allowed";
}

/**
 * True when an item breaks the item policy. rawResponseItem/completed, and an item of a raw type
 * under any method other than item/started or item/completed, use the raw-item policy. Every
 * other item uses the thread-item policy: an allowed type, the participant's one dynamic tool, and
 * no agent message that delivers asynchronously or asks a question.
 */
export function itemPolicyViolation(
  method: string,
  item: Record<string, unknown>,
  policy: NotificationPolicy,
): boolean {
  const rawTypes = policy.participant ? PARTICIPANT_RAW_ITEM_TYPES : ANALYST_RAW_ITEM_TYPES;
  const threadItemMethod = method === "item/started" || method === "item/completed";
  const type = String(item.type);
  if (method === "rawResponseItem/completed" || (!threadItemMethod && rawTypes.includes(type)))
    return toolPolicyViolation("rawResponseItem/completed", item, rawTypes);
  const itemTypes = policy.participant ? PARTICIPANT_ITEM_TYPES : ANALYST_ITEM_TYPES;
  if (!itemTypes.includes(type)) return true;
  if (type === "dynamicToolCall" && (item.tool !== policy.toolName() || item.namespace !== null))
    return true;
  return toolPolicyViolation("item/completed", item, rawTypes);
}

/**
 * The handler for notifications outside a dispatched turn: during the handshake, before
 * turn/start, between requests and while closing. A disallowed or malformed item refuses; an
 * unknown method without an item is counted; anything else is ignored, as there is no turn to
 * apply it to.
 */
export function idleNotificationHandler(
  policy: NotificationPolicy,
  recordUnknown: (method: string) => void,
  refuse: (code: RestrictedCodexAnalysisErrorCode) => void,
): (method: string, params: Record<string, unknown>) => void {
  return (method, params) => {
    const items = itemPolicyOf(method, params, policy);
    if (items === "violation") refuse("codex_tool_call");
    else if (items === "none" && !KNOWN_CODEX_NOTIFICATIONS.has(method)) recordUnknown(method);
  };
}

/** The run warning for unknown notification methods, or undefined when there were none. */
export function unknownNotificationsWarning(
  counts: Readonly<Record<string, number>> | undefined,
  cliVersion: string | undefined,
): string | undefined {
  const entries = Object.entries(counts ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return undefined;
  const list = entries.map(([method, count]) => `${method} ×${count}`).join(", ");
  return `Codex CLI${cliVersion === undefined ? "" : ` ${cliVersion}`} sent notification methods humanish does not know: ${list}. They carried no item and were ignored.`;
}

/** The run warning for a last frame cut off by humanish's own stop, or undefined when none was. */
export function truncatedFrameWarning(bytes: number | undefined): string | undefined {
  return bytes === undefined
    ? undefined
    : `Codex output was cut off when humanish stopped the app-server: ${bytes} bytes of an unfinished last frame were not checked.`;
}

/** The session fields its handlers outside a turn read and write (restricted-session). */
export interface NotificationSessionState {
  readonly unknownNotifications: Map<string, number>;
  /** The request in flight's deadline, or undefined between requests. */
  readonly activeDeadline: RestrictedCodexDeadline | undefined;
  readonly transport: RestrictedCodexTransport | undefined;
  /**
   * The first policy refusal or unchecked output in the session, whenever it happened and whether
   * or not a request reported it: a caller that tolerates a request's failure (the debrief) must
   * not absorb it.
   */
  policyRefusal: RestrictedCodexAnalysisErrorCode | undefined;
  /** Bytes of last frames cut off after humanish stopped the app-server: a warning only. */
  truncatedFrameBytes: number | undefined;
}
type Participant = { readonly tool: { readonly name: string } } | undefined;

/**
 * A policy refusal: it is recorded, the active request stops with `code`, pending RPCs are
 * rejected, and between requests the next request fails with it.
 */
export function refuseSession(
  state: NotificationSessionState,
  code: RestrictedCodexAnalysisErrorCode,
): void {
  state.policyRefusal ??= code;
  state.activeDeadline?.stop(code);
  state.transport?.refuse(code);
}

/** The session's handler for notifications outside a dispatched turn, on its current transport. */
export function idleNotifications(
  participant: Participant,
  state: NotificationSessionState,
): (method: string, params: Record<string, unknown>) => void {
  return idleNotificationHandler(
    notificationPolicyOf(participant),
    (method) => countUnknownNotification(state.unknownNotifications, method),
    (code) => refuseSession(state, code),
  );
}

/**
 * Installs the session's handlers on a new transport, before its first request: notifications
 * outside a turn, notifications once the transport stopped or is closing, and policy failures
 * the transport finds itself.
 */
export function installSessionHandlers(
  participant: Participant,
  state: NotificationSessionState,
  transport: RestrictedCodexTransport,
): void {
  transport.onNotification = idleNotifications(participant, state);
  transport.onPolicyOnlyNotification = idleNotificationHandler(
    notificationPolicyOf(participant),
    (method) => countUnknownNotification(state.unknownNotifications, method),
    (code) => {
      state.policyRefusal ??= code;
    },
  );
  transport.onPolicyFailure = (code) => {
    state.policyRefusal ??= code;
  };
  transport.onTruncatedFrame = (bytes) => {
    state.truncatedFrameBytes = (state.truncatedFrameBytes ?? 0) + bytes;
  };
}

/** A server request outside a turn is refused; the transport answers it and stops the request. */
function idleRequests(
  state: NotificationSessionState,
): NonNullable<RestrictedCodexTransport["onRequest"]> {
  return async () => {
    state.policyRefusal ??= "codex_tool_call";
    throw new RestrictedCodexStop("codex_tool_call");
  };
}

/** After a request: the turn's handlers come off the transport, and the idle handlers go on. */
export function detachTurn(participant: Participant, state: NotificationSessionState): void {
  const transport = state.transport;
  if (!transport) return;
  transport.onNotification = idleNotifications(participant, state);
  transport.onRequest = idleRequests(state);
  transport.onRequestComplete = undefined;
}
