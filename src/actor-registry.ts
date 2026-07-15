import {
  runCodexAppServerSession,
  type CodexAppServerRunOptions,
  type CodexAppServerRunResult
} from "./codex-app-server.js";
import {
  CLAUDE_AGENT_SDK_CAPABILITIES,
  CODEX_APP_SERVER_CAPABILITIES,
  PI_AGENT_CORE_CAPABILITIES,
  SCRIPTED_BROWSER_CAPABILITIES,
  TERMINAL_AGENT_CAPABILITIES,
  codexResultToActorTrace,
  type ActorCapabilities,
  type ActorPersonaRef,
  type ActorTrace
} from "./actor-contract.js";
import {
  runTerminalAgentSession,
  type TerminalAgentSessionOptions,
  type TerminalAgentSessionResult
} from "./terminal-agent-actor.js";
import { piSessionToActorTrace, type PiSessionResult } from "./pi-agent-core.js";
import {
  claudeSessionToActorTrace,
  runClaudeAgentSession,
  type ClaudeAgentSessionOptions,
  type ClaudeAgentSessionResult,
  type ClaudeSessionResult
} from "./claude-agent-sdk.js";
import { runCuaActorSession, type CuaActorSessionOptions } from "./computer-use-actor.js";
import type { CuaLoopResult } from "./computer-use.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES } from "./openai-responses-cu.js";
import {
  runScriptedBrowserSession,
  type ScriptedBrowserSessionOptions,
  type ScriptedBrowserSessionResult
} from "./scripted-browser-actor.js";

// Closed first-party actor registry. These ids are implemented in core; supported out-of-tree
// actor registration does not ship. See docs/architecture/actor-contract.md.
export type ActorId = "codex-app-server" | "pi-agent-core" | "claude-agent-sdk" | "openai-computer-use" | "scripted-browser" | "codex-exec";

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

// pi currently exposes ONLY the pure mapper: live invocation is deferred
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

// The CUA descriptor exposes runSession ONLY (no toActorTrace): runComputerUseLoop already
// returns a fully-formed ActorTrace at result.trace, so a mapper would be a no-op identity.
// This mirrors PiActorDescriptor being mapper-only — the union is intentionally heterogeneous.
export interface CuaActorDescriptor extends ActorDescriptorBase {
  id: "openai-computer-use";
  runSession(options: CuaActorSessionOptions): Promise<CuaLoopResult>;
}

// The scripted descriptor exposes runSession ONLY (no toActorTrace): runScriptedBrowserSession
// already returns a fully-formed ActorTrace at result.trace (the CUA shape), so a mapper would
// be a no-op identity.
export interface ScriptedBrowserActorDescriptor extends ActorDescriptorBase {
  id: "scripted-browser";
  runSession(options: ScriptedBrowserSessionOptions): Promise<ScriptedBrowserSessionResult>;
}

// The terminal descriptor's capabilities are load-bearing for terminal-product route selection
// and command-scoped key-placement enforcement. Its runSession member is a fail-closed
// compatibility entry, not the shipped live runner: live execution is route-owned by
// runTerminalProductLab so sandbox lifecycle, caps, evidence, and by-id cleanup stay atomic.
export interface TerminalActorDescriptor extends ActorDescriptorBase {
  id: "codex-exec";
  runSession(options: TerminalAgentSessionOptions): Promise<TerminalAgentSessionResult>;
}

export type ActorDescriptor =
  | CodexActorDescriptor
  | PiActorDescriptor
  | ClaudeActorDescriptor
  | CuaActorDescriptor
  | ScriptedBrowserActorDescriptor
  | TerminalActorDescriptor;

/**
 * REGISTRY CONTRACT: an actor whose capabilities include the "computer-use" lane is a
 * CuaActorDescriptor — its runSession takes CuaActorSessionOptions and returns a CuaLoopResult.
 * Any future computer-use provider (e.g. stagehand-cua) must keep that session signature; this
 * guard is what lets the lab dispatch on capabilities rather than on hardcoded actor ids.
 */
export function isCuaActorDescriptor(descriptor: ActorDescriptor): descriptor is CuaActorDescriptor {
  return descriptor.capabilities.lanes.includes("computer-use");
}

/**
 * REGISTRY CONTRACT (mirror of isCuaActorDescriptor): an actor whose capabilities include the
 * "scripted-browser" lane IS a ScriptedBrowserActorDescriptor — runSession takes
 * ScriptedBrowserSessionOptions and returns ScriptedBrowserSessionResult (trace fully formed,
 * like the CUA shape — no separate toActorTrace). Any future scripted driver (e.g. a HAR
 * replayer) must keep this signature; it is what lets the lab dispatch on capabilities, not ids.
 */
export function isScriptedBrowserActorDescriptor(descriptor: ActorDescriptor): descriptor is ScriptedBrowserActorDescriptor {
  return descriptor.capabilities.lanes.includes("scripted-browser");
}

/**
 * REGISTRY CONTRACT (mirror of isCuaActorDescriptor / isScriptedBrowserActorDescriptor): an actor
 * whose capabilities include the "terminal" lane IS a TerminalActorDescriptor. This is the guard
 * the terminal-product lab uses for route selection and capability enforcement. The current
 * descriptor's direct runSession is intentionally unsupported; live execution is route-owned.
 * Any future terminal actor must declare keyPlacement honestly and integrate with that lifecycle.
 */
export function isTerminalActorDescriptor(descriptor: ActorDescriptor): descriptor is TerminalActorDescriptor {
  return descriptor.capabilities.lanes.includes("terminal");
}

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
  },
  // The ActorId names the actor slot (keeps the lane open for a future stagehand-cua provider);
  // the trace's `provider` string stays "openai-responses-cu" (the concrete model adapter).
  "openai-computer-use": {
    id: "openai-computer-use",
    label: "OpenAI Computer Use",
    capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
    runSession: runCuaActorSession
  },
  // Same naming convention: the ActorId names the slot; the trace's `provider` stays the
  // concrete driver name "browser-persona" (matching the native
  // humanish.browser-persona-trace.v1 evidence it already emits).
  "scripted-browser": {
    id: "scripted-browser",
    label: "Scripted Browser (deterministic Playwright steps)",
    capabilities: SCRIPTED_BROWSER_CAPABILITIES,
    runSession: runScriptedBrowserSession
  },
  // The ActorId names the terminal-product dispatch slot; the live route records the concrete
  // provider as "codex". keyPlacement "in-sandbox-command-scoped" is registry-declared and
  // enforced by runTerminalProductLab before it creates a sandbox. runSession is retained only as
  // a fail-closed compatibility entry; it is not the live route.
  "codex-exec": {
    id: "codex-exec",
    label: "Codex Exec (autonomous terminal agent, in-sandbox)",
    capabilities: TERMINAL_AGENT_CAPABILITIES,
    runSession: runTerminalAgentSession
  }
};

// Overloads narrow the return type per id so codex call sites keep their exact
// signatures (e.g. getActor("codex-app-server").runSession(...) stays valid).
export function getActor(id: "codex-app-server"): CodexActorDescriptor;
export function getActor(id: "pi-agent-core"): PiActorDescriptor;
export function getActor(id: "claude-agent-sdk"): ClaudeActorDescriptor;
export function getActor(id: "openai-computer-use"): CuaActorDescriptor;
export function getActor(id: "scripted-browser"): ScriptedBrowserActorDescriptor;
export function getActor(id: "codex-exec"): TerminalActorDescriptor;
export function getActor(id: ActorId): ActorDescriptor;
export function getActor(id: ActorId): ActorDescriptor {
  const actor = actorRegistry[id];
  if (!actor) {
    throw new Error(`Unknown actor: ${String(id)}`);
  }
  return actor;
}
