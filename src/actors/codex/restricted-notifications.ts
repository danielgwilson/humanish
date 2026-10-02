// The policy every app-server notification passes, whenever it arrives: during the launch
// handshake, before a turn is dispatched, during a turn, or between requests. A notification that
// carries an item is checked against the item policy whatever its method, so a new method cannot
// carry a native operation past it. A method this humanish does not know that carries no item is
// counted and reported, not refused, so a release's new progress events do not break a run.
import { toolPolicyViolation, type RestrictedCodexAnalysisErrorCode } from "./restricted-policy.js";

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
 * (`codex app-server generate-json-schema --experimental`, ServerNotification), plus
 * rawResponseItem/completed, which the experimental API sends without declaring it.
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

/** The item a notification carries: an `item` object with a string `type`, or none. */
export function notificationItem(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const item = params.item;
  return item !== null &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    typeof (item as Record<string, unknown>).type === "string"
    ? (item as Record<string, unknown>)
    : undefined;
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
 * turn/start, and between requests. A disallowed item refuses; an unknown method without an item
 * is counted; anything else is ignored, as there is no turn to apply it to.
 */
export function idleNotificationHandler(
  policy: NotificationPolicy,
  recordUnknown: (method: string) => void,
  refuse: (code: RestrictedCodexAnalysisErrorCode) => void,
): (method: string, params: Record<string, unknown>) => void {
  return (method, params) => {
    const item = notificationItem(params);
    if (item !== undefined) {
      if (itemPolicyViolation(method, item, policy)) refuse("codex_tool_call");
      return;
    }
    if (!KNOWN_CODEX_NOTIFICATIONS.has(method)) recordUnknown(method);
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
