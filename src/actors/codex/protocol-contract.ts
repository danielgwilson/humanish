// The app-server protocol humanish depends on: each method it calls with the fields and values it
// sends and the response fields it reads, each notification and server request it consumes, and
// the containers its item policy reads in every notification. protocol-compat.ts checks a
// release's generated schema against this table on every launch.
//
// Types and known values are the baseline of every release this humanish admits. A read rule's
// `expects` lists the values humanish compares against; one a release no longer allows refuses
// the launch. `known` lists every string value the baseline offers; one beyond it is recorded and
// the launch goes on. Values humanish only refuses (an asynchronous delivery, a raw item type it
// allows but does not need) are `known`, since their removal cannot make humanish accept more.

export type ProtocolPrimitive =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

/** A value humanish compares against or sends. */
export type ProtocolValue = string | boolean | null;

/** One field humanish reads. */
export interface ProtocolFieldRule {
  /** Dot path under the definition. `name[]` is its array items; `{field=value}` selects a branch. */
  readonly path: string;
  /** The types humanish accepts; a release that allows another refuses. Omitted: presence only. */
  readonly types?: readonly ProtocolPrimitive[];
  readonly expects?: readonly ProtocolValue[];
  readonly known?: readonly string[];
  /** humanish handles the field's absence; when present, its types are still checked. */
  readonly optional?: boolean;
}

/** One field humanish sends: the schema must still accept each type and value it sends there. */
export interface ProtocolSentField {
  readonly path: string;
  readonly sends: readonly ProtocolPrimitive[];
  readonly expects?: readonly ProtocolValue[];
  /** For an object: every field humanish sends in it; a field the release newly requires refuses. */
  readonly fields?: readonly string[];
}

interface ProtocolRequest {
  readonly method: string;
  readonly params: readonly ProtocolSentField[];
  /** The response definition, named here because the schema does not link it to its method. */
  readonly response?: { readonly definition: string; readonly reads: readonly ProtocolFieldRule[] };
}

interface ProtocolMessage {
  /** The notification method, or the server request humanish answers. */
  readonly method: string;
  readonly definition: string;
  readonly reads: readonly ProtocolFieldRule[];
  /** The answer humanish sends to a server request. */
  readonly reply?: { readonly definition: string; readonly sends: readonly ProtocolSentField[] };
}

export interface ProtocolContract {
  readonly requests: readonly ProtocolRequest[];
  readonly messages: readonly ProtocolMessage[];
  /** Read in every server notification's params (restricted-notifications.ts, notificationItems). */
  readonly itemCarriers: readonly ProtocolFieldRule[];
}

const S: readonly ProtocolPrimitive[] = ["string"];
const B: readonly ProtocolPrimitive[] = ["boolean"];
const I: readonly ProtocolPrimitive[] = ["integer"];
const A: readonly ProtocolPrimitive[] = ["array"];
const O: readonly ProtocolPrimitive[] = ["object"];
const orNull = (types: readonly ProtocolPrimitive[]): readonly ProtocolPrimitive[] => [
  ...types,
  "null",
];
const sent = (
  path: string,
  sends: readonly ProtocolPrimitive[],
  ...expects: ProtocolValue[]
): ProtocolSentField => (expects.length === 0 ? { path, sends } : { path, sends, expects });
const object = (path: string, fields: readonly string[]): ProtocolSentField => ({
  path,
  sends: O,
  fields,
});
const scope: readonly ProtocolFieldRule[] = [
  { path: "threadId", types: S },
  { path: "turnId", types: S },
];

/** ThreadItem types in the baseline; humanish admits five and refuses the rest. */
const THREAD_ITEM_TYPES = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "functionCallOutput",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
];
/** ResponseItem types in the baseline (rawResponseItem/completed). */
const RAW_ITEM_TYPES = [
  "message",
  "agent_message",
  "reasoning",
  "local_shell_call",
  "function_call",
  "tool_search_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "tool_search_output",
  "web_search_call",
  "image_generation_call",
  "compaction",
  "configuration_update",
  "compaction_trigger",
  "context_compaction",
  "other",
];
const APPROVAL_POLICIES = ["untrusted", "on-request", "never"];

const itemType: ProtocolFieldRule = {
  path: "item.type",
  types: S,
  expects: ["userMessage", "agentMessage", "reasoning", "contextCompaction", "dynamicToolCall"],
  known: THREAD_ITEM_TYPES,
};
/** What the tool policy reads on both item notifications; it refuses on a value, not an absence. */
const agentMessageRefusals: readonly ProtocolFieldRule[] = [
  { path: "item.{type=agentMessage}.delivery", types: orNull(S), known: ["async"], optional: true },
  { path: "item.{type=agentMessage}.questions", types: orNull(A), optional: true },
];
const dynamicTool = (status: string, others: string[]): readonly ProtocolFieldRule[] => [
  { path: "item.{type=dynamicToolCall}.tool", types: S },
  { path: "item.{type=dynamicToolCall}.namespace", types: orNull(S), expects: [null] },
  { path: "item.{type=dynamicToolCall}.status", types: S, expects: [status], known: others },
];
/** item/started: the type, the tool policy and a started tool call (restricted-turn.ts admitsItem). */
const startedReads: readonly ProtocolFieldRule[] = [
  ...scope,
  itemType,
  ...agentMessageRefusals,
  ...dynamicTool("inProgress", ["completed", "failed"]),
];
/** item/completed adds the answer's shape and a finished tool call. */
const completedReads: readonly ProtocolFieldRule[] = [
  ...scope,
  itemType,
  ...agentMessageRefusals,
  { path: "item.{type=agentMessage}.id", types: S },
  { path: "item.{type=agentMessage}.text", types: S },
  {
    path: "item.{type=agentMessage}.phase",
    types: orNull(S),
    expects: [null, "final_answer", "commentary"],
    known: [],
  },
  ...dynamicTool("completed", ["inProgress", "failed"]),
  { path: "item.{type=dynamicToolCall}.success", types: orNull(B), expects: [true] },
];

/** What a launch compares against that depends on the launch. */
export interface ProtocolContractHost {
  /** The reasoning effort the launch configures and expects back. */
  readonly reasoningEffort: string;
  readonly platform: NodeJS.Platform;
}

/** initialize, config/read and account/read: what the launch handshake sends and reads. */
function handshakeRequests(host: ProtocolContractHost): readonly ProtocolRequest[] {
  const effort = host.reasoningEffort;
  return [
    {
      method: "initialize",
      params: [
        object("", ["clientInfo", "capabilities"]),
        object("clientInfo", ["name", "version"]),
        sent("clientInfo.name", S),
        sent("clientInfo.version", S),
        object("capabilities", ["experimentalApi"]),
        sent("capabilities.experimentalApi", B, true),
      ],
      response: {
        definition: "InitializeResponse",
        reads: [
          { path: "userAgent", types: S },
          { path: "codexHome", types: S },
          {
            path: "platformOs",
            types: S,
            expects: [host.platform === "darwin" ? "macos" : "linux"],
          },
          { path: "platformFamily", types: S, expects: ["unix"] },
        ],
      },
    },
    {
      method: "config/read",
      params: [
        object("", ["includeLayers", "cwd"]),
        sent("includeLayers", B, true),
        sent("cwd", S),
      ],
      response: {
        definition: "ConfigReadResponse",
        reads: [
          { path: "layers", types: orNull(A) },
          {
            path: "layers[].name.type",
            types: S,
            expects: ["user", "system"],
            known: [
              "packagedDefaults",
              "mdm",
              "enterpriseManaged",
              "project",
              "sessionFlags",
              "legacyManagedConfigTomlFromFile",
              "legacyManagedConfigTomlFromMdm",
            ],
          },
          // admitsRestrictedCodexConfig reads the file and profile of the user layer only.
          { path: "layers[].name.{type=user}.file", types: S },
          { path: "layers[].name.{type=user}.profile", types: orNull(S), expects: [null] },
          { path: "layers[].disabledReason", types: orNull(S), expects: [null] },
          // A system layer must be empty (admitsRestrictedCodexConfig).
          { path: "layers[].config" },
          { path: "config", types: O },
          { path: "config.model", types: orNull(S) },
          { path: "config.model_provider", types: orNull(S), expects: ["openai"] },
          { path: "config.model_reasoning_effort", types: orNull(S), expects: [effort] },
          {
            path: "config.forced_login_method",
            types: orNull(S),
            expects: ["chatgpt"],
            known: ["api"],
          },
          {
            path: "config.sandbox_mode",
            types: orNull(S),
            expects: ["read-only"],
            known: ["workspace-write", "danger-full-access"],
          },
          {
            path: "config.approval_policy",
            types: ["string", "object", "null"],
            expects: ["never"],
            known: APPROVAL_POLICIES,
          },
          {
            path: "config.web_search",
            types: orNull(S),
            expects: ["disabled"],
            known: ["cached", "indexed", "live"],
          },
          { path: "config.analytics", types: orNull(O) },
          { path: "config.analytics.enabled", types: orNull(B), expects: [false] },
        ],
      },
    },
    {
      method: "account/read",
      params: [object("", ["refreshToken"]), sent("refreshToken", B, false)],
      response: {
        definition: "GetAccountResponse",
        reads: [
          { path: "account", types: orNull(O), expects: [null] },
          {
            path: "account.type",
            types: S,
            expects: ["chatgpt", "apiKey"],
            known: ["amazonBedrock"],
          },
          { path: "requiresOpenaiAuth", types: B, expects: [true] },
        ],
      },
    },
  ];
}

/** thread/start, mcpServerStatus/list, turn/start and turn/interrupt. */
function threadRequests(host: ProtocolContractHost): readonly ProtocolRequest[] {
  const effort = host.reasoningEffort;
  return [
    {
      method: "thread/start",
      params: [
        object("", [
          "cwd",
          "ephemeral",
          "experimentalRawEvents",
          "approvalPolicy",
          "sandbox",
          "model",
          "modelProvider",
          "allowProviderModelFallback",
          "environments",
          "runtimeWorkspaceRoots",
          "dynamicTools",
          "baseInstructions",
          "config",
        ]),
        sent("cwd", S),
        sent("ephemeral", B, true),
        sent("experimentalRawEvents", B, true),
        sent("approvalPolicy", S, "never"),
        sent("sandbox", S, "read-only"),
        sent("model", S),
        sent("modelProvider", S, "openai"),
        sent("allowProviderModelFallback", B, false),
        sent("environments", A),
        sent("runtimeWorkspaceRoots", A),
        sent("dynamicTools", A),
        sent("dynamicTools[].type", S, "function"),
        object("dynamicTools[].{type=function}", ["type", "name", "description", "inputSchema"]),
        sent("dynamicTools[].{type=function}.name", S),
        sent("dynamicTools[].{type=function}.description", S),
        sent("dynamicTools[].{type=function}.inputSchema", O),
        sent("baseInstructions", S),
        sent("config", O),
      ],
      response: {
        definition: "ThreadStartResponse",
        reads: [
          { path: "thread.id", types: S },
          { path: "thread.ephemeral", types: B, expects: [true] },
          { path: "thread.model", types: orNull(S) },
          { path: "thread.modelProvider", types: S, expects: ["openai"] },
          { path: "thread.reasoningEffort", types: orNull(S), expects: [effort] },
          { path: "thread.cliVersion", types: S },
          { path: "thread.environments", types: orNull(A) },
          { path: "thread.path", types: orNull(S), expects: [null] },
          { path: "thread.cwd", types: S },
          { path: "model", types: S },
          { path: "modelProvider", types: S, expects: ["openai"] },
          { path: "reasoningEffort", types: orNull(S), expects: [effort] },
          { path: "cwd", types: S },
          {
            path: "approvalPolicy",
            types: ["string", "object"],
            expects: ["never"],
            known: APPROVAL_POLICIES,
          },
          {
            path: "sandbox.type",
            types: S,
            expects: ["readOnly"],
            known: ["dangerFullAccess", "externalSandbox", "workspaceWrite"],
          },
          { path: "sandbox.{type=readOnly}.networkAccess", types: B, expects: [false] },
          { path: "instructionSources", types: A },
          { path: "runtimeWorkspaceRoots", types: A },
        ],
      },
    },
    {
      method: "mcpServerStatus/list",
      params: [object("", ["limit"]), sent("limit", I)],
      response: {
        definition: "ListMcpServerStatusResponse",
        reads: [
          { path: "data", types: A },
          { path: "nextCursor", types: orNull(S), expects: [null] },
        ],
      },
    },
    {
      method: "turn/start",
      params: [
        object("", [
          "threadId",
          "cwd",
          "approvalPolicy",
          "sandboxPolicy",
          "environments",
          "runtimeWorkspaceRoots",
          "effort",
          "model",
          "outputSchema",
          "input",
        ]),
        sent("threadId", S),
        sent("cwd", S),
        sent("approvalPolicy", S, "never"),
        sent("sandboxPolicy.type", S, "readOnly"),
        object("sandboxPolicy.{type=readOnly}", ["type"]),
        sent("environments", A),
        sent("runtimeWorkspaceRoots", A),
        sent("effort", S, effort),
        sent("model", S),
        sent("outputSchema", O),
        sent("input", A),
        sent("input[].type", S, "text", "localImage"),
        object("input[].{type=text}", ["type", "text", "text_elements"]),
        sent("input[].{type=text}.text", S),
        sent("input[].{type=text}.text_elements", A),
        object("input[].{type=localImage}", ["type", "path"]),
        sent("input[].{type=localImage}.path", S),
      ],
      response: { definition: "TurnStartResponse", reads: [{ path: "turn.id", types: S }] },
    },
    {
      method: "turn/interrupt",
      params: [object("", ["threadId", "turnId"]), sent("threadId", S), sent("turnId", S)],
    },
  ];
}

/** The notifications and the server request humanish consumes, and its reply to that request. */
const MESSAGES: readonly ProtocolMessage[] = [
  // Where the baseline carries items; a release that moves them refuses (ITEM_CARRIERS).
  {
    method: "thread/started",
    definition: "ThreadStartedNotification",
    reads: [
      { path: "thread", types: orNull(O) },
      { path: "thread.turns", types: orNull(A) },
      { path: "thread.turns[].items", types: orNull(A) },
    ],
  },
  {
    method: "turn/started",
    definition: "TurnStartedNotification",
    reads: [
      { path: "threadId", types: S },
      { path: "turn.id", types: S },
      { path: "turn.items", types: orNull(A) },
    ],
  },
  {
    method: "turn/completed",
    definition: "TurnCompletedNotification",
    reads: [
      { path: "threadId", types: S },
      { path: "turn.id", types: S },
      {
        path: "turn.status",
        types: S,
        expects: ["completed", "interrupted"],
        known: ["failed", "inProgress"],
      },
      { path: "turn.error", types: orNull(O), expects: [null] },
      { path: "turn.items", types: orNull(A) },
    ],
  },
  { method: "item/started", definition: "ItemStartedNotification", reads: startedReads },
  { method: "item/completed", definition: "ItemCompletedNotification", reads: completedReads },
  {
    method: "item/agentMessage/delta",
    definition: "AgentMessageDeltaNotification",
    reads: [...scope, { path: "delta", types: S }],
  },
  {
    method: "rawResponseItem/completed",
    definition: "RawResponseItemCompletedNotification",
    reads: [
      ...scope,
      {
        path: "item.type",
        types: S,
        expects: ["message", "reasoning", "custom_tool_call", "function_call"],
        known: RAW_ITEM_TYPES,
      },
      { path: "item.{type=custom_tool_call}.name", types: S, expects: ["exec"] },
      { path: "item.{type=function_call}.name", types: S, expects: ["wait"] },
      { path: "item.{type=message}.content", types: A },
      // humanish stops on a "refusal" content item, which the baseline schema does not list.
      {
        path: "item.{type=message}.content[].type",
        types: S,
        known: ["input_text", "input_image", "input_audio", "output_text", "refusal"],
      },
    ],
  },
  {
    method: "thread/tokenUsage/updated",
    definition: "ThreadTokenUsageUpdatedNotification",
    reads: [
      ...scope,
      { path: "tokenUsage.total.inputTokens", types: I },
      { path: "tokenUsage.total.outputTokens", types: I },
      { path: "tokenUsage.total.cachedInputTokens", types: I },
      { path: "tokenUsage.total.cacheWriteInputTokens", types: I },
    ],
  },
  {
    method: "item/tool/call",
    definition: "DynamicToolCallParams",
    reads: [
      ...scope,
      { path: "callId", types: S },
      { path: "tool", types: S },
      { path: "namespace", types: orNull(S), expects: [null] },
      { path: "arguments" },
    ],
    reply: {
      definition: "DynamicToolCallResponse",
      sends: [
        object("", ["success", "contentItems"]),
        sent("success", B, true),
        sent("contentItems", A),
        sent("contentItems[].type", S, "inputText"),
        object("contentItems[].{type=inputText}", ["type", "text"]),
        sent("contentItems[].{type=inputText}.text", S),
      ],
    },
  },
];

/** A container that stops being an array or object would hide its items from the item policy. */
const ITEM_CARRIERS: readonly ProtocolFieldRule[] = [
  { path: "items", types: orNull(A), optional: true },
  { path: "turn", types: orNull(O), optional: true },
  { path: "turn.items", types: orNull(A), optional: true },
  { path: "thread", types: orNull(O), optional: true },
  { path: "thread.turns", types: orNull(A), optional: true },
  { path: "thread.turns[]", types: O, optional: true },
  { path: "thread.turns[].items", types: orNull(A), optional: true },
];

/**
 * The contract for one launch. config/read's `config` is typed only for some keys; the keys
 * humanish pins that the schema leaves open are checked at launch by admitsRestrictedCodexConfig,
 * which compares exact values, so they are not listed here.
 */
export function protocolContract(host: ProtocolContractHost): ProtocolContract {
  return {
    requests: [...handshakeRequests(host), ...threadRequests(host)],
    messages: MESSAGES,
    itemCarriers: ITEM_CARRIERS,
  };
}
