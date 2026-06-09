import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import { runCuaActorSession, type CuaActorSessionOptions } from "../src/computer-use-actor.js";
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

function makeFakeSandbox(options: { withOpen?: boolean } = {}): FakeSandbox {
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
        return { exitCode: 0 };
      }
    },
    files: {
      write: async (filePath: string) => {
        calls.push(["files.write", filePath]);
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

function makeFakeModule(sandbox: FakeSandbox): {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  killed: string[];
} {
  const created: E2BDesktopCreateOptions[] = [];
  const killed: string[] = [];
  const module: E2BDesktopModule = {
    Sandbox: {
      create: async (createOptions) => {
        created.push(createOptions);
        return sandbox;
      },
      kill: async (sandboxId) => {
        killed.push(sandboxId);
        return undefined;
      }
    }
  };
  return { module, created, killed };
}

const TWO_TURN_SESSION = [
  { id: "resp_1", output: [{ type: "computer_call", call_id: "c1", action: { type: "click", x: 11, y: 22 } }] },
  { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }
];

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
    const openIndex = sandbox.calls.findIndex(([name]) => name === "open");
    expect(sandbox.calls[openIndex]).toEqual(["open", "http://127.0.0.1:3000/"]);

    // The model's click actuated the desktop through the real executor.
    expect(sandbox.calls).toContainEqual(["leftClick", 11, 22]);

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

  it("falls back to launching the browser explicitly when the SDK lacks open()", async () => {
    const sandbox = makeFakeSandbox({ withOpen: false });
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
    expect(outcome.result.ok).toBe(true);
    expect(sandbox.calls).toContainEqual(["launch", "google-chrome", "http://127.0.0.1:3000/"]);
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
    // Stream artifact references are unique and relative (verifyRun's evidence rules).
    const keys = bundle.streams[0]?.artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
    for (const artifact of bundle.streams[0]?.artifacts ?? []) {
      expect(path.isAbsolute(artifact.path)).toBe(false);
    }
  });
});
