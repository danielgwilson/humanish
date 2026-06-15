import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorCapabilities } from "../src/actor-contract.js";
import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import type { CuaAction, CuaObservation, CuaProvider, CuaTurn, CuaExecutor } from "../src/computer-use.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";
import { verifyRun } from "../src/run.js";

// The single LIVE rung for the STATE-DRIVEN (in-process, no-E2B, no-vision) lab route — the
// pixel-bae library snippet shape from issue #148. It is $0 BY MECHANISM (no provider spend, no
// E2B sandbox), but it is gated EXACTLY like the other live rungs so CI never runs it by
// accident and the orchestrator can run it post-merge for a kept receipt:
//   1. MIMETIC_LIVE_CUA=1 must be set explicitly (the live opt-in convention).
// Unlike the desktop rungs it needs NO OPENAI_API_KEY / E2B_API_KEY — the caller's own executor
// and provider drive the loop. The subject is a REAL already-running LOCAL app (a node http
// server on loopback) exposing a window.app.* style state contract; a REAL CuaExecutor reads
// getState() (NO screenshot), and a fake-but-real-shaped NON-vision provider (requiresFrame
// falsey) reasons over appState. Asserts: the run reaches goal_satisfied via getState(), NO E2B
// sandbox was created (result.sandbox === undefined), and the bundle verifies.
const LIVE = process.env.MIMETIC_LIVE_CUA === "1";

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
    }
  };
}

// A REAL state executor over the app's contract. observe() returns NO screenshot and surfaces
// getState() as appState; execute() maps the model intent onto the contract.
function createAppContractExecutor(app: LocalApp, appUrl: string): CuaExecutor {
  // appUrl is unused for routing here (the bridge is in-process); kept to mirror the public
  // buildExecutor ctx, which passes the entry appUrl to a real bridge.
  void appUrl;
  return {
    async observe(): Promise<CuaObservation> {
      const s = app.getState();
      return {
        stateSignature: JSON.stringify({ route: s.route, turn: s.turn }),
        appState: s as unknown as Record<string, unknown>
      };
    },
    async execute(action: CuaAction): Promise<void> {
      if (action.kind === "type") app.sendChat(action.text);
    }
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
  license: "open"
};

// A fake-but-real-shaped NON-vision provider: it reasons over req.observation.appState (never a
// screenshot), greets once, then declares the goal satisfied once the app reports greeted.
function createStateBrain(): CuaProvider {
  return {
    id: "pixel-bae-state-brain",
    version: "0.1.0",
    requiresFrame: false,
    capabilities: STATE_CAPS,
    async nextTurn(req): Promise<CuaTurn> {
      const state = (req.observation.appState ?? {}) as { greeted?: boolean };
      if (state.greeted === true) {
        return { actions: [], pendingSafetyChecks: [], done: true, message: "Goal satisfied: the app reports greeted via getState()." };
      }
      return { actions: [{ kind: "type", text: "hello there" }], pendingSafetyChecks: [], done: false, reasoning: "app state shows not greeted yet" };
    }
  };
}

describe.skipIf(!LIVE)("cua-actor-lab state-driven executor (LIVE rung, no E2B, no vision) — issue #148", () => {
  let cwd: string;
  let server: Server;
  let appUrl: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-state-live-"));
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
    await rm(cwd, { recursive: true, force: true });
  });

  it("drives an already-running local app via getState() to goal_satisfied with NO E2B sandbox", { timeout: 60_000 }, async () => {
    const app = makeLocalApp();
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "pixel-bae-state",
      title: "State-driven local app (live rung)",
      subject: { source: "local-app", appUrl },
      actors: [{ type: "openai-computer-use", persona: "pixel-pat", mission: "Greet the app, then stop when getState() reports greeted." }],
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);

    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        buildExecutor: async (ctx) => createAppContractExecutor(app, ctx.appUrl),
        buildProvider: async () => createStateBrain()
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    // The acceptance proof: goal_satisfied via getState(), and NO E2B sandbox created.
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.sandbox).toBeUndefined();
    expect("streamUrl" in result).toBe(false);
    expect(result.ok).toBe(true);

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(bundle.streams[0].actor.provider).toBe("pixel-bae-state-brain");
    expect(bundle.streams[0].actor.redaction.screenshots).toBe("n/a");
    expect(bundle.streams[0].actor.redaction.notes).toContain("App state was observed");
    // appState never persists.
    expect(JSON.stringify(bundle)).not.toContain('"appState"');
    expect(JSON.stringify(bundle)).not.toContain("/greeted");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });
});
