import { automaticAnalysisBoundary } from "../helpers/automatic-analysis-boundary.js";
import { CommanderError } from "commander";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, SCRIPTED_BROWSER_CAPABILITIES } from "../../src/actors/contract.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../src/substrates/e2b/sdk.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";
import { parseLabConfig } from "../../src/lab/config.js";
import { runLab, selectLabBackend } from "../../src/lab/engine.js";
import { createProgram } from "../../src/cli/program.js";
import { digestText } from "../../src/evidence/redaction.js";
import { verifyRun } from "../../src/verify/verify.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { computeStats } from "../../src/run/stats.js";
import { reclaimRunSandboxes } from "../../src/run/reclaim.js";
import {
  parseSandboxReceipts,
  SANDBOX_RECEIPTS_ARTIFACT,
  type ParsedSandboxReceipt,
} from "../../src/run/sandbox-receipts.js";
import { runCuaActorLab } from "../../src/routes/computer-use/lab.js";
import { runScriptedBrowserLab, runScriptedPlan } from "../../src/routes/scripted-browser/lab.js";
import { planScriptedLab } from "../../src/routes/scripted-browser/plan.js";
import type { ScriptedBrowserLabHooks } from "../../src/routes/scripted-browser/types.js";
import type {
  ScriptedBrowserLike,
  ScriptedLocatorLike,
  ScriptedPageLike,
} from "../../src/actors/scripted-browser/types.js";
import type { ScriptedBrowserSessionResult } from "../../src/actors/scripted-browser/actor.js";
import { syntheticPng1x1 } from "../image-fixtures.js";
import { evaluatePagePredicate } from "../helpers/scripted-page-predicate.js";
import { captureStderr, runDirSnapshot } from "../helpers/run-golden.js";
import { expectFailureGolden } from "../helpers/failure-golden.js";

const ROOT = process.cwd();
const PNG_1X1 = syntheticPng1x1();

// ---------------------------------------------------------------------------
// Fakes + fixtures. The fake browser drives the REAL step executor and writes
// real screenshot bytes, so evidence-presence checks see what a live run would.
// ---------------------------------------------------------------------------

function makeFakeBrowser(
  options: {
    bodyAfterClick?: string;
    selectorCounts?: Record<string, number>;
  } = {},
): ScriptedBrowserLike {
  const state = { url: "about:blank", body: "landing page" };
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
      isVisible: async () => count > 0,
    };
    return locator;
  };
  const page: ScriptedPageLike = {
    goto: async (url) => {
      state.url = url;
      return undefined;
    },
    locator: locatorFor,
    waitForTimeout: async () => undefined,
    waitForFunction: async (expression) => {
      if (evaluatePagePredicate(expression, state.body)) return undefined;
      throw new Error(`Timeout waiting for ${expression}`);
    },
    screenshot: async ({ path: screenshotPath }) => {
      if (screenshotPath) await writeFile(screenshotPath, PNG_1X1);
      return PNG_1X1;
    },
    url: () => state.url,
    evaluate: async <T>() => state.body as unknown as T,
  };
  return {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => undefined,
  };
}

interface FakeSubjectSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
}

function makeFakeSubjectSandbox(
  id: string,
  beforeWork: () => Promise<void> = async () => undefined,
  failStep?: string,
): FakeSubjectSandbox {
  const calls: Array<[string, ...unknown[]]> = [];
  const sandbox = {
    calls,
    sandboxId: id,
    commands: {
      run: async (command: string) => {
        await beforeWork();
        calls.push(["commands.run", command]);
        if (command.includes("/status")) {
          return { exitCode: 0, stdout: failStep && command.includes(failStep) ? "1\n" : "0\n" };
        }
        if (command.includes("rev-parse")) return { exitCode: 0, stdout: "abc123def4567890abc1\n" };
        if (command.includes("curl")) return { exitCode: 0, stdout: "READY\n" };
        if (command.includes("tail -c")) return { exitCode: 0, stdout: "" };
        return { exitCode: 0, stdout: "" };
      },
    },
    files: {
      write: async (filePath: string, data: string | ArrayBuffer) => {
        await beforeWork();
        calls.push(["files.write", filePath, String(data)]);
        return undefined;
      },
    },
    launch: async (application: string, uri?: string) => {
      calls.push(["launch", application, uri]);
    },
    open: async (fileOrUrl: string) => {
      calls.push(["open", fileOrUrl]);
    },
    getHost: (port: number) => `${port}-${id}.e2b.app`,
    async screenshot() {
      return new Uint8Array([1, 2, 3, 4]);
    },
    async wait(ms: number) {
      calls.push(["wait", ms]);
    },
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async () => undefined,
    },
  };
  return sandbox as unknown as FakeSubjectSandbox;
}

/**
 * `order` logs every module call and the first command or file write on each sandbox, in the
 * order they happen. `onFirstWork` runs just before that first write is logged, so a test can
 * snapshot run-dir state at the moment provisioning starts.
 */
function makeFakeE2BModule(
  options: {
    onFirstWork?: (sandboxId: string) => Promise<string>;
    /** What the sandbox's getInfo reports; absent leaves the size unmeasured. */
    resources?: { cpuCount: number; memoryMB: number };
    /** A detached step name (such as `subject-install`) whose exit status reads as 1. */
    failStep?: string;
  } = {},
): {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
  sandboxes: FakeSubjectSandbox[];
  order: string[];
} {
  const created: E2BDesktopCreateOptions[] = [];
  const templates: (string | undefined)[] = [];
  const killed: string[] = [];
  const sandboxes: FakeSubjectSandbox[] = [];
  const order: string[] = [];
  let n = 0;
  const module: E2BDesktopModule = {
    Sandbox: {
      create: async (
        templateOrOptions: string | E2BDesktopCreateOptions,
        maybeOptions?: E2BDesktopCreateOptions,
      ) => {
        const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
        const createOptions =
          typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
        n += 1;
        const id = `fake-subject-${String(n).padStart(3, "0")}`;
        let worked = false;
        const sandbox = makeFakeSubjectSandbox(
          id,
          async () => {
            if (worked) return;
            worked = true;
            if (options.onFirstWork) order.push(await options.onFirstWork(id));
            order.push(`first-work:${id}`);
          },
          options.failStep,
        );
        order.push(`create:${id}`);
        templates.push(template);
        created.push(createOptions);
        sandboxes.push(sandbox);
        const resources = options.resources;
        return resources === undefined
          ? sandbox
          : Object.assign(sandbox, { getInfo: async () => resources });
      },
      kill: async (sandboxId: string) => {
        order.push(`kill:${sandboxId}`);
        // The real SDK returns false for a sandbox that is already gone.
        const present = !killed.includes(sandboxId);
        killed.push(sandboxId);
        return present;
      },
    },
  };
  return { module, created, templates, killed, sandboxes, order };
}

async function readRunReceipts(runDir: string): Promise<ParsedSandboxReceipt[]> {
  try {
    return parseSandboxReceipts(
      await readFile(path.join(runDir, SANDBOX_RECEIPTS_ARTIFACT), "utf8"),
    );
  } catch {
    return [];
  }
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

/** Copy the COMMITTED demo scenario into the temp cwd so the test binds to the real file. */
async function writeCommittedScenario(cwd: string): Promise<string> {
  const text = await readFile(
    path.join(ROOT, "humanish", "scenarios", "scripted-first-run.yaml"),
    "utf8",
  );
  await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(cwd, "humanish", "scenarios", "scripted-first-run.yaml"), text, "utf8");
  return text;
}

function scriptedConfig(overrides?: {
  appUrl?: string;
  count?: number;
  mode?: "dry-run" | "live";
  target?: "local" | undefined;
  ref?: string;
}): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "scripted-routing-proof",
    title: "Scripted routing proof",
    subject: { source: "app-url", appUrl: overrides?.appUrl ?? "http://127.0.0.1:5173/" },
    actors: [
      {
        type: "scripted-browser",
        persona: "synthetic-new-user",
        ...(overrides?.count === undefined ? {} : { count: overrides.count }),
      },
    ],
    scenario: {
      ref: overrides?.ref ?? "scripted-first-run",
      ...(overrides?.mode === undefined ? {} : { mode: overrides.mode }),
    },
    execution: {
      ...(overrides && "target" in overrides
        ? overrides.target
          ? { target: overrides.target }
          : {}
        : { target: "local" }),
      timeoutMs: 30_000,
    },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function provisionedScriptedConfig(): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "provisioned-scripted-routing-proof",
    title: "Provisioned scripted routing proof",
    subject: {
      source: "clone",
      exposure: "synthetic",
      repos: ["example-org/example-app"],
      clone: { depth: 1 },
      serve: {
        install: "pnpm install --frozen-lockfile",
        build: "pnpm build",
        start: "pnpm start --host 0.0.0.0",
        url: "http://127.0.0.1:3000/",
      },
      env: ["GITHUB_TOKEN"],
      state: { seed: [{ name: "seed", command: "pnpm db:seed" }] },
    },
    actors: [{ type: "scripted-browser", persona: "synthetic-provider", count: 1 }],
    scenario: { ref: "scripted-first-run", mode: "live" },
    execution: {
      target: "e2b-desktop",
      timeoutMs: 30_000,
      desktop: { template: "adopter-ui-sim-base" },
    },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("lab routing (app-url × scripted-browser → scripted)", () => {
  it("selectLabBackend routes app-url × local × scripted-browser to the scripted backend (target absent too)", () => {
    expect(selectLabBackend(scriptedConfig())).toBe("scripted");
    expect(selectLabBackend(scriptedConfig({ target: undefined }))).toBe("scripted");
  });

  it("REGRESSION: app-url × e2b-desktop × openai-computer-use still routes to cua, and the other routes are untouched", () => {
    const cua = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use" }],
      execution: { target: "e2b-desktop" },
    });
    const synthetic = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "s",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona" }],
    });
    // A clone lab without a computer-use or scripted actor no longer parses; a library caller that
    // skips the parser still reaches the computer-use route's fail-closed actor check.
    const cloneWithCodeActor = {
      schema: LAB_CONFIG_SCHEMA,
      id: "m",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "codex-app-server" }],
      execution: { target: "e2b-desktop" },
    } as const;
    if (!cua.ok || !synthetic.ok) throw new Error("fixture configs must parse");
    expect(parseLabConfig(cloneWithCodeActor).ok).toBe(false);
    expect(selectLabBackend(cua.config)).toBe("cua");
    expect(selectLabBackend(synthetic.config)).toBe("synthetic");
    expect(selectLabBackend(cloneWithCodeActor as unknown as LabConfig)).toBe("cua");
  });

  it("library-API fallback: app-url with an UNREGISTERED actor type still routes to cua's fail-closed gate", async () => {
    // Such a config cannot parse; build it by hand (the library-API path).
    const tampered = {
      ...scriptedConfig(),
      actors: [{ type: "not-a-registered-actor" }],
    } as LabConfig;
    expect(selectLabBackend(tampered)).toBe("cua");
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-scripted-fallback-"));
    try {
      const result = await runCuaActorLab({ cwd, config: tampered, dryRun: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * Hooks for a live scripted run on a fake provisioned clone. The injected session writes synthetic
 * captures instead of launching a browser, and one monotonic clock drives every provisioned poll.
 */
function provisionedCloneHooks(module: E2BDesktopModule): {
  hooks: ScriptedBrowserLabHooks;
  rawSessionUrls: string[];
} {
  let clock = Date.parse("2026-09-04T00:00:00.000Z");
  const rawSessionUrls: string[] = [];
  const hooks: ScriptedBrowserLabHooks = {
    env: {
      E2B_API_KEY: "fake-e2b-key-for-test",
      GITHUB_TOKEN: "github-token-test",
    },
    loadDesktopModule: async () => module,
    // The injected session writes synthetic captures; it does not launch a host browser.
    browserCommand: "/synthetic/browser",
    runSession: async (options) => {
      rawSessionUrls.push(options.appUrl);
      expect(options.evidenceAppUrl).toBe("[provisioned-subject]");
      expect(options.urlPolicy).toEqual({
        kind: "provisioned-subject",
        evidenceOrigin: "[provisioned-subject]",
      });
      const capturedAt = "2026-06-19T00:00:00.000Z";
      const screenshotPath = `screenshots/${options.surface.id}-step-01-load.png`;
      const tracePath = `traces/${options.surface.id}.json`;
      await mkdir(path.join(options.artifactRoot, "screenshots"), { recursive: true });
      await mkdir(path.join(options.artifactRoot, "traces"), { recursive: true });
      await writeFile(path.join(options.artifactRoot, screenshotPath), PNG_1X1);
      const reason = `${options.surface.label} completed 1/1 scripted browser steps from [provisioned-subject] with HTTP 200.`;
      const capture = {
        capturedAt,
        durationMs: 1,
        httpStatus: 200,
        ok: true,
        reason,
        screenshotPath,
        steps: [
          {
            action: "goto" as const,
            completedAt: capturedAt,
            durationMs: 1,
            id: "step-01-load",
            label: "Load landing page",
            reason: "goto completed for Load landing page.",
            screenshotPath,
            status: "passed" as const,
            url: "[provisioned-subject]/",
          },
        ],
        surface: options.surface,
        tracePath,
      };
      await writeFile(
        path.join(options.artifactRoot, tracePath),
        `${JSON.stringify(
          {
            schema: "humanish.browser-persona-trace.v1",
            capturedAt,
            appUrl: "[provisioned-subject]",
            browserCommand: "injected-browser",
            durationMs: 1,
            httpStatus: 200,
            ok: true,
            reason,
            screenshotPath,
            steps: capture.steps,
            surface: options.surface,
            redaction: "passed",
          },
          null,
          2,
        )}\n`,
      );
      return {
        status: "passed",
        completionReason: "goal_satisfied",
        reason,
        capture,
        trace: {
          schema: ACTOR_TRACE_SCHEMA,
          provider: "browser-persona",
          protocol: "scripted-steps",
          lane: "scripted-browser",
          persona: options.persona,
          redaction: {
            status: "passed",
            screenshots: "raw",
            notes: "fake provisioned scripted trace",
          },
          startedAt: capturedAt,
          completedAt: capturedAt,
          durationMs: 1,
          status: "passed",
          completionReason: "goal_satisfied",
          reason,
          ids: {},
          counts: { steps: 1, actions: 1, assertions: 0, blocked: 0, screenshots: 1 },
          items: [
            {
              id: "step-01-load",
              kind: "ui_action",
              lifecycle: "completed",
              status: "passed",
              title: "Load landing page",
              screenshotRef: { path: screenshotPath, redaction: "none" },
            },
          ],
          tokenUsage: { input: 0, output: 0, total: 0, costUsd: 0 },
          capabilities: SCRIPTED_BROWSER_CAPABILITIES,
        },
      };
    },
    // An injected monotonic clock (#276): every poll loop on the provisioned path (install, build,
    // readiness, seed steps) computes its deadline from `now()` and advances only through
    // `sleep()`, so no wall-clock deadline can decide this case on a loaded runner. The earlier
    // `now: Date.now` with a no-op sleep let a real 15 s budget expire twice on CI (2026-07 and
    // 2026-09-03) while three local runs passed in under a second.
    detachedTimers: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  };
  return { hooks, rawSessionUrls };
}

describe("runScriptedBrowserLab", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-scripted-lab-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("dry-run produces a verified contract bundle with pinned scenario provenance and no actor seam", async () => {
    const scenarioText = await writeCommittedScenario(cwd);
    const outcome = await runLab(scriptedConfig({ count: 2 }), { cwd, dryRun: true });
    expect(outcome.backend).toBe("scripted");
    if (outcome.backend !== "scripted") return;
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.actor).toBe("scripted-browser");
    expect(result.sessions).toEqual([]);
    expect(result.observer?.ok).toBe(true);
    // scenario.ref CONSUMED: digest-pinned provenance.
    expect(result.scenario).toEqual({
      id: "scripted-first-run",
      source: "humanish/scenarios/scripted-first-run.yaml",
      sourceDigest: digestText(scenarioText),
      steps: 4,
    });

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.schema).toBe("humanish.run-bundle.v1");
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.simCount).toBe(2);
    expect(bundle.cwd).toBe("[target-cwd]");
    expect(
      bundle.simulations.map((sim: { id: string; status: string }) => [sim.id, sim.status]),
    ).toEqual([
      ["scripted-desktop", "contract_proof_only"],
      ["scripted-mobile", "contract_proof_only"],
    ]);
    expect(bundle.simulations.map((sim: { progress: number }) => sim.progress)).toEqual([100, 100]);
    // No session ran, so no stream.actor exists (mirrors the cua dry-run honesty rule).
    for (const stream of bundle.streams) {
      expect(stream.actor).toBeUndefined();
    }
    expect(bundle.review.verdict).toBe("contract_proof_only");
    expect(bundle.scenario.sourceDigest).toBe(digestText(scenarioText));
    // Subject provenance and the participant/analysis spending boundary are explicit events.
    const subjectEvent = bundle.events.find(
      (event: { type: string }) => event.type === "scripted-lab.subject.declared",
    );
    expect(subjectEvent?.message).toContain("UNPINNED");
    expect(subjectEvent?.message).toContain("scenario digest");
    const spendEvent = bundle.events.find(
      (event: { type: string }) => event.type === "scripted-lab.spend",
    );
    expect(spendEvent?.message).toContain("Scripted participant steps make no model requests");
    expect(spendEvent?.message).toContain(
      "post-run analysis has a separate budget unless disabled",
    );

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);

    // latest.json points at THIS run so `verify --run latest` stays honest.
    const pointer = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", "latest.json"), "utf8"),
    );
    expect(pointer.runId).toBe(result.runId);
  });

  it("default surface roster is 1 (desktop only) — the single-lane default governs; count: 2 is the override", async () => {
    await writeCommittedScenario(cwd);
    const outcome = await runLab(scriptedConfig(), { cwd, dryRun: true });
    if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.simCount).toBe(1);
    expect(bundle.simulations.map((sim: { id: string }) => sim.id)).toEqual(["scripted-desktop"]);
  });

  it("runs a plan alone: the bundle records the plan's lab id, persona and surfaces", async () => {
    await writeCommittedScenario(cwd);
    const planned = planScriptedLab(scriptedConfig({ count: 2 }), { dryRun: true });
    if (!planned.ok) throw new Error("expected a scripted plan");
    const plan = {
      ...planned.plan,
      labId: "planned-lab",
      personaId: "planned-persona",
      surfaces: planned.plan.surfaces.slice(0, 1),
    };
    const result = await runScriptedPlan(plan, { cwd });
    expect(result.ok).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.persona.id).toBe("planned-persona");
    expect(bundle.persona.source).toBe("lab:planned-lab");
    expect(bundle.simCount).toBe(1);
  });

  it.each(["default", "disabled"])(
    "live (with a fake browser): the real step engine verifies with analysis %s",
    async (analysisMode) => {
      await writeCommittedScenario(cwd);
      await withHttpServer(async (appUrl) => {
        const hooks: ScriptedBrowserLabHooks = {
          launchBrowser: async () => makeFakeBrowser({ bodyAfterClick: "Welcome aboard" }),
        };
        const config = scriptedConfig({ appUrl, count: 2, mode: "live" });
        if (analysisMode === "disabled") config.review = { analysis: false };
        const analyze = automaticAnalysisBoundary();
        const outcome = await runLab(config, {
          cwd,
          scriptedHooks: hooks,
          automaticAnalysis: { run: analyze },
        });
        expect(analyze).toHaveBeenCalledTimes(analysisMode === "disabled" ? 0 : 1);
        if (analysisMode === "disabled")
          expect(outcome.result).not.toHaveProperty("automaticAnalysis");
        else
          expect(outcome.result).toMatchObject({
            automaticAnalysisTrigger: "default",
            automaticAnalysis: { reason: "synthetic_no_provider" },
          });
        expect(outcome.backend).toBe("scripted");
        if (outcome.backend !== "scripted") return;
        const result = outcome.result;

        expect(result.ok).toBe(true);
        expect(result.dryRun).toBe(false);
        expect(result.sessions).toHaveLength(2);
        for (const session of result.sessions) {
          expect(session.status).toBe("passed");
          expect(session.completionReason).toBe("goal_satisfied");
          expect(session.screenshots).toBe(4);
        }

        const runDir = path.join(cwd, ".humanish", "runs", result.runId);
        const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
        expect(bundle.mode).toBe("live");
        expect(bundle.simCount).toBe(2);
        expect(bundle.simulations.map((sim: { progress: number }) => sim.progress)).toEqual([
          100, 100,
        ]);

        for (const surface of ["desktop", "mobile"]) {
          const stream = bundle.streams.find(
            (entry: { id: string }) => entry.id === `scripted-${surface}-stream`,
          );
          // The seam this registration exists to fill.
          expect(stream.actor.schema).toBe(ACTOR_TRACE_SCHEMA);
          expect(stream.actor.lane).toBe("scripted-browser");
          expect(stream.actor.provider).toBe("browser-persona");
          expect(stream.actor.protocol).toBe("scripted-steps");
          expect(stream.actor.tokenUsage).toEqual({ input: 0, output: 0, total: 0, costUsd: 0 });
          // REAL emulated viewport metadata (isMobile/DSF genuinely render on this route).
          expect(stream.viewport.isMobile).toBe(surface === "mobile");

          // Native + projected traces persist on disk; the projection matches the seam.
          const nativeTrace = JSON.parse(
            await readFile(path.join(runDir, "traces", `${surface}.json`), "utf8"),
          );
          expect(nativeTrace.schema).toBe("humanish.browser-persona-trace.v1");
          const actorTrace = JSON.parse(
            await readFile(path.join(runDir, `actor-${surface}.json`), "utf8"),
          );
          expect(actorTrace).toEqual(stream.actor);
        }

        // Screenshots referenced by streams exist on disk (4 steps × 2 surfaces).
        const screenshotFiles = await readdir(path.join(runDir, "screenshots"));
        expect(screenshotFiles).toHaveLength(8);

        // verifyRun passes INCLUDING the hollow-run engagement check, and surfaces the
        // raw-screenshot posture as a warning (never flips ok).
        const verified = await verifyRun(cwd, result.runId);
        expect(verified.ok).toBe(true);
        expect(verified.checks.find((check) => check.name === "actor engagement")?.ok).toBe(true);
        expect(verified.warnings.join("\n")).toContain("FULL-FIDELITY (raw)");
        expect(result.warnings.join("\n")).toContain("full-fidelity");

        // Public safety: no absolute machine paths or secret-shaped text in any text artifact.
        for (const file of [
          "run.json",
          "review.json",
          "review.md",
          "events.ndjson",
          "actor-desktop.json",
          "actor-mobile.json",
        ]) {
          const text = await readFile(path.join(runDir, file), "utf8");
          expect(text, file).not.toContain(cwd);
          expect(text, file).not.toContain(tmpdir());
        }
      });
    },
  );

  it("live provisioned clone: provisions one synthetic subject, drives getHost, and persists only public-safe URL labels", async () => {
    await writeCommittedScenario(cwd);
    const runId = "scripted-provisioned-clone";
    const runDir = path.join(cwd, ".humanish", "runs", runId);
    const fakeE2B = makeFakeE2BModule({
      onFirstWork: async () => {
        const ids = (await readRunReceipts(runDir)).map((receipt) => receipt.sandboxId);
        return `receipts:${ids.join(",")}`;
      },
      resources: { cpuCount: 8, memoryMB: 8192 },
    });
    const { hooks, rawSessionUrls } = provisionedCloneHooks(fakeE2B.module);

    const outcome = await runLab(provisionedScriptedConfig(), {
      cwd,
      runId,
      scriptedHooks: hooks,
    });
    expect(outcome.backend).toBe("scripted");
    if (outcome.backend !== "scripted") return;
    const result = outcome.result;

    // Name the step on failure: "expected false to be true" said nothing on either CI leg.
    expect(result.ok, JSON.stringify({ error: result.error, warnings: result.warnings })).toBe(
      true,
    );
    expect(result.runId).toBe(runId);
    expect(result.appUrl).toBe("[provisioned-subject]");
    expect(result.subjectSandbox).toEqual({ sandboxId: "fake-subject-001", killed: true });
    expect(result.hostDigest).toMatch(/^[a-f0-9]{16}$/);
    expect(fakeE2B.created).toHaveLength(1);
    expect(fakeE2B.templates).toEqual(["adopter-ui-sim-base"]);
    expect(fakeE2B.created[0]?.envs).toEqual({ GITHUB_TOKEN: "github-token-test" });
    expect(fakeE2B.killed).toEqual(["fake-subject-001"]);
    expect(rawSessionUrls).toEqual(["https://3000-fake-subject-001.e2b.app"]);

    // The subject id is on disk before the first provisioning command reaches the sandbox, so a
    // process killed during clone or install still leaves a reclaimable id.
    expect(fakeE2B.order).toEqual([
      "create:fake-subject-001",
      "receipts:fake-subject-001",
      "first-work:fake-subject-001",
      "kill:fake-subject-001",
    ]);
    const receipts = await readRunReceipts(runDir);
    expect(receipts.map((receipt) => receipt.sandboxId)).toEqual(["fake-subject-001"]);
    expect(receipts[0]).toMatchObject({ laneId: "subject" });
    expect(fakeE2B.created[0]?.timeoutMs).toEqual(expect.any(Number));
    expect(receipts[0]?.timeoutMs).toBe(fakeE2B.created[0]?.timeoutMs);

    const bundleText = await readFile(path.join(runDir, "run.json"), "utf8");
    const bundle = JSON.parse(bundleText);
    // No model runs here, so the clone's desktop is the whole cost: one priced subject line.
    expect(bundle.cost.fullyEstimated).toBe(true);
    expect(bundle.cost.breakdown).toHaveLength(1);
    expect(bundle.cost.breakdown[0]).toMatchObject({
      kind: "desktop-minutes",
      laneId: "subject",
      desktop: { resources: { cpuCount: 8, memoryMiB: 8192 } },
    });
    expect(bundle.cost.breakdown[0].desktop.minutes).toBeGreaterThan(0);
    expect(bundle.cost.estimatedTotalUsd).toBe(bundle.cost.breakdown[0].estimatedCostUsd);
    // The fake sandbox lives a few milliseconds, which round6 can price at $0, so this checks
    // that the line has a price at all.
    expect(bundle.cost.estimatedTotalUsd).toEqual(expect.any(Number));
    expect(bundle.subject).toMatchObject({
      source: "clone",
      repo: "repo-01",
      commit: "abc123def4567890abc1",
      envNames: ["GITHUB_TOKEN"],
      state: { provenance: "seeded" },
    });
    expect(bundle.desktopTemplate).toBe("adopter-ui-sim-base");
    expect(bundle.streams[0].ui.route).toBe("[provisioned-subject]");
    expect(bundle.streams[0].actor.reason).toContain("[provisioned-subject]");
    expect(
      bundle.events.find(
        (event: { type: string }) => event.type === "scripted-lab.subject.declared",
      )?.message,
    ).toContain("Provisioned synthetic subject");
    expect(
      bundle.events.find((event: { type: string }) => event.type === "scripted-lab.spend")?.message,
    ).toContain("E2B sandbox minutes");

    for (const file of [
      "run.json",
      "review.json",
      "review.md",
      "events.ndjson",
      "actor-desktop.json",
      path.join("traces", "desktop.json"),
    ]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).toContain("[provisioned-subject]");
      expect(text, file).not.toContain("e2b.app");
      expect(text, file).not.toContain("fake-subject-001");
      expect(text, file).not.toContain("github-token-test");
      expect(text, file).not.toContain("example-org/example-app");
    }

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);

    // `humanish reclaim` reads the same journal and targets exactly the subject sandbox, which the
    // finished run already destroyed.
    const reclaimed = await reclaimRunSandboxes(cwd, runId, {
      loadModule: async () => fakeE2B.module,
    });
    expect(reclaimed.ok).toBe(true);
    expect(reclaimed.outcomes).toEqual([
      { sandboxId: "fake-subject-001", laneId: "subject", state: "already-gone" },
    ]);
  });

  it("the subject failing the script is successful EVIDENCE: lab ok stays true, review verdict is fail", async () => {
    await writeCommittedScenario(cwd);
    await withHttpServer(async (appUrl) => {
      // Click never produces the Welcome state -> stateChanged + waitForText fail honestly.
      const hooks: ScriptedBrowserLabHooks = {
        launchBrowser: async () => makeFakeBrowser({}),
      };
      const outcome = await runLab(scriptedConfig({ appUrl, count: 1, mode: "live" }), {
        cwd,
        scriptedHooks: hooks,
      });
      if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
      const result = outcome.result;

      // Credible failure evidence is a successful lab run.
      expect(result.ok).toBe(true);
      expect(result.sessions[0]?.completionReason).toBe("step_failed");
      expect(result.sessions[0]?.status).toBe("failed");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
      );
      expect(bundle.review.verdict).toBe("fail");
      expect(bundle.review.gaps.join("\n")).toContain("desktop");
      const sessionEvent = bundle.events.find(
        (event: { type: string }) => event.type === "scripted-lab.session.step_failed",
      );
      expect(sessionEvent).toBeDefined();

      const verified = await verifyRun(cwd, result.runId);
      expect(verified.ok).toBe(true);
    });
  });

  it("a browser that cannot launch is a harness error: lab ok false, failed-evidence bundle persisted", async () => {
    await writeCommittedScenario(cwd);
    await withHttpServer(async (appUrl) => {
      const hooks: ScriptedBrowserLabHooks = {
        launchBrowser: async () => {
          throw new Error("chromium executable missing");
        },
      };
      const stderr = captureStderr();
      const outcome = await runLab(scriptedConfig({ appUrl, count: 1, mode: "live" }), {
        cwd,
        scriptedHooks: hooks,
      }).finally(stderr.stop);
      if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
      const result = outcome.result;

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HUMANISH_SCRIPTED_LAB_FAILED");
      expect(result.sessions[0]?.completionReason).toBe("harness_error");
      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
      );
      expect(bundle.review.verdict).toBe("fail");
      await expectFailureGolden(
        "scripted/browser-launch-fails",
        path.join(cwd, ".humanish", "runs", result.runId),
        {
          result,
          stderr: stderr.text(),
          replace: [
            [result.runId, "[run]"],
            [cwd, "[cwd]"],
            [appUrl, "[app-url]/"],
            [new URL(appUrl).host, "[app-host]"],
          ],
        },
      );

      // No step ran, so the bundle references no screenshot and its evidence check passes.
      for (const stream of bundle.streams) {
        expect(stream.embed.kind).toBe("placeholder");
        expect(stream.ui.screenshotUrl).toBeUndefined();
        expect(
          stream.artifacts.some((artifact: { kind: string }) => artifact.kind === "screenshot"),
        ).toBe(false);
      }
      const verified = await verifyRun(cwd, result.runId);
      expect(
        verified.checks.find((check) => check.name === "local evidence artifacts exist")?.ok,
      ).toBe(true);
    });
  });

  // One judgment decides the bundle's verdict and the result's ok, and status.json repeats the
  // bundle's verdict. The worst surface decides the verdict; only a harness failure fails ok.
  type SurfaceEnding = "pass" | "step_failed" | "timeout";
  function surfaceBrowser(
    endings: Record<"desktop" | "mobile", SurfaceEnding>,
  ): ScriptedBrowserLike {
    return {
      newContext: async (options) => {
        const ending = endings[options.isMobile ? "mobile" : "desktop"];
        const context = await makeFakeBrowser(
          ending === "pass" ? { bodyAfterClick: "Welcome aboard" } : {},
        ).newContext(options);
        if (ending !== "timeout") return context;
        const page = await context.newPage();
        // The first navigation never settles, so the journey runs into its wall-clock budget.
        return { newPage: async () => ({ ...page, goto: () => new Promise<undefined>(() => {}) }) };
      },
      close: async () => undefined,
    };
  }
  it.each<[string, ScriptedBrowserLabHooks, RunBundle["review"]["verdict"], boolean]>([
    [
      "every surface passes",
      { launchBrowser: async () => surfaceBrowser({ desktop: "pass", mobile: "pass" }) },
      "pass",
      true,
    ],
    [
      "a failed step on one surface",
      { launchBrowser: async () => surfaceBrowser({ desktop: "pass", mobile: "step_failed" }) },
      "fail",
      true,
    ],
    [
      "a timeout on one surface",
      { launchBrowser: async () => surfaceBrowser({ desktop: "pass", mobile: "timeout" }) },
      "timed_out",
      true,
    ],
    [
      "a timeout and a failed step",
      { launchBrowser: async () => surfaceBrowser({ desktop: "timeout", mobile: "step_failed" }) },
      "fail",
      true,
    ],
    [
      "a browser that cannot launch",
      {
        launchBrowser: async () => {
          throw new Error("chromium executable missing");
        },
      },
      "fail",
      false,
    ],
    [
      "a session that throws",
      {
        runSession: async () => {
          throw new Error("synthetic session failure");
        },
        launchBrowser: async () => surfaceBrowser({ desktop: "pass", mobile: "pass" }),
      },
      "fail",
      false,
    ],
  ])("agrees across bundle, result and status with %s", async (_name, hooks, verdict, ok) => {
    await writeCommittedScenario(cwd);
    await withHttpServer(async (appUrl) => {
      const config = scriptedConfig({ appUrl, count: 2, mode: "live" });
      config.execution!.timeoutMs = 3_000;
      const stderr = captureStderr();
      const outcome = await runLab(config, { cwd, scriptedHooks: hooks }).finally(stderr.stop);
      if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
      const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
      const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
        outcome?: { verdict?: string };
      };
      expect(bundle.review.verdict).toBe(verdict);
      expect(status.outcome?.verdict).toBe(verdict);
      expect(outcome.result.ok).toBe(ok);
    });
  });

  it("verify fails closed when a live stream references a screenshot that is missing", async () => {
    await writeCommittedScenario(cwd);
    await withHttpServer(async (appUrl) => {
      const config = scriptedConfig({ appUrl, count: 1, mode: "live" });
      config.review = { analysis: false };
      const outcome = await runLab(config, {
        cwd,
        scriptedHooks: {
          launchBrowser: async () => makeFakeBrowser({ bodyAfterClick: "Welcome aboard" }),
        },
      });
      if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
      const { runId } = outcome.result;
      const runDir = path.join(cwd, ".humanish", "runs", runId);
      const evidenceCheck = async () =>
        (await verifyRun(cwd, runId)).checks.find(
          (check) => check.name === "local evidence artifacts exist",
        );
      expect((await evidenceCheck())?.ok).toBe(true);

      const bundlePath = path.join(runDir, "run.json");
      const original = await readFile(bundlePath, "utf8");
      const bundle = JSON.parse(original);
      bundle.streams[0].embed.url = "../screenshots/missing-embed.png";
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
      const missingEmbed = await evidenceCheck();
      expect(missingEmbed?.ok).toBe(false);
      expect(missingEmbed?.message).toContain("screenshots/missing-embed.png");
      await writeFile(bundlePath, original, "utf8");

      await rm(path.join(runDir, "screenshots", "desktop-step-02-fill-email.png"));
      const missingStep = await evidenceCheck();
      expect(missingStep?.ok).toBe(false);
      expect(missingStep?.message).toContain("screenshots/desktop-step-02-fill-email.png");
    });
  });

  it("strips userinfo, query and hash from the loopback app URL before writing evidence", async () => {
    await writeCommittedScenario(cwd);
    await withHttpServer(async (appUrl) => {
      const polluted =
        appUrl.replace("http://", "http://synthetic-user:synthetic-pass@") +
        "?access_token=secret-token#private-fragment";
      const config = scriptedConfig({ appUrl: polluted, count: 1, mode: "live" });
      config.review = { analysis: false };
      const outcome = await runLab(config, {
        cwd,
        scriptedHooks: {
          launchBrowser: async () => makeFakeBrowser({ bodyAfterClick: "Welcome aboard" }),
        },
      });
      if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
      expect(outcome.result.ok).toBe(true);
      expect(outcome.result.sessions[0]?.completionReason).toBe("goal_satisfied");

      const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
      expect(bundle.streams[0].ui.route).toBe(appUrl);
      for (const file of [
        "run.json",
        "events.ndjson",
        "review.md",
        "actor-desktop.json",
        "traces/desktop.json",
      ]) {
        const text = await readFile(path.join(runDir, file), "utf8");
        for (const secret of [
          "synthetic-user",
          "synthetic-pass",
          "access_token",
          "secret-token",
          "private-fragment",
        ]) {
          expect(text, file).not.toContain(secret);
        }
      }
    });
  });

  it("an unexpected runSession throw becomes a redacted structured failure with a failed bundle (no raw throw)", async () => {
    const secretToken = "Bearer " + "a1b2c3d4e5".repeat(4);
    await writeCommittedScenario(cwd);
    const hooks: ScriptedBrowserLabHooks = {
      runSession: async () => {
        throw new Error(`session exploded with ${secretToken}`);
      },
      launchBrowser: async () => makeFakeBrowser({}),
    };
    const stderr = captureStderr();
    const outcome = await runLab(scriptedConfig({ count: 1, mode: "live" }), {
      cwd,
      scriptedHooks: hooks,
    }).finally(stderr.stop);
    if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SCRIPTED_LAB_FAILED");
    expect(result.error?.message).not.toContain(secretToken);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(secretToken);
    }
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.simulations[0].status).toBe("failed");
    expect(bundle.review.verdict).toBe("fail");
    await expectFailureGolden("scripted/session-throws", runDir, {
      result,
      stderr: stderr.text(),
      replace: [
        [result.runId, "[run]"],
        [cwd, "[cwd]"],
      ],
    });
  });

  it("fails a live run whose session threw an error with an empty message", async () => {
    await writeCommittedScenario(cwd);
    const stderr = captureStderr();
    const outcome = await runLab(scriptedConfig({ count: 1, mode: "live" }), {
      cwd,
      scriptedHooks: {
        runSession: async () => {
          throw new Error("");
        },
        launchBrowser: async () => makeFakeBrowser({}),
      },
    }).finally(stderr.stop);
    if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      outcome?: { verdict?: string };
    };
    expect(bundle.mode).toBe("live");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.simulations[0]?.status).toBe("failed");
    expect(status.outcome?.verdict).toBe("fail");
    expect(outcome.result.ok).toBe(false);
  });

  it("rejects callback-returned traversal artifacts before parent bundle finalization", async () => {
    await writeCommittedScenario(cwd);
    const outside = path.join(path.dirname(cwd), "scripted-outside-sentinel.txt");
    await writeFile(outside, "UNCHANGED", "utf8");
    const runId = "unsafe-hook-result";
    const hooks: ScriptedBrowserLabHooks = {
      browserCommand: "/synthetic/browser",
      runSession: async (options) =>
        ({
          status: "passed",
          completionReason: "goal_satisfied",
          reason: "synthetic malicious callback result",
          capture: {
            capturedAt: "2026-07-13T00:00:00.000Z",
            durationMs: 1,
            ok: true,
            reason: "synthetic malicious callback result",
            steps: [],
            surface: options.surface,
            tracePath: "../../scripted-outside-sentinel.txt",
          },
          trace: {
            schema: ACTOR_TRACE_SCHEMA,
            provider: "browser-persona",
            protocol: "scripted-steps",
            lane: "scripted-browser",
            persona: options.persona,
            redaction: { status: "passed", screenshots: "none", notes: "synthetic" },
            startedAt: "2026-07-13T00:00:00.000Z",
            completedAt: "2026-07-13T00:00:00.000Z",
            status: "passed",
            completionReason: "goal_satisfied",
            summary: "synthetic",
            capabilities: SCRIPTED_BROWSER_CAPABILITIES,
            actions: [],
            tokenUsage: { input: 0, output: 0, total: 0, costUsd: 0 },
          },
        }) as unknown as ScriptedBrowserSessionResult,
    };

    await expect(
      runScriptedBrowserLab({
        cwd,
        config: scriptedConfig({ count: 1, mode: "live" }),
        dryRun: false,
        hooks,
        runId,
      }),
    ).rejects.toThrow(/unsafe artifact path/i);
    expect(await readFile(outside, "utf8")).toBe("UNCHANGED");
    await expect(
      stat(path.join(cwd, ".humanish", "runs", runId, "run.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(cwd, ".humanish", "runs", "latest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  describe("scenario.ref consumption (fail-closed)", () => {
    it.each([
      ["missing scenario file", "does-not-exist", undefined],
      ["invalid YAML", "broken-scenario", "id: broken\n  bad:\n indent: [unclosed"],
      [
        "zero executable browser steps",
        "no-browser-steps",
        [
          "schema: humanish.scenario.v1",
          "id: no-browser-steps",
          "title: Prose-only scenario",
          "goal: No executable steps here.",
          "steps:",
          "  - name: look around",
          "    expectation: something is visible",
        ].join("\n"),
      ],
      [
        "fill step without a selector",
        "fill-without-selector",
        [
          "schema: humanish.scenario.v1",
          "id: fill-without-selector",
          "browser:",
          "  steps:",
          "    - id: missing-selector",
          "      action: fill",
          "      value: synthetic.user@example.test",
        ].join("\n"),
      ],
    ])(
      "returns HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID with no artifacts: %s",
      async (_label, ref, text) => {
        if (text !== undefined) {
          await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
          await writeFile(path.join(cwd, "humanish", "scenarios", `${ref}.yaml`), text, "utf8");
        }
        const result = await runScriptedBrowserLab({
          cwd,
          config: scriptedConfig({ ref }),
          dryRun: true,
        });
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID");
        expect(result.runId).toBe("not-created");
        await expect(readdir(path.join(cwd, ".humanish", "runs"))).rejects.toThrow();
      },
    );

    it("clamps path-style refs inside the target cwd (no ../../ escape recorded as provenance)", async () => {
      const result = await runScriptedBrowserLab({
        cwd,
        config: scriptedConfig({ ref: "../../outside/evil.yaml" }),
        dryRun: true,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID");
      expect(result.error?.message).toContain("inside the target cwd");
      await expect(readdir(path.join(cwd, ".humanish", "runs"))).rejects.toThrow();
    });

    it("resolves a path-style ref and records repo-relative provenance", async () => {
      const text = await readFile(
        path.join(ROOT, "humanish", "scenarios", "scripted-first-run.yaml"),
        "utf8",
      );
      await mkdir(path.join(cwd, "custom"), { recursive: true });
      await writeFile(path.join(cwd, "custom", "journey.yaml"), text, "utf8");
      const result = await runScriptedBrowserLab({
        cwd,
        config: scriptedConfig({ ref: "custom/journey.yaml" }),
        dryRun: true,
      });
      expect(result.ok).toBe(true);
      expect(result.scenario?.source).toBe("custom/journey.yaml");
      expect(result.scenario?.sourceDigest).toBe(digestText(text));
    });

    it("rejects a symlinked scenario before any browser hook runs or outside bytes enter output", async () => {
      const outsideScenario = path.join(path.dirname(cwd), "outside-scenario.yaml");
      const secretMarker = "OUTSIDE-SCENARIO-SECRET";
      const scenarioText = await readFile(
        path.join(ROOT, "humanish", "scenarios", "scripted-first-run.yaml"),
        "utf8",
      );
      await writeFile(outsideScenario, `${scenarioText}\n# ${secretMarker}\n`, "utf8");
      await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
      await symlink(outsideScenario, path.join(cwd, "humanish", "scenarios", "linked.yaml"));
      let hookCalled = false;

      const result = await runScriptedBrowserLab({
        cwd,
        config: scriptedConfig({ ref: "linked", mode: "live" }),
        dryRun: false,
        hooks: {
          browserCommand: "/synthetic/browser",
          runSession: async () => {
            hookCalled = true;
            throw new Error("must not run");
          },
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID");
      expect(result.error?.message).not.toContain(secretMarker);
      expect(hookCalled).toBe(false);
      await expect(readdir(path.join(cwd, ".humanish", "runs"))).rejects.toThrow();
    });
  });

  it("rejects a non-scripted actor at the engine even if a config bypasses the parser", async () => {
    await writeCommittedScenario(cwd);
    const tampered = { ...scriptedConfig(), actors: [{ type: "codex-app-server" }] } as LabConfig;
    const result = await runScriptedBrowserLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SCRIPTED_LAB_ACTOR_UNSUPPORTED");
  });

  it("re-enforces the loopback boundary at the engine even if a config bypasses the parser", async () => {
    await writeCommittedScenario(cwd);
    const config = scriptedConfig();
    const tampered = {
      ...config,
      subject: { source: "app-url" as const, appUrl: "https://example.com/" },
    };
    const result = await runScriptedBrowserLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE");
    expect(result.runId).toBe("not-created");
    await expect(readdir(path.join(cwd, ".humanish", "runs"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CLI (rung 4): the committed scripted-demo lab through `lab run`, JSON + human.
// ---------------------------------------------------------------------------

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (
      !(
        error instanceof CommanderError &&
        (error.code === "commander.helpDisplayed" || error.code === "commander.version")
      )
    ) {
      throw error;
    }
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("humanish lab run scripted-demo (CLI)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-scripted-cli-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "fixture-app" }, null, 2),
    );
    const lab = await readFile(path.join(ROOT, "humanish", "labs", "scripted-demo.yaml"), "utf8");
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
    await writeFile(path.join(cwd, "humanish", "labs", "scripted-demo.yaml"), lab, "utf8");
    await writeCommittedScenario(cwd);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("dry-run --json emits the structured scripted lab result", async () => {
    const result = await runCli([
      "lab",
      "run",
      "scripted-demo",
      "--cwd",
      cwd,
      "--dry-run",
      "--json",
      "--no-open",
      "--run-id",
      "scripted-cli-json",
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      schema: string;
      ok: boolean;
      dryRun: boolean;
      actor: string;
      labId: string;
      runId: string;
      scenario: { id: string; source: string; steps: number };
    };
    expect(envelope.schema).toBe("humanish.scripted-lab-result.v1");
    expect(envelope.ok).toBe(true);
    expect(envelope.dryRun).toBe(true);
    expect(envelope.actor).toBe("scripted-browser");
    expect(envelope.labId).toBe("scripted-demo");
    expect(envelope.runId).toBe("scripted-cli-json");
    expect(envelope.scenario).toEqual(
      expect.objectContaining({
        id: "scripted-first-run",
        source: "humanish/scenarios/scripted-first-run.yaml",
        steps: 4,
      }),
    );
  });

  it("dry-run human output names run/lab/actor/subject/scenario", async () => {
    const result = await runCli([
      "lab",
      "run",
      "scripted-demo",
      "--cwd",
      cwd,
      "--dry-run",
      "--no-open",
      "--run-id",
      "scripted-cli-human",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("humanish lab scripted dry-run");
    expect(result.stdout).toContain("run: scripted-cli-human");
    expect(result.stdout).toContain("lab: scripted-demo");
    expect(result.stdout).toContain("actor: scripted-browser");
    expect(result.stdout).toContain("subject: http://127.0.0.1:5173/");
    expect(result.stdout).toContain("scenario: scripted-first-run @");
    expect(result.stdout).toContain("(humanish/scenarios/scripted-first-run.yaml, 4 steps)");
  });
});

// Characterization: the complete run directory of each deterministic scripted run, pinned so a
// refactor of bundle assembly or artifact writing shows up as a diff. Regenerate with
// `pnpm vitest run tests/routes/scripted-browser.test.ts -u` and review the golden diff.
describe("scripted-browser run directory goldens", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-scripted-golden-"));
    await writeCommittedScenario(cwd);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("dry run with two surfaces", async () => {
    const stderr = captureStderr();
    const outcome = await runLab(scriptedConfig({ count: 2 }), { cwd, dryRun: true }).finally(
      stderr.stop,
    );
    const runId = outcome.result.runId;
    if (!runId) throw new Error("the run wrote no bundle");
    const snapshot = await runDirSnapshot(path.join(cwd, ".humanish", "runs", runId), {
      result: outcome.result,
      stderr: stderr.text(),
      replace: [
        [runId, "[run]"],
        [cwd, "[cwd]"],
      ],
    });
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/routes/scripted-dry-run.json",
    );
  });

  it("live journey that passes on a fake browser", async () => {
    await withHttpServer(async (appUrl) => {
      const stderr = captureStderr();
      const outcome = await runLab(scriptedConfig({ appUrl, count: 1, mode: "live" }), {
        cwd,
        automaticAnalysis: { run: automaticAnalysisBoundary() },
        scriptedHooks: {
          launchBrowser: async () => makeFakeBrowser({ bodyAfterClick: "Welcome aboard" }),
        },
      }).finally(stderr.stop);
      const runId = outcome.result.runId;
      if (!runId) throw new Error("the run wrote no bundle");
      const snapshot = await runDirSnapshot(path.join(cwd, ".humanish", "runs", runId), {
        result: outcome.result,
        stderr: stderr.text(),
        replace: [
          [runId, "[run]"],
          [cwd, "[cwd]"],
          [appUrl, "[app-url]/"],
          [new URL(appUrl).host, "[app-host]"],
        ],
      });
      await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
        "../golden/routes/scripted-live.json",
      );
      // A spend-free live run reads as $0, never as an unmeasured cost.
      expect((await verifyRun(cwd, runId)).ok).toBe(true);
      const stats = await computeStats(cwd);
      if (!("costsByRun" in stats)) throw new Error("stats failed");
      const row = stats.costsByRun.find((entry) => entry.runId === runId);
      expect(row?.costs.runEstimatedUsd).toBe(0);
      expect(row?.warnings).not.toContain("RUN_COST_COMPLETENESS_UNKNOWN");
    });
  });

  it("live journey on a provisioned clone", async () => {
    const runId = "scripted-clone-golden";
    const fakeE2B = makeFakeE2BModule({ resources: { cpuCount: 8, memoryMB: 8192 } });
    // The subject sandbox's create and teardown read this clock, so its desktop minutes and cost
    // are fixed instead of measured.
    let clock = 0;
    const stderr = captureStderr();
    const outcome = await runLab(provisionedScriptedConfig(), {
      cwd,
      runId,
      automaticAnalysis: { run: automaticAnalysisBoundary() },
      scriptedHooks: {
        ...provisionedCloneHooks(fakeE2B.module).hooks,
        now: () => (clock += 60_000),
      },
    }).finally(stderr.stop);
    expect(outcome.result.ok).toBe(true);
    const snapshot = await runDirSnapshot(path.join(cwd, ".humanish", "runs", runId), {
      result: outcome.result,
      stderr: stderr.text(),
      replace: [
        [runId, "[run]"],
        [cwd, "[cwd]"],
      ],
    });
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/routes/scripted-clone-live.json",
    );
  });
});

describe("scripted run lifetime on the provisioned clone route", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-scripted-lifetime-"));
    await writeCommittedScenario(cwd);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function cloneHooks(
    module: E2BDesktopModule,
    runSession: ScriptedBrowserLabHooks["runSession"],
  ): ScriptedBrowserLabHooks {
    let clock = Date.parse("2026-09-30T00:00:00.000Z");
    return {
      env: { E2B_API_KEY: "fake-e2b-key-for-test", GITHUB_TOKEN: "github-token-test" },
      loadDesktopModule: async () => module,
      browserCommand: "/synthetic/browser",
      ...(runSession === undefined ? {} : { runSession }),
      detachedTimers: {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    };
  }

  it("S2: an unsafe session result after start kills the subject, closes the run and runs no analysis", async () => {
    const runId = "unsafe-after-start";
    const runDir = path.join(cwd, ".humanish", "runs", runId);
    const fakeE2B = makeFakeE2BModule();
    const analysis = automaticAnalysisBoundary();
    const hooks = cloneHooks(
      fakeE2B.module,
      async (options) =>
        ({
          status: "passed",
          completionReason: "goal_satisfied",
          reason: "synthetic unsafe result",
          capture: {
            capturedAt: "2026-09-30T00:00:00.000Z",
            durationMs: 1,
            ok: true,
            reason: "synthetic unsafe result",
            steps: [],
            surface: options.surface,
            tracePath: "../../outside.txt",
          },
        }) as unknown as ScriptedBrowserSessionResult,
    );

    await expect(
      runLab(provisionedScriptedConfig(), {
        cwd,
        runId,
        scriptedHooks: hooks,
        automaticAnalysis: { run: analysis },
      }),
    ).rejects.toThrow(/unsafe artifact path/i);

    expect(fakeE2B.killed).toEqual(["fake-subject-001"]);
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8"));
    expect(status.state).toBe("finished");
    expect(status).not.toHaveProperty("outcome");
    await expect(stat(path.join(runDir, "run.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(analysis).not.toHaveBeenCalled();
  });

  it("records the cloned commit when the install fails after the clone", async () => {
    const runId = "install-fails-after-clone";
    const runDir = path.join(cwd, ".humanish", "runs", runId);
    const fakeE2B = makeFakeE2BModule({ failStep: "subject-install" });
    const hooks = cloneHooks(fakeE2B.module, async () => {
      throw new Error("the session must not start when the subject is not served");
    });

    const stderr = captureStderr();
    const outcome = await runLab(provisionedScriptedConfig(), {
      cwd,
      runId,
      scriptedHooks: hooks,
    }).finally(stderr.stop);
    if (outcome.backend !== "scripted") throw new Error(`unexpected backend ${outcome.backend}`);
    expect(outcome.result.ok).toBe(false);
    expect(fakeE2B.killed).toEqual(["fake-subject-001"]);
    expect(outcome.result.error?.message).toMatch(/^subject install failed/);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.subject).toMatchObject({ source: "clone", commit: "abc123def4567890abc1" });
    await expectFailureGolden("scripted/clone-install-fails", runDir, {
      result: outcome.result,
      stderr: stderr.text(),
      replace: [
        [runId, "[run]"],
        [cwd, "[cwd]"],
      ],
      // Desktop minutes are host-measured wall-clock spans of the fake subject sandbox.
      maskKeys: ["minutes", "desktopMinutes"],
    });
  });

  it.each([
    [
      "a not-found kill error reads as already gone",
      async (sandboxId: string): Promise<boolean> => {
        throw Object.assign(new Error(`Sandbox ${sandboxId} not found`), {
          name: "SandboxNotFoundError",
        });
      },
      true,
      "Subject sandbox was already absent when cleanup ran",
    ],
    [
      "a non-boolean kill answer is not proof of release",
      async () => "ok" as unknown as boolean,
      false,
      "Subject sandbox teardown returned an unexpected result",
    ],
  ] as const)("subject teardown: %s", async (_label, kill, killed, warning) => {
    const fakeE2B = makeFakeE2BModule();
    fakeE2B.module.Sandbox.kill = kill;
    const hooks = cloneHooks(fakeE2B.module, async () => {
      throw new Error("synthetic session failure");
    });
    const outcome = await runLab(provisionedScriptedConfig(), { cwd, scriptedHooks: hooks });
    if (outcome.backend !== "scripted") throw new Error(`unexpected backend ${outcome.backend}`);
    expect(outcome.result.subjectSandbox).toEqual({ sandboxId: "fake-subject-001", killed });
    expect(outcome.result.warnings.join("\n")).toContain(warning);
  });

  it("a failed subject teardown leaves a passing run's verdict and ok alone", async () => {
    const fakeE2B = makeFakeE2BModule();
    const kill = fakeE2B.module.Sandbox.kill!;
    fakeE2B.module.Sandbox.kill = async (sandboxId, options) => {
      await kill(sandboxId, options);
      throw new Error("synthetic kill failure");
    };
    const passing = provisionedCloneHooks(fakeE2B.module).hooks.runSession;
    const hooks = cloneHooks(fakeE2B.module, passing);

    const outcome = await runLab(provisionedScriptedConfig(), { cwd, scriptedHooks: hooks });
    if (outcome.backend !== "scripted") throw new Error(`unexpected backend ${outcome.backend}`);
    expect(outcome.result.subjectSandbox?.killed).toBe(false);
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      outcome?: { verdict?: string };
    };
    expect(bundle.review.verdict).toBe("pass");
    expect(status.outcome?.verdict).toBe("pass");
    expect(outcome.result.ok).toBe(true);
  });

  it("S3: after a failed subject teardown, reclaim kills the receipted subject", async () => {
    const runId = "failed-teardown";
    const fakeE2B = makeFakeE2BModule();
    const kill = fakeE2B.module.Sandbox.kill!;
    fakeE2B.module.Sandbox.kill = async (sandboxId, options) => {
      await kill(sandboxId, options);
      throw new Error("synthetic kill failure");
    };
    const hooks = cloneHooks(fakeE2B.module, async () => {
      throw new Error("synthetic session failure");
    });

    const outcome = await runLab(provisionedScriptedConfig(), { cwd, runId, scriptedHooks: hooks });
    if (outcome.backend !== "scripted") throw new Error(`unexpected backend ${outcome.backend}`);
    expect(outcome.result.subjectSandbox).toEqual({ sandboxId: "fake-subject-001", killed: false });

    const reclaimed: string[] = [];
    await reclaimRunSandboxes(cwd, runId, {
      loadModule: async () =>
        ({
          Sandbox: {
            async kill(sandboxId: string) {
              reclaimed.push(sandboxId);
              return true;
            },
          },
        }) as unknown as E2BDesktopModule,
    });
    expect(reclaimed).toEqual(["fake-subject-001"]);
  });
});
