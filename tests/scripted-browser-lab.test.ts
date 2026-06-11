import { CommanderError } from "commander";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import { createProgram } from "../src/program.js";
import { digestText } from "../src/redaction.js";
import { verifyRun } from "../src/run.js";
import { runCuaActorLab } from "../src/cua-actor-lab.js";
import {
  runScriptedBrowserLab,
  type ScriptedBrowserLabHooks
} from "../src/scripted-browser-lab.js";
import type { ScriptedBrowserLike, ScriptedLocatorLike, ScriptedPageLike } from "../src/scripted-browser-actor.js";

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Fakes + fixtures. The fake browser drives the REAL step executor and writes
// real screenshot bytes, so evidence-presence checks see what a live run would.
// ---------------------------------------------------------------------------

function makeFakeBrowser(options: {
  bodyAfterClick?: string;
  selectorCounts?: Record<string, number>;
} = {}): ScriptedBrowserLike {
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
      isVisible: async () => count > 0
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
    waitForFunction: async (_fn, needle) => {
      if (typeof needle === "string" && state.body.includes(needle)) return undefined;
      throw new Error(`Timeout waiting for text ${String(needle)}`);
    },
    screenshot: async ({ path: screenshotPath }) => {
      await writeFile(screenshotPath, Buffer.from(`fake-frame:${state.body}`));
      return undefined;
    },
    url: () => state.url,
    evaluate: async <T,>() => state.body as unknown as T
  };
  return {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => undefined
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

/** Copy the COMMITTED demo scenario into the temp cwd so the test binds to the real file. */
async function writeCommittedScenario(cwd: string): Promise<string> {
  const text = await readFile(path.join(ROOT, "mimetic", "scenarios", "scripted-first-run.yaml"), "utf8");
  await mkdir(path.join(cwd, "mimetic", "scenarios"), { recursive: true });
  await writeFile(path.join(cwd, "mimetic", "scenarios", "scripted-first-run.yaml"), text, "utf8");
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
    actors: [{ type: "scripted-browser", persona: "synthetic-new-user", ...(overrides?.count === undefined ? {} : { count: overrides.count }) }],
    scenario: { ref: overrides?.ref ?? "scripted-first-run", ...(overrides?.mode === undefined ? {} : { mode: overrides.mode }) },
    execution: { ...(overrides && "target" in overrides ? (overrides.target ? { target: overrides.target } : {}) : { target: "local" }), timeoutMs: 30_000 }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("lab routing (app-url × scripted-browser → scripted)", () => {
  it("selectLabBackend routes app-url × local × scripted-browser to the scripted backend (target absent too)", () => {
    expect(selectLabBackend(scriptedConfig())).toBe("scripted");
    expect(selectLabBackend(scriptedConfig({ target: undefined }))).toBe("scripted");
  });

  it("REGRESSION: app-url × e2b-desktop × openai-computer-use still routes to cua, and the other three backends are untouched", () => {
    const cua = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use" }],
      execution: { target: "e2b-desktop" }
    });
    const synthetic = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "s",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona" }]
    });
    const smoke = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "c",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "mimetic-setup" }]
    });
    const meta = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "m",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "codex-app-server" }],
      execution: { target: "e2b-desktop" }
    });
    if (!cua.ok || !synthetic.ok || !smoke.ok || !meta.ok) throw new Error("fixture configs must parse");
    expect(selectLabBackend(cua.config)).toBe("cua");
    expect(selectLabBackend(synthetic.config)).toBe("synthetic");
    expect(selectLabBackend(smoke.config)).toBe("smoke");
    expect(selectLabBackend(meta.config)).toBe("meta");
  });

  it("library-API fallback: app-url with an UNREGISTERED actor type still routes to cua's fail-closed gate", async () => {
    // Such a config cannot parse; build it by hand (the library-API path).
    const tampered = {
      ...scriptedConfig(),
      actors: [{ type: "not-a-registered-actor" }]
    } as LabConfig;
    expect(selectLabBackend(tampered)).toBe("cua");
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-scripted-fallback-"));
    try {
      const result = await runCuaActorLab({ cwd, config: tampered, dryRun: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_CUA_LAB_ACTOR_UNSUPPORTED");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("runScriptedBrowserLab", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-scripted-lab-"));
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
      source: "mimetic/scenarios/scripted-first-run.yaml",
      sourceDigest: digestText(scenarioText),
      steps: 4
    });

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.schema).toBe("mimetic.run-bundle.v1");
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.simCount).toBe(2);
    expect(bundle.cwd).toBe("[target-cwd]");
    expect(bundle.simulations.map((sim: { id: string; status: string }) => [sim.id, sim.status])).toEqual([
      ["scripted-desktop", "contract_proof_only"],
      ["scripted-mobile", "contract_proof_only"]
    ]);
    // No session ran, so no stream.actor exists (mirrors the cua dry-run honesty rule).
    for (const stream of bundle.streams) {
      expect(stream.actor).toBeUndefined();
    }
    expect(bundle.review.verdict).toBe("contract_proof_only");
    expect(bundle.scenario.sourceDigest).toBe(digestText(scenarioText));
    // The UNPINNED subject declaration + the $0 spend declaration are explicit events.
    const subjectEvent = bundle.events.find((event: { type: string }) => event.type === "scripted-lab.subject.declared");
    expect(subjectEvent?.message).toContain("UNPINNED");
    expect(subjectEvent?.message).toContain("scenario digest");
    const spendEvent = bundle.events.find((event: { type: string }) => event.type === "scripted-lab.spend");
    expect(spendEvent?.message).toContain("$0 provider spend by construction");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);

    // latest.json points at THIS run so `verify --run latest` stays honest.
    const pointer = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", "latest.json"), "utf8"));
    expect(pointer.runId).toBe(result.runId);
  });

  it("default surface roster is 1 (desktop only) — the single-lane default governs; count: 2 is the override", async () => {
    await writeCommittedScenario(cwd);
    const outcome = await runLab(scriptedConfig(), { cwd, dryRun: true });
    if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.simCount).toBe(1);
    expect(bundle.simulations.map((sim: { id: string }) => sim.id)).toEqual(["scripted-desktop"]);
  });

  it("live (with a fake browser): the registry actor drives the REAL step engine per surface, fills stream.actor, and verifies", async () => {
    await writeCommittedScenario(cwd);
    await withHttpServer(async (appUrl) => {
      const hooks: ScriptedBrowserLabHooks = {
        launchBrowser: async () => makeFakeBrowser({ bodyAfterClick: "Welcome aboard" })
      };
      const outcome = await runLab(scriptedConfig({ appUrl, count: 2, mode: "live" }), { cwd, scriptedHooks: hooks });
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

      const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
      expect(bundle.mode).toBe("live");
      expect(bundle.simCount).toBe(2);

      for (const surface of ["desktop", "mobile"]) {
        const stream = bundle.streams.find((entry: { id: string }) => entry.id === `scripted-${surface}-stream`);
        // The seam this registration exists to fill.
        expect(stream.actor.schema).toBe(ACTOR_TRACE_SCHEMA);
        expect(stream.actor.lane).toBe("scripted-browser");
        expect(stream.actor.provider).toBe("browser-persona");
        expect(stream.actor.protocol).toBe("scripted-steps");
        expect(stream.actor.tokenUsage).toEqual({ input: 0, output: 0, total: 0, costUsd: 0 });
        // REAL emulated viewport metadata (isMobile/DSF genuinely render on this route).
        expect(stream.viewport.isMobile).toBe(surface === "mobile");

        // Native + projected traces persist on disk; the projection matches the seam.
        const nativeTrace = JSON.parse(await readFile(path.join(runDir, "traces", `${surface}.json`), "utf8"));
        expect(nativeTrace.schema).toBe("mimetic.browser-persona-trace.v1");
        const actorTrace = JSON.parse(await readFile(path.join(runDir, `actor-${surface}.json`), "utf8"));
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
      for (const file of ["run.json", "review.json", "review.md", "events.ndjson", "actor-desktop.json", "actor-mobile.json"]) {
        const text = await readFile(path.join(runDir, file), "utf8");
        expect(text, file).not.toContain(cwd);
        expect(text, file).not.toContain(tmpdir());
      }
    });
  });

  it("the subject failing the script is successful EVIDENCE: lab ok stays true, review verdict is fail", async () => {
    await writeCommittedScenario(cwd);
    await withHttpServer(async (appUrl) => {
      // Click never produces the Welcome state -> stateChanged + waitForText fail honestly.
      const hooks: ScriptedBrowserLabHooks = {
        launchBrowser: async () => makeFakeBrowser({})
      };
      const outcome = await runLab(scriptedConfig({ appUrl, count: 1, mode: "live" }), { cwd, scriptedHooks: hooks });
      if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
      const result = outcome.result;

      // Deliberate divergence from `run --app-url` (whose ok = journey passed): credible
      // failure evidence is a SUCCESSFUL lab run.
      expect(result.ok).toBe(true);
      expect(result.sessions[0]?.completionReason).toBe("step_failed");
      expect(result.sessions[0]?.status).toBe("failed");

      const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
      expect(bundle.review.verdict).toBe("fail");
      expect(bundle.review.gaps.join("\n")).toContain("desktop");
      const sessionEvent = bundle.events.find((event: { type: string }) => event.type === "scripted-lab.session.step_failed");
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
        }
      };
      const outcome = await runLab(scriptedConfig({ appUrl, count: 1, mode: "live" }), { cwd, scriptedHooks: hooks });
      if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
      const result = outcome.result;

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_SCRIPTED_LAB_FAILED");
      expect(result.sessions[0]?.completionReason).toBe("harness_error");
      const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
      expect(bundle.review.verdict).toBe("fail");
    });
  });

  it("an unexpected runSession throw becomes a redacted structured failure with a failed bundle (no raw throw)", async () => {
    const secretToken = "Bearer " + "a1b2c3d4e5".repeat(4);
    await writeCommittedScenario(cwd);
    const hooks: ScriptedBrowserLabHooks = {
      runSession: async () => {
        throw new Error(`session exploded with ${secretToken}`);
      },
      launchBrowser: async () => makeFakeBrowser({})
    };
    const outcome = await runLab(scriptedConfig({ count: 1, mode: "live" }), { cwd, scriptedHooks: hooks });
    if (outcome.backend !== "scripted") throw new Error("expected scripted backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_SCRIPTED_LAB_FAILED");
    expect(result.error?.message).not.toContain(secretToken);

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(secretToken);
    }
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.simulations[0].status).toBe("failed");
    expect(bundle.review.verdict).toBe("fail");
  });

  describe("scenario.ref consumption (fail-closed)", () => {
    it.each([
      ["missing scenario file", "does-not-exist", undefined],
      ["invalid YAML", "broken-scenario", "id: broken\n  bad:\n indent: [unclosed"],
      ["zero executable browser steps", "no-browser-steps", [
        "schema: mimetic.scenario.v1",
        "id: no-browser-steps",
        "title: Prose-only scenario",
        "goal: No executable steps here.",
        "steps:",
        "  - name: look around",
        "    expectation: something is visible"
      ].join("\n")]
    ])("returns MIMETIC_SCRIPTED_LAB_SCENARIO_INVALID with no artifacts: %s", async (_label, ref, text) => {
      if (text !== undefined) {
        await mkdir(path.join(cwd, "mimetic", "scenarios"), { recursive: true });
        await writeFile(path.join(cwd, "mimetic", "scenarios", `${ref}.yaml`), text, "utf8");
      }
      const result = await runScriptedBrowserLab({ cwd, config: scriptedConfig({ ref }), dryRun: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_SCRIPTED_LAB_SCENARIO_INVALID");
      expect(result.runId).toBe("not-created");
      await expect(readdir(path.join(cwd, ".mimetic", "runs"))).rejects.toThrow();
    });

    it("clamps path-style refs inside the target cwd (no ../../ escape recorded as provenance)", async () => {
      const result = await runScriptedBrowserLab({
        cwd,
        config: scriptedConfig({ ref: "../../outside/evil.yaml" }),
        dryRun: true
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_SCRIPTED_LAB_SCENARIO_INVALID");
      expect(result.error?.message).toContain("inside the target cwd");
      await expect(readdir(path.join(cwd, ".mimetic", "runs"))).rejects.toThrow();
    });

    it("resolves a path-style ref and records repo-relative provenance", async () => {
      const text = await readFile(path.join(ROOT, "mimetic", "scenarios", "scripted-first-run.yaml"), "utf8");
      await mkdir(path.join(cwd, "custom"), { recursive: true });
      await writeFile(path.join(cwd, "custom", "journey.yaml"), text, "utf8");
      const result = await runScriptedBrowserLab({
        cwd,
        config: scriptedConfig({ ref: "custom/journey.yaml" }),
        dryRun: true
      });
      expect(result.ok).toBe(true);
      expect(result.scenario?.source).toBe("custom/journey.yaml");
      expect(result.scenario?.sourceDigest).toBe(digestText(text));
    });
  });

  it("rejects a non-scripted actor at the engine even if a config bypasses the parser", async () => {
    await writeCommittedScenario(cwd);
    const tampered = { ...scriptedConfig(), actors: [{ type: "codex-app-server" }] } as LabConfig;
    const result = await runScriptedBrowserLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_SCRIPTED_LAB_ACTOR_UNSUPPORTED");
  });

  it("re-enforces the loopback boundary at the engine even if a config bypasses the parser", async () => {
    await writeCommittedScenario(cwd);
    const config = scriptedConfig();
    const tampered = { ...config, subject: { source: "app-url" as const, appUrl: "https://example.com/" } };
    const result = await runScriptedBrowserLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_SCRIPTED_LAB_SUBJECT_UNSAFE");
    expect(result.runId).toBe("not-created");
    await expect(readdir(path.join(cwd, ".mimetic", "runs"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CLI (rung 4): the committed scripted-demo lab through `lab run`, JSON + human.
// ---------------------------------------------------------------------------

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    }
  });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "mimetic", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError && (error.code === "commander.helpDisplayed" || error.code === "commander.version"))) {
      throw error;
    }
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("mimetic lab run scripted-demo (CLI)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-scripted-cli-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture-app" }, null, 2));
    const lab = await readFile(path.join(ROOT, "mimetic", "labs", "scripted-demo.yaml"), "utf8");
    await mkdir(path.join(cwd, "mimetic", "labs"), { recursive: true });
    await writeFile(path.join(cwd, "mimetic", "labs", "scripted-demo.yaml"), lab, "utf8");
    await writeCommittedScenario(cwd);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("dry-run --json emits the structured scripted lab result", async () => {
    const result = await runCli(["lab", "run", "scripted-demo", "--cwd", cwd, "--dry-run", "--json", "--no-open", "--run-id", "scripted-cli-json"]);
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
    expect(envelope.schema).toBe("mimetic.scripted-lab-result.v1");
    expect(envelope.ok).toBe(true);
    expect(envelope.dryRun).toBe(true);
    expect(envelope.actor).toBe("scripted-browser");
    expect(envelope.labId).toBe("scripted-demo");
    expect(envelope.runId).toBe("scripted-cli-json");
    expect(envelope.scenario).toEqual(expect.objectContaining({
      id: "scripted-first-run",
      source: "mimetic/scenarios/scripted-first-run.yaml",
      steps: 4
    }));
  });

  it("dry-run human output names run/lab/actor/subject/scenario", async () => {
    const result = await runCli(["lab", "run", "scripted-demo", "--cwd", cwd, "--dry-run", "--no-open", "--run-id", "scripted-cli-human"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mimetic lab scripted dry-run");
    expect(result.stdout).toContain("run: scripted-cli-human");
    expect(result.stdout).toContain("lab: scripted-demo");
    expect(result.stdout).toContain("actor: scripted-browser");
    expect(result.stdout).toContain("subject: http://127.0.0.1:5173/");
    expect(result.stdout).toContain("scenario: scripted-first-run @");
    expect(result.stdout).toContain("(mimetic/scenarios/scripted-first-run.yaml, 4 steps)");
  });
});
