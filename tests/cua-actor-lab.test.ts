import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import type { ActorCapabilities } from "../src/actor-contract.js";
import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import { runCuaActorSession, type CuaActorSessionOptions } from "../src/computer-use-actor.js";
import type {
  CuaAction,
  CuaExecutor,
  CuaObservation,
  CuaProvider,
  CuaTurn
} from "../src/computer-use.js";
import {
  CUA_ACTOR_LAB_PROVIDER_METADATA,
  buildCuaBundle,
  runCuaActorLab,
  type CuaActorLabHooks
} from "../src/cua-actor-lab.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox
} from "../src/e2b-desktop-launch.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import type { FetchLike } from "../src/openai-responses-cu.js";
import type {
  BrowserLabScoringContext,
  RunAdapterScore,
  RunBundle,
  RunFeedbackCandidate
} from "../src/index.js";
import { containsSensitive } from "../src/redaction.js";
import { verifyRun } from "../src/run.js";

// ---------------------------------------------------------------------------
// Fakes. The desktop module fake serves BOTH faces of the sandbox: the
// E2BDesktopSandbox shape the lab provisions through, and the E2BDesktopLike
// input surface the real executor actuates. Frames are real PNGs (distinct per
// call) so the loop's perceptual progress signature registers movement.
// ---------------------------------------------------------------------------

function makePng(seed: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (seed * 37 + i) % 256;
    png.data[i + 1] = (seed * 89 + i) % 256;
    png.data[i + 2] = (seed * 13 + i) % 256;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function scriptedFetch(responses: unknown[]): FetchLike {
  let i = 0;
  return async (_url, _init) => {
    const value = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
  };
}

interface FakeSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
}

function makeFakeSandbox(options: {
  withOpen?: boolean;
  commandHandler?: (command: string) => { stdout?: string; exitCode?: number } | undefined;
} = {}): FakeSandbox {
  let frame = 0;
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => async (...args: unknown[]): Promise<void> => {
    calls.push([name, ...args]);
  };
  const sandbox = {
    calls,
    sandboxId: "fake-sandbox-001",
    commands: {
      run: async (command: string) => {
        calls.push(["commands.run", command]);
        return options.commandHandler?.(command) ?? { exitCode: 0, stdout: "" };
      }
    },
    files: {
      write: async (filePath: string, data: string | ArrayBuffer) => {
        calls.push(["files.write", filePath, String(data)]);
        return undefined;
      }
    },
    launch: record("launch") as (application: string, uri?: string) => Promise<void>,
    ...(options.withOpen === false ? {} : { open: record("open") as (fileOrUrl: string) => Promise<void> }),
    async screenshot() {
      frame += 1;
      return makePng(frame);
    },
    async wait(ms: number) {
      calls.push(["wait", ms]);
    },
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async () => {
        calls.push(["stream.start"]);
      }
    },
    // E2BDesktopLike actuation surface (driven by the real executor).
    leftClick: record("leftClick"),
    rightClick: record("rightClick"),
    middleClick: record("middleClick"),
    doubleClick: record("doubleClick"),
    moveMouse: record("moveMouse"),
    scroll: record("scroll"),
    write: record("write"),
    press: record("press"),
    drag: record("drag")
  };
  return sandbox as unknown as FakeSandbox;
}

function expectSafeBrowserOpen(calls: Array<[string, ...unknown[]]>, url: string): number {
  const quotedUrl = url.replace(/'/g, "'\\''");
  const index = calls.findIndex(
    (call) =>
      call[0] === "commands.run" &&
      String(call[1]).includes(`target_url='${quotedUrl}'`) &&
      String(call[1]).includes("launch_browser xdg-open xdg-open")
  );
  expect(index).toBeGreaterThan(-1);
  return index;
}

function makeFakeModule(sandbox: FakeSandbox): {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
} {
  const created: E2BDesktopCreateOptions[] = [];
  // Parallel to `created`: the custom desktop template each create() was called with, or undefined
  // when called with NO template arg (the byte-stable default). Mirrors the real @e2b/desktop
  // overload: create(opts) OR create(template, opts).
  const templates: (string | undefined)[] = [];
  const killed: string[] = [];
  const module: E2BDesktopModule = {
    Sandbox: {
      create: async (templateOrOptions: string | E2BDesktopCreateOptions, maybeOptions?: E2BDesktopCreateOptions) => {
        const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
        const createOptions = typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
        templates.push(template);
        created.push(createOptions);
        return sandbox;
      },
      kill: async (sandboxId) => {
        killed.push(sandboxId);
        return undefined;
      }
    }
  };
  return { module, created, templates, killed };
}

const TWO_TURN_SESSION = [
  { id: "resp_1", output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }] },
  { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }
];
const BROWSER_ADAPTER_NAMESPACE = "browser-adapter-proof";

function failingBrowserScore(ctx: BrowserLabScoringContext): RunAdapterScore {
  return {
    schema: "mimetic.adapter-score.v1",
    namespace: BROWSER_ADAPTER_NAMESPACE,
    status: "fail",
    score: 12,
    summary: `${ctx.backend} actor stopped before product evidence.`,
    data: {
      backend: ctx.backend,
      laneCount: ctx.laneCount,
      productAcceptance: "missing"
    }
  };
}

function browserFeedback(ctx: BrowserLabScoringContext): RunFeedbackCandidate[] {
  return [{
    schema: "mimetic.feedback-candidate.v1",
    id: `${BROWSER_ADAPTER_NAMESPACE}-${ctx.runId}`,
    run_id: ctx.runId,
    stream_id: ctx.bundle.streams[0]?.id ?? "stream-001",
    adapter_id: BROWSER_ADAPTER_NAMESPACE,
    scenario_id: ctx.labId,
    persona_id: ctx.bundle.simulations[0]?.personaId ?? "unknown",
    actor: "unknown",
    substrate: "e2b-desktop",
    failure_owner: "actor",
    summary: "Browser actor reached a terminal session but did not provide product-visible completion evidence.",
    expected: "The actor completes the declared browser task and leaves product-visible evidence.",
    actual: "The generic actor session was terminal, but the adapter rubric found no product completion evidence.",
    evidence: [{ path: "review.md", kind: "review", note: "Review summary includes the adapter-owned product acceptance gap." }],
    redaction: { status: "passed", notes: "Synthetic adapter feedback references local public-safe artifacts only." },
    idempotency_key: `${BROWSER_ADAPTER_NAMESPACE}:${ctx.runId}:missing-product-evidence`,
    proposed_next_state: "actor-auth",
    acceptance_proof: [`mimetic verify --run ${ctx.runId} --json`],
    adapter: {
      namespace: BROWSER_ADAPTER_NAMESPACE,
      data: {
        productAcceptance: "missing",
        suggestedOwner: "adopter-adapter"
      }
    }
  }];
}

function cuaConfig(appUrl = "http://127.0.0.1:3000/"): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "cua-routing-proof",
    title: "CUA routing proof",
    subject: { source: "app-url", appUrl },
    actors: [{
      type: "openai-computer-use",
      persona: "first-time-visitor",
      mission: "Explore the app and stop.",
      laneFocus: { instruction: "Focus on the landing page." }
    }],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { resolution: [1280, 800] } },
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** Scripted in-sandbox responses for the clone-route provisioning steps. */
function cloneCommandHandler(overrides?: (command: string) => { stdout?: string } | undefined) {
  return (command: string): { stdout?: string } | undefined => {
    const override = overrides?.(command);
    if (override !== undefined) return override;
    if (command.includes("/status")) return { stdout: "0" };
    if (command.includes("rev-parse")) return { stdout: "abc123def4567890abc1\n" };
    if (command.includes("curl")) return { stdout: "READY" };
    if (command.includes("tail -c")) return { stdout: "" };
    return undefined;
  };
}

function cloneCuaConfig(extra?: { env?: string[]; readyTimeoutMs?: number; state?: unknown; keep?: boolean }): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "cua-clone-proof",
    title: "CUA clone proof",
    subject: {
      source: "clone",
      repos: ["example-org/example-app"],
      clone: { depth: 2, ...(extra?.keep === undefined ? {} : { keep: extra.keep }) },
      serve: {
        install: "pnpm install --frozen-lockfile",
        build: "pnpm build",
        start: "pnpm start",
        url: "http://127.0.0.1:3000/",
        ...(extra?.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: extra.readyTimeoutMs })
      },
      ...(extra?.env ? { env: extra.env } : {}),
      ...(extra?.state === undefined ? {} : { state: extra.state })
    },
    actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop." }],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("lab routing (app-url → cua)", () => {
  it("selectLabBackend routes app-url to the cua backend and leaves the other routes untouched", () => {
    expect(selectLabBackend(cuaConfig())).toBe("cua");
    const synthetic = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "s",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona" }]
    });
    const clone = parseLabConfig({
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
    if (!synthetic.ok || !clone.ok || !meta.ok) throw new Error("fixture configs must parse");
    expect(selectLabBackend(synthetic.config)).toBe("synthetic");
    expect(selectLabBackend(clone.config)).toBe("smoke");
    expect(selectLabBackend(meta.config)).toBe("meta");
  });

  it("routes clone × e2b-desktop to cua when the actor lane is computer-use (meta otherwise)", () => {
    expect(selectLabBackend(cloneCuaConfig())).toBe("cua");
    // Same subject × execution with a non-cua actor stays on the meta route — the lane
    // disambiguates where the two axes collide.
    const meta = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "m2",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "codex-app-server" }],
      execution: { target: "e2b-desktop" }
    });
    if (!meta.ok) throw new Error("fixture must parse");
    expect(selectLabBackend(meta.config)).toBe("meta");
    // A cua-typed actor WITHOUT the desktop target routes to smoke (type is inert there).
    const smoke = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "s2",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "openai-computer-use" }]
    });
    if (!smoke.ok) throw new Error("fixture must parse");
    expect(selectLabBackend(smoke.config)).toBe("smoke");
  });
});

describe("runCuaActorLab", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-cua-lab-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("dry-run produces a verified contract bundle with no sandbox and no spend", async () => {
    const outcome = await runLab(cuaConfig(), { cwd, dryRun: true });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.actor).toBe("openai-computer-use");
    expect(result.sandbox).toBeUndefined();
    expect(result.session).toBeUndefined();
    expect(result.observer?.ok).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.schema).toBe("mimetic.run-bundle.v1");
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.simulations[0].status).toBe("contract_proof_only");
    expect(bundle.review.verdict).toBe("contract_proof_only");
    expect(bundle.cwd).toBe("[target-cwd]");
  });

  it("live (with fakes): registry actor drives the REAL loop/provider/executor through the lab, fills stream.actor, and tears down", async () => {
    const config = cuaConfig();
    const sandbox = makeFakeSandbox();
    const { module, created, killed } = makeFakeModule(sandbox);
    const sessionOptionsSeen: CuaActorSessionOptions[] = [];
    const prepared: string[] = [];

    const hooks: CuaActorLabHooks = {
      env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      loadDesktopModule: async () => module,
      prepareDesktop: async (desktop) => {
        prepared.push(desktop.sandboxId);
      },
      // Wrap the REAL session: real provider (scripted transport), real executor, the lab's
      // desktop and writeScreenshot — only the network is faked.
      runSession: async (options) => {
        sessionOptionsSeen.push(options);
        return runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
      }
    };

    const outcome = await runLab(config, { cwd, cuaHooks: hooks });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    // Lab verdict: ran to a terminal session and the bundle verified.
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.session?.status).toBe("passed");
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.observer?.ok).toBe(true);

    // Provisioning: metadata convention, config resolution, and NO env forwarding into the
    // sandbox (the model drives from outside; no key may enter the sandbox).
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata?.mode).toBe(CUA_ACTOR_LAB_PROVIDER_METADATA.mode);
    expect(created[0]?.resolution).toEqual([1280, 800]);
    expect(created[0]?.envs).toBeUndefined();
    expect(created[0]?.lifecycle).toEqual({ onTimeout: "kill" });

    // prepareDesktop ran before the browser opened, against the created sandbox.
    expect(prepared).toEqual(["fake-sandbox-001"]);
    const openIndex = expectSafeBrowserOpen(sandbox.calls, "http://127.0.0.1:3000/");

    // The model's click actuated the desktop through the real executor.
    expect(sandbox.calls).toContainEqual(["leftClick", 11, 22]);
    expect(openIndex).toBeLessThan(sandbox.calls.findIndex(([name]) => name === "leftClick"));

    // The prompt was composed from config (persona + mission + lane focus).
    const instructions = sessionOptionsSeen[0]?.instructions ?? "";
    expect(instructions).toContain("first-time-visitor");
    expect(instructions).toContain("Explore the app and stop.");
    expect(instructions).toContain("Focus on the landing page.");

    // Teardown happened even on success.
    expect(killed).toEqual(["fake-sandbox-001"]);
    expect(result.sandbox).toEqual({ sandboxId: "fake-sandbox-001", killed: true, streamUrlPresent: true });

    // The persisted bundle fills the provider-neutral actor seam and keeps evidence local.
    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(bundle.streams[0].actor.lane).toBe("computer-use");
    expect(bundle.streams[0].actor.provider).toBe("openai-responses-cu");
    expect(bundle.cwd).toBe("[target-cwd]");

    // Screenshots were persisted (redacted upstream) and referenced relatively.
    const screenshotArtifacts = bundle.streams[0].artifacts.filter(
      (artifact: { kind: string }) => artifact.kind === "screenshot"
    );
    expect(screenshotArtifacts.length).toBeGreaterThan(0);
    const screenshotFiles = await readdir(path.join(runDir, "screenshots"));
    expect(screenshotFiles.length).toBe(screenshotArtifacts.length);

    // actor.json trace artifact exists and matches the stream seam.
    const traceOnDisk = JSON.parse(await readFile(path.join(runDir, "actor.json"), "utf8"));
    expect(traceOnDisk).toEqual(bundle.streams[0].actor);

    // The runtime-only stream URL (carries an auth key) never lands anywhere: not on the
    // result (the sandbox is dead by then — only presence is reported) nor in any artifact.
    expect("streamUrl" in result).toBe(false);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson", "actor.json"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("stream.invalid");
      expect(text, file).not.toContain("fake-auth-key");
      expect(text, file).not.toContain("test-openai-key");
      expect(text, file).not.toContain("test-e2b-key");
    }
  });

  it("adapter fail score turns an otherwise goal_satisfied browser run red while keeping the bundle verifiable", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        score: failingBrowserScore,
        deriveFeedback: browserFeedback
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Adapter scorer failed the run");

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore?.namespace).toBe(BROWSER_ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("Adapter scorer failed the run");
    expect(bundle.review.gaps.some((gap) => gap.includes("Adapter scorer failed the run"))).toBe(true);
    expect(bundle.feedbackCandidates).toHaveLength(1);
    expect(bundle.feedbackCandidates[0]?.adapter?.namespace).toBe(BROWSER_ADAPTER_NAMESPACE);
    expect(bundle.feedbackCandidates[0]?.substrate).toBe("e2b-desktop");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("malformed browser adapter outputs are dropped, preserving default green behavior", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        score: () => ({ schema: "mimetic.adapter-score.v1", namespace: "", status: "fail", score: 0, summary: "bad" }) as RunAdapterScore,
        deriveFeedback: () => ([{
          schema: "mimetic.feedback-candidate.v1",
          id: "bad",
          summary: "Malformed candidate missing required run fields.",
          evidence: [],
          redaction: { status: "passed", notes: "shape test" }
        }] as unknown as RunFeedbackCandidate[])
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("adapter-score.v1") || warning.includes("feedback-candidate.v1"))).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore).toBeUndefined();
    expect(bundle.feedbackCandidates).toHaveLength(0);
    expect(bundle.review.verdict).toBe("pass");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("DEFAULT persists RAW screenshots (full fidelity, local) and warns the bundle is not publish-safe as-is", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const runDir = path.join(cwd, ".mimetic", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.redaction.screenshots).toBe("raw");
    expect(bundle.streams[0].actor.items.filter((i: { kind: string }) => i.kind === "screenshot")
      .every((i: { screenshotRef?: { redaction: string } }) => i.screenshotRef?.redaction === "none")).toBe(true);
    expect(outcome.result.warnings.some((w) => w.toLowerCase().includes("full-fidelity") || w.toLowerCase().includes("raw"))).toBe(true);

    // Honest labels (invariant 6): a raw run must never be labeled "redacted" anywhere.
    expect(bundle.streams[0].embed.title).toBe("CUA desktop (raw)");
    const screenshotLabels = bundle.streams[0].artifacts
      .filter((a: { kind: string }) => a.kind === "screenshot")
      .map((a: { label: string }) => a.label);
    expect(screenshotLabels.length).toBeGreaterThan(0);
    expect(screenshotLabels.every((label: string) => label.endsWith("(raw)"))).toBe(true);
    expect(bundle.redaction.notes).toContain("FULL-FIDELITY (raw)");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toMatch(/\d+ raw screenshot\(s\)/);
    for (const text of [JSON.stringify(bundle), reviewMd]) {
      expect(text).not.toContain("(redacted)");
      expect(text).not.toContain("redacted screenshot");
    }
    // The raw warning must not promise a commit-blocking scan downstream users do not have
    // (the binary-asset scan is mimetic-cli's own CI, not part of the package).
    const rawWarning = outcome.result.warnings.find((w) => w.includes("full-fidelity"));
    expect(rawWarning).toContain(".mimetic");
    expect(rawWarning).toContain("review");
    expect(rawWarning).not.toContain("binary-asset scan");
    expect(rawWarning).not.toContain("blocked from commit");
  });

  it("policies.redactScreenshots: true persists blurred screenshots and drops the raw warning", async () => {
    const config = cuaConfig();
    const redactedConfig: LabConfig = { ...config, policies: { ...config.policies, redactScreenshots: true } };
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(redactedConfig, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const runDir = path.join(cwd, ".mimetic", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.redaction.screenshots).toBe("blurred");
    expect(outcome.result.warnings.some((w) => w.toLowerCase().includes("full-fidelity"))).toBe(false);

    // Honest labels (invariant 6): the blurred mode is named as such, not a vague "redacted".
    expect(bundle.streams[0].embed.title).toBe("CUA desktop (blurred)");
    const screenshotLabels = bundle.streams[0].artifacts
      .filter((a: { kind: string }) => a.kind === "screenshot")
      .map((a: { label: string }) => a.label);
    expect(screenshotLabels.length).toBeGreaterThan(0);
    expect(screenshotLabels.every((label: string) => label.endsWith("(blurred)"))).toBe(true);
    expect(bundle.redaction.notes).toContain("blurred at capture");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toMatch(/\d+ blurred screenshot\(s\)/);
    expect(reviewMd).not.toContain("redacted screenshot");
  });

  it("policies.allowPublicTargets lets the engine drive a declared public app-url target", async () => {
    const config = cuaConfig();
    const publicConfig: LabConfig = {
      ...config,
      subject: { source: "app-url", appUrl: "https://preview-xyz.vercel.app/" },
      policies: { allowPublicTargets: true }
    };
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(publicConfig, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.error).toBeUndefined();
    expectSafeBrowserOpen(sandbox.calls, "https://preview-xyz.vercel.app/");

    // Without the policy, the engine fails closed even if a config bypasses the parser.
    const sandbox2 = makeFakeSandbox();
    const { module: module2 } = makeFakeModule(sandbox2);
    const blocked = await runLab({ ...publicConfig, policies: {} }, {
      cwd,
      cuaHooks: { env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" }, loadDesktopModule: async () => module2 }
    });
    if (blocked.backend !== "cua") throw new Error("expected cua backend");
    expect(blocked.result.ok).toBe(false);
    expect(blocked.result.error?.code).toBe("MIMETIC_CUA_LAB_SUBJECT_UNSAFE");
  });

  it("honors subject.clone.keep on FAILURE: leaves the sandbox up for debugging instead of killing it", async () => {
    const config = cloneCuaConfig();
    const keepConfig: LabConfig = { ...config, subject: { ...config.subject, clone: { ...config.subject.clone, keep: true } } };
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(keepConfig, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async () => { throw new Error("boom during session"); }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);
    // Failure + keep → NOT killed, with a debug warning naming the sandbox.
    expect(killed).toEqual([]);
    expect(outcome.result.sandbox?.killed).toBe(false);
    expect(outcome.result.warnings.some((w) => w.includes("kept for debugging"))).toBe(true);
  });

  it("does NOT pass a goal_satisfied run with zero actions and zero messages (blank-screen honesty guard)", async () => {
    // Model immediately returns done with no action and no message — i.e. it saw a blank/loading
    // screen and stopped. This must NOT be reported as a pass.
    const noEngagementSession = [
      { id: "r1", output: [{ type: "message", content: [] }] } // no actions, no text
    ];
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(noEngagementSession) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    // The session itself is goal_satisfied, but the LAB refuses to call zero-engagement a pass.
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("no actions");
    expect(result.warnings.some((w) => w.includes("ZERO actions"))).toBe(true);

    // The independent verifier reaches the same judgment from the persisted bundle alone —
    // a hollow bundle must not verify ok even though the producer wrote redaction: passed.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
    expect(verified.checks.find((check) => check.name === "actor engagement")?.ok).toBe(false);
  });

  it("device preset drives the E2B desktop resolution + tells the model it's mobile (sim-parity)", async () => {
    const config = cuaConfig();
    const mobileConfig: LabConfig = {
      ...config,
      execution: { ...config.execution, target: "e2b-desktop", desktop: { device: "mobile" } }
    };
    const sandbox = makeFakeSandbox();
    const { module, created } = makeFakeModule(sandbox);
    const sessionOptionsSeen: CuaActorSessionOptions[] = [];
    const outcome = await runLab(mobileConfig, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => {
          sessionOptionsSeen.push(options);
          return runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // The mobile preset (414x896, copied from the sims) sizes the E2B desktop — NOT 1280x800.
    expect(created[0]?.resolution).toEqual([414, 896]);
    // And the model is TOLD it's mobile (the sim-parity prompt signal, since touch/DPR can't render).
    expect(sessionOptionsSeen[0]?.instructions).toContain("mobile user");
    expect(sessionOptionsSeen[0]?.instructions).toContain("414x896");
    // The bundle's stream viewport carries the honest device metadata.
    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.streams[0].viewport).toMatchObject({ width: 414, height: 896, deviceScaleFactor: 3, isMobile: true });
  });

  it("device resolution order: raw resolution overrides the preset; default is desktop 1440x950", async () => {
    const def = makeFakeSandbox();
    const defMod = makeFakeModule(def);
    const defConfig: LabConfig = { ...cuaConfig(), execution: { target: "e2b-desktop" } };
    const r1 = await runLab(defConfig, {
      cwd, cuaHooks: { env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" }, loadDesktopModule: async () => defMod.module,
        runSession: async (o) => runCuaActorSession({ ...o, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }) }
    });
    if (r1.backend !== "cua") throw new Error("expected cua");
    expect(defMod.created[0]?.resolution).toEqual([1440, 950]);

    const ov = makeFakeSandbox();
    const ovMod = makeFakeModule(ov);
    const ovConfig: LabConfig = { ...cuaConfig(), execution: { target: "e2b-desktop", desktop: { device: "mobile", resolution: [1024, 768] } } };
    const ovSeen: CuaActorSessionOptions[] = [];
    const r2 = await runLab(ovConfig, {
      cwd, cuaHooks: { env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" }, loadDesktopModule: async () => ovMod.module,
        runSession: async (o) => { ovSeen.push(o); return runCuaActorSession({ ...o, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }); } }
    });
    if (r2.backend !== "cua") throw new Error("expected cua");
    expect(ovMod.created[0]?.resolution).toEqual([1024, 768]);
    // Consistency: a raw resolution override must NOT inherit a named preset's mobile/DSF — the
    // prompt + bundle metadata reflect the actual (custom, non-mobile) geometry, not "mobile".
    expect(ovSeen[0]?.instructions).not.toContain("mobile user");
    const ovBundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", r2.result.runId, "run.json"), "utf8"));
    expect(ovBundle.streams[0].viewport).toMatchObject({ width: 1024, height: 768, deviceScaleFactor: 1, isMobile: false });
  });

  it("opens HTTP targets with a shell-quoted browser command so query params survive", async () => {
    const targetUrl = "http://127.0.0.1:3000/api/bootstrap?origin=http%3A%2F%2F127.0.0.1%3A3000&scenario=alpha&redirect=%2Fdashboard";
    const sandbox = makeFakeSandbox({ withOpen: false });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(targetUrl), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    const openIndex = expectSafeBrowserOpen(sandbox.calls, targetUrl);
    const openCommand = String(sandbox.calls[openIndex]?.[1] ?? "");
    expect(openCommand).toContain("&scenario=alpha&redirect=");
    expect(sandbox.calls.some((call) => call[0] === "open")).toBe(false);
    expect(sandbox.calls.some((call) => call[0] === "launch")).toBe(false);
  });

  it("launches the requested desktop browser and records browser provenance", async () => {
    const targetUrl = "http://127.0.0.1:3000/api/bootstrap?scenario=chrome-proof&redirect=%2Fdashboard";
    const config: LabConfig = {
      ...cuaConfig(targetUrl),
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { resolution: [1280, 800], browser: "chrome" } }
    };
    const sandbox = makeFakeSandbox({
      commandHandler: (command) =>
        command.includes("browser_preference='chrome'")
          ? { stdout: "MIMETIC_BROWSER_RESOLVED=google-chrome\n", exitCode: 0 }
          : undefined
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    const openIndex = expectSafeBrowserOpen(sandbox.calls, targetUrl);
    const openCommand = String(sandbox.calls[openIndex]?.[1] ?? "");
    expect(openCommand).toContain("browser_preference='chrome'");
    expect(openCommand).toContain("launch_browser google-chrome google-chrome");
    expect(sandbox.calls.some((call) => call[0] === "open")).toBe(false);
    expect(sandbox.calls.some((call) => call[0] === "launch")).toBe(false);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.desktopBrowser).toEqual({ requested: "chrome", resolved: "google-chrome" });
  });

  it("live with missing keys fails closed, names the variables, and never creates a sandbox", async () => {
    const sandbox = makeFakeSandbox();
    const { module, created } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: { env: { OPENAI_API_KEY: "present-key" }, loadDesktopModule: async () => module }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_CUA_LAB_KEYS_MISSING");
    expect(result.error?.message).toContain("E2B_API_KEY");
    expect(result.error?.message).not.toContain("OPENAI_API_KEY and");
    expect(result.error?.message).not.toContain("present-key");
    expect(created).toHaveLength(0);
    expect(result.runId).toBe("not-created");
  });

  it("kills the sandbox and still persists a failed-evidence bundle when the session throws", async () => {
    const sandbox = makeFakeSandbox();
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async () => {
          throw new Error("provider exploded mid-session");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_CUA_LAB_FAILED");
    expect(result.error?.message).toContain("provider exploded");
    expect(killed).toEqual(["fake-sandbox-001"]);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8")
    );
    expect(bundle.simulations[0].status).toBe("failed");
    expect(bundle.review.verdict).toBe("fail");
  });

  it("rejects a non-computer-use actor at the engine even if a config bypasses the parser", async () => {
    const config = cuaConfig();
    const tampered = { ...config, actors: [{ type: "codex-app-server" }] };
    const result = await runCuaActorLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_CUA_LAB_ACTOR_UNSUPPORTED");
  });

  it("re-enforces the loopback entry boundary at the engine even if a config bypasses the parser", async () => {
    const config = cuaConfig();
    const tampered = { ...config, subject: { source: "app-url" as const, appUrl: "https://example.com/" } };
    const result = await runCuaActorLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_CUA_LAB_SUBJECT_UNSAFE");
    // Nothing was persisted, so no artifact can mislabel the public URL as loopback.
    expect(result.runId).toBe("not-created");
    await expect(readdir(path.join(cwd, ".mimetic", "runs"))).rejects.toThrow();
  });

  it("redacts harness-level session errors before they reach ANY persisted artifact", async () => {
    // Built dynamically so no secret-shaped literal ever appears in this source file.
    const secretToken = "Bearer " + "a1b2c3d4e5".repeat(4);
    const hostPath = "/home/" + "someuser/private-checkout/app";
    const sandbox = makeFakeSandbox();
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async () => {
          throw new Error(`request failed with ${secretToken} while reading ${hostPath}`);
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(killed).toEqual(["fake-sandbox-001"]);
    // The error is reported — but scrubbed — and the bundle still VERIFIES (the gate must not
    // trip on the lab's own error report).
    expect(result.error?.message).toContain("[REDACTED_SECRET]");
    expect(result.error?.message).not.toContain(secretToken);
    expect(result.observer?.ok).toBe(true);

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(secretToken);
      expect(text, file).not.toContain(hostPath);
    }
  });

  it("turns a missing @e2b/desktop peer into a structured failure with a complete failed bundle (no raw throw, no orphan dir)", async () => {
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => {
          throw new Error("Live E2B desktop launch requires optional peer dependency @e2b/desktop.");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_CUA_LAB_FAILED");
    expect(result.error?.message).toContain("@e2b/desktop");
    // The run dir is a complete failed-evidence bundle, not an orphan screenshots/ shell.
    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const files = await readdir(runDir);
    expect(files).toContain("run.json");
    expect(files).toContain("review.md");
    expect(result.observer?.ok).toBe(true);
  });

  it("points .mimetic/runs/latest.json at the cua run so `verify --run latest` stays honest", async () => {
    const outcome = await runLab(cuaConfig(), { cwd, dryRun: true });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);

    const pointer = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", "latest.json"), "utf8"));
    expect(pointer.schema).toBe("mimetic.latest-run.v1");
    expect(pointer.runId).toBe(result.runId);

    const verified = await verifyRun(cwd, "latest");
    expect(verified.ok).toBe(true);
    expect(verified.run).toBe("latest");
    expect(verified.bundlePath).toContain(result.runId);
  });

  it("reports killed=false (with a warning) when the installed SDK lacks Sandbox.kill", async () => {
    const sandbox = makeFakeSandbox();
    const module: E2BDesktopModule = {
      Sandbox: { create: async () => sandbox }
    };
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.sandbox?.killed).toBe(false);
    expect(outcome.result.warnings.some((warning) => warning.includes("Sandbox.kill"))).toBe(true);
  });

  it("clone route: clones, installs, builds, serves, probes, and drives the subject — with provenance and zero value leaks", async () => {
    const config = cloneCuaConfig({ env: ["DATABASE_URL"] });
    const cloneHead = "8758a953415e1f60091d";
    const servedHead = "859043fc8dec448d2ac3";
    let revParseCount = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (!command.includes("rev-parse")) return undefined;
        revParseCount += 1;
        return { stdout: `${revParseCount === 1 ? cloneHead : servedHead}\n` };
      })
    });
    const { module, created, killed } = makeFakeModule(sandbox);

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: {
          OPENAI_API_KEY: "test-openai-key",
          E2B_API_KEY: "test-e2b-key",
          DATABASE_URL: "postgres-secret-value"
        },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.session?.status).toBe("passed");
    expect(result.appUrl).toBe("http://127.0.0.1:3000/");

    // Env placement: EXACTLY the declared subject names — never the actor keys.
    expect(created[0]?.envs).toEqual({ DATABASE_URL: "postgres-secret-value" });

    // Provisioning sequence: the wrapper scripts carry the declared commands.
    const scriptFor = (name: string): string => {
      const entry = sandbox.calls.find(
        (call): call is [string, string, string] => call[0] === "files.write" && String(call[1]).endsWith(`${name}/run.sh`)
      );
      if (!entry) throw new Error(`missing script for ${name}`);
      return entry[2];
    };
    expect(scriptFor("subject-clone")).toContain("git clone --depth 2 https://github.com/example-org/example-app.git");
    expect(scriptFor("subject-install")).toContain("( pnpm install --frozen-lockfile )");
    expect(scriptFor("subject-install")).toContain("cd '/home/user/subject'");
    expect(scriptFor("subject-build")).toContain("( pnpm build )");
    expect(scriptFor("subject-start")).toContain("( pnpm start )");

    // Readiness was probed before the browser opened on the served URL.
    const probeIndex = sandbox.calls.findIndex(
      (call) => call[0] === "commands.run" && String(call[1]).includes("curl")
    );
    const openIndex = expectSafeBrowserOpen(sandbox.calls, "http://127.0.0.1:3000/");
    expect(probeIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeGreaterThan(probeIndex);

    // The model's click actuated the real executor against the served subject.
    expect(sandbox.calls).toContainEqual(["leftClick", 11, 22]);
    expect(killed).toEqual(["fake-sandbox-001"]);

    // Provenance (invariant 5): repo + commit + env NAMES — on the result and in evidence.
    // No subject.state declared → the state story is explicitly "undeclared", never silent.
    expect(result.subject).toEqual({
      source: "clone",
      repo: "example-org/example-app",
      commit: servedHead,
      envNames: ["DATABASE_URL"],
      state: { provenance: "undeclared" }
    });
    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(revParseCount).toBeGreaterThan(1);
    expect(bundle.subject.commit).toBe(servedHead);
    expect(JSON.stringify(bundle.subject)).not.toContain(cloneHead);
    const provenance = bundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(provenance?.message).toContain(`example-org/example-app@${servedHead}`);
    expect(provenance?.message).toContain("DATABASE_URL");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toContain(`Subject cloned from example-org/example-app@${servedHead}`);

    // Values never persist: not the subject env value, not the actor keys.
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson", "actor.json"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("postgres-secret-value");
      expect(text, file).not.toContain("test-openai-key");
      expect(text, file).not.toContain("test-e2b-key");
    }
  });

  it("clone route with GITHUB_TOKEN: the clone authenticates via in-sandbox env — the token value never appears in any script or artifact", async () => {
    const config = cloneCuaConfig({ env: ["GITHUB_TOKEN"] });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created } = makeFakeModule(sandbox);

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", GITHUB_TOKEN: "ghp-token-value" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    // The token is provisioned as sandbox env…
    expect(created[0]?.envs).toEqual({ GITHUB_TOKEN: "ghp-token-value" });
    // …and the clone script references the VARIABLE, never the value, never a token-in-URL.
    const cloneScript = sandbox.calls.find(
      (call): call is [string, string, string] => call[0] === "files.write" && String(call[1]).endsWith("subject-clone/run.sh")
    );
    expect(cloneScript?.[2]).toContain("$GITHUB_TOKEN");
    expect(cloneScript?.[2]).toContain("http.extraHeader");
    expect(cloneScript?.[2]).not.toContain("ghp-token-value");
    expect(cloneScript?.[2]).not.toMatch(/https:\/\/[^@\s]+@github\.com/);

    const runDir = path.join(cwd, ".mimetic", "runs", outcome.result.runId);
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("ghp-token-value");
    }
  });

  it("fails closed BEFORE any sandbox exists when a declared subject env name is missing", async () => {
    const config = cloneCuaConfig({ env: ["DATABASE_URL"] });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("MIMETIC_CUA_LAB_SUBJECT_ENV_MISSING");
    expect(outcome.result.error?.message).toContain("DATABASE_URL");
    expect(created).toHaveLength(0);
  });

  it("scrubs PROVISIONED VALUES (no secret shape) from every artifact and the result when a serve step echoes them", async () => {
    // The P0 class: an app dumps its config on boot failure. The value is arbitrary — no
    // pattern can catch it; only literal scrubbing of known provisioned values can.
    const plainValue = "plain-text-pw-" + "12345678";
    const config = cloneCuaConfig({ env: ["DATABASE_PASSWORD"] });
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-install/status")) return { stdout: "1" };
        if (command.includes("subject-install") && command.includes("tail -c")) {
          return { stdout: `boot dump: DATABASE_PASSWORD=${plainValue} (config echo)` };
        }
        return undefined;
      })
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", DATABASE_PASSWORD: plainValue },
        loadDesktopModule: async () => module
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(killed).toEqual(["fake-sandbox-001"]);
    // The error is still diagnosable — the log tail rides along — but the VALUE is gone,
    // replaced by the scrub marker, on the result AND in every persisted artifact.
    expect(result.error?.message).toContain("subject install failed");
    expect(result.error?.message).toContain("[REDACTED_SECRET]");
    expect(result.error?.message).not.toContain(plainValue);
    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(plainValue);
    }
    // And the bundle still VERIFIES: the gate must not trip on the scrubbed error report.
    expect(result.observer?.ok).toBe(true);
  });

  it("pattern-redacts a secret-shaped token in a log tail BEFORE truncation can slice through it", async () => {
    // A distinct, properly-bounded token (NOT a known provisioned value — only pattern
    // redaction can catch it). It sits at the FRONT of the log with ~2000 chars after it, so
    // the last-2000 truncation cuts THROUGH the token. Truncate-then-redact would leave a
    // prefix-less fragment that no longer matches `\bghp_…`; redact-then-truncate erases it.
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"; // 44 chars, matches whole
    const midChunk = token.slice(26, 44); // 18 distinct chars, all AFTER the cut at 22 — truncate-first would expose this
    const log = token + " " + "z".repeat(1977); // total 2022; cut lands inside the token
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("curl")) return { stdout: "WAIT" };
        if (command.includes("subject-start") && command.includes("tail -c")) return { stdout: log };
        return undefined;
      })
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cloneCuaConfig({ readyTimeoutMs: 5000 }), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, `${file} full token`).not.toContain(token);
      expect(text, `${file} token fragment`).not.toContain(midChunk);
    }
    expect(result.observer?.ok).toBe(true);
  });

  it("provenance wording is honest per phase: dry-run declares, failed provisioning never claims 'served'", async () => {
    // Dry-run: nothing cloned — the event must say so.
    const dry = await runLab(cloneCuaConfig(), { cwd, dryRun: true });
    if (dry.backend !== "cua") throw new Error("expected cua backend");
    const dryBundle = JSON.parse(
      await readFile(path.join(cwd, ".mimetic", "runs", dry.result.runId, "run.json"), "utf8")
    );
    const dryProvenance = dryBundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(dryProvenance?.message).toContain("dry-run contract; nothing cloned");
    expect(dryProvenance?.message).not.toContain("Subject cloned from");

    // Probe failure: cloned at a real commit, but serving never completed — say exactly that.
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) =>
        command.includes("curl") ? { stdout: "WAIT" } : undefined
      )
    });
    const { module } = makeFakeModule(sandbox);
    let t = 0;
    const failed = await runLab(cloneCuaConfig({ readyTimeoutMs: 5000 }), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (failed.backend !== "cua") throw new Error("expected cua backend");
    const failedBundle = JSON.parse(
      await readFile(path.join(cwd, ".mimetic", "runs", failed.result.runId, "run.json"), "utf8")
    );
    const failedProvenance = failedBundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(failedProvenance?.message).toContain("did not complete");
    expect(failedProvenance?.message).not.toContain("and served at");
  });

  it("redacts the repo slug in provenance by default for token-authenticated clones (policies.redactRepos overrides)", async () => {
    // Token present, no explicit policy → redacted by default.
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);
    const tokenHooks = {
      env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", GITHUB_TOKEN: "ghp-token-value" },
      loadDesktopModule: async () => module,
      runSession: async (options: Parameters<NonNullable<CuaActorLabHooks["runSession"]>>[0]) =>
        runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
    };
    const redacted = await runLab(cloneCuaConfig({ env: ["GITHUB_TOKEN"] }), { cwd, cuaHooks: tokenHooks });
    if (redacted.backend !== "cua") throw new Error("expected cua backend");
    expect(redacted.result.subject?.repo).toBe("repo-01");
    const runDir = path.join(cwd, ".mimetic", "runs", redacted.result.runId);
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("example-org/example-app");
    }

    // Explicit policies.redactRepos: false wins over the token default.
    const explicit = cloneCuaConfig({ env: ["GITHUB_TOKEN"] });
    const explicitConfig: LabConfig = { ...explicit, policies: { redactRepos: false } };
    const sandbox2 = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module: module2 } = makeFakeModule(sandbox2);
    const unredacted = await runLab(explicitConfig, {
      cwd,
      cuaHooks: { ...tokenHooks, loadDesktopModule: async () => module2 }
    });
    if (unredacted.backend !== "cua") throw new Error("expected cua backend");
    expect(unredacted.result.subject?.repo).toBe("example-org/example-app");
  });

  it("re-enforces the clone-route structure at the engine (tampered config without serve)", async () => {
    const config = cloneCuaConfig();
    const { serve: _serve, ...subjectWithoutServe } = config.subject;
    const tampered: LabConfig = { ...config, subject: subjectWithoutServe };
    const result = await runCuaActorLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_CUA_LAB_SUBJECT_INVALID");
  });

  it("persists a failed-evidence bundle (with the server log tail) when the subject never answers the probe", async () => {
    const config = cloneCuaConfig({ readyTimeoutMs: 5000 });
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("curl")) return { stdout: "WAIT" };
        if (command.includes("tail -c")) return { stdout: "server crashed at boot" };
        return undefined;
      })
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          }
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_CUA_LAB_FAILED");
    expect(result.error?.message).toContain("did not answer");
    expect(result.error?.message).toContain("server crashed at boot");
    expect(killed).toEqual(["fake-sandbox-001"]);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8")
    );
    expect(bundle.simulations[0].status).toBe("failed");
  });
});

describe("execution.desktop.template (custom E2B desktop image, single-lane cua route)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-cua-template-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function templatedConfig(template?: string): LabConfig {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-template-proof",
      title: "CUA template proof",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop." }],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { resolution: [1280, 800], ...(template === undefined ? {} : { template }) }
      },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  async function runWith(config: LabConfig) {
    const sandbox = makeFakeSandbox();
    const { module, created, templates } = makeFakeModule(sandbox);
    const hooks: CuaActorLabHooks = {
      env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      loadDesktopModule: async () => module,
      runSession: async (options) =>
        runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
    };
    const outcome = await runLab(config, { cwd, cuaHooks: hooks });
    if (outcome.backend !== "cua") throw new Error("expected the cua backend");
    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", outcome.result.runId, "run.json"), "utf8"));
    return { created, templates, bundle };
  }

  it("threads the template into Sandbox.create(template, opts) and records it in the bundle (provenance)", async () => {
    const { created, templates, bundle } = await runWith(templatedConfig("acme-desktop-with-runtimes"));
    expect(created).toHaveLength(1);
    // The desktop create received the configured template as its first (template) argument.
    expect(templates).toEqual(["acme-desktop-with-runtimes"]);
    // The options object is otherwise unchanged — the template is an ADDED selector, not a rewrite.
    expect(created[0]?.resolution).toEqual([1280, 800]);
    expect(created[0]?.lifecycle).toEqual({ onTimeout: "kill" });
    // Evidence shows WHICH image ran (public-safe: a template name is not a secret).
    expect(bundle.desktopTemplate).toBe("acme-desktop-with-runtimes");
  });

  it("byte-stable default: NO template → Sandbox.create called with NO template arg, bundle omits desktopTemplate", async () => {
    const { created, templates, bundle } = await runWith(templatedConfig());
    expect(created).toHaveLength(1);
    // undefined == create(opts): the historical single-argument call shape, unchanged.
    expect(templates).toEqual([undefined]);
    expect(bundle.desktopTemplate).toBeUndefined();
    expect("desktopTemplate" in bundle).toBe(false);
  });
});

describe("subject.state (seed/migrate/fixtures on the clone route)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-cua-state-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const sha16 = (command: string): string => createHash("sha256").update(command).digest("hex").slice(0, 16);

  const THREE_PHASE_STATE = {
    seed: [
      { name: "prebuild", command: "node scripts/prebuild-fixtures.js", when: "before-build", timeoutMs: 300_000 },
      { name: "db-up", command: "sudo service postgresql start && pg_isready -t 30", timeoutMs: 120_000 },
      { name: "admin-user", command: "curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin", when: "after-ready", timeoutMs: 60_000 }
    ]
  };

  it("runs seed steps in their declared phases with exact commands, records seeded provenance with digests, and grows the sandbox deadline", async () => {
    const config = cloneCuaConfig({ state: THREE_PHASE_STATE });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        // Fixed clock so per-step durationMs is deterministic (0) in the record assertions.
        detachedTimers: { now: () => 0, sleep: async () => {} },
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);
    expect(killed).toEqual(["fake-sandbox-001"]);

    // Each step runs through the detached primitive under the reserved prefix, with the
    // EXACT declared command and cwd inside the subject checkout.
    const writeIndexFor = (name: string): number =>
      sandbox.calls.findIndex((call) => call[0] === "files.write" && String(call[1]).endsWith(`${name}/run.sh`));
    const scriptFor = (name: string): string => {
      const entry = sandbox.calls.find(
        (call): call is [string, string, string] => call[0] === "files.write" && String(call[1]).endsWith(`${name}/run.sh`)
      );
      if (!entry) throw new Error(`missing script for ${name}`);
      return entry[2];
    };
    expect(scriptFor("subject-state-db-up")).toContain("( sudo service postgresql start && pg_isready -t 30 )");
    expect(scriptFor("subject-state-db-up")).toContain("cd '/home/user/subject'");
    expect(scriptFor("subject-state-admin-user")).toContain("bootstrap-admin");

    // Phase ordering from the recorded call sequence: install → before-build → build →
    // before-start → start → readiness probe → after-ready → browser open.
    const probeIndex = sandbox.calls.findIndex(
      (call) => call[0] === "commands.run" && String(call[1]).includes("curl -sf -o /dev/null")
    );
    const openIndex = expectSafeBrowserOpen(sandbox.calls, "http://127.0.0.1:3000/");
    expect(writeIndexFor("subject-install")).toBeLessThan(writeIndexFor("subject-state-prebuild"));
    expect(writeIndexFor("subject-state-prebuild")).toBeLessThan(writeIndexFor("subject-build"));
    expect(writeIndexFor("subject-build")).toBeLessThan(writeIndexFor("subject-state-db-up"));
    expect(writeIndexFor("subject-state-db-up")).toBeLessThan(writeIndexFor("subject-start"));
    expect(writeIndexFor("subject-start")).toBeLessThan(probeIndex);
    expect(probeIndex).toBeLessThan(writeIndexFor("subject-state-admin-user"));
    expect(writeIndexFor("subject-state-admin-user")).toBeLessThan(openIndex);

    // The default sandbox deadline grows by the declared state budget.
    expect(created[0]?.timeoutMs).toBe(
      60_000 // execution.timeoutMs
      + 30 * 60_000 // SUBJECT_PROVISION_BUDGET_MS
      + (300_000 + 120_000 + 60_000) // Σ step.timeoutMs
      + 10 * 60_000 // SANDBOX_TIMEOUT_BUFFER_MS
    );

    // Provenance: marker seeded, per-step records with sha256-16 digests of the EXACT
    // commands — and never the command text itself.
    const expectedSeed = [
      { name: "prebuild", when: "before-build", commandDigest: sha16("node scripts/prebuild-fixtures.js"), ok: true, exitCode: 0, durationMs: 0 },
      { name: "db-up", when: "before-start", commandDigest: sha16("sudo service postgresql start && pg_isready -t 30"), ok: true, exitCode: 0, durationMs: 0 },
      { name: "admin-user", when: "after-ready", commandDigest: sha16("curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin"), ok: true, exitCode: 0, durationMs: 0 }
    ];
    expect(result.subject?.state).toEqual({ provenance: "seeded", seed: expectedSeed });

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.subject).toEqual({
      source: "clone",
      repo: "example-org/example-app",
      commit: "abc123def4567890abc1",
      envNames: [],
      state: { provenance: "seeded", seed: expectedSeed }
    });
    const provenance = bundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(provenance?.message).toContain("state: seeded (3 step(s): prebuild, db-up, admin-user)");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toContain("state: seeded");
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("pg_isready"); // digests only — never command text
      expect(text, file).not.toContain("prebuild-fixtures.js");
    }

    // The independent verifier accepts the seeded claim against its evidence.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(true);
    // No undeclared-state nudge: the state story IS declared.
    expect(verified.warnings.some((w) => w.includes("no state story"))).toBe(false);
  });

  it("fails closed on a mid-sequence step failure: partial provenance, no actor session, scrubbed tail, failed bundle that still verifies", async () => {
    const plainValue = "plain-state-pw-" + "87654321";
    const config = cloneCuaConfig({
      env: ["DATABASE_PASSWORD"],
      state: {
        seed: [
          { name: "db-up", command: "start the db" },
          { name: "db-migrate", command: "run migrations" },
          { name: "fixtures", command: "load fixtures" }
        ]
      }
    });
    let sessionStarted = false;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-state-db-migrate/status")) return { stdout: "1" };
        if (command.includes("subject-state-db-migrate") && command.includes("tail -c")) {
          return { stdout: `migration blew up: DATABASE_PASSWORD=${plainValue}` };
        }
        return undefined;
      })
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", DATABASE_PASSWORD: plainValue },
        loadDesktopModule: async () => module,
        detachedTimers: { now: () => 0, sleep: async () => {} },
        runSession: async () => {
          sessionStarted = true;
          throw new Error("session must never start after a failed state step");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(sessionStarted).toBe(false);
    expect(killed).toEqual(["fake-sandbox-001"]);
    expect(result.error?.message).toContain('subject state step "db-migrate" failed (exit 1)');
    expect(result.error?.message).toContain("[REDACTED_SECRET]");
    expect(result.error?.message).not.toContain(plainValue);

    // Partial state provenance: the succeeded step ok:true, the failing step ok:false with
    // its exit code, the unreached step ABSENT — and the marker stays honest.
    expect(result.subject?.state.provenance).toBe("declared-not-run");
    expect(result.subject?.state.seed).toEqual([
      { name: "db-up", when: "before-start", commandDigest: sha16("start the db"), ok: true, exitCode: 0, durationMs: 0 },
      { name: "db-migrate", when: "before-start", commandDigest: sha16("run migrations"), ok: false, exitCode: 1, durationMs: 0 }
    ]);

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.simulations[0].status).toBe("failed");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.subject.state.provenance).toBe("declared-not-run");
    expect(bundle.subject.state.seed).toHaveLength(2);

    // The provisioned value never reaches any artifact (literal scrub pre-truncation).
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(plainValue);
    }

    // A FAILED bundle with honest partial provenance still verifies its state claim
    // (verdict is fail, so the passed-live-with-failed-step rule does not trip).
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(true);
  });

  it("times out a hung state step (kill + timedOut record) and honors clone.keep on that failure", async () => {
    const config = cloneCuaConfig({
      keep: true,
      state: { seed: [{ name: "slow", command: "sleep forever", timeoutMs: 5_000 }] }
    });
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-state-slow/status")) return { stdout: "" };
        if (command.includes("subject-state-slow") && command.includes("tail -c")) return { stdout: "still sleeping" };
        return undefined;
      })
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('subject state step "slow" timed out after 5000ms');
    expect(result.subject?.state.seed?.[0]).toMatchObject({ name: "slow", ok: false, timedOut: true });
    // keep-on-failure applies to state failures exactly as to serve failures.
    expect(killed).toEqual([]);
    expect(result.warnings.some((w) => w.includes("kept for debugging"))).toBe(true);
  });

  it("dry-run records the DECLARED recipe as declared-not-run: digests and phases only, no execution fields, honest event wording", async () => {
    const outcome = await runLab(cloneCuaConfig({ state: THREE_PHASE_STATE }), { cwd, dryRun: true });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);

    expect(result.subject?.state).toEqual({
      provenance: "declared-not-run",
      seed: [
        { name: "prebuild", when: "before-build", commandDigest: sha16("node scripts/prebuild-fixtures.js") },
        { name: "db-up", when: "before-start", commandDigest: sha16("sudo service postgresql start && pg_isready -t 30") },
        { name: "admin-user", when: "after-ready", commandDigest: sha16("curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin") }
      ]
    });

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.subject.state.provenance).toBe("declared-not-run");
    expect(bundle.subject.state.seed.every((record: Record<string, unknown>) => !("ok" in record))).toBe(true);
    const provenance = bundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(provenance?.message).toContain("state: declared, not run (dry-run contract)");

    // The contract bundle verifies — declared-not-run is the honest dry-run marker.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(true);
  });

  it("declared external state records UNPINNED provenance (seed digests still attached when both are declared)", async () => {
    const config = cloneCuaConfig({
      env: ["DATABASE_URL"],
      state: { seed: [{ name: "db-migrate", command: "run migrations" }], external: ["DATABASE_URL"] }
    });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", DATABASE_URL: "postgres-external-value" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);

    // Migrating an external DB is still unpinned overall: marker unpinned, digests attached.
    expect(result.subject?.state.provenance).toBe("unpinned");
    expect(result.subject?.state.externalEnvNames).toEqual(["DATABASE_URL"]);
    expect(result.subject?.state.seed?.[0]).toMatchObject({ name: "db-migrate", ok: true });

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const provenance = bundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(provenance?.message).toContain("state: UNPINNED (external: DATABASE_URL)");
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("postgres-external-value");
    }
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(true);
  });

  it("app-url bundles carry the uniform subject block: source app-url, state undeclared", async () => {
    const outcome = await runLab(cuaConfig(), { cwd, dryRun: true });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.subject).toEqual({ source: "app-url", state: { provenance: "undeclared" } });
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8")
    );
    expect(bundle.subject).toEqual({ source: "app-url", state: { provenance: "undeclared" } });
  });

  it("re-enforces the state declaration at the engine for configs that bypass the parser", async () => {
    const base = cloneCuaConfig();
    const tamper = (state: unknown): LabConfig =>
      ({ ...base, subject: { ...base.subject, state } }) as LabConfig;

    // Bad step name (interpolates into in-sandbox paths — must fail closed).
    const badName = await runCuaActorLab({ cwd, config: tamper({ seed: [{ name: "Bad Name!", command: "true" }] }), dryRun: true });
    expect(badName.ok).toBe(false);
    expect(badName.error?.code).toBe("MIMETIC_CUA_LAB_SUBJECT_INVALID");
    expect(badName.runId).toBe("not-created");

    // Duplicate step names.
    const dupe = await runCuaActorLab({
      cwd,
      config: tamper({ seed: [{ name: "a", command: "true" }, { name: "a", command: "false" }] }),
      dryRun: true
    });
    expect(dupe.error?.code).toBe("MIMETIC_CUA_LAB_SUBJECT_INVALID");

    // external must name a provisioned channel (subset of subject.env).
    const unbacked = await runCuaActorLab({ cwd, config: tamper({ external: ["REDIS_URL"] }), dryRun: true });
    expect(unbacked.error?.code).toBe("MIMETIC_CUA_LAB_SUBJECT_INVALID");

    // state on an app-url subject is rejected, never silently inert (invariant 6).
    const appUrlBase = cuaConfig();
    const appUrlTampered = {
      ...appUrlBase,
      subject: { ...appUrlBase.subject, state: { seed: [{ name: "a", command: "true" }] } }
    } as LabConfig;
    const onAppUrl = await runCuaActorLab({ cwd, config: appUrlTampered, dryRun: true });
    expect(onAppUrl.ok).toBe(false);
    expect(onAppUrl.error?.code).toBe("MIMETIC_CUA_LAB_SUBJECT_INVALID");
    expect(onAppUrl.error?.message).toContain("clone subjects");
  });
});

describe("buildCuaBundle", () => {
  it("dry-run bundle shape: contract verdict, no actor seam, public cwd", () => {
    const bundle = buildCuaBundle({
      actorId: "openai-computer-use",
      appUrl: "http://127.0.0.1:3000/",
      createdAt: "2026-01-01T00:00:00.000Z",
      dryRun: true,
      labId: "shape-proof",
      mission: "Explore.",
      persona: { id: "p1", traitsApplied: [], promptDigest: "digest" },
      resolution: [1440, 960],
      runId: "cua-test-run",
      screenshots: [],
      source: {
        packageName: "mimetic-cli",
        mimeticSource: "present",
        git: { schema: "mimetic.git-state.v1", capturedAt: "2026-01-01T00:00:00.000Z", present: false, refState: "unknown", note: "test" } as never
      }
    });
    expect(bundle.streams[0]?.actor).toBeUndefined();
    expect(bundle.streams[0]?.embed?.kind).toBe("placeholder");
    expect(bundle.review.verdict).toBe("contract_proof_only");
    expect(bundle.review.gaps.length).toBeGreaterThan(0);
    expect(bundle.cwd).toBe("[target-cwd]");
    expect(bundle.simCount).toBe(1);
    // Honest no-session notes: zero frames exist, so no redaction (blur OR raw) is claimed.
    expect(bundle.redaction.notes).toContain("No screenshots captured");
    expect(bundle.redaction.notes).not.toContain("blurred fail-closed");
    // Stream artifact references are unique and relative (verifyRun's evidence rules).
    const keys = bundle.streams[0]?.artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
    for (const artifact of bundle.streams[0]?.artifacts ?? []) {
      expect(path.isAbsolute(artifact.path)).toBe(false);
    }
  });

  it("keeps sensitive public target URLs out of persisted bundle text while preserving lane metadata", () => {
    const rawUrl = "https://3000-example-sandbox.e2b.app/bootstrap/session";
    const bundle = buildCuaBundle({
      actorId: "openai-computer-use",
      actorType: "reviewer",
      surface: "inbox",
      caseGroup: "message-flow",
      appUrl: rawUrl,
      createdAt: "2026-01-01T00:00:00.000Z",
      dryRun: true,
      labId: "shape-proof",
      mission: "Explore.",
      persona: { id: "p1", traitsApplied: [], promptDigest: "digest" },
      resolution: [414, 896],
      runId: "cua-test-run",
      screenshots: [],
      source: {
        packageName: "mimetic-cli",
        mimeticSource: "present",
        git: { schema: "mimetic.git-state.v1", capturedAt: "2026-01-01T00:00:00.000Z", present: false, refState: "unknown", note: "test" } as never
      }
    });

    const text = JSON.stringify(bundle);
    expect(text).not.toContain(rawUrl);
    expect(text).not.toContain("e2b.app");
    expect(containsSensitive(text)).toBe(false);
    expect(bundle.streams[0]?.ui?.route).toMatch(/^\[target-url:[a-f0-9]{16}\]$/);
    expect(bundle.streams[0]).toMatchObject({
      actorType: "reviewer",
      surface: "inbox",
      caseGroup: "message-flow"
    });
  });

  it("labels mid-failure frames by capture policy when the session died before a trace existed", () => {
    // A session can throw after frames were already written: no trace exists to testify, so
    // the labels fall back to the capture-time policy the lab actually ran with.
    const base = {
      actorId: "openai-computer-use",
      appUrl: "http://127.0.0.1:3000/",
      createdAt: "2026-01-01T00:00:00.000Z",
      dryRun: false,
      labId: "shape-proof",
      mission: "Explore.",
      persona: { id: "p1", traitsApplied: [], promptDigest: "digest" },
      resolution: [1440, 960] as [number, number],
      runId: "cua-test-run",
      screenshots: ["screenshots/turn-001.png"],
      sessionError: "provider exploded mid-loop",
      source: {
        packageName: "mimetic-cli",
        mimeticSource: "present" as const,
        git: { schema: "mimetic.git-state.v1", capturedAt: "2026-01-01T00:00:00.000Z", present: false, refState: "unknown", note: "test" } as never
      }
    };

    const blurred = buildCuaBundle({ ...base, captureRedaction: "blurred" });
    expect(blurred.streams[0]?.embed?.title).toBe("CUA desktop (blurred)");
    expect(blurred.streams[0]?.artifacts.some((a) => a.label === "screenshot 01 (blurred)")).toBe(true);
    expect(blurred.redaction.notes).toContain("capture policy (blurred)");

    const raw = buildCuaBundle({ ...base, captureRedaction: "raw" });
    expect(raw.streams[0]?.embed?.title).toBe("CUA desktop (raw)");
    expect(raw.streams[0]?.artifacts.some((a) => a.label === "screenshot 01 (raw)")).toBe(true);
    expect(raw.redaction.notes).toContain("capture policy (raw)");
    expect(JSON.stringify(raw)).not.toContain("(redacted)");
  });
});

// ---------------------------------------------------------------------------
// Issue #148: the in-process (state-driven, no-E2B) lab route. RUNG 4 (load-bearing) and RUNG 5.
// ---------------------------------------------------------------------------

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

// A fake state executor: drives an in-memory app (route advances each action), returns NO
// screenshot and a distinct appState per turn so the REAL loop's friction keys off app state.
function makeStateExecutor(): CuaExecutor & { actuated: CuaAction[] } {
  const actuated: CuaAction[] = [];
  let turn = 0;
  return {
    actuated,
    async observe(): Promise<CuaObservation> {
      turn += 1;
      return { stateSignature: "frozen-sig", appState: { route: `/step-${turn}`, turn } };
    },
    async execute(action: CuaAction): Promise<void> {
      actuated.push(action);
    }
  };
}

// A fake state "brain": reasons over appState, takes one real action, then stops (so the run
// bumps counts.actions and passes the noEngagement honesty guard), with NO requiresFrame.
function makeStateProvider(): CuaProvider {
  let i = 0;
  return {
    id: "fake-state-brain",
    version: "0.1.0",
    requiresFrame: false,
    capabilities: STATE_CAPS,
    async nextTurn(): Promise<CuaTurn> {
      i += 1;
      return i >= 2
        ? { actions: [], pendingSafetyChecks: [], done: true, message: "Reached the goal via getState()." }
        : { actions: [{ kind: "type", text: "hello" }], pendingSafetyChecks: [], done: false, reasoning: "state looks right" };
    }
  };
}

function localAppConfig(appUrl = "http://localhost:5173/"): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "pixel-bae-state",
    title: "State-driven local app",
    subject: { source: "local-app", appUrl },
    actors: [{ type: "openai-computer-use", persona: "pixel-pat", mission: "Drive the app via its state contract." }],
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("runCuaActorLab in-process (state-driven, no E2B) — issue #148", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-cua-inproc-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // RUNG 4 (load-bearing): live mode, custom executor + provider drive the REAL loop, a
  // loadDesktopModule whose Sandbox.create pushes to created[]. Assert created.length === 0,
  // result.sandbox === undefined, AND the produced bundle PASSES verifyRun (the hollow-pass net).
  it("drives the REAL loop with NO E2B sandbox created, omits result.sandbox, and the bundle passes verifyRun", async () => {
    const sandbox = makeFakeSandbox();
    const { module, created, killed } = makeFakeModule(sandbox);
    const stateExecutor = makeStateExecutor();

    const outcome = await runLab(localAppConfig(), {
      cwd,
      cuaHooks: {
        // If anything on this route touched E2B, created[] would grow — this is the proof probe.
        loadDesktopModule: async () => module,
        buildExecutor: async () => stateExecutor,
        buildProvider: async () => makeStateProvider()
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    // The verifiable "no E2B SDK call" proof: no sandbox was ever created or killed.
    expect(created).toHaveLength(0);
    expect(killed).toHaveLength(0);
    expect(result.sandbox).toBeUndefined();
    expect("streamUrl" in result).toBe(false);

    // The REAL loop ran: the state executor was actuated by the brain's action.
    expect(stateExecutor.actuated).toContainEqual({ kind: "type", text: "hello" });

    // The lab reached a terminal verdict and the bundle verified.
    expect(result.dryRun).toBe(false);
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(true);
    expect(result.observer?.ok).toBe(true);

    // The trace's provider id is the INJECTED brain's id (no new lane needed); zero screenshots.
    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.provider).toBe("fake-state-brain");
    expect(bundle.streams[0].actor.lane).toBe("computer-use");
    expect(bundle.streams[0].actor.redaction.screenshots).toBe("n/a");
    expect(bundle.streams[0].actor.counts.screenshots).toBe(0);
    expect(bundle.streams[0].actor.redaction.notes).toContain("App state was observed");
    // No screenshots dir contents on disk.
    const shotFiles = await readdir(path.join(runDir, "screenshots")).catch(() => [] as string[]);
    expect(shotFiles).toHaveLength(0);

    // Honest UNPINNED provenance (invariant 5): the bundle DECLARES the un-pinnable local app.
    const subjectEvent = bundle.events.find((e: { type: string }) => e.type === "cua-lab.subject.declared");
    expect(subjectEvent.message).toContain("UNPINNED");
    expect(subjectEvent.message).toContain("NO E2B");
    expect(bundle.subject).toEqual({ source: "app-url", state: { provenance: "undeclared" } });

    // appState never persists anywhere in the bundle (runtime-only).
    const bundleText = await readFile(path.join(runDir, "run.json"), "utf8");
    expect(bundleText).not.toContain("/step-1");
    expect(bundleText).not.toContain('"appState"');

    // The hollow-pass net: the independent verifier passes the REAL (action-bearing) bundle.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "actor engagement")?.ok).toBe(true);
  });

  it("a hollow in-process run (zero actions/messages) still FAILS the honesty guard + verifyRun", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runLab(localAppConfig(), {
      cwd,
      cuaHooks: {
        loadDesktopModule: async () => module,
        buildExecutor: async () => makeStateExecutor(),
        // A brain that immediately reports done with no action and no message → hollow.
        buildProvider: async (): Promise<CuaProvider> => ({
          id: "hollow-brain",
          capabilities: STATE_CAPS,
          async nextTurn(): Promise<CuaTurn> {
            return { actions: [], pendingSafetyChecks: [], done: true };
          }
        })
      }
    });
    expect(created).toHaveLength(0);
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("no actions");
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
  });

  it("a gave_up in-process run is a failed lane, not an engaged pass", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runLab(localAppConfig(), {
      cwd,
      cuaHooks: {
        loadDesktopModule: async () => module,
        buildExecutor: async () => makeStateExecutor(),
        buildProvider: async (): Promise<CuaProvider> => ({
          id: "idle-brain",
          capabilities: STATE_CAPS,
          async nextTurn(): Promise<CuaTurn> {
            return { actions: [{ kind: "wait", ms: 1 }], pendingSafetyChecks: [], done: false, message: "Still waiting." };
          }
        })
      }
    });
    expect(created).toHaveLength(0);
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.session?.status).toBe("failed");
    expect(result.session?.completionReason).toBe("gave_up");
    expect(result.ok).toBe(false);
    const lanes = result.lanes ?? [];
    const laneSummary = result.laneSummary;
    if (!laneSummary) throw new Error("expected lane summary");
    expect(lanes[0]?.status).toBe("failed");
    expect(lanes[0]?.ok).toBe(false);
    expect(laneSummary.passed).toBe(0);
    expect(result.error?.message).toContain("failed");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("gave up");
  });

  // RUNG 5: the two boot-time fail-closed guards, both BEFORE any key check / any E2B touch.
  it("buildExecutor WITHOUT buildProvider → EXECUTOR_NO_PROVIDER (before any key check)", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runCuaActorLab({
      cwd,
      config: localAppConfig(),
      dryRun: false,
      hooks: {
        env: {}, // NO keys — proves the guard precedes key-gating
        loadDesktopModule: async () => module,
        buildExecutor: async () => makeStateExecutor()
        // buildProvider deliberately omitted
      }
    });
    expect(created).toHaveLength(0);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("MIMETIC_CUA_LAB_EXECUTOR_NO_PROVIDER");
    expect(outcome.sandbox).toBeUndefined();
  });

  it("local-app subject with NO hooks → LOCAL_APP_NO_EXECUTOR (a structured error, never a desktop attempt, before key-gating)", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runCuaActorLab({
      cwd,
      config: localAppConfig(),
      dryRun: false,
      hooks: {
        env: {}, // NO keys — the local-app guard must win over KEYS_MISSING
        loadDesktopModule: async () => module
        // no buildExecutor / buildProvider
      }
    });
    expect(created).toHaveLength(0);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("MIMETIC_CUA_LAB_LOCAL_APP_NO_EXECUTOR");
    expect(outcome.error?.message).toContain("buildExecutor");
    expect(outcome.sandbox).toBeUndefined();
  });

  it("buildProvider ALONE (a model swap) does NOT take the in-process route — it still provisions E2B", async () => {
    // buildProvider without buildExecutor is allowed and stays on the normal E2B route; with no
    // keys/dry-run we just confirm it does NOT trip EXECUTOR_NO_PROVIDER and is NOT treated as
    // in-process (a dry-run produces a contract bundle with no sandbox, the normal route).
    const outcome = await runLab(cuaConfig(), {
      cwd,
      dryRun: true,
      cuaHooks: { buildProvider: async () => makeStateProvider() }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.error?.code).not.toBe("MIMETIC_CUA_LAB_EXECUTOR_NO_PROVIDER");
  });
});
