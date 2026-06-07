import {
  runCodexAppServerSession,
  type CodexAppServerRunOptions,
  type CodexAppServerRunResult
} from "./codex-app-server.js";
import {
  CLAUDE_AGENT_SDK_CAPABILITIES,
  CODEX_APP_SERVER_CAPABILITIES,
  PI_AGENT_CORE_CAPABILITIES,
  codexResultToActorTrace,
  type ActorCapabilities,
  type ActorPersonaRef,
  type ActorTrace
} from "./actor-contract.js";
import { piSessionToActorTrace, type PiSessionResult } from "./pi-agent-core.js";
import {
  claudeSessionToActorTrace,
  runClaudeAgentSession,
  type ClaudeAgentSessionOptions,
  type ClaudeAgentSessionResult,
  type ClaudeSessionResult
} from "./claude-agent-sdk.js";

// The set of pluggable actor harnesses. The union grows as adapters land
// (stagehand-cua next). See docs/architecture/actor-contract.md.
export type ActorId = "codex-app-server" | "pi-agent-core" | "claude-agent-sdk";

interface ActorDescriptorBase {
  id: ActorId;
  label: string;
  capabilities: ActorCapabilities;
}

export interface CodexActorDescriptor extends ActorDescriptorBase {
  id: "codex-app-server";
  // Drive the harness and return its native result, then map it to ActorTrace.
  runSession(options: CodexAppServerRunOptions): Promise<CodexAppServerRunResult>;
  toActorTrace(result: CodexAppServerRunResult, persona: ActorPersonaRef): ActorTrace;
}

// pi exposes ONLY the pure mapper in this slice: live invocation is deferred
// behind a DI seam (see src/pi-agent-core.ts header), so the descriptor honestly
// advertises just the mapping capability that exists today.
export interface PiActorDescriptor extends ActorDescriptorBase {
  id: "pi-agent-core";
  toActorTrace(session: PiSessionResult, persona: ActorPersonaRef): ActorTrace;
}

// The Claude descriptor now exposes a live runSession (drives the SDK query() and
// writes evidence artifacts) alongside the pure mapper. The SDK is an optional
// peer loaded lazily; tests inject a fake queryFn via runSession's options.
export interface ClaudeActorDescriptor extends ActorDescriptorBase {
  id: "claude-agent-sdk";
  runSession(options: ClaudeAgentSessionOptions): Promise<ClaudeAgentSessionResult>;
  toActorTrace(session: ClaudeSessionResult, persona: ActorPersonaRef): ActorTrace;
}

export type ActorDescriptor = CodexActorDescriptor | PiActorDescriptor | ClaudeActorDescriptor;

export const actorRegistry: Record<ActorId, ActorDescriptor> = {
  "codex-app-server": {
    id: "codex-app-server",
    label: "Codex App-Server",
    capabilities: CODEX_APP_SERVER_CAPABILITIES,
    runSession: runCodexAppServerSession,
    toActorTrace: codexResultToActorTrace
  },
  "pi-agent-core": {
    id: "pi-agent-core",
    label: "pi Agent Core",
    capabilities: PI_AGENT_CORE_CAPABILITIES,
    toActorTrace: piSessionToActorTrace
  },
  "claude-agent-sdk": {
    id: "claude-agent-sdk",
    label: "Claude Agent SDK",
    capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
    runSession: runClaudeAgentSession,
    toActorTrace: claudeSessionToActorTrace
  }
};

// Overloads narrow the return type per id so codex call sites keep their exact
// signatures (e.g. getActor("codex-app-server").runSession(...) stays valid).
export function getActor(id: "codex-app-server"): CodexActorDescriptor;
export function getActor(id: "pi-agent-core"): PiActorDescriptor;
export function getActor(id: "claude-agent-sdk"): ClaudeActorDescriptor;
export function getActor(id: ActorId): ActorDescriptor;
export function getActor(id: ActorId): ActorDescriptor {
  const actor = actorRegistry[id];
  if (!actor) {
    throw new Error(`Unknown actor: ${String(id)}`);
  }
  return actor;
}
