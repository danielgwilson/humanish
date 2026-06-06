import {
  runCodexAppServerSession,
  type CodexAppServerRunOptions,
  type CodexAppServerRunResult
} from "./codex-app-server.js";
import {
  CODEX_APP_SERVER_CAPABILITIES,
  codexResultToActorTrace,
  type ActorCapabilities,
  type ActorPersonaRef,
  type ActorTrace
} from "./actor-contract.js";

// The set of pluggable actor harnesses. One member today; the union grows as
// pi-agent-core, claude-agent-sdk, and stagehand-cua adapters land. See
// docs/architecture/actor-contract.md.
export type ActorId = "codex-app-server";

export interface ActorDescriptor {
  id: ActorId;
  label: string;
  capabilities: ActorCapabilities;
  // Drive the harness and return its native result. The signature is the
  // existing Codex one today; later adapters generalize behind ActorRunInput.
  runSession(options: CodexAppServerRunOptions): Promise<CodexAppServerRunResult>;
  // Map a native result into the provider-neutral ActorTrace.
  toActorTrace(result: CodexAppServerRunResult, persona: ActorPersonaRef): ActorTrace;
}

export const actorRegistry: Record<ActorId, ActorDescriptor> = {
  "codex-app-server": {
    id: "codex-app-server",
    label: "Codex App-Server",
    capabilities: CODEX_APP_SERVER_CAPABILITIES,
    runSession: runCodexAppServerSession,
    toActorTrace: codexResultToActorTrace
  }
};

export function getActor(id: ActorId): ActorDescriptor {
  const actor = actorRegistry[id];
  if (!actor) {
    throw new Error(`Unknown actor: ${String(id)}`);
  }
  return actor;
}
