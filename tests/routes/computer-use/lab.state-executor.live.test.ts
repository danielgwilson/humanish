import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retainLiveRuns } from "../../helpers/live-retention.js";

import type { ActorCapabilities } from "../../../src/actors/contract.js";
import { ACTOR_TRACE_SCHEMA } from "../../../src/actors/contract.js";
import type {
  CuaAction,
  CuaObservation,
  CuaProvider,
  CuaTurn,
  CuaExecutor,
} from "../../../src/actors/computer-use/loop.js";
import { V2_SCHEMA } from "../../../src/study/types.js";
import { parseStudy } from "../../../src/study/config.js";
import { runLab } from "../../../src/run-lab.js";
import { verifyRun } from "../../../src/verify/verify.js";

// The single live rung for the state-driven (in-process, no-E2B, no-vision) route: the
// downstream local-app consumer shape. It is $0 by mechanism (no provider spend, no
// E2B sandbox), but it is gated exactly like the other live rungs so CI never runs it by
// accident and the orchestrator can run it post-merge for a kept receipt:
//   1. HUMANISH_LIVE_CUA=1 must be set explicitly (the live opt-in convention).
// Unlike the desktop rungs it needs no OPENAI_API_KEY / E2B_API_KEY: the caller's own executor
// and provider drive the loop. The subject is a real already-running local app (a node http
// server on loopback) exposing a window.app.* style state contract; a real CuaExecutor reads
// getState() (no screenshot), and a fake-but-real-shaped non-vision provider (requiresFrame
// falsey) reasons over appState. Asserts: the run reaches goal_satisfied via getState(), no E2B
// sandbox was created (result.sandbox === undefined), and the bundle verifies.
const LIVE = process.env.HUMANISH_LIVE_CUA === "1";

// A minimal "already-running local app" with an in-process JS automation contract. The HTTP
// server stands in for the real dev server; the contract is reached here directly (a library
// caller would reach window.app.* via a thin page.evaluate bridge). State advances on sendChat.
interface LocalApp {
  getState(): { route: string; turn: number; greeted: boolean };
  sendChat(text: string): void;
}

function makeLocalApp(): LocalApp {
  let turn = 0;
  let greeted = false;
  return {
    getState() {
      return { route: greeted ? "/greeted" : "/home", turn, greeted };
    },
    sendChat(text: string) {
      turn += 1;
      if (text.toLowerCase().includes("hello")) greeted = true;
    },
  };
}

// A real state executor over the app's contract. observe() returns no screenshot and surfaces
// getState() as appState; execute() maps the model intent onto the contract.
function createAppContractExecutor(app: LocalApp, appUrl: string): CuaExecutor {
  // appUrl is unused for routing here (the bridge is in-process); kept to mirror the public
  // inProcess.executor ctx, which passes the entry appUrl to a real bridge.
  void appUrl;
  return {
    async observe(): Promise<CuaObservation> {
      const s = app.getState();
      return {
        stateSignature: JSON.stringify({ route: s.route, turn: s.turn }),
        appState: s as unknown as Record<string, unknown>,
      };
    },
    async execute(action: CuaAction): Promise<void> {
      if (action.kind === "type") app.sendChat(action.text);
    },
  };
}

const STATE_CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: false,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open",
};

// A fake-but-real-shaped non-vision provider: it reasons over req.observation.appState (never a
// screenshot), greets once, then declares the goal satisfied once the app reports greeted.
function createStateBrain(): CuaProvider {
  return {
    id: "downstream-local-app-state-brain",
    version: "0.1.0",
    requiresFrame: false,
    capabilities: STATE_CAPS,
    async nextTurn(req): Promise<CuaTurn> {
      const state = (req.observation.appState ?? {}) as { greeted?: boolean };
      if (state.greeted === true) {
        return {
          actions: [],
          pendingSafetyChecks: [],
          done: true,
          message: "Goal satisfied: the app reports greeted via getState().",
        };
      }
      return {
        actions: [{ kind: "type", text: "hello there" }],
        pendingSafetyChecks: [],
        done: false,
        reasoning: "app state shows not greeted yet",
      };
    },
  };
}

describe.skipIf(!LIVE)("cua-actor-lab state-driven executor (live rung, no E2B, no vision)", () => {
  let cwd: string;
  let server: Server;
  let appUrl: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-state-live-"));
    // A real already-running local dev server on loopback (the subject the lab points at).
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><h1>Local state app</h1>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    appUrl = `http://127.0.0.1:${port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await retainLiveRuns(cwd, "cua-state-executor");
  });

  it(
    "drives an already-running local app via getState() to goal_satisfied with no E2B sandbox",
    { timeout: 60_000 },
    async () => {
      const app = makeLocalApp();
      const parsed = parseStudy({
        schema: V2_SCHEMA,
        id: "downstream-local-app-state",
        title: "State-driven local app (live rung)",
        subject: { source: "local-app", appUrl },
        actors: [
          {
            type: "openai-computer-use",
            persona: "pixel-pat",
            mission: "Greet the app, then stop when getState() reports greeted.",
          },
        ],
        scenario: { mode: "live" },
      });
      if (!parsed.ok) throw new Error(parsed.error.message);

      const outcome = await runLab(parsed.config, {
        cwd,
        inProcess: { executor: async (ctx) => createAppContractExecutor(app, ctx.appUrl) },
        createProvider: async () => createStateBrain(),
      });

      expect(outcome.route).toBe("computer-use");
      if (outcome.route !== "computer-use") return;
      const result = outcome.result;

      // The acceptance proof: goal_satisfied via getState(), and no E2B sandbox created.
      expect(result.session?.completionReason).toBe("goal_satisfied");
      expect(result.sandbox).toBeUndefined();
      expect("streamUrl" in result).toBe(false);
      expect(result.ok).toBe(true);

      const runDir = path.join(cwd, ".humanish", "runs", result.runId);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
      expect(bundle.streams[0].actor.schema).toBe(ACTOR_TRACE_SCHEMA);
      expect(bundle.streams[0].actor.provider).toBe("downstream-local-app-state-brain");
      expect(bundle.streams[0].actor.redaction.screenshots).toBe("n/a");
      expect(bundle.streams[0].actor.redaction.notes).toContain("App state was observed");
      // appState never persists.
      expect(JSON.stringify(bundle)).not.toContain('"appState"');
      expect(JSON.stringify(bundle)).not.toContain("/greeted");

      const verified = await verifyRun(cwd, result.runId);
      expect(verified.ok).toBe(true);
    },
  );
});
