import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, SCRIPTED_BROWSER_CAPABILITIES, type ActorPersonaRef } from "../src/actor-contract.js";
import { getActor, isCuaActorDescriptor, isScriptedBrowserActorDescriptor } from "../src/actor-registry.js";
import {
  runScriptedBrowserSession,
  browserSurfaces,
  type BrowserPersonaJourney,
  type ScriptedBrowserLike,
  type ScriptedLocatorLike,
  type ScriptedPageLike
} from "../src/scripted-browser-actor.js";

// ---------------------------------------------------------------------------
// Fake browser: a tiny in-memory "app" behind the structural seams, driven by
// the REAL step executor and expectation evaluator. screenshot() writes real
// bytes so evidence-presence checks observe the same truth a live run would.
// ---------------------------------------------------------------------------

interface FakeAppOptions {
  /** Selector -> match count (default 1 for any selector). */
  selectorCounts?: Record<string, number>;
  /** Body text after a click step ran (lets stateChanged/waitForText pass or fail). */
  bodyAfterClick?: string;
  initialBody?: string;
  /** Make goto reject (unreachable subject). */
  gotoError?: string;
  /** Make goto hang forever (wall-clock timeout). */
  gotoHangs?: boolean;
}

function makeFakeBrowser(options: FakeAppOptions = {}): { browser: ScriptedBrowserLike; state: { url: string; body: string } } {
  const state = { url: "about:blank", body: options.initialBody ?? "landing page" };

  const locatorFor = (selector: string): ScriptedLocatorLike => {
    const count = options.selectorCounts?.[selector] ?? 1;
    const locator: ScriptedLocatorLike = {
      first: () => locator,
      fill: async () => undefined,
      click: async () => {
        state.body = options.bodyAfterClick ?? state.body;
      },
      count: async () => count,
      waitFor: async () => {
        if (count === 0) throw new Error(`Timeout waiting for selector ${selector}`);
      },
      isVisible: async () => count > 0
    };
    return locator;
  };

  const page: ScriptedPageLike = {
    goto: async (url) => {
      if (options.gotoHangs) {
        return new Promise(() => undefined);
      }
      if (options.gotoError) {
        throw new Error(options.gotoError);
      }
      state.url = url;
      return undefined;
    },
    locator: locatorFor,
    waitForTimeout: async () => undefined,
    waitForFunction: async (_fn, needle) => {
      if (typeof needle === "string" && state.body.includes(needle)) {
        return undefined;
      }
      throw new Error(`Timeout waiting for text ${String(needle)}`);
    },
    screenshot: async ({ path: screenshotPath }) => {
      await writeFile(screenshotPath, Buffer.from(`fake-frame:${state.body}`));
      return undefined;
    },
    url: () => state.url,
    evaluate: async <T,>() => state.body as unknown as T
  };

  const browser: ScriptedBrowserLike = {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => undefined
  };
  return { browser, state };
}

const persona: ActorPersonaRef = { id: "scripted-journey", traitsApplied: [], promptDigest: "abcd1234abcd1234" };

function demoJourney(): BrowserPersonaJourney {
  return {
    goal: "Load the app, submit the primary form, and confirm the success state renders.",
    scenarioId: "scripted-first-run",
    scenarioTitle: "First-run scripted walkthrough",
    source: "mimetic/scenarios/scripted-first-run.yaml",
    sourceDigest: "abcd1234abcd",
    startPath: "/",
    steps: [
      { action: "goto", id: "step-01-load", label: "Load landing page", path: "/", expectation: { selectorVisible: "main" } },
      { action: "fill", id: "step-02-fill-email", label: "Fill the signup email", selector: "input[type='email']", value: "synthetic.user@example.test" },
      { action: "click", id: "step-03-submit", label: "Submit the form", selector: "button[type='submit']", expectation: { stateChanged: true } },
      { action: "waitForText", id: "step-04-confirm", label: "Confirm success copy", expectation: { text: "Welcome" } }
    ]
  };
}

async function withHttpServer<T>(callback: (appUrl: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<main>landing page</main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await callback(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("runScriptedBrowserSession (completion semantics through the REAL step executor)", () => {
  const surface = browserSurfaces[0]!;
  let artifactRoot: string;

  beforeEach(async () => {
    artifactRoot = await mkdtemp(path.join(tmpdir(), "mimetic-scripted-actor-"));
  });

  afterEach(async () => {
    await rm(artifactRoot, { recursive: true, force: true });
  });

  it("goal_satisfied: every step executed, every assertion passed, probe ok", async () => {
    await withHttpServer(async (appUrl) => {
      const { browser } = makeFakeBrowser({ bodyAfterClick: "Welcome aboard" });
      const result = await runScriptedBrowserSession({
        appUrl,
        journey: demoJourney(),
        surface,
        persona,
        timeoutMs: 10_000,
        artifactRoot,
        launchBrowser: async () => browser
      });

      expect(result.status).toBe("passed");
      expect(result.completionReason).toBe("goal_satisfied");
      expect(result.capture.ok).toBe(true);
      expect(result.capture.steps.map((step) => step.status)).toEqual(["passed", "passed", "passed", "passed"]);

      // ActorTrace projection pins.
      const trace = result.trace;
      expect(trace.schema).toBe(ACTOR_TRACE_SCHEMA);
      expect(trace.provider).toBe("browser-persona");
      expect(trace.protocol).toBe("scripted-steps");
      expect(trace.lane).toBe("scripted-browser");
      expect(trace.capabilities).toEqual(SCRIPTED_BROWSER_CAPABILITIES);
      expect(trace.persona).toEqual(persona);
      expect(trace.items).toHaveLength(4);
      for (const item of trace.items) {
        expect(item.kind).toBe("ui_action");
        expect(item.lifecycle).toBe("completed");
        expect(item.status).toBe("passed");
        expect(item.title.length).toBeLessThanOrEqual(120);
        expect(item.screenshotRef).toEqual({ path: expect.stringContaining("screenshots/desktop-"), redaction: "none" });
      }
      // counts.actions mirrors the engagement-check contract; screenshots are honest (on disk).
      expect(trace.counts).toEqual({ steps: 4, actions: 4, assertions: 3, blocked: 0, screenshots: 4 });
      // Affirmative $0 declaration, true by mechanism.
      expect(trace.tokenUsage).toEqual({ input: 0, output: 0, total: 0, costUsd: 0 });
      // No session/model ids exist — absence declared by omission.
      expect(trace.ids).toEqual({});
      expect(trace.redaction.status).toBe("passed");
      expect(trace.redaction.screenshots).toBe("raw");

      // The native mimetic.browser-persona-trace.v1 is kept on disk.
      const native = JSON.parse(await readFile(path.join(artifactRoot, "traces", "desktop.json"), "utf8"));
      expect(native.schema).toBe("mimetic.browser-persona-trace.v1");
      expect(native.scenario.sourceDigest).toBe("abcd1234abcd");
      expect(native.steps).toHaveLength(4);
    });
  });

  it("step_failed: an expectation evaluated false (subject failed the script; harness ran faithfully)", async () => {
    await withHttpServer(async (appUrl) => {
      // Click does not change the body -> stateChanged blocks, waitForText never sees Welcome.
      const { browser } = makeFakeBrowser({});
      const result = await runScriptedBrowserSession({
        appUrl,
        journey: demoJourney(),
        surface,
        persona,
        timeoutMs: 10_000,
        artifactRoot,
        launchBrowser: async () => browser
      });

      expect(result.status).toBe("failed");
      expect(result.completionReason).toBe("step_failed");
      // reason names the FIRST failing step id + its captured reason.
      expect(result.reason).toContain("step-03-submit");
      expect(result.trace.counts.blocked).toBeGreaterThan(0);
      expect(result.trace.status).toBe("failed");
    });
  });

  it("step_failed: a step target is missing (selector not found); remaining steps are not claimed", async () => {
    await withHttpServer(async (appUrl) => {
      const { browser } = makeFakeBrowser({ selectorCounts: { "button[type='submit']": 0 } });
      const result = await runScriptedBrowserSession({
        appUrl,
        journey: demoJourney(),
        surface,
        persona,
        timeoutMs: 10_000,
        artifactRoot,
        launchBrowser: async () => browser
      });

      expect(result.status).toBe("failed");
      expect(result.completionReason).toBe("step_failed");
      expect(result.reason).toContain("step-03-submit");
      expect(result.reason).toContain("found no target");
      // Driver behavior preserved: the in-flight step is recorded blocked; steps beyond it are
      // not fabricated as executed.
      expect(result.capture.steps.map((step) => step.status)).toEqual(["passed", "passed", "blocked"]);
      expect(result.trace.counts.actions).toBe(3);
    });
  });

  it("step_failed: unreachable subject (probe refused, first goto throws)", async () => {
    // No HTTP server: the probe fails AND goto rejects — the declared subject was not serving.
    const { browser } = makeFakeBrowser({ gotoError: "net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/" });
    const result = await runScriptedBrowserSession({
      appUrl: "http://127.0.0.1:9/",
      journey: demoJourney(),
      surface,
      persona,
      timeoutMs: 5_000,
      artifactRoot,
      launchBrowser: async () => browser
    });

    expect(result.status).toBe("failed");
    expect(result.completionReason).toBe("step_failed");
    expect(result.capture.steps.every((step) => step.status === "blocked")).toBe(true);
  });

  it("timed_out: the journey exceeds its wall-clock budget", async () => {
    await withHttpServer(async (appUrl) => {
      const { browser } = makeFakeBrowser({ gotoHangs: true });
      const result = await runScriptedBrowserSession({
        appUrl,
        journey: demoJourney(),
        surface,
        persona,
        timeoutMs: 50,
        artifactRoot,
        launchBrowser: async () => browser
      });

      expect(result.status).toBe("timed_out");
      expect(result.completionReason).toBe("timed_out");
      expect(result.reason).toContain("wall-clock budget");
    });
  });

  it("harness_error: the browser cannot launch (failure owned by the harness, not the subject)", async () => {
    const result = await runScriptedBrowserSession({
      appUrl: "http://127.0.0.1:9/",
      journey: demoJourney(),
      surface,
      persona,
      timeoutMs: 5_000,
      artifactRoot,
      launchBrowser: async () => {
        throw new Error("chromium executable missing");
      }
    });

    expect(result.status).toBe("failed");
    expect(result.completionReason).toBe("harness_error");
    expect(result.reason).toContain("launch failed");
    // The failure still persists an honest native trace (all steps blocked, ok: false).
    const native = JSON.parse(await readFile(path.join(artifactRoot, "traces", "desktop.json"), "utf8"));
    expect(native.ok).toBe(false);
    expect((native.steps as Array<{ status: string }>).every((step) => step.status === "blocked")).toBe(true);
    // No screenshots exist, so the projection declares none rather than claiming raw frames.
    expect(result.trace.redaction.screenshots).toBe("n/a");
    expect(result.trace.counts.screenshots).toBe(0);
  });

  it("gave_up and blocked_approval are UNREACHABLE from this actor (no persona patience, no approvals)", () => {
    const source = readFileSync(path.resolve("src/scripted-browser-actor.ts"), "utf8");
    expect(source).not.toContain('"gave_up"');
    expect(source).not.toContain('"blocked_approval"');
  });
});

describe("scripted-browser registry entry", () => {
  it("is registered with the scripted-browser lane and the session runner", () => {
    const descriptor = getActor("scripted-browser");
    expect(descriptor.id).toBe("scripted-browser");
    expect(descriptor.capabilities).toEqual(SCRIPTED_BROWSER_CAPABILITIES);
    expect(isScriptedBrowserActorDescriptor(descriptor)).toBe(true);
    expect(isCuaActorDescriptor(descriptor)).toBe(false);
    expect(typeof descriptor.runSession).toBe("function");
  });

  it("the lane guard does not claim non-scripted actors", () => {
    expect(isScriptedBrowserActorDescriptor(getActor("openai-computer-use"))).toBe(false);
    expect(isScriptedBrowserActorDescriptor(getActor("codex-app-server"))).toBe(false);
  });
});
