// The app-server protocol humanish depends on: each method it calls with the request fields it
// sends and the response fields it reads, and each notification and server request it consumes.
// protocol-compat.ts checks a release's generated schema against this table on every launch.
//
// Types and known values are the baseline of every release this humanish admits. A rule's
// `expects` lists the values humanish compares against; one a release drops refuses the launch.
// `known` lists every value the baseline offers; one beyond it is recorded and the launch goes on.

export type ProtocolPrimitive =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

/** One field humanish reads or a value it sends. */
export interface ProtocolFieldRule {
  /** Dot path under the definition. `name[]` is its array items; `{field=value}` selects a branch. */
  readonly path: string;
  /** The types humanish accepts; a release that allows another refuses. Omitted: presence only. */
  readonly types?: readonly ProtocolPrimitive[];
  readonly expects?: readonly string[];
  readonly known?: readonly string[];
}

interface ProtocolRequest {
  readonly method: string;
  /** Every params field humanish sends; a field the release newly requires refuses. */
  readonly sends: readonly string[];
  /** Values humanish sends that must stay valid, checked against the params definition. */
  readonly sentValues?: readonly ProtocolFieldRule[];
  /** The response definition, named here because the schema does not link it to its method. */
  readonly response?: { readonly definition: string; readonly reads: readonly ProtocolFieldRule[] };
}

interface ProtocolMessage {
  /** The notification method, or the server request humanish answers. */
  readonly method: string;
  readonly definition: string;
  readonly reads: readonly ProtocolFieldRule[];
}

export interface ProtocolContract {
  readonly requests: readonly ProtocolRequest[];
  readonly messages: readonly ProtocolMessage[];
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

/** The fields an item notification carries that humanish reads. */
const itemReads: readonly ProtocolFieldRule[] = [
  ...scope,
  {
    path: "item.type",
    types: S,
    expects: ["userMessage", "agentMessage", "reasoning", "contextCompaction", "dynamicToolCall"],
    known: THREAD_ITEM_TYPES,
  },
  { path: "item.{type=agentMessage}.id", types: S },
  { path: "item.{type=agentMessage}.text", types: S },
  {
    path: "item.{type=agentMessage}.phase",
    types: orNull(S),
    expects: ["final_answer", "commentary"],
    known: [],
  },
  { path: "item.{type=agentMessage}.delivery", types: orNull(S), known: ["async"] },
  { path: "item.{type=agentMessage}.questions", types: orNull(A) },
  { path: "item.{type=dynamicToolCall}.tool", types: S },
  { path: "item.{type=dynamicToolCall}.namespace", types: orNull(S) },
  {
    path: "item.{type=dynamicToolCall}.status",
    types: S,
    expects: ["inProgress", "completed"],
    known: ["failed"],
  },
  { path: "item.{type=dynamicToolCall}.success", types: orNull(B) },
];

/**
 * The contract. config/read's `config` is typed only for some keys; the keys humanish pins that
 * the schema leaves open are checked at launch by admitsRestrictedCodexConfig, which compares
 * exact values, so they are not listed here.
 */
export const PROTOCOL_CONTRACT: ProtocolContract = {
  requests: [
    {
      method: "initialize",
      sends: ["clientInfo", "capabilities"],
      response: {
        definition: "InitializeResponse",
        reads: [
          { path: "userAgent", types: S },
          { path: "codexHome", types: S },
          { path: "platformOs", types: S },
          { path: "platformFamily", types: S },
        ],
      },
    },
    {
      method: "config/read",
      sends: ["includeLayers", "cwd"],
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
          { path: "layers[].name.file", types: S },
          { path: "layers[].name.profile", types: orNull(S) },
          { path: "layers[].disabledReason", types: orNull(S) },
          { path: "config", types: O },
          { path: "config.model", types: orNull(S) },
          { path: "config.model_provider", types: orNull(S) },
          { path: "config.model_reasoning_effort", types: orNull(S) },
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
          { path: "config.analytics.enabled", types: orNull(B) },
        ],
      },
    },
    {
      method: "account/read",
      sends: ["refreshToken"],
      response: {
        definition: "GetAccountResponse",
        reads: [
          { path: "account", types: orNull(O) },
          {
            path: "account.type",
            types: S,
            expects: ["chatgpt", "apiKey"],
            known: ["amazonBedrock"],
          },
          { path: "requiresOpenaiAuth", types: B },
        ],
      },
    },
    {
      method: "thread/start",
      sends: [
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
      ],
      sentValues: [
        { path: "approvalPolicy", expects: ["never"] },
        { path: "sandbox", expects: ["read-only"] },
      ],
      response: {
        definition: "ThreadStartResponse",
        reads: [
          { path: "thread.id", types: S },
          { path: "thread.ephemeral", types: B },
          { path: "thread.model", types: orNull(S) },
          { path: "thread.modelProvider", types: S },
          { path: "thread.reasoningEffort", types: orNull(S) },
          { path: "thread.cliVersion", types: S },
          { path: "thread.environments", types: orNull(A) },
          { path: "thread.path", types: orNull(S) },
          { path: "thread.cwd", types: S },
          { path: "model", types: S },
          { path: "modelProvider", types: S },
          { path: "reasoningEffort", types: orNull(S) },
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
          { path: "sandbox.{type=readOnly}.networkAccess", types: B },
          { path: "instructionSources", types: A },
          { path: "runtimeWorkspaceRoots", types: A },
        ],
      },
    },
    {
      method: "mcpServerStatus/list",
      sends: ["limit"],
      response: {
        definition: "ListMcpServerStatusResponse",
        reads: [
          { path: "data", types: A },
          { path: "nextCursor", types: orNull(S) },
        ],
      },
    },
    {
      method: "turn/start",
      sends: [
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
      ],
      sentValues: [
        { path: "approvalPolicy", expects: ["never"] },
        { path: "sandboxPolicy.type", expects: ["readOnly"] },
        { path: "input[].type", expects: ["text", "localImage"] },
      ],
      response: { definition: "TurnStartResponse", reads: [{ path: "turn.id", types: S }] },
    },
    { method: "turn/interrupt", sends: ["threadId", "turnId"] },
  ],
  messages: [
    {
      method: "turn/started",
      definition: "TurnStartedNotification",
      reads: [
        { path: "threadId", types: S },
        { path: "turn.id", types: S },
        { path: "turn.items", types: A },
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
        { path: "turn.error", types: orNull(O) },
        { path: "turn.items", types: A },
      ],
    },
    { method: "item/started", definition: "ItemStartedNotification", reads: itemReads },
    { method: "item/completed", definition: "ItemCompletedNotification", reads: itemReads },
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
        { path: "item.{type=custom_tool_call}.name", types: S },
        { path: "item.{type=function_call}.name", types: S },
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
        { path: "namespace", types: orNull(S) },
        { path: "arguments" },
      ],
    },
  ],
};
