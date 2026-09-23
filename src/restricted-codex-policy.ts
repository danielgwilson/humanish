/** Versioned, deliberately narrow profile qualified with an account-backed vision turn.
 * The CLI still advertises code-mode tools: disabling their host is the enforcement
 * boundary. Feature names alone are not proof that a tool has been removed. */
export const RESTRICTED_CODEX_ANALYSIS_IDENTITY = {
  provider: "codex", authMode: "chatgpt", modelProvider: "openai", cliVersion: "0.154.0",
  toolPolicy: "restricted-codex-v1", reasoningEffort: "low"
} as const;
export const RESTRICTED_CODEX_ANALYSIS_MODELS = ["gpt-6-astra"] as const;

export type RestrictedCodexAnalysisErrorCode = "invalid_request" | "cancelled" | "timeout"
  | "response_too_large" | "invalid_response" | "refusal" | "output_incomplete"
  | "codex_unavailable" | "codex_unsupported_version" | "codex_unsupported_platform"
  | "codex_login_required" | "codex_unsupported_auth" | "codex_unsafe_configuration"
  | "codex_model_unavailable" | "codex_protocol_error" | "codex_tool_call"
  | "codex_process_failed" | "codex_cleanup_failed" | "codex_busy";

export interface RestrictedCodexRequest {
  model: string;
  instructions: string;
  evidence: string;
  images: { evidenceId: string; dataUrl: string }[];
  schema: Record<string, unknown>;
  maxOutputTokens: number | null;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface RestrictedCodexUsage { input: number; output: number; cachedInput?: number; cacheWriteInput?: number }
export interface RestrictedCodexResult {
  status: "completed" | "incomplete" | "refused" | "failed" | "cancelled" | "timed_out";
  output: unknown;
  usage: RestrictedCodexUsage | null;
  usageComplete: boolean;
  dispatched: boolean;
  errorCode: RestrictedCodexAnalysisErrorCode | null;
}

export const CODEX_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const CODEX_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const CODEX_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const CODEX_MAX_EVENTS = 1000;
export const CODEX_IMAGE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export const codexRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const empty = (value: unknown): boolean => value === null || value === undefined
  || (typeof value === "object" && Object.keys(value).length === 0);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1e12;

const disabledFeatures = ["apps", "plugins", "hooks", "shell_tool", "shell_snapshot", "view_image", "image_generation",
  "skill_search", "skill_mcp_dependency_install", "multi_agent", "multi_agent_v2", "browser_use", "browser_use_external",
  "computer_use", "memories", "external_agent_memory_import", "goals", "sleep_tool", "tool_suggest", "code_mode",
  "code_mode_host", "code_mode_only", "default_mode_request_user_input", "unbounded_connection_retries",
  "workspace_dependencies", "remote_plugin", "recommended_plugins", "in_app_local_automation"] as const;

export function restrictedCodexConfig(model: string): { toml: string; overrides: Record<string, unknown> } {
  const overrides: Record<string, unknown> = {
    model, model_provider: "openai", model_reasoning_effort: "low", approval_policy: "never", sandbox_mode: "read-only",
    forced_login_method: "chatgpt", project_doc_max_bytes: 0, web_search: "disabled", "history.persistence": "none",
    "analytics.enabled": false, "features.skip_host_skill_discovery": true, "skills.bundled.enabled": false,
    "agents.enabled": false, "agents.max_threads": 1, "agents.max_depth": 1
  };
  for (const name of disabledFeatures) overrides[`features.${name}`] = false;
  const toml = `model = ${JSON.stringify(model)}
model_provider = "openai"
model_reasoning_effort = "low"
approval_policy = "never"
sandbox_mode = "read-only"
forced_login_method = "chatgpt"
project_doc_max_bytes = 0
web_search = "disabled"
[history]
persistence = "none"
[analytics]
enabled = false
[features]
skip_host_skill_discovery = true
${disabledFeatures.map(name => `${name} = false`).join("\n")}
[skills.bundled]
enabled = false
[agents]
enabled = false
max_threads = 1
max_depth = 1
`;
  return { toml, overrides };
}

/** Inspect before thread/start, which could otherwise start inherited integrations. */
export function admitsRestrictedCodexConfig(raw: unknown, configPath: string, model: string): boolean {
  const root = codexRecord(raw), config = codexRecord(root.config), features = codexRecord(config.features);
  if (!Array.isArray(root.layers) || root.layers.length === 0) return false;
  let ownLayer = false;
  for (const rawLayer of root.layers) {
    const layer = codexRecord(rawLayer), name = codexRecord(layer.name);
    if (name.type === "user" && name.file === configPath && name.profile === null
      && (layer.disabledReason === null || layer.disabledReason === undefined)) {
      if (ownLayer) return false;
      ownLayer = true;
    } else if (name.type !== "system" || !empty(layer.config)) return false;
  }
  if (!ownLayer || config.model !== model || config.model_provider !== "openai" || config.model_reasoning_effort !== "low"
    || config.forced_login_method !== "chatgpt" || config.sandbox_mode !== "read-only" || config.approval_policy !== "never"
    || config.project_doc_max_bytes !== 0 || config.web_search !== "disabled" || features.skip_host_skill_discovery !== true
    || codexRecord(config.history).persistence !== "none" || codexRecord(config.analytics).enabled !== false
    || disabledFeatures.some(name => features[name] !== false)) return false;
  const agents = codexRecord(config.agents), skills = codexRecord(config.skills);
  if (agents.enabled !== false || agents.max_concurrent_threads_per_session !== 1 || agents.max_depth !== 1
    || codexRecord(skills.bundled).enabled !== false || Object.keys(skills).some(key => key !== "bundled")) return false;
  for (const key of ["mcp_servers", "plugins", "hooks", "notify", "instructions", "developer_instructions", "permissions",
    "profiles", "projects", "model_providers", "experimental_compact_prompt_file", "experimental_model_instructions_file", "model_instructions_file",
    "model_catalog_json", "openai_base_url", "orchestrator", "experimental_thread_store", "experimental_thread_store_endpoint",
    "experimental_realtime_ws_base_url", "experimental_realtime_webrtc_call_base_url", "forced_chatgpt_workspace_id",
    "log_dir", "sqlite_home", "otel", "marketplaces", "js_repl_node_path", "js_repl_node_module_dirs", "responses_api_metadata",
    "compact_prompt", "profile", "default_permissions", "auto_review", "apps", "browser_use", "computer_use", "desktop", "memories", "realtime"])
    if (!empty(config[key])) return false;
  if (Object.values(codexRecord(config.shell_environment_policy)).some(value => !empty(value))) return false;
  return config.cli_auth_credentials_store === "file" && config.chatgpt_base_url === "https://chatgpt.com/backend-api/";
}

export function admitsRestrictedCodexThread(raw: unknown, model: string, cwd: string): boolean {
  const value = codexRecord(raw), thread = codexRecord(value.thread), sandbox = codexRecord(value.sandbox);
  return typeof thread.id === "string" && thread.id.length > 0 && thread.id.length <= 200
    && thread.ephemeral === true && thread.model === model && thread.modelProvider === "openai"
    && thread.reasoningEffort === "low" && thread.cliVersion === RESTRICTED_CODEX_ANALYSIS_IDENTITY.cliVersion
    && Array.isArray(thread.environments) && thread.environments.length === 0 && thread.path === null
    && value.model === model && value.modelProvider === "openai" && value.reasoningEffort === "low"
    && value.cwd === cwd && thread.cwd === cwd && value.approvalPolicy === "never"
    && sandbox.type === "readOnly" && sandbox.networkAccess === false
    && Array.isArray(value.instructionSources) && value.instructionSources.length === 0
    && Array.isArray(value.runtimeWorkspaceRoots) && value.runtimeWorkspaceRoots.length === 0;
}

export function restrictedCodexRequestError(request: RestrictedCodexRequest): RestrictedCodexAnalysisErrorCode | null {
  if (request.signal?.aborted) return "cancelled";
  if (!RESTRICTED_CODEX_ANALYSIS_MODELS.some(model => model === request.model)) return "codex_model_unavailable";
  if (request.maxOutputTokens !== null || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 600_000
    || typeof request.instructions !== "string" || typeof request.evidence !== "string" || !Array.isArray(request.images)
    || request.images.length > 128 || !request.schema || typeof request.schema !== "object" || Array.isArray(request.schema)) return "invalid_request";
  try {
    if (new TextEncoder().encode(JSON.stringify({ instructions: request.instructions, evidence: request.evidence,
      images: request.images, schema: request.schema })).byteLength > CODEX_MAX_REQUEST_BYTES) return "invalid_request";
    let imageBytes = 0;
    for (const image of request.images) {
      if (typeof image.evidenceId !== "string" || image.evidenceId.length === 0 || image.evidenceId.length > 300
        || typeof image.dataUrl !== "string") return "invalid_request";
      const match = CODEX_IMAGE.exec(image.dataUrl);
      if (!match) return "invalid_request";
      const decoded = atob(match[2]!);
      imageBytes += decoded.length;
      if (btoa(decoded) !== match[2] || imageBytes > 20 * 1024 * 1024) return "invalid_request";
    }
    return null;
  } catch { return "invalid_request"; }
}

export function restrictedCodexUsage(raw: unknown): RestrictedCodexUsage | null {
  const total = codexRecord(codexRecord(raw).total);
  const input = total.inputTokens, output = total.outputTokens, cachedInput = total.cachedInputTokens, cacheWriteInput = total.cacheWriteInputTokens;
  if (!count(input) || !count(output) || !count(cachedInput) || !count(cacheWriteInput) || cachedInput + cacheWriteInput > input) return null;
  return { input, output, cachedInput, cacheWriteInput };
}

export function restrictedCodexFailure(errorCode: RestrictedCodexAnalysisErrorCode, dispatched = false,
  usage: RestrictedCodexUsage | null = null): RestrictedCodexResult {
  return { status: errorCode === "cancelled" ? "cancelled" : errorCode === "timeout" ? "timed_out"
    : errorCode === "refusal" ? "refused" : errorCode === "output_incomplete" ? "incomplete" : "failed",
  output: null, usage, usageComplete: false, dispatched, errorCode };
}
