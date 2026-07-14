import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorCapabilities, type ActorTrace } from "../src/actor-contract.js";
import { getActor } from "../src/actor-registry.js";
import {
  runScriptedBrowserSession,
  browserSurfaces,
  type ScriptedBrowserLike,
  type ScriptedLocatorLike,
  type ScriptedPageLike
} from "../src/scripted-browser-actor.js";
import { buildClaudeSession, buildCodexResult, buildPiSession, fixturePersona } from "./actor-fixtures.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lp9J1wAAAABJRU5ErkJggg==",
  "base64"
);

// The shared contract every adapter's ActorTrace must satisfy. This is what makes
// the harnesses interchangeable (ADR step 7): one persona run through codex and pi
// yields the same trace shape, completion vocabulary, and redaction status.
const ACTOR_STATUSES = ["passed", "failed", "blocked", "timed_out"];
const COMPLETION_REASONS = [
  "goal_satisfied",
  "turn_completed",
  "gave_up",
  "blocked_approval",
  "timed_out",
  "actor_error",
  // The scripted-browser lane's reason: a deterministic step/expectation evaluated false —
  // the subject failed the script while the harness executed faithfully.
  "step_failed",
  "harness_error"
];
const ITEM_KINDS = [
  "message",
  "reasoning",
  "tool_call",
  "command",
  "file_change",
  "approval",
  "screenshot",
  "ui_action",
  "plan",
  "notice"
];

function assertConformsToActorTrace(trace: ActorTrace): void {
  expect(trace.schema).toBe(ACTOR_TRACE_SCHEMA);
  expect(typeof trace.provider).toBe("string");
  expect(["json-rpc", "json-stream", "in-process-sdk", "cua-loop", "scripted-steps"]).toContain(trace.protocol);
  expect(["code", "app", "computer-use", "scripted-browser"]).toContain(trace.lane);
  expect(ACTOR_STATUSES).toContain(trace.status);
  expect(COMPLETION_REASONS).toContain(trace.completionReason);
  expect(typeof trace.reason).toBe("string");
  expect(typeof trace.startedAt).toBe("string");
  expect(typeof trace.completedAt).toBe("string");
  expect(typeof trace.durationMs).toBe("number");

  expect(trace.redaction.status).toBe("passed");
  expect(typeof trace.redaction.notes).toBe("string");
  expect(["n/a", "raw", "blurred", "ocr_scrubbed"]).toContain(trace.redaction.screenshots);

  expect(typeof trace.ids).toBe("object");
  expect(trace.ids).not.toBeNull();

  expect(typeof trace.persona.id).toBe("string");
  expect(Array.isArray(trace.persona.traitsApplied)).toBe(true);
  expect(typeof trace.persona.promptDigest).toBe("string");

  const capabilities = trace.capabilities as unknown as Record<keyof ActorCapabilities, unknown>;
  for (const key of ["headless", "structuredTrace", "producesScreenshots", "byoModel", "preGrantableApprovals", "inProcessTools"] as const) {
    expect(typeof capabilities[key]).toBe("boolean");
  }
  expect(Array.isArray(trace.capabilities.lanes)).toBe(true);
  expect(["open", "source-available", "proprietary"]).toContain(trace.capabilities.license);

  for (const value of Object.values(trace.counts)) {
    expect(typeof value).toBe("number");
  }

  for (const item of trace.items) {
    expect(typeof item.id).toBe("string");
    expect(ITEM_KINDS).toContain(item.kind);
    expect(["started", "completed"]).toContain(item.lifecycle);
    expect(typeof item.title).toBe("string");
  }

  expect(JSON.stringify(trace)).not.toContain("/Users/");
  expect(JSON.stringify(trace)).not.toContain("/private/");
}

describe("cross-harness ActorTrace conformance", () => {
  const codex = getActor("codex-app-server").toActorTrace(buildCodexResult(), fixturePersona);
  const pi = getActor("pi-agent-core").toActorTrace(buildPiSession(), fixturePersona);
  const claude = getActor("claude-agent-sdk").toActorTrace(buildClaudeSession(), fixturePersona);
  const traces = [
    { name: "codex-app-server", trace: codex },
    { name: "pi-agent-core", trace: pi },
    { name: "claude-agent-sdk", trace: claude }
  ];

  for (const { name, trace } of traces) {
    it(`${name} produces a conformant trace`, () => {
      assertConformsToActorTrace(trace);
    });
  }

  it("all adapters emit the identical envelope shape (same top-level keys)", () => {
    const codexKeys = Object.keys(codex).sort();
    expect(Object.keys(pi).sort()).toEqual(codexKeys);
    expect(Object.keys(claude).sort()).toEqual(codexKeys);
  });

  it("all adapters thread the same persona reference identically", () => {
    for (const { trace } of traces) {
      expect(trace.persona).toEqual(fixturePersona);
    }
  });

  it("all adapters use the shared status and completion-reason vocabulary", () => {
    for (const { trace } of traces) {
      expect(ACTOR_STATUSES).toContain(trace.status);
      expect(COMPLETION_REASONS).toContain(trace.completionReason);
    }
  });

  it("all adapters report redaction passed", () => {
    for (const { trace } of traces) {
      expect(trace.redaction.status).toBe("passed");
    }
  });

  it("each adapter declares its own distinct provider and protocol", () => {
    expect(codex.provider).toBe("codex-app-server");
    expect(pi.provider).toBe("pi-agent-core");
    expect(claude.provider).toBe("claude-agent-sdk");
    expect(codex.protocol).toBe("json-rpc");
    expect(pi.protocol).toBe("in-process-sdk");
    expect(claude.protocol).toBe("in-process-sdk");
    expect(new Set(traces.map((entry) => entry.trace.provider)).size).toBe(3);
  });
});

// The scripted-browser actor has no pure mapper (runSession returns the fully-formed trace),
// so its conformance fixture runs the REAL session against a fake browser at $0.
describe("scripted-browser ActorTrace conformance", () => {
  it("a scripted session trace conforms to humanish.actor-trace.v1", async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "humanish-scripted-conformance-"));
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<main>conformance fixture</main>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await runScriptedBrowserSession({
        appUrl: `http://127.0.0.1:${port}/`,
        journey: {
          goal: "Conformance fixture journey.",
          scenarioId: "conformance-journey",
          scenarioTitle: "Conformance journey",
          source: "humanish/scenarios/conformance-journey.yaml",
          sourceDigest: "abcdef123456",
          startPath: "/",
          steps: [
            { action: "goto", id: "step-01", label: "Load", path: "/", expectation: { selectorVisible: "main" } },
            { action: "click", id: "step-02", label: "Act", selector: "button", expectation: { stateChanged: true } }
          ]
        },
        surface: browserSurfaces[0]!,
        persona: fixturePersona,
        timeoutMs: 10_000,
        artifactRoot,
        launchBrowser: async () => makeConformanceFakeBrowser()
      });

      assertConformsToActorTrace(result.trace);
      expect(result.trace.provider).toBe("browser-persona");
      expect(result.trace.protocol).toBe("scripted-steps");
      expect(result.trace.lane).toBe("scripted-browser");
      expect(result.trace.persona).toEqual(fixturePersona);
      expect(result.trace.completionReason).toBe("goal_satisfied");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});

function makeConformanceFakeBrowser(): ScriptedBrowserLike {
  const state = { url: "about:blank", body: "conformance fixture" };
  const locator: ScriptedLocatorLike = {
    first: () => locator,
    fill: async () => undefined,
    click: async () => {
      state.body = "conformance fixture changed";
    },
    count: async () => 1,
    waitFor: async () => undefined,
    isVisible: async () => true
  };
  const page: ScriptedPageLike = {
    goto: async (url) => {
      state.url = url;
      return undefined;
    },
    locator: () => locator,
    waitForTimeout: async () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async ({ path: screenshotPath }) => {
      if (screenshotPath) await writeFile(screenshotPath, PNG_1X1);
      return PNG_1X1;
    },
    url: () => state.url,
    evaluate: async <T,>() => state.body as unknown as T
  };
  return {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => undefined
  };
}
