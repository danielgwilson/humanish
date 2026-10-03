import { createServer, type Server } from "node:http";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTOR_TRACE_SCHEMA,
  SCRIPTED_BROWSER_CAPABILITIES,
  type ActorPersonaRef,
} from "../../../src/actors/contract.js";
import {
  getActor,
  isCuaActorDescriptor,
  isScriptedBrowserActorDescriptor,
} from "../../../src/actors/registry.js";
import { runScriptedBrowserSession } from "../../../src/actors/scripted-browser/actor.js";
import {
  browserSurfaces,
  type BrowserPersonaJourney,
  type ScriptedBrowserLike,
  type ScriptedLocatorLike,
  type ScriptedPageLike,
} from "../../../src/actors/scripted-browser/types.js";
import { parseBrowserPersonaJourneyFromScenario } from "../../../src/actors/scripted-browser/journey.js";
import { resolveBrowserCommand } from "../../../src/actors/scripted-browser/browser-command.js";
import { syntheticPng1x1 } from "../../image-fixtures.js";
import { evaluatePagePredicate } from "../../helpers/scripted-page-predicate.js";

const PNG_1X1 = syntheticPng1x1();

// ---------------------------------------------------------------------------
// Fake browser: a tiny in-memory "app" behind the structural seams, driven by
// the real step executor and expectation evaluator. screenshot() writes real
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
  screenshotHook?: () => Promise<void>;
}

function makeFakeBrowser(options: FakeAppOptions = {}): {
  browser: ScriptedBrowserLike;
  state: { url: string; body: string };
} {
  const state = { url: "about:blank", body: options.initialBody ?? "landing page" };

  const locatorFor = (selector: string): ScriptedLocatorLike => {
    const count = options.selectorCounts?.[selector] ?? 1;
    const locator: ScriptedLocatorLike = {
      first: () => locator,
      fill: async () => undefined,
      click: async () => {
        state.body = options.bodyAfterClick ?? state.body;
      },
      press: async () => undefined,
      count: async () => count,
      waitFor: async () => {
        if (count === 0) throw new Error(`Timeout waiting for selector ${selector}`);
      },
      isVisible: async () => count > 0,
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
    keyboard: { press: async () => undefined },
    waitForTimeout: async () => undefined,
    waitForFunction: async (expression) => {
      if (evaluatePagePredicate(expression, state.body)) return undefined;
      throw new Error(`Timeout waiting for ${expression}`);
    },
    screenshot: async ({ path: screenshotPath }) => {
      await options.screenshotHook?.();
      if (screenshotPath) await writeFile(screenshotPath, PNG_1X1);
      return PNG_1X1;
    },
    url: () => state.url,
    evaluate: async <T>() => state.body as unknown as T,
  };

  const browser: ScriptedBrowserLike = {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => undefined,
  };
  return { browser, state };
}

const persona: ActorPersonaRef = {
  id: "scripted-journey",
  traitsApplied: [],
  promptDigest: "abcd1234abcd1234",
};

function demoJourney(): BrowserPersonaJourney {
  return {
    goal: "Load the app, submit the primary form, and confirm the success state renders.",
    scenarioId: "scripted-first-run",
    scenarioTitle: "First-run scripted walkthrough",
    source: "humanish/scenarios/scripted-first-run.yaml",
    sourceDigest: "abcd1234abcd",
    startPath: "/",
    steps: [
      {
        action: "goto",
        id: "step-01-load",
        label: "Load landing page",
        path: "/",
        expectation: { selectorVisible: "main" },
      },
      {
        action: "fill",
        id: "step-02-fill-email",
        label: "Fill the signup email",
        selector: "input[type='email']",
        value: "synthetic.user@example.test",
      },
      {
        action: "click",
        id: "step-03-submit",
        label: "Submit the form",
        selector: "button[type='submit']",
        expectation: { stateChanged: true },
      },
      {
        action: "waitForText",
        id: "step-04-confirm",
        label: "Confirm success copy",
        expectation: { text: "Welcome" },
      },
    ],
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

describe("runScriptedBrowserSession (completion semantics through the real step executor)", () => {
  const surface = browserSurfaces[0]!;
  let artifactRoot: string;

  beforeEach(async () => {
    artifactRoot = await mkdtemp(path.join(tmpdir(), "humanish-scripted-actor-"));
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
        launchBrowser: async () => browser,
      });

      expect(result.status).toBe("passed");
      expect(result.completionReason).toBe("goal_satisfied");
      expect(result.capture.ok).toBe(true);
      expect(result.capture.steps.map((step) => step.status)).toEqual([
        "passed",
        "passed",
        "passed",
        "passed",
      ]);

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
        expect(item.screenshotRef).toEqual({
          path: expect.stringContaining("screenshots/desktop-"),
          redaction: "none",
        });
      }
      // counts.actions mirrors the engagement-check contract; screenshots count only frames on
      // disk.
      expect(trace.counts).toEqual({
        steps: 4,
        actions: 4,
        assertions: 3,
        blocked: 0,
        screenshots: 4,
      });
      // Affirmative $0 declaration, true by mechanism.
      expect(trace.tokenUsage).toEqual({ input: 0, output: 0, total: 0, costUsd: 0 });
      // No session/model ids exist: absence declared by omission.
      expect(trace.ids).toEqual({});
      expect(trace.redaction.status).toBe("passed");
      expect(trace.redaction.screenshots).toBe("raw");

      // The native humanish.browser-persona-trace.v1 is kept on disk.
      const native = JSON.parse(
        await readFile(path.join(artifactRoot, "traces", "desktop.json"), "utf8"),
      );
      expect(native.schema).toBe("humanish.browser-persona-trace.v1");
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
        launchBrowser: async () => browser,
      });

      expect(result.status).toBe("failed");
      expect(result.completionReason).toBe("step_failed");
      // reason names the first failing step id + its captured reason.
      expect(result.reason).toContain("step-03-submit");
      expect(result.trace.counts.blocked).toBeGreaterThan(0);
      expect(result.trace.status).toBe("failed");
    });
  });

  it("step_failed: the state changes but the expected text never appears", async () => {
    await withHttpServer(async (appUrl) => {
      const { browser } = makeFakeBrowser({ bodyAfterClick: "Request received" });
      const result = await runScriptedBrowserSession({
        appUrl,
        journey: demoJourney(),
        surface,
        persona,
        timeoutMs: 2_000,
        artifactRoot,
        launchBrowser: async () => browser,
      });

      expect(result.completionReason).toBe("step_failed");
      expect(result.reason).toContain("step-04-confirm");
      const confirm = result.capture.steps.find((step) => step.id === "step-04-confirm");
      expect(confirm?.status).not.toBe("passed");
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
        launchBrowser: async () => browser,
      });

      expect(result.status).toBe("failed");
      expect(result.completionReason).toBe("step_failed");
      expect(result.reason).toContain("step-03-submit");
      expect(result.reason).toContain("found no target");
      // Driver behavior preserved: the in-flight step is recorded blocked; steps beyond it are
      // not fabricated as executed.
      expect(result.capture.steps.map((step) => step.status)).toEqual([
        "passed",
        "passed",
        "blocked",
      ]);
      expect(result.trace.counts.actions).toBe(3);
    });
  });

  it("step_failed: unreachable subject (probe refused, first goto throws)", async () => {
    // No HTTP server: the probe fails and goto rejects; the declared subject was not serving.
    const { browser } = makeFakeBrowser({
      gotoError: "net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/",
    });
    const result = await runScriptedBrowserSession({
      appUrl: "http://127.0.0.1:9/",
      journey: demoJourney(),
      surface,
      persona,
      timeoutMs: 5_000,
      artifactRoot,
      launchBrowser: async () => browser,
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
        launchBrowser: async () => browser,
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
      },
    });

    expect(result.status).toBe("failed");
    expect(result.completionReason).toBe("harness_error");
    expect(result.reason).toContain("launch failed");
    // The failure still persists a native trace (all steps blocked, ok: false).
    const native = JSON.parse(
      await readFile(path.join(artifactRoot, "traces", "desktop.json"), "utf8"),
    );
    expect(native.ok).toBe(false);
    expect(
      (native.steps as Array<{ status: string }>).every((step) => step.status === "blocked"),
    ).toBe(true);
    // No screenshots exist, so the projection declares none rather than claiming raw frames.
    expect(result.trace.redaction.screenshots).toBe("n/a");
    expect(result.trace.counts.screenshots).toBe(0);
  });

  it("rejects path-shaped surface and step ids before browser launch", async () => {
    let launches = 0;
    const launchBrowser = async (): Promise<ScriptedBrowserLike> => {
      launches += 1;
      return makeFakeBrowser().browser;
    };
    await expect(
      runScriptedBrowserSession({
        appUrl: "http://127.0.0.1:9/",
        journey: demoJourney(),
        surface: { ...surface, id: "../escape" } as unknown as typeof surface,
        persona,
        timeoutMs: 5_000,
        artifactRoot,
        launchBrowser,
      }),
    ).rejects.toThrow(/path segment/i);
    const maliciousJourney = demoJourney();
    maliciousJourney.steps[0] = { ...maliciousJourney.steps[0]!, id: "nested\\escape" };
    await expect(
      runScriptedBrowserSession({
        appUrl: "http://127.0.0.1:9/",
        journey: maliciousJourney,
        surface,
        persona,
        timeoutMs: 5_000,
        artifactRoot,
        launchBrowser,
      }),
    ).rejects.toThrow(/path segment/i);
    expect(launches).toBe(0);
  });

  it("rejects generated root aliases before browser launch", async () => {
    const selected = path.join(artifactRoot, "selected");
    const outside = path.join(artifactRoot, "outside");
    await mkdir(selected);
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel.txt"), "unchanged\n", "utf8");
    await symlink(outside, path.join(selected, "screenshots"), "dir");
    let launches = 0;
    await expect(
      runScriptedBrowserSession({
        appUrl: "http://127.0.0.1:9/",
        journey: demoJourney(),
        surface,
        persona,
        timeoutMs: 5_000,
        artifactRoot: selected,
        launchBrowser: async () => {
          launches += 1;
          return makeFakeBrowser().browser;
        },
      }),
    ).rejects.toThrow(/symbolic links/i);
    expect(launches).toBe(0);
    expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
  });

  it("retains selected-root identity across browser launch", async () => {
    const first = path.join(artifactRoot, "first");
    const second = path.join(artifactRoot, "second");
    const alias = path.join(artifactRoot, "selected-alias");
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(second, "sentinel.txt"), "unchanged\n", "utf8");
    await symlink(first, alias, "dir");
    const fake = makeFakeBrowser();
    let closes = 0;
    const browser: ScriptedBrowserLike = {
      ...fake.browser,
      close: async () => {
        closes += 1;
      },
    };

    await expect(
      runScriptedBrowserSession({
        appUrl: "http://127.0.0.1:9/",
        journey: demoJourney(),
        surface,
        persona,
        timeoutMs: 5_000,
        artifactRoot: alias,
        launchBrowser: async () => {
          await rm(alias);
          await symlink(second, alias, "dir");
          return browser;
        },
      }),
    ).rejects.toThrow(/changed physical destination/i);
    expect(closes).toBe(1);
    expect(await readFile(path.join(second, "sentinel.txt"), "utf8")).toBe("unchanged\n");
    await expect(access(path.join(second, "traces", "desktop.json"))).rejects.toThrow();
  });

  it("does not let an awaitable screenshot hook redirect bytes through a hardlink", async () => {
    await withHttpServer(async (appUrl) => {
      const outside = path.join(artifactRoot, "outside-screenshot.png");
      const target = path.join(artifactRoot, "screenshots", "desktop-step-01-load.png");
      await writeFile(outside, "unchanged\n", "utf8");
      let planted = false;
      const { browser } = makeFakeBrowser({
        bodyAfterClick: "Welcome aboard",
        screenshotHook: async () => {
          if (planted) return;
          planted = true;
          try {
            await link(outside, target);
          } catch (error) {
            const code = error instanceof Error && "code" in error ? String(error.code) : "";
            if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
            throw error;
          }
        },
      });
      const result = await runScriptedBrowserSession({
        appUrl,
        journey: demoJourney(),
        surface,
        persona,
        timeoutMs: 10_000,
        artifactRoot,
        launchBrowser: async () => browser,
      });
      expect(result.status).toBe("failed");
      expect(await readFile(outside, "utf8")).toBe("unchanged\n");
      expect(await readFile(target, "utf8")).toBe("unchanged\n");
    });
  });

  it("redacts provisioned subject URLs from persisted evidence while driving the raw app URL", async () => {
    await withHttpServer(async (appUrl) => {
      const { browser, state } = makeFakeBrowser({ bodyAfterClick: "Welcome aboard" });
      const result = await runScriptedBrowserSession({
        appUrl,
        evidenceAppUrl: "[provisioned-subject]",
        urlPolicy: { kind: "provisioned-subject", evidenceOrigin: "[provisioned-subject]" },
        journey: demoJourney(),
        surface,
        persona,
        timeoutMs: 10_000,
        artifactRoot,
        launchBrowser: async () => browser,
      });

      expect(state.url).toBe(appUrl);
      expect(result.status).toBe("passed");
      expect(result.capture.reason).toContain("[provisioned-subject]");
      expect(result.capture.steps.map((step) => step.url)).toEqual([
        "[provisioned-subject]/",
        "[provisioned-subject]/",
        "[provisioned-subject]/",
        "[provisioned-subject]/",
      ]);

      const nativeText = await readFile(path.join(artifactRoot, "traces", "desktop.json"), "utf8");
      expect(nativeText).toContain("[provisioned-subject]");
      expect(nativeText).not.toContain("127.0.0.1");
      expect(nativeText).not.toContain("localhost");
    });
  });

  it("gave_up and blocked_approval are unreachable from this actor (no persona patience, no approvals)", () => {
    const dir = path.resolve("src/actors/scripted-browser");
    const source = readdirSync(dir)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(path.join(dir, file), "utf8"))
      .join("\n");
    expect(source).not.toContain('"gave_up"');
    expect(source).not.toContain('"blocked_approval"');
  });
});

describe("scripted-browser registry entry", () => {
  it("is registered with the scripted-browser run kind and the session runner", () => {
    const descriptor = getActor("scripted-browser");
    expect(descriptor.id).toBe("scripted-browser");
    expect(descriptor.capabilities).toEqual(SCRIPTED_BROWSER_CAPABILITIES);
    expect(isScriptedBrowserActorDescriptor(descriptor)).toBe(true);
    expect(isCuaActorDescriptor(descriptor)).toBe(false);
    expect(typeof descriptor.runSession).toBe("function");
  });

  it("the run-kind guard does not claim non-scripted actors", () => {
    expect(isScriptedBrowserActorDescriptor(getActor("openai-computer-use"))).toBe(false);
    expect(isScriptedBrowserActorDescriptor(getActor("codex-app-server"))).toBe(false);
  });
});

describe("parseBrowserPersonaJourneyFromScenario", () => {
  const parse = (raw: unknown) =>
    parseBrowserPersonaJourneyFromScenario({
      raw,
      relativePath: "humanish/scenarios/app-browser.yaml",
      sourceDigest: "synthetic-digest",
    });

  it("accepts a one-step manifest and keeps the scenario provenance", () => {
    const parsed = parse({
      schema: "humanish.scenario.v1",
      id: "single-step-proof",
      title: "Single-step browser proof",
      goal: "Load the fixture app and verify visible copy.",
      mode: "browser",
      browser: {
        startPath: "/",
        steps: [
          {
            id: "open-home",
            label: "Open fixture home",
            action: "goto",
            path: "/",
            expect: { text: "browser surface proof" },
          },
        ],
      },
    });
    expect(parsed.failure).toBeUndefined();
    expect(parsed.journey).toEqual({
      goal: "Load the fixture app and verify visible copy.",
      scenarioId: "single-step-proof",
      scenarioTitle: "Single-step browser proof",
      source: "humanish/scenarios/app-browser.yaml",
      sourceDigest: "synthetic-digest",
      startPath: "/",
      steps: [
        {
          action: "goto",
          expectation: { text: "browser surface proof" },
          id: "open-home",
          label: "Open fixture home",
          path: "/",
        },
      ],
    });
  });

  it("fails closed on a fill step without a selector", () => {
    const parsed = parse({
      mode: "browser",
      browser: {
        steps: [{ id: "missing-selector", action: "fill", value: "synthetic.user@example.test" }],
      },
    });
    expect(parsed.journey).toBeUndefined();
    expect(parsed.failure).toContain("fill action requires selector");
  });

  it("returns neither a journey nor a failure for a scenario without browser steps", () => {
    expect(parse({ id: "prose-only", steps: [{ name: "look around" }] })).toEqual({});
  });
});

describe("resolveBrowserCommand", () => {
  let binDir: string;
  const savedCommand = process.env.HUMANISH_BROWSER_COMMAND;
  const savedHome = process.env.HOME;

  beforeEach(async () => {
    binDir = await mkdtemp(path.join(tmpdir(), "humanish-browser-bin-"));
  });

  afterEach(async () => {
    if (savedCommand === undefined) delete process.env.HUMANISH_BROWSER_COMMAND;
    else process.env.HUMANISH_BROWSER_COMMAND = savedCommand;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(binDir, { recursive: true, force: true });
  });

  // Records its arguments so the test can see the probe, then answers like a browser would.
  async function fakeBrowser(name: string, exitCode = 0, mode = 0o755): Promise<string> {
    const file = path.join(binDir, name);
    const argsFile = path.join(binDir, `${name}.args`);
    await writeFile(
      file,
      `#!/bin/sh\nprintf '%s' "$*" > '${argsFile}'\necho 'Chromium 999.0.0'\nexit ${exitCode}\n`,
    );
    await chmod(file, mode);
    return file;
  }

  it("returns an absolute HUMANISH_BROWSER_COMMAND that answers --version", async () => {
    const browser = await fakeBrowser("fake-chrome");
    process.env.HUMANISH_BROWSER_COMMAND = browser;

    await expect(resolveBrowserCommand()).resolves.toBe(browser);
    await expect(readFile(`${browser}.args`, "utf8")).resolves.toBe("--version");
  });

  it("looks a bare HUMANISH_BROWSER_COMMAND up on `PATH`", async () => {
    const browser = await fakeBrowser("humanish-test-chrome");
    // The lookup runs in a login shell, and some /etc/profile files reset `PATH`. A login shell
    // reads $HOME/.profile after /etc/profile, so the fake bin dir is added there.
    const home = path.join(binDir, "home");
    await mkdir(home);
    await writeFile(path.join(home, ".profile"), `export PATH='${binDir}':"$PATH"\n`);
    process.env.HOME = home;
    process.env.HUMANISH_BROWSER_COMMAND = "humanish-test-chrome";

    await expect(resolveBrowserCommand()).resolves.toBe(browser);
  });

  it("skips a candidate that fails the --version probe or is not executable", async () => {
    const failing = await fakeBrowser("failing-chrome", 1);
    const plainFile = await fakeBrowser("plain-file", 0, 0o644);

    for (const candidate of [failing, plainFile]) {
      process.env.HUMANISH_BROWSER_COMMAND = candidate;
      // A browser installed on the machine may still resolve; only the rejected candidate is pinned.
      await expect(resolveBrowserCommand()).resolves.not.toBe(candidate);
    }
    await expect(readFile(`${failing}.args`, "utf8")).resolves.toBe("--version");
    await expect(access(`${plainFile}.args`)).rejects.toThrow();
  });
});
