import type { ActorRuntimeProvenance } from "./actor-contract.js";
import type { ReasoningEffort } from "./reasoning-effort.js";

export const TERMINAL_RUNTIME_PACKAGE = "@openai/codex";
export const TERMINAL_RUNTIME_VERSION_TIMEOUT_MS = 60_000;

/** Exact semver only: no registry tags, ranges, URLs, or shell syntax. */
export function isExactRuntimeVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 120) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  return match !== null && (match[4]?.split(".").every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0")) ?? true);
}

/** Captured Codex CLI output: `codex-cli 0.153.3\n`. Other shapes fail closed. */
export function parseTerminalRuntimeVersion(stdout: string): string | undefined {
  const match = /^codex-cli ([^\s]+)$/.exec(stdout.trim());
  return match && isExactRuntimeVersion(match[1]) ? match[1] : undefined;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildRuntimeVersionCommand(requestedVersion?: string): string {
  if (requestedVersion !== undefined && !isExactRuntimeVersion(requestedVersion)) throw new Error("Invalid exact Codex runtime version.");
  return `npm_config_update_notifier=false npx -y ${TERMINAL_RUNTIME_PACKAGE}@${requestedVersion ?? "latest"} --version`;
}

export function buildRuntimeExecPrefix(version: string, model?: string, reasoningEffort?: ReasoningEffort): string {
  if (!isExactRuntimeVersion(version)) throw new Error("Codex execution requires a verified exact runtime version.");
  return `npm_config_update_notifier=false npx -y ${TERMINAL_RUNTIME_PACKAGE}@${version} exec`
    + (model === undefined ? "" : ` --model ${shellQuote(model)}`)
    + (reasoningEffort === undefined ? "" : ` -c ${shellQuote(`model_reasoning_effort=${JSON.stringify(reasoningEffort)}`)}`);
}

export function declaredRuntimeProvenance(args: { version?: string; model?: string; reasoningEffort?: ReasoningEffort }): ActorRuntimeProvenance {
  return {
    schema: "humanish.actor-runtime.v1",
    package: TERMINAL_RUNTIME_PACKAGE,
    requestedVersion: args.version ?? "latest",
    versionStatus: "unobserved",
    ...(args.model === undefined ? {} : { requestedModel: args.model }),
    modelStatus: args.model === undefined ? "runtime_default_unobserved" : "declared",
    ...(args.reasoningEffort === undefined ? {} : { requestedReasoningEffort: args.reasoningEffort }),
    usageGranularity: "runtime_turn"
  };
}
