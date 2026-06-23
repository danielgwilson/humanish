import { createServer, type Server } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import {
  ACTOR_TRACE_SCHEMA,
  LAB_CONFIG_SCHEMA,
  parseLabConfig,
  runLab,
  verifyRun,
  type ActorCapabilities,
  type CuaAction,
  type CuaExecutor,
  type CuaObservation,
  type CuaProvider,
  type CuaTurn
} from "mimetic-cli";

type LocalAppState = {
  route: string;
  turn: number;
  greeted: boolean;
};

type LocalAppContract = {
  getState(): LocalAppState;
  sendChat(text: string): void;
};

function createSyntheticLocalApp(): LocalAppContract {
  let turn = 0;
  let greeted = false;

  return {
    getState() {
      return { route: greeted ? "/greeted" : "/home", turn, greeted };
    },
    sendChat(text: string) {
      turn += 1;
      if (text.toLowerCase().includes("hello")) greeted = true;
    }
  };
}

function createAppContractExecutor(app: LocalAppContract, appUrl: string): CuaExecutor {
  // A browser/page bridge would use appUrl to reach window.app.* through page.evaluate.
  // This minimal example keeps the contract in process so it runs with no browser,
  // no E2B sandbox, and no provider spend.
  void appUrl;

  return {
    async observe(): Promise<CuaObservation> {
      const state = app.getState();
      return {
        stateSignature: JSON.stringify({ route: state.route, turn: state.turn }),
        appState: { ...state }
      };
    },
    async execute(action: CuaAction): Promise<void> {
      if (action.kind === "type") app.sendChat(action.text);
    }
  };
}

const STATE_PROVIDER_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: false,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open"
};

function createStateBrain(): CuaProvider {
  return {
    id: "state-contract-example-brain",
    version: "0.1.0",
    requiresFrame: false,
    capabilities: STATE_PROVIDER_CAPABILITIES,
    async nextTurn(req): Promise<CuaTurn> {
      const state = (req.observation.appState ?? {}) as { greeted?: boolean };
      if (state.greeted === true) {
        return {
          actions: [],
          pendingSafetyChecks: [],
          done: true,
          message: "Goal satisfied: the app reports greeted through getState()."
        };
      }

      return {
        actions: [{ kind: "type", text: "hello from a synthetic persona" }],
        pendingSafetyChecks: [],
        done: false,
        reasoning: "getState() reports that the synthetic user has not greeted the app yet."
      };
    }
  };
}

async function startLoopbackApp(): Promise<{ appUrl: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>State contract example</title><h1>State contract example</h1>");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { appUrl: `http://127.0.0.1:${port}/`, server };
}

async function main() {
  const cwd = path.join(tmpdir(), `mimetic-state-example-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
  const { appUrl, server } = await startLoopbackApp();

  try {
    const app = createSyntheticLocalApp();
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "state-driven-local-app-example",
      title: "State-driven local-app example",
      subject: { source: "local-app", appUrl },
      actors: [
        {
          type: "openai-computer-use",
          persona: "synthetic-newcomer",
          mission: "Greet the local app, then stop when getState() reports greeted."
        }
      ],
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);

    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        buildExecutor: async ({ appUrl: entryUrl }) => createAppContractExecutor(app, entryUrl),
        buildProvider: async () => createStateBrain()
      }
    });

    if (outcome.backend !== "cua") throw new Error(`Expected CUA backend, got ${outcome.backend}`);
    const result = outcome.result;
    if (!result.ok) throw new Error(`Run failed: ${result.error?.message ?? "unknown error"}`);
    if (result.sandbox !== undefined) throw new Error("Expected result.sandbox === undefined. No E2B sandbox should be created.");

    const verified = await verifyRun(cwd, result.runId);
    if (!verified.ok) throw new Error(`verifyRun failed: ${verified.error?.message ?? "unknown error"}`);

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as {
      streams?: Array<{ actor?: { schema?: string; provider?: string; redaction?: { screenshots?: string; notes?: string[] } } }>;
    };
    const actor = bundle.streams?.[0]?.actor;

    console.log(JSON.stringify({
      ok: true,
      runId: result.runId,
      completionReason: result.session?.completionReason,
      sandbox: result.sandbox,
      proof: "result.sandbox === undefined; No E2B sandbox was created.",
      actorSchema: actor?.schema,
      expectedActorSchema: ACTOR_TRACE_SCHEMA,
      provider: actor?.provider,
      screenshotRedaction: actor?.redaction?.screenshots,
      verify: verified.ok
    }, null, 2));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}

await main();
