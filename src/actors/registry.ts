import {
  runCodexAppServerSession,
  type CodexAppServerRunOptions,
  type CodexAppServerRunResult,
} from "./codex/app-server.js";
import {
  CODEX_APP_SERVER_CAPABILITIES,
  SCRIPTED_BROWSER_CAPABILITIES,
  TERMINAL_AGENT_CAPABILITIES,
  type ActorCapabilities,
  type ActorPersonaRef,
  type ActorTrace,
} from "./contract.js";
import { codexResultToActorTrace } from "./codex/app-server-actor-trace.js";
import { runCuaActorSession, type CuaActorSessionOptions } from "./computer-use/actor.js";
import { LOCAL_AGENT_CAPABILITIES } from "./local-agent/cli.js";
import type { CuaLoopResult } from "./computer-use/loop.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES } from "./computer-use/openai-provider.js";
import {
  runScriptedBrowserSession,
  type ScriptedBrowserSessionOptions,
  type ScriptedBrowserSessionResult,
} from "./scripted-browser/actor.js";

// Closed first-party actor registry. These ids are implemented in core; supported out-of-tree
// actor registration does not ship. See docs/architecture/actor-contract.md.
export type ActorId =
  | "codex-app-server"
  | "openai-computer-use"
  | "local-agent"
  | "scripted-browser"
  | "codex-exec";

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

// CuaActorDescriptor covers every actor of the computer-use run kind. The ids share a session
// entry and differ in where the provider comes from: local-agent builds it from the operator's
// signed-in CLI, openai-computer-use from a keyed API client. The id stays distinct because it is
// the slot a lab names when it chooses a brain. There is no toActorTrace: runComputerUseLoop
// already returns a complete ActorTrace at result.trace, so a mapper would be an identity
// function. The union is intentionally heterogeneous: each descriptor exposes only the entries
// it has.
export interface CuaActorDescriptor extends ActorDescriptorBase {
  id: "openai-computer-use" | "local-agent";
  runSession(options: CuaActorSessionOptions): Promise<CuaLoopResult>;
}

// The scripted descriptor exposes runSession only (no toActorTrace): runScriptedBrowserSession
// already returns a fully-formed ActorTrace at result.trace (the CUA shape), so a mapper would
// be a no-op identity.
export interface ScriptedBrowserActorDescriptor extends ActorDescriptorBase {
  id: "scripted-browser";
  runSession(options: ScriptedBrowserSessionOptions): Promise<ScriptedBrowserSessionResult>;
}

// The terminal descriptor has no runSession. The terminal agent runs inside runTerminalProductLab
// (src/routes/terminal/route.ts), which creates the sandbox, enforces command-scoped runtime auth
// and caps, captures evidence and destroys the sandbox by id as one lifecycle. The registry holds
// its capabilities, which route selection and key-placement enforcement read.
export interface TerminalActorDescriptor extends ActorDescriptorBase {
  id: "codex-exec";
}

export type ActorDescriptor =
  | CodexActorDescriptor
  | CuaActorDescriptor
  | ScriptedBrowserActorDescriptor
  | TerminalActorDescriptor;

/**
 * Registry contract: an actor whose capabilities include the "computer-use" run kind is a
 * CuaActorDescriptor: its runSession takes CuaActorSessionOptions and returns a CuaLoopResult.
 * Any future computer-use provider (e.g. stagehand-cua) must keep that session signature and add
 * its id to CuaActorDescriptor["id"], so code narrowed by this guard can still tell the ids apart.
 * This guard is what lets the lab dispatch on capabilities rather than on hardcoded actor ids.
 */
export function isCuaActorDescriptor(
  descriptor: ActorDescriptor,
): descriptor is CuaActorDescriptor {
  return descriptor.capabilities.lanes.includes("computer-use");
}

/**
 * Registry contract (mirror of isCuaActorDescriptor): an actor whose capabilities include the
 * "scripted-browser" run kind is a ScriptedBrowserActorDescriptor; runSession takes
 * ScriptedBrowserSessionOptions and returns ScriptedBrowserSessionResult (trace fully formed,
 * like the CUA shape; no separate toActorTrace). Any future scripted driver (e.g. a HAR
 * replayer) must keep this signature; it is what lets the lab dispatch on capabilities, not ids.
 */
export function isScriptedBrowserActorDescriptor(
  descriptor: ActorDescriptor,
): descriptor is ScriptedBrowserActorDescriptor {
  return descriptor.capabilities.lanes.includes("scripted-browser");
}

/**
 * Registry contract (mirror of isCuaActorDescriptor / isScriptedBrowserActorDescriptor): an actor
 * whose capabilities include the "terminal" run kind is a TerminalActorDescriptor. This is the
 * guard the terminal-product route uses for route selection and capability enforcement. The current
 * descriptor's direct runSession is intentionally unsupported; live execution is route-owned. Any
 * future terminal actor must declare the keyPlacement it uses and integrate with that lifecycle.
 */
export function isTerminalActorDescriptor(
  descriptor: ActorDescriptor,
): descriptor is TerminalActorDescriptor {
  return descriptor.capabilities.lanes.includes("terminal");
}

export const actorRegistry: Record<ActorId, ActorDescriptor> = {
  "codex-app-server": {
    id: "codex-app-server",
    label: "Codex App-Server",
    capabilities: CODEX_APP_SERVER_CAPABILITIES,
    runSession: runCodexAppServerSession,
    toActorTrace: codexResultToActorTrace,
  },
  // The ActorId names the actor slot (keeps the slot open for a future stagehand-cua
  // provider); the trace's `provider` string stays "openai-responses-cu" (the concrete model
  // adapter). The operator's own signed-in coding agent as the computer-use brain (Codex on a
  // ChatGPT plan, Claude Code on a Max plan). Same run kind, same loop, same evidence; the only
  // difference is where the next action comes from, which is exactly why it is a provider swap and
  // not a new run kind. It exists so someone new can watch a persona drive a real desktop
  // without first going to find an API key; the machine they are on very often already has one of
  // these signed in.
  "local-agent": {
    id: "local-agent",
    label: "Local coding agent (operator-authenticated)",
    capabilities: LOCAL_AGENT_CAPABILITIES,
    runSession: runCuaActorSession,
  },
  "openai-computer-use": {
    id: "openai-computer-use",
    label: "OpenAI Computer Use",
    capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
    runSession: runCuaActorSession,
  },
  // Same naming convention: the ActorId names the slot; the trace's `provider` stays the
  // concrete driver name "browser-persona" (matching the native
  // humanish.browser-persona-trace.v1 evidence it already emits).
  "scripted-browser": {
    id: "scripted-browser",
    label: "Scripted Browser (deterministic Playwright steps)",
    capabilities: SCRIPTED_BROWSER_CAPABILITIES,
    runSession: runScriptedBrowserSession,
  },
  // The ActorId names the terminal-product dispatch slot; the live route records the concrete
  // provider as "codex". keyPlacement "in-sandbox-command-scoped" is registry-declared and
  // enforced by runTerminalProductLab before it creates a sandbox, which is where this actor runs.
  "codex-exec": {
    id: "codex-exec",
    label: "Codex Exec (autonomous terminal agent, in-sandbox)",
    capabilities: TERMINAL_AGENT_CAPABILITIES,
  },
};

// Overloads narrow the return type per id so codex call sites keep their exact
// signatures (e.g. getActor("codex-app-server").runSession(...) stays valid).
export function getActor(id: "codex-app-server"): CodexActorDescriptor;
export function getActor(id: CuaActorDescriptor["id"]): CuaActorDescriptor;
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
