import { DEVICE_PRESETS } from "../../../src/study/device-presets.js";
import {
  phaseEvent,
  type StudyEvent,
  type SetupTarget,
} from "../../../src/study/run-study-events.js";
import type { SubjectPhaseEvent } from "../../../src/subject/steps.js";
import { browserScorer } from "../../../src/study/adapter-scorer-loader.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { symlinkSync, unlinkSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { measuredChromeDesktop } from "../../helpers/measured-chrome-desktop.js";
import { automaticAnalysisBoundary } from "../../helpers/automatic-analysis-boundary.js";
import { captureStderr, runDirSnapshot } from "../../helpers/run-golden.js";
import { expectFailureGolden } from "../../helpers/failure-golden.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";

import type { ActorCapabilities, ActorTrace } from "../../../src/actors/contract.js";
import { ACTOR_TRACE_SCHEMA } from "../../../src/actors/contract.js";
import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type {
  CuaAction,
  CuaExecutor,
  CuaLoopResult,
  CuaObservation,
  CuaProvider,
  CuaTurn,
} from "../../../src/actors/computer-use/loop.js";
import { runComputerUsePlan, runCuaActorStudy } from "../../../src/routes/computer-use/route.js";
import { planComputerUseStudy } from "../../../src/routes/computer-use/plan.js";
import { CUA_ACTOR_STUDY_PROVIDER_METADATA } from "../../../src/routes/computer-use/e2b-desktop/prepare.js";
import { makeChromeBrowserStateObserver } from "../../../src/substrates/e2b/desktop-cdp.js";
import { buildSingleParticipantBundle } from "../../../src/routes/computer-use/single-bundle.js";
import { buildRunCostSummary } from "../../../src/run/cost-summary.js";
import { makeParticipantWriteScreenshot } from "../../../src/routes/computer-use/participant-execution.js";
import { pngTextChunk, withPngChunk } from "../../helpers/png-chunks.js";
import {
  resolveSelfReportedBlocker,
  resolveSelfReportedFriction,
} from "../../../src/routes/computer-use/self-report.js";
import type { StudyDeps } from "../../../src/study/study-deps.js";
import {
  judgeOneParticipant,
  participantStatus as participantStatusForCredibility,
} from "../../../src/run/judge.js";
import {
  CLOSING_LINE_DIRECTIVE,
  composeParticipantInstructions,
} from "../../../src/routes/computer-use/participant-prompt.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../../src/substrates/e2b/sdk.js";
import { V2_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { parseStudy } from "../../../src/study/config.js";
import { externalCatchHealthy } from "../../../src/comms/sandbox-catch.js";
import { SANDBOX_CATCH_SCRIPT } from "../../../src/comms/sandbox-catch-script.js";
import { recipientInboxUrl } from "../../../src/comms/capture-surface.js";
import { runStudyWith } from "../../../src/run-study.js";
import { routeOf } from "../../../src/study/plan.js";
import {
  renderObserver,
  serveObserver,
  type ObserverResult,
  type ObserverServer,
} from "../../../src/observer/render.js";
import type { FetchLike } from "../../../src/actors/computer-use/openai-provider.js";
import type {
  BrowserScoringContext,
  RunAdapterScore,
  RunBundle,
  RunFeedbackCandidate,
} from "../../../src/index.js";
import { containsSensitive } from "../../../src/evidence/redaction.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { prepareSelectedOutputDirectory } from "../../../src/run/contained-output.js";
import type { LocalTreeArchive } from "../../../src/subject/local-tree-archive.js";
import { freePort } from "../../helpers/free-port.js";
import { NODE_BOOTSTRAP_COMMAND } from "../../../src/subject/node-bootstrap.js";

// ---------------------------------------------------------------------------
// Fakes. The desktop module fake serves both faces of the sandbox: the
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
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
}

interface FakeSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
  /** The resolution Sandbox.create was asked for, which xdpyinfo then reports. */
  screen?: readonly [number, number] | undefined;
}

function makeFakeSandbox(
  options: {
    withOpen?: boolean;
    commandHandler?: (command: string) => { stdout?: string; exitCode?: number } | undefined;
    /**
     * Throws a CommandExitError-shaped error (real-SDK-accurate: the real @e2b/desktop Sandbox
     * throws on any non-zero exit rather than returning one) for commands the predicate matches.
     * Mirrors tests/e2b-desktop-type-fallback.test.ts's makeFakeDesktop convention so both the
     * throwing shape and the structural non-throwing shape (commandHandler) are coverable from
     * the same fake.
     */
    commandThrow?: (
      command: string,
    ) => { exitCode?: number; stderr?: string; stdout?: string; message?: string } | undefined;
  } = {},
): FakeSandbox {
  let frame = 0;
  const calls: Array<[string, ...unknown[]]> = [];
  const record =
    (name: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push([name, ...args]);
    };
  let screen: readonly [number, number] | undefined;
  const sandbox = {
    calls,
    sandboxId: "fake-sandbox-001",
    get screen() {
      return screen;
    },
    set screen(resolution: readonly [number, number] | undefined) {
      screen = resolution;
    },
    // Resource fields captured on stock E2B desktops; see fixtures/e2b-desktop-resources.
    getInfo: async () => ({ cpuCount: 8, memoryMB: 8192 }),
    commands: {
      run: async (command: string) => {
        calls.push(["commands.run", command]);
        const t = options.commandThrow?.(command);
        if (t) {
          throw Object.assign(new Error(t.message ?? `exit status ${t.exitCode ?? 1}`), {
            name: "CommandExitError",
            ...(t.exitCode === undefined ? {} : { exitCode: t.exitCode }),
            ...(t.stderr === undefined ? {} : { stderr: t.stderr }),
            ...(t.stdout === undefined ? {} : { stdout: t.stdout }),
          });
        }
        const handled = options.commandHandler?.(command);
        if (handled !== undefined) return handled;
        // E2B creates the desktop at the requested resolution, and xdpyinfo reports it. The
        // fake has no Chromium, so window, containment and viewport stay unmeasured unless a
        // test passes measuredChromeDesktop as its commandHandler.
        if (command.includes("xdpyinfo") && screen !== undefined)
          return { exitCode: 0, stdout: `  dimensions:    ${screen[0]}x${screen[1]} pixels\n` };
        return { exitCode: 0, stdout: "" };
      },
    },
    files: {
      // Raw data (never String()-coerced): existing callers all write string script content
      // (unchanged behavior), and the local-tree upload path writes a real ArrayBuffer that
      // tests need to inspect directly (byteLength, instanceof ArrayBuffer).
      write: async (
        filePath: string,
        data: string | ArrayBuffer,
        writeOpts?: { requestTimeoutMs?: number; useOctetStream?: boolean },
      ) => {
        calls.push(["files.write", filePath, data, writeOpts]);
        return undefined;
      },
    },
    launch: record("launch") as (application: string, uri?: string) => Promise<void>,
    ...(options.withOpen === false
      ? {}
      : { open: record("open") as (fileOrUrl: string) => Promise<void> }),
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
      },
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
    drag: record("drag"),
  };
  return sandbox as unknown as FakeSandbox;
}

function expectSafeBrowserOpen(calls: Array<[string, ...unknown[]]>, url: string): number {
  const quotedUrl = url.replace(/'/g, "'\\''");
  const index = calls.findIndex(
    (call) =>
      call[0] === "commands.run" &&
      String(call[1]).includes(`target_url='${quotedUrl}'`) &&
      String(call[1]).includes("launch_browser google-chrome google-chrome"),
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
  // when called with no template arg (the byte-stable default). Mirrors the real @e2b/desktop
  // overload: create(opts) or create(template, opts).
  const templates: (string | undefined)[] = [];
  const killed: string[] = [];
  const module: E2BDesktopModule = {
    Sandbox: {
      create: async (
        templateOrOptions: string | E2BDesktopCreateOptions,
        maybeOptions?: E2BDesktopCreateOptions,
      ) => {
        const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
        const createOptions =
          typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
        templates.push(template);
        created.push(createOptions);
        sandbox.screen = createOptions.resolution;
        return sandbox;
      },
      kill: async (sandboxId) => {
        killed.push(sandboxId);
        return true;
      },
    },
  };
  return { module, created, templates, killed };
}

const TWO_TURN_SESSION = [
  {
    id: "resp_1",
    output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }],
  },
  {
    id: "resp_2",
    output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
  },
];
const SUCCESS_WITH_NEGATED_BLOCKER_SESSION = [
  {
    id: "resp_1",
    output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }],
  },
  {
    id: "resp_2",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Success: the target state is visible. No blocker encountered.",
          },
        ],
      },
    ],
  },
];
// The 2026-08-19 drawDB run: three tables created, then "could not connect the two tables
// because every new table appeared directly on top of the previous one". goal_satisfied, with a
// final message that is a blocker report.
const BLOCKED_AFTER_PARTIAL_SESSION = [
  {
    id: "resp_1",
    output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }],
  },
  {
    id: "resp_2",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Blocked after partial completion. Created three tables. Could not connect the two tables because every new table appeared directly on top of the previous one, and repeated attempts to drag them apart did not separate them.",
          },
        ],
      },
    ],
  },
];
const BROWSER_ADAPTER_NAMESPACE = "browser-adapter-proof";

function failingBrowserScore(ctx: BrowserScoringContext): RunAdapterScore {
  return {
    schema: "humanish.adapter-score.v1",
    namespace: BROWSER_ADAPTER_NAMESPACE,
    status: "fail",
    score: 12,
    summary: `${ctx.route} actor stopped before product evidence.`,
    data: {
      route: ctx.route,
      participantCount: ctx.participantCount,
      productAcceptance: "missing",
    },
  };
}

function browserFeedback(ctx: BrowserScoringContext): RunFeedbackCandidate[] {
  return [
    {
      schema: "humanish.feedback-candidate.v1",
      id: `${BROWSER_ADAPTER_NAMESPACE}-${ctx.runId}`,
      run_id: ctx.runId,
      stream_id: ctx.bundle.streams[0]?.id ?? "stream-001",
      adapter_id: BROWSER_ADAPTER_NAMESPACE,
      scenario_id: ctx.labId,
      persona_id: ctx.bundle.simulations[0]?.personaId ?? "unknown",
      actor: "unknown",
      substrate: "e2b-desktop",
      failure_owner: "actor",
      summary:
        "Browser actor reached a terminal session but did not provide product-visible completion evidence.",
      expected:
        "The actor completes the declared browser task and leaves product-visible evidence.",
      actual:
        "The generic actor session was terminal, but the adapter rubric found no product completion evidence.",
      evidence: [
        {
          path: "review.md",
          kind: "review",
          note: "Review summary includes the adapter-owned product acceptance gap.",
        },
      ],
      redaction: {
        status: "passed",
        notes: "Synthetic adapter feedback references local public-safe artifacts only.",
      },
      idempotency_key: `${BROWSER_ADAPTER_NAMESPACE}:${ctx.runId}:missing-product-evidence`,
      proposed_next_state: "actor-auth",
      acceptance_proof: [`humanish verify --run ${ctx.runId} --json`],
      adapter: {
        namespace: BROWSER_ADAPTER_NAMESPACE,
        data: {
          productAcceptance: "missing",
          suggestedOwner: "adopter-adapter",
        },
      },
    },
  ];
}

function cuaConfig(appUrl = "http://127.0.0.1:3000/"): StudyConfig {
  const parsed = parseStudy({
    schema: V2_SCHEMA,
    id: "cua-routing-proof",
    title: "CUA routing proof",
    subject: { source: "app-url", appUrl },
    actors: [
      {
        type: "openai-computer-use",
        persona: "first-time-visitor",
        mission: "Explore the app and stop.",
        laneFocus: { instruction: "Focus on the landing page." },
      },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { resolution: [1280, 800] } },
    scenario: { mode: "live" },
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

function cloneCuaConfig(extra?: {
  env?: string[];
  readyTimeoutMs?: number;
  state?: unknown;
  keep?: boolean;
}): StudyConfig {
  const parsed = parseStudy({
    schema: V2_SCHEMA,
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
        ...(extra?.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: extra.readyTimeoutMs }),
      },
      ...(extra?.env ? { env: extra.env } : {}),
      ...(extra?.state === undefined ? {} : { state: extra.state }),
    },
    actors: [
      {
        type: "openai-computer-use",
        persona: "first-time-visitor",
        mission: "Explore the app and stop.",
      },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    scenario: { mode: "live" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("lab routing (app-url → cua)", () => {
  it("routeOf sends app-url to computer-use and leaves the other routes untouched", () => {
    expect(routeOf(cuaConfig())).toBe("computer-use");
    const synthetic = parseStudy({
      schema: V2_SCHEMA,
      id: "s",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona" }],
    });
    if (!synthetic.ok) throw new Error("fixture config must parse");
    expect(routeOf(synthetic.config)).toBe("preview");
    // A clone lab without a computer-use or scripted actor no longer parses; a library caller that
    // skips the parser still routes to cua.
    for (const type of ["humanish-setup", "codex-app-server"]) {
      const clone = {
        schema: V2_SCHEMA,
        id: "c",
        subject: { source: "clone", repos: ["example-org/example-app"] },
        actors: [{ type }],
        execution: { target: "e2b-desktop" },
      } as const;
      expect(parseStudy(clone).ok).toBe(false);
      expect(routeOf(clone as unknown as StudyConfig)).toBe("computer-use");
    }
  });

  it("routes every clone subject to cua, where a non-computer-use actor fails closed", async () => {
    expect(routeOf(cloneCuaConfig())).toBe("computer-use");
    // A non-computer-use actor also routes to cua, whose actor gate refuses it before any
    // sandbox or filesystem work.
    // The parser refuses this config now; runStudyWith is reached by a library caller that skips it.
    const meta = {
      schema: V2_SCHEMA,
      id: "m2",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "codex-app-server" }],
      execution: { target: "e2b-desktop" },
    } as unknown as StudyConfig;
    expect(routeOf(meta)).toBe("computer-use");
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-clone-actor-"));
    try {
      const outcome = await runStudyWith(meta, { cwd, dryRun: true });
      expect(outcome.route).toBe("computer-use");
      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_ACTOR_UNSUPPORTED");
      expect(await readdir(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
    // A computer-use clone lab without the desktop target no longer parses; it would still have
    // routed to cua and run on a hosted desktop.
    const untargeted = parseStudy({
      schema: V2_SCHEMA,
      id: "s2",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "openai-computer-use" }],
    });
    expect(untargeted.ok).toBe(false);
  });
});

describe("desktop-cli runtime prerequisites", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-desktop-cli-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function configFor(install?: string): StudyConfig {
    const parsed = parseStudy({
      ...cuaConfig(),
      subject: {
        source: "desktop-cli",
        product: {
          name: "sample-cli",
          publicSurfaces: ["https://example.com/sample-cli"],
          ...(install === undefined ? {} : { install }),
        },
      },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  function scriptIndex(sandbox: FakeSandbox, step: string): number {
    return sandbox.calls.findIndex(
      ([name, file]) => name === "files.write" && String(file).endsWith(`${step}/run.sh`),
    );
  }

  it.each([
    { label: "participant-owned installation", install: undefined, runtime: true },
    {
      label: "declared npm installation",
      install: "sudo -n npm install -g sample-cli",
      runtime: true,
    },
    { label: "declared Python installation", install: "pip install sample-cli", runtime: false },
  ])(
    "prepares $label before the participant and keeps product installation explicit",
    async ({ install, runtime }) => {
      const config = configFor(install);
      const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
      const { module, created, killed } = makeFakeModule(sandbox);
      let sessionCallIndex = -1;
      const result = await runCuaActorStudy({
        cwd,
        config,
        dryRun: false,
        env: { OPENAI_API_KEY: "synthetic", E2B_API_KEY: "synthetic" },
        deps: {
          desktopModule: async () => module,
          runSession: async (options) => {
            sessionCallIndex = sandbox.calls.length;
            return runCuaActorSession({
              ...options,
              openai: { apiKey: "synthetic", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
            });
          },
        },
      });
      expect(result.ok).toBe(true);
      expect(created).toHaveLength(1);
      expect(created[0]?.envs).toBeUndefined();
      expect(killed).toEqual([sandbox.sandboxId]);
      const terminalIndex = scriptIndex(sandbox, "desktop-cli-terminal");
      expect(terminalIndex).toBeGreaterThan(-1);
      expect(terminalIndex).toBeLessThan(sessionCallIndex);
      const runtimeIndex = scriptIndex(sandbox, "desktop-cli-runtime-node");
      if (runtime) {
        expect(runtimeIndex).toBeGreaterThan(-1);
        expect(runtimeIndex).toBeLessThan(terminalIndex);
        // Use the same checksum-pinned archive and global npm prefix already shell-tested by the
        // terminal route, including its mutation-free fast path for a working custom runtime.
        expect(sandbox.calls[runtimeIndex]?.[2]).toContain(NODE_BOOTSTRAP_COMMAND);
      } else {
        expect(runtimeIndex).toBe(-1);
      }
      const installIndex = scriptIndex(sandbox, "desktop-cli-install");
      if (install === undefined) {
        expect(installIndex).toBe(-1);
        expect(config.subject.product?.install).toBeUndefined();
      } else {
        expect(installIndex).toBeGreaterThan(runtimeIndex);
        expect(installIndex).toBeLessThan(terminalIndex);
        expect(sandbox.calls[installIndex]?.[2]).toContain(`( ${install} )`);
      }
      expect(sandbox.calls.some(([name]) => name === "open")).toBe(false);
    },
  );

  it("fails before opening a terminal or starting a participant if the no-install runtime fails", async () => {
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) =>
        command.includes("desktop-cli-runtime-node/status") ? { stdout: "1" } : undefined,
      ),
    });
    const { module, killed } = makeFakeModule(sandbox);
    let sessions = 0;
    const result = await runCuaActorStudy({
      cwd,
      config: configFor(),
      dryRun: false,
      env: { OPENAI_API_KEY: "synthetic", E2B_API_KEY: "synthetic" },
      deps: {
        desktopModule: async () => module,
        runSession: async (options) => {
          sessions += 1;
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "synthetic", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("desktop-cli runtime bootstrap failed");
    expect(sessions).toBe(0);
    expect(scriptIndex(sandbox, "desktop-cli-terminal")).toBe(-1);
    expect(scriptIndex(sandbox, "desktop-cli-install")).toBe(-1);
    expect(killed).toEqual([sandbox.sandboxId]);
  });
});

describe("runCuaActorLab", () => {
  it("carries a failed drain of the operator-hosted catch into the result warnings", async () => {
    // The drain's error quotes the run's OpenAI key and the catch's bearer token; the warning must
    // carry neither.
    const token = ["tango", "lima", "catch", "credential"].join("-");
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-external-comms",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Sign up." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      comms: {
        email: {
          external: { catchBaseUrl: "https://catch.example.test", authTokenEnv: "CATCH_TOKEN" },
        },
      },
      scenario: { mode: "live" },
      review: { analysis: false },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    // The catch passes its health check, then fails when the run drains it.
    vi.stubGlobal("fetch", async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return new Response(
          JSON.stringify({
            ok: true,
            service: "humanish-comms-catch",
            capabilities: ["recipient-inbox-v1"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`synthetic catch outage: refused test-openai-key with bearer ${token}`);
    });
    try {
      const { module } = makeFakeModule(makeFakeSandbox());
      const result = await runCuaActorStudy({
        cwd,
        config: parsed.config,
        dryRun: false,
        env: {
          OPENAI_API_KEY: "test-openai-key",
          E2B_API_KEY: "test-e2b-key",
          CATCH_TOKEN: token,
        },
        deps: {
          desktopModule: async () => module,
          runSession: async (options) =>
            runCuaActorSession({
              ...options,
              openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
            }),
        },
      });
      const warnings = result.warnings.join("\n");
      expect(warnings).toContain(
        "Comms evidence collection failed against the adopter-hosted catch",
      );
      expect(warnings).not.toContain("test-openai-key");
      expect(warnings).not.toContain(token);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // A live run against an operator-hosted catch whose token is CATCH_TOKEN. The catch passes its
  // health check; `deliveries` answers the drain.
  async function drainWithCatch(options: {
    token: string;
    openaiKey?: string;
    catchBaseUrl?: string;
    deliveries: () => Promise<Response>;
  }) {
    const catchBaseUrl = options.catchBaseUrl ?? "https://catch.example.test";
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-external-comms",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Sign up." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      comms: { email: { external: { catchBaseUrl, authTokenEnv: "CATCH_TOKEN" } } },
      scenario: { mode: "live" },
      review: { analysis: false },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const drains: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return new Response(
          JSON.stringify({
            ok: true,
            service: "humanish-comms-catch",
            capabilities: ["recipient-inbox-v1"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      drains.push(String(input));
      return options.deliveries();
    });
    try {
      const { module, created } = makeFakeModule(makeFakeSandbox());
      const result = await runCuaActorStudy({
        cwd,
        config: parsed.config,
        dryRun: false,
        env: {
          OPENAI_API_KEY: options.openaiKey ?? "test-openai-key",
          E2B_API_KEY: "test-e2b-key",
          CATCH_TOKEN: options.token,
        },
        deps: {
          desktopModule: async () => module,
          runSession: async (sessionOptions) =>
            runCuaActorSession({
              ...sessionOptions,
              openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
            }),
        },
      });
      return { result, warnings: result.warnings.join("\n"), created, drains };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("removes a known secret whole when the catch token is a part of it", async () => {
    const token = ["tango", "lima", "catch", "01"].join("-");
    const openaiKey = `${token}-private-credential`;
    const { warnings } = await drainWithCatch({
      token,
      openaiKey,
      deliveries: async () => {
        throw new Error(`refused ${openaiKey}`);
      },
    });
    expect(warnings).toContain("Comms evidence collection failed");
    expect(warnings).not.toContain("private-credential");
  });

  it("removes the catch token's percent-encoded, base64 and JSON-escaped forms", async () => {
    const token = 'tango/lima+key"0123';
    const forms = [
      encodeURIComponent(token),
      Buffer.from(token).toString("base64"),
      JSON.stringify(token).slice(1, -1),
    ];
    const { warnings } = await drainWithCatch({
      token,
      deliveries: async () => {
        throw new Error(`refused ${forms.join(" ")}`);
      },
    });
    expect(warnings).toContain("Comms evidence collection failed");
    for (const form of forms) expect(warnings).not.toContain(form);
  });

  it("refuses a catch token shorter than 16 characters before any desktop", async () => {
    const { result, created, drains } = await drainWithCatch({
      token: "abc",
      deliveries: async () => new Response("", { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_COMMS_TOKEN_INVALID");
    expect(result.error?.message).not.toContain("abc");
    expect(created).toHaveLength(0);
    expect(drains).toEqual([]);
  });

  it("refuses a catch token that is not well-formed Unicode before any desktop", async () => {
    const { result, created, drains } = await drainWithCatch({
      token: "x".repeat(16) + "\uD800",
      deliveries: async () => new Response("", { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_COMMS_TOKEN_INVALID");
    expect(created).toHaveLength(0);
    expect(drains).toEqual([]);
  });

  it("scrubs the catch token from the zero-send warning's catch URL", async () => {
    const token = ["tango", "lima", "catch", "02"].join("-");
    const { warnings } = await drainWithCatch({
      token,
      catchBaseUrl: `https://catch.example.test/${token}`,
      deliveries: async () => new Response("", { status: 200 }),
    });
    expect(warnings).toContain("The email catch captured no email sends");
    expect(warnings).not.toContain(token);
  });

  it("records a drained operator-hosted catch in the bundle and leaves the verdict alone", async () => {
    const tokenEnv = "CATCH_TOKEN";
    const token = ["synthetic", "catch", "token"].join("-");
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-external-comms-drained",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Sign up." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      comms: {
        email: {
          external: { catchBaseUrl: "https://catch.example.test", authTokenEnv: tokenEnv },
          recipients: [{ lane: "lane-01", address: "user@example.test" }],
        },
      },
      scenario: { mode: "live" },
      review: { analysis: false },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    // The catch holds one send to the declared address, and serves it only with the run's token,
    // which the drain reads from the participants' env.
    const send = {
      path: "/emails",
      body: JSON.stringify({
        from: "no-reply@example.test",
        to: ["user@example.test"],
        subject: "Confirm your email",
        html: "<p>Welcome</p>",
      }),
      t: 1,
    };
    const drainAuth: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(
          JSON.stringify({
            ok: true,
            service: "humanish-comms-catch",
            capabilities: ["recipient-inbox-v1"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/deliveries")) {
        const auth = new Headers(init?.headers).get("authorization");
        drainAuth.push(auth);
        if (auth !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });
        return new Response(`${JSON.stringify(send)}\n`, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const { module } = makeFakeModule(makeFakeSandbox());
      const result = await runCuaActorStudy({
        cwd,
        config: parsed.config,
        dryRun: false,
        env: {
          OPENAI_API_KEY: "test-openai-key",
          E2B_API_KEY: "test-e2b-key",
          [tokenEnv]: token,
        },
        deps: {
          desktopModule: async () => module,
          runSession: async (options) =>
            runCuaActorSession({
              ...options,
              openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
            }),
        },
      });
      expect(drainAuth).toEqual([`Bearer ${token}`]);
      expect(result.warnings.join("\n")).not.toContain("Comms");
      expect(result.ok).toBe(true);

      const runDir = path.join(cwd, ".humanish", "runs", result.runId);
      const thread = JSON.parse(await readFile(path.join(runDir, "comms", "thread.json"), "utf8"));
      expect(thread.schema).toBe("humanish.comms-thread.v1");
      expect(thread).toMatchObject({ channel: "email", count: 1 });
      expect(thread.thread).toHaveLength(1);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
      expect(bundle.review.verdict).toBe("pass");
      expect(
        bundle.streams[0].artifacts.some(
          (artifact: { path: string }) => artifact.path === "comms/thread.json",
        ),
      ).toBe(true);
      const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8"));
      expect(status.outcome).toMatchObject({ verdict: "pass", ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["missing-artifact", "missing-run"] as const)(
    "classifies the real Observer's %s refusal as invalid evidence",
    async (kind) => {
      const result = await runCuaActorStudy({
        cwd,
        config: cuaConfig(),
        dryRun: true,
        deps: {
          renderObserver: async (project, runId, options) => {
            const runDir = path.join(project, ".humanish", "runs", runId);
            if (kind === "missing-artifact") await rm(path.join(runDir, "review.json"));
            else await rm(runDir, { recursive: true });
            return renderObserver(project, runId, options);
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.observer?.ok).toBe(false);
      expect(result.observer?.error?.code).toBe(
        kind === "missing-artifact" ? "HUMANISH_INVALID_RUN_BUNDLE" : "HUMANISH_RUN_NOT_FOUND",
      );
      expect(result.diagnostics).toEqual({ category: "evidence_invalid" });
    },
  );

  it("forwards the public output limit into the real provider and retained incomplete trace", async () => {
    const config = cuaConfig();
    config.actors[0]!.maxOutputTokens = 16;
    delete config.review; // Omitted config uses the separate default analysis budget.
    const sandbox = makeFakeSandbox();
    const { module, created, killed } = makeFakeModule(sandbox);
    const wire = JSON.parse(
      await readFile(
        new URL("../../fixtures/openai-incomplete/reasoning-only.json", import.meta.url),
        "utf8",
      ),
    );
    let requests = 0;
    vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
      expect(JSON.parse(init.body).max_output_tokens).toBe(16);
      requests += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(wire),
        json: async () => wire,
      };
    });
    const analyze = vi.fn(async (analysisCwd: string, runId: string) => {
      expect(killed).toHaveLength(1);
      const runRoot = path.join(analysisCwd, ".humanish", "runs", runId);
      const status = JSON.parse(await readFile(path.join(runRoot, "status.json"), "utf8"));
      const source = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8"));
      expect(status.state).toBe("finished");
      expect(source.streams[0].actor.status).toBe("incomplete");
      return { state: "failed" as const, reason: "analysis_validation_failed" };
    });
    const result = await runCuaActorStudy({
      cwd,
      config,
      dryRun: false,
      env: { OPENAI_API_KEY: "synthetic", E2B_API_KEY: "synthetic" },
      deps: {
        analysis: { run: analyze },

        desktopModule: async () => module,
      },
    }).finally(() => vi.unstubAllGlobals());
    expect(analyze).toHaveBeenCalledOnce();
    expect(result.automaticAnalysis).toEqual({
      state: "failed",
      reason: "analysis_validation_failed",
    });
    expect(created).toHaveLength(1);
    expect(killed).toHaveLength(1);
    // The cut-off reply is asked for once more; the second is cut off too.
    expect(requests).toBe(2);
    expect(result.session?.status).toBe("incomplete");
    expect(result.session?.stopCause).toBe("provider_output_limit");
    expect(result.lanes?.[0]?.session?.stopCause).toBe("provider_output_limit");
    expect(result.diagnostics).toEqual({
      category: "session_interrupted",
      stopCause: "provider_output_limit",
    });
    expect(result.lanes?.[0]?.diagnostics).toEqual(result.diagnostics);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.streams[0].actor.modelSettings.maxOutputTokens).toBe(16);
    expect(sandbox.calls.some(([name]) => name === "leftClick")).toBe(false);
  });

  it("refuses an invalid typed-library output limit before sandbox allocation", async () => {
    const config = cuaConfig();
    config.actors[0]!.maxOutputTokens = 0;
    let allocations = 0;
    const result = await runCuaActorStudy({
      cwd,
      config,
      dryRun: false,
      deps: {
        desktopModule: async () => {
          allocations += 1;
          throw new Error("must not allocate");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("maxOutputTokens");
    expect(allocations).toBe(0);
  });

  it("rejects custom session hooks that could bypass a declared output limit", async () => {
    const config = cuaConfig();
    config.actors[0]!.maxOutputTokens = 16;
    let called = 0;
    const result = await runCuaActorStudy({
      cwd,
      config,
      dryRun: false,
      deps: {
        runSession: async () => {
          called += 1;
          throw new Error("must not dispatch");
        },
        desktopModule: async () => {
          called += 1;
          throw new Error("must not allocate");
        },
      },
    });
    expect(result.error?.message).toContain("custom runSession");
    expect(called).toBe(0);
  });
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-lab-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("runs a plan alone: the result and bundle take the plan's app URL and lab provenance", async () => {
    const config = cuaConfig();
    const planned = planComputerUseStudy(config, { dryRun: true });
    if (!planned.ok || planned.plan.runner.subject.kind !== "app-url")
      throw new Error("expected an app-url computer-use plan");
    const plan = {
      ...planned.plan,
      lab: {
        id: "planned-lab",
        path: "humanish/labs/planned-lab.yaml",
        origin: "committed" as const,
      },
      runner: {
        ...planned.plan.runner,
        subject: { ...planned.plan.runner.subject, appUrl: "http://127.0.0.1:4555/" },
      },
    };
    const result = await runComputerUsePlan(plan, { cwd }, config);
    expect(result.ok).toBe(true);
    expect(result.appUrl).toBe("http://127.0.0.1:4555/");
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.lab.id).toBe("planned-lab");
  });

  it("dry-run produces a verified contract bundle with no sandbox and no spend", async () => {
    const outcome = await runStudyWith(cuaConfig(), { cwd, dryRun: true });
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.actor).toBe("openai-computer-use");
    expect(result.sandbox).toBeUndefined();
    expect(result.session).toBeUndefined();
    expect(result.observer?.ok).toBe(true);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.schema).toBe("humanish.run-bundle.v1");
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.simulations[0].status).toBe("contract_proof_only");
    expect(bundle.review.verdict).toBe("contract_proof_only");
    expect(bundle.cwd).toBe("[target-cwd]");
    expect(bundle.streams[0].desktopGeometry).toEqual({
      screen: { requested: { width: 1280, height: 800 } },
    });
    expect(bundle.streams[0].viewport).toBeUndefined();
  });

  it("pins a symlink cwd before a plan event handler can retarget the alias", async () => {
    const physicalA = path.join(cwd, "project-a");
    const physicalB = path.join(cwd, "project-b");
    const cwdAlias = path.join(cwd, "project-alias");
    const runId = "preflight-cwd-retarget";
    const decoyRuns = path.join(physicalB, ".humanish", "runs");
    const decoyLatest = path.join(decoyRuns, "latest.json");
    const sentinel = "outside sentinel must stay unchanged\n";

    await mkdir(physicalA);
    await mkdir(decoyRuns, { recursive: true });
    await writeFile(decoyLatest, sentinel, "utf8");
    symlinkSync(physicalA, cwdAlias, "dir");
    const pinnedA = await realpath(physicalA);

    let preflightCalls = 0;
    const result = await runCuaActorStudy({
      cwd: cwdAlias,
      config: cuaConfig(),
      dryRun: true,
      runId,
      emit: (event) => {
        if (event.type !== "plan") return;
        preflightCalls += 1;
        unlinkSync(cwdAlias);
        symlinkSync(physicalB, cwdAlias, "dir");
      },
    });

    expect(preflightCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.cwd).toBe(pinnedA);
    await expect(
      readFile(path.join(physicalA, ".humanish", "runs", runId, "run.json"), "utf8"),
    ).resolves.toContain(`"runId": "${runId}"`);
    expect(
      JSON.parse(await readFile(path.join(physicalA, ".humanish", "runs", "latest.json"), "utf8"))
        .runId,
    ).toBe(runId);
    expect(await readFile(decoyLatest, "utf8")).toBe(sentinel);
    expect(await readdir(decoyRuns)).toEqual(["latest.json"]);

    const verified = await verifyRun(physicalA, runId);
    expect(verified.ok).toBe(true);
  });

  it("writes a frame without the metadata chunks its source PNG carried", async () => {
    const artifactRoot = path.join(cwd, "screenshot-root");
    await mkdir(artifactRoot);
    const preparedRoot = await prepareSelectedOutputDirectory(cwd, artifactRoot);
    const screenshots: string[] = [];
    const writer = makeParticipantWriteScreenshot(preparedRoot, { screenshotDir: "" }, screenshots);
    const frame = makePng(1);
    const rel = await writer("frame.png", withPngChunk(frame, "tEXt", pngTextChunk("tEXt", "x")));
    expect(rel).toBe("screenshots/frame.png");
    expect((await readFile(path.join(artifactRoot, rel))).equals(frame)).toBe(true);
  });

  it("rejects path-shaped screenshot names and hardlinked leaves", async () => {
    const artifactRoot = path.join(cwd, "screenshot-root");
    await mkdir(artifactRoot);
    const preparedRoot = await prepareSelectedOutputDirectory(cwd, artifactRoot);
    const screenshots: string[] = [];
    const writer = makeParticipantWriteScreenshot(
      preparedRoot,
      { screenshotDir: "lane-01" },
      screenshots,
    );
    await expect(writer("../sentinel.png", makePng(1))).rejects.toThrow(/path segment/i);
    await expect(writer("nested/frame.png", makePng(1))).rejects.toThrow(/path segment/i);
    expect(() =>
      makeParticipantWriteScreenshot(preparedRoot, { screenshotDir: "../lane" }, screenshots),
    ).toThrow(/path segment/i);

    const outside = path.join(cwd, "outside-frame.png");
    await writeFile(outside, "unchanged\n", "utf8");
    await mkdir(path.join(artifactRoot, "screenshots", "lane-01"), { recursive: true });
    try {
      await link(outside, path.join(artifactRoot, "screenshots", "lane-01", "frame.png"));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
      throw error;
    }
    await expect(writer("frame.png", makePng(2))).rejects.toThrow(/hardlink|single-link/i);
    expect(await readFile(outside, "utf8")).toBe("unchanged\n");
    expect(screenshots).toEqual([]);
  });

  it("live (with fakes): registry actor drives the real loop/provider/executor through a study run, fills stream.actor, and tears down", async () => {
    const config = cuaConfig();
    const sandbox = makeFakeSandbox();
    const { module, created, killed } = makeFakeModule(sandbox);
    const sessionOptionsSeen: CuaActorSessionOptions[] = [];
    const prepared: string[] = [];
    const targets: SetupTarget[] = [];

    const deps: StudyDeps = {
      desktopModule: async () => module,
      // Wrap the real session: real provider (scripted transport), real executor, the run's
      // desktop and writeScreenshot: only the network is faked.
      runSession: async (options) => {
        sessionOptionsSeen.push(options);
        return runCuaActorSession({
          ...options,
          openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
        });
      },
    };

    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        prepareDesktop: async (desktop, target) => {
          prepared.push(desktop.sandboxId);
          targets.push(target);
        },
      },
      deps,
    );
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;

    // Lab verdict: ran to a terminal session and the bundle verified.
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.session?.status).toBe("passed");
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.observer?.ok).toBe(true);

    // Provisioning: metadata convention, config resolution, and no env forwarding into the
    // sandbox (the model drives from outside; no key may enter the sandbox).
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata?.mode).toBe(CUA_ACTOR_STUDY_PROVIDER_METADATA.mode);
    expect(created[0]?.resolution).toEqual([1280, 800]);
    expect(created[0]?.envs).toBeUndefined();
    expect(created[0]?.lifecycle).toEqual({ onTimeout: "kill" });

    // prepareDesktop ran before the browser opened, against the created sandbox, with the
    // participant as its target.
    expect(prepared).toEqual(["fake-sandbox-001"]);
    expect(targets).toEqual([
      { kind: "participant", participant: { id: "lane-01", index: 0, count: 1 } },
    ]);
    const openIndex = expectSafeBrowserOpen(sandbox.calls, "http://127.0.0.1:3000/");

    // The model's click actuated the desktop through the real executor.
    expect(sandbox.calls).toContainEqual(["leftClick", 11, 22]);
    expect(openIndex).toBeLessThan(sandbox.calls.findIndex(([name]) => name === "leftClick"));

    // The prompt was composed from config (persona + mission + participant focus).
    const instructions = sessionOptionsSeen[0]?.instructions ?? "";
    expect(instructions).toContain("first-time-visitor");
    expect(instructions).toContain("Explore the app and stop.");
    expect(instructions).toContain("Focus on the landing page.");

    // Teardown happened even on success.
    expect(killed).toEqual(["fake-sandbox-001"]);
    expect(result.sandbox).toEqual({
      sandboxId: "fake-sandbox-001",
      killed: true,
      streamUrlPresent: true,
    });

    // The persisted bundle fills the provider-neutral actor seam and keeps evidence local.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(bundle.streams[0].actor.lane).toBe("computer-use");
    expect(bundle.streams[0].actor.provider).toBe("openai-responses-cu");
    expect(bundle.cwd).toBe("[target-cwd]");
    // This fake reports its screen through xdpyinfo but has no Chromium, so the bundle keeps the
    // requested viewport out of stream.viewport instead of falsifying it as measured.
    expect(bundle.streams[0].desktopGeometry).toMatchObject({
      screen: {
        requested: { width: 1280, height: 800 },
        verified: { width: 1280, height: 800, source: "xdpyinfo" },
      },
    });
    expect(bundle.streams[0].desktopGeometry.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("stream.viewport is omitted")]),
    );
    expect(bundle.streams[0].viewport).toBeUndefined();

    // Screenshots were persisted (redacted upstream) and referenced relatively.
    const screenshotArtifacts = bundle.streams[0].artifacts.filter(
      (artifact: { kind: string }) => artifact.kind === "screenshot",
    );
    expect(screenshotArtifacts.length).toBeGreaterThan(0);
    const screenshotFiles = await readdir(path.join(runDir, "screenshots"));
    expect(screenshotFiles.length).toBe(screenshotArtifacts.length);

    // actor.json trace artifact exists and matches the stream seam.
    const traceOnDisk = JSON.parse(await readFile(path.join(runDir, "actor.json"), "utf8"));
    expect(traceOnDisk).toEqual(bundle.streams[0].actor);

    // The runtime-only stream URL (carries an auth key) never lands anywhere: not on the
    // result (the sandbox is dead by then: only presence is reported) nor in any artifact.
    expect("streamUrl" in result).toBe(false);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson", "actor.json"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("stream.invalid");
      expect(text, file).not.toContain("fake-auth-key");
      expect(text, file).not.toContain("test-openai-key");
      expect(text, file).not.toContain("test-e2b-key");
    }
  });

  it("continues the E2B study with a warning when optional recording cannot start", async () => {
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-recording-startup-failure",
      title: "Recording startup failure",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Explore and stop.",
        },
      ],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { recording: { audio: false } },
      },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const sandbox = makeFakeSandbox(); // Deliberately lacks files.read, like an older optional peer.
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      parsed.config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.warnings).toContainEqual(
      expect.stringContaining("continues without video"),
    );
    expect(killed).toEqual(["fake-sandbox-001"]);
  });

  it("mobile emulation: launches Chrome with the mobile UA and touch flags, holds the CDP session, and records what the page reported", async () => {
    const commands: string[] = [];
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        commands.push(command);
        if (command.includes("xdpyinfo")) {
          return { exitCode: 0, stdout: "dimensions: 500x896 pixels (300x200 millimeters)\n" };
        }
        if (command.includes("find_chrome_window")) {
          return { exitCode: 0, stdout: "WINDOW_ID=7340035\n" };
        }
        if (command.includes("xwininfo -id")) {
          return {
            exitCode: 0,
            stdout:
              "Absolute upper-left X: 0\nAbsolute upper-left Y: 0\nWidth: 500\nHeight: 896\nMap State: IsViewable\n",
          };
        }
        // Order matters: every probe command embeds the whole script, so match the JSON args first.
        if (command.includes('"mode":"fidelity"')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              fidelity: {
                userAgent:
                  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1",
                devicePixelRatio: 3,
                innerWidth: 414,
                innerHeight: 896,
                maxTouchPoints: 5,
                coarsePointer: true,
              },
              targetId: "T1",
            }),
          };
        }
        if (command.includes("mobile-emulation-") && command.includes("tail -c")) {
          return {
            exitCode: 0,
            stdout:
              JSON.stringify({
                applied: [
                  "Emulation.setDeviceMetricsOverride",
                  "Emulation.setTouchEmulationEnabled",
                  "Emulation.setEmitTouchEventsForMouse",
                  "Emulation.setUserAgentOverride",
                  "Page.reload",
                ],
                held: true,
                targetId: "T1",
              }) + "\n",
          };
        }
        // The session's state observations read the emulated target: no drift.
        if (command.includes('"mode":"state"')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              url: "http://127.0.0.1:3000/",
              title: "app",
              text: "hello",
              scrollY: 0,
              targetId: "T1",
            }),
          };
        }
        if (command.includes("browserWindow: { x: window.screenX")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              browserWindow: { x: 0, y: 0, width: 500, height: 896 },
              viewport: { width: 414, height: 800, deviceScaleFactor: 3 },
              targetId: "T1",
            }),
          };
        }
        if (command.includes("browser_preference='chrome'")) {
          return {
            exitCode: 0,
            stdout:
              "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\nHUMANISH_BROWSER_CDP_PORT=9222\n",
          };
        }
        return undefined;
      },
    });
    const { module } = makeFakeModule(sandbox);
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-mobile-fidelity",
      title: "Mobile fidelity",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Explore the app and stop.",
        },
      ],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { device: "mobile", browser: "chrome", fidelity: { mobileEmulation: true } },
      },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runStudyWith(
      parsed.config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    expect(outcome.result.ok).toBe(true);

    // Launch flags: the UA and touch hold browser-wide, beyond the launch tab the holder covers.
    const launch = commands.find((command) => command.includes("browser_preference='chrome'"))!;
    expect(launch).toContain("--user-agent=Mozilla/5.0 (iPhone");
    expect(launch).toContain("--touch-events=enabled");
    // The holder was started detached (its script goes through files.write) with the participant's
    // preset as the emulated device.
    const holderScript = sandbox.calls
      .filter((call) => call[0] === "files.write" && String(call[1]).includes("mobile-emulation-"))
      .map((call) => String(call[2]))
      .find((script) => script.includes('"mode":"hold"'))!;
    expect(holderScript).toContain('"width":414');
    expect(holderScript).toContain('"deviceScaleFactor":3');
    expect(holderScript).toContain('"touch":true');

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.streams[0].desktopGeometry.fidelity).toEqual({
      tier: "mobile-emulated",
      requested: {
        width: 414,
        height: 896,
        deviceScaleFactor: 3,
        touch: true,
        userAgent: expect.stringContaining("iPhone"),
      },
      applied: [
        "Emulation.setDeviceMetricsOverride",
        "Emulation.setTouchEmulationEnabled",
        "Emulation.setEmitTouchEventsForMouse",
        "Emulation.setUserAgentOverride",
        "Page.reload",
      ],
      resolved: {
        userAgent: expect.stringContaining("iPhone"),
        devicePixelRatio: 3,
        innerWidth: 414,
        innerHeight: 896,
        maxTouchPoints: 5,
        coarsePointer: true,
        source: "cdp",
      },
    });
    const geometryWarnings: string[] = bundle.streams[0].desktopGeometry.warnings ?? [];
    expect(geometryWarnings.filter((warning) => warning.includes("Mobile emulation"))).toEqual([]);
    // The advisory must reach the run result consumed by CLI/JSON callers even when every
    // fidelity read-back matches. Correct context flags do not certify repeated-tap behavior.
    expect(
      outcome.result.warnings.filter((warning) => warning.includes("pointer-to-touch conversion")),
    ).toEqual([
      "Mobile emulation uses desktop pointer-to-touch conversion, which can differ for repeated taps. Confirm gesture failures with direct or native touch input before attributing them to the app.",
    ]);
  });

  // A phone participant whose every observation reads a new tab (T2) the participant opened; the
  // tab's own fidelity read-back is what the test varies.
  function laterTabSandbox(secondTabInnerWidth: number) {
    return makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("xdpyinfo"))
          return { exitCode: 0, stdout: "dimensions: 500x896 pixels (300x200 millimeters)\n" };
        if (command.includes("find_chrome_window"))
          return { exitCode: 0, stdout: "WINDOW_ID=7340035\n" };
        if (command.includes("xwininfo -id"))
          return {
            exitCode: 0,
            stdout:
              "Absolute upper-left X: 0\nAbsolute upper-left Y: 0\nWidth: 500\nHeight: 896\nMap State: IsViewable\n",
          };
        if (command.includes('"mode":"fidelity"')) {
          const onSecondTab = command.includes('"targetId":"T2"');
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              fidelity: {
                userAgent:
                  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1",
                devicePixelRatio: onSecondTab && secondTabInnerWidth !== 414 ? 1 : 3,
                innerWidth: onSecondTab ? secondTabInnerWidth : 414,
                innerHeight: 896,
                maxTouchPoints: 5,
                coarsePointer: true,
              },
              targetId: onSecondTab ? "T2" : "T1",
            }),
          };
        }
        if (command.includes("mobile-emulation-") && command.includes("tail -c")) {
          // The holder's log grows as tabs appear: the announce first, then one line per attach.
          return {
            exitCode: 0,
            stdout:
              JSON.stringify({
                applied: ["Emulation.setDeviceMetricsOverride", "Page.reload"],
                held: true,
                targetId: "T1",
              }) +
              "\n" +
              JSON.stringify({
                attached: "T2",
                sent: ["Emulation.setDeviceMetricsOverride", "Page.reload"],
              }) +
              "\n",
          };
        }
        if (command.includes('"mode":"state"')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              url: "http://127.0.0.1:3000/help",
              title: "help",
              text: "help",
              scrollY: 0,
              targetId: "T2",
            }),
          };
        }
        if (command.includes("browserWindow: { x: window.screenX")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              browserWindow: { x: 0, y: 0, width: 500, height: 896 },
              viewport: { width: 414, height: 800, deviceScaleFactor: 3 },
              targetId: "T1",
            }),
          };
        }
        if (command.includes("browser_preference='chrome'")) {
          return {
            exitCode: 0,
            stdout:
              "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\nHUMANISH_BROWSER_CDP_PORT=9222\n",
          };
        }
        return undefined;
      },
    });
  }
  async function runLaterTabLane(sandbox: ReturnType<typeof makeFakeSandbox>) {
    const { module } = makeFakeModule(sandbox);
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-mobile-fidelity-drift",
      title: "Mobile fidelity drift",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Explore the app and stop.",
        },
      ],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { device: "mobile", browser: "chrome", fidelity: { mobileEmulation: true } },
      },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runStudyWith(
      parsed.config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    return { outcome, bundle };
  }

  it("mobile emulation on a later tab: a tab the page itself reports at the phone width is recorded on the bundle, with no drift warning", async () => {
    const { outcome, bundle } = await runLaterTabLane(laterTabSandbox(414));
    expect(
      (outcome.result.warnings ?? []).filter((warning: string) =>
        warning.includes("Mobile emulation drift"),
      ),
    ).toEqual([]);
    expect(bundle.streams[0].desktopGeometry.fidelity.laterTargets).toEqual([
      { targetId: "T2", innerWidth: 414, devicePixelRatio: 3, maxTouchPoints: 5 },
    ]);
    // The holder's own account of the later tab travels with the bundle (after its announce line).
    expect(bundle.streams[0].desktopGeometry.fidelity.holderLog).toEqual([
      JSON.stringify({
        attached: "T2",
        sent: ["Emulation.setDeviceMetricsOverride", "Page.reload"],
      }),
    ]);
  });

  it("mobile emulation drift: a later tab that reports the window width puts one warning on the participant, with the page's number", async () => {
    const { outcome, bundle } = await runLaterTabLane(laterTabSandbox(500));
    const driftWarnings = (outcome.result.warnings ?? []).filter((warning: string) =>
      warning.includes("Mobile emulation drift"),
    );
    expect(driftWarnings).toHaveLength(1);
    expect(driftWarnings[0]).toContain("reports a 500 px viewport where 414 px was requested");
    expect(bundle.streams[0].desktopGeometry.fidelity.laterTargets).toBeUndefined();
  });

  it("a lab's dwell window reaches the session the participant runs: actor default, participant override", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-dwell-plumbing",
      title: "Dwell plumbing",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          mission: "Watch the room.",
          dwell: { when: { any: [{ id: "in-room", urlIncludes: "/room/" }] }, ms: 30_000 },
          lanes: [
            { id: "watcher", persona: "first-time-visitor", instruction: "Watch." },
            {
              id: "leaver",
              persona: "first-time-visitor",
              instruction: "Watch, then leave.",
              dwell: { ms: 2_000, everyMs: 1_000, then: "stop" },
            },
          ],
        },
      ],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 1 },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const seen: unknown[] = [];
    const outcome = await runStudyWith(
      parsed.config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) => {
          seen.push(options.dwell);
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const verified = await verifyRun(cwd, outcome.result.runId);
    expect(outcome.result.ok, JSON.stringify(verified.checks.filter((check) => !check.ok))).toBe(
      true,
    );
    // The spread that carried it past the type checker is exactly why this test exists: an excess
    // property in a spread is never an error, so a dropped option is silent without it.
    expect(seen).toEqual([
      {
        when: { any: [{ id: "in-room", urlIncludes: "/room/" }] },
        ms: 30_000,
        everyMs: 10_000,
        then: "continue",
      },
      { ms: 2_000, everyMs: 1_000, then: "stop" },
    ]);
  }, 30_000);

  // A participant with a declared synthetic camera: the fake desktop answers the ffmpeg feed
  // generation and the Chrome launch, and the test reads what the browser was launched with.
  function cameraSandbox(ffmpegExit: number) {
    const commands: string[] = [];
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        commands.push(command);
        if (command.includes("ffmpeg -y"))
          return {
            exitCode: ffmpegExit,
            stdout: "",
            ...(ffmpegExit === 0 ? {} : { stderr: "ffmpeg: command not found" }),
          };
        if (command.includes("browser_preference='chrome'")) {
          return {
            exitCode: 0,
            stdout:
              "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\nHUMANISH_BROWSER_CDP_PORT=9222\n",
          };
        }
        return undefined;
      },
    });
    return { sandbox, commands };
  }
  async function runCameraLane(
    sandbox: ReturnType<typeof makeFakeSandbox>,
    policies: Record<string, unknown>,
  ) {
    const { module } = makeFakeModule(sandbox);
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-camera",
      title: "Participant camera",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Turn on the camera and stop.",
        },
      ],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { browser: "chrome", media: { camera: { source: "synthetic" } } },
      },
      scenario: { mode: "live" },
      policies,
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runStudyWith(
      parsed.config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    return outcome;
  }

  it("a synthetic camera: the feed is generated before launch, Chrome gets the fake-device flags, the bundle records it, the permission dialog stays real", async () => {
    const { sandbox, commands } = cameraSandbox(0);
    const outcome = await runCameraLane(sandbox, {});
    expect(outcome.result.ok, JSON.stringify(outcome.result.error)).toBe(true);
    const ffmpeg = commands.findIndex((command) => command.includes("ffmpeg -y"));
    const launch = commands.findIndex((command) => command.includes("browser_preference='chrome'"));
    expect(ffmpeg).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(ffmpeg);
    expect(commands[launch]).toContain("--use-fake-device-for-media-stream");
    expect(commands[launch]).toContain(
      "--use-file-for-fake-video-capture=/dev/shm/humanish-media/camera.y4m",
    );
    expect(commands[launch]).not.toContain("--use-fake-ui-for-media-stream");
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.desktopBrowser.media).toEqual({
      camera: { source: "synthetic", file: "/dev/shm/humanish-media/camera.y4m" },
      permission: "prompt",
      flags: [
        "--use-fake-device-for-media-stream",
        "--use-file-for-fake-video-capture=/dev/shm/humanish-media/camera.y4m",
      ],
    });
  });

  it("rejects a direct-library microphone source before desktop or model dispatch", async () => {
    const config = cuaConfig();
    config.execution = {
      ...config.execution,
      desktop: {
        template: "synthetic-audio-template",
        media: { microphone: { source: "./room.wav" } },
      },
    };
    let desktopLoads = 0,
      modelCalls = 0;
    const result = await runCuaActorStudy({
      cwd,
      config,
      dryRun: false,
      env: {},
      deps: {
        desktopModule: async () => {
          desktopLoads++;
          throw new Error("must not load desktop");
        },
        runSession: async () => {
          modelCalls++;
          throw new Error("must not call model");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Microphone source-file injection is unsupported");
    expect(result.runId).toBe("not-created");
    expect(desktopLoads).toBe(0);
    expect(modelCalls).toBe(0);
  });

  it("policies.mediaPermission: granted adds the auto-accept flag and the bundle says so", async () => {
    const { sandbox, commands } = cameraSandbox(0);
    const outcome = await runCameraLane(sandbox, { mediaPermission: "granted" });
    expect(outcome.result.ok).toBe(true);
    const launch = commands.find((command) => command.includes("browser_preference='chrome'"))!;
    expect(launch).toContain("--use-fake-ui-for-media-stream");
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.desktopBrowser.media.permission).toBe("granted");
    expect(bundle.desktopBrowser.media.flags).toContain("--use-fake-ui-for-media-stream");
  });

  it("a desktop image without ffmpeg fails the participant closed before the browser launches, named", async () => {
    const { sandbox, commands } = cameraSandbox(127);
    const outcome = await runCameraLane(sandbox, {});
    expect(outcome.result.ok).toBe(false);
    expect(JSON.stringify(outcome.result.error)).toContain(
      "synthetic camera feed could not be generated",
    );
    expect(commands.some((command) => command.includes("browser_preference='chrome'"))).toBe(false);
  });

  it("sandbox create retried once: a first attempt that hit an envd not yet routable is retried, named on the participant and in the phase trail", async () => {
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("browser_preference='chrome'")) {
          return {
            exitCode: 0,
            stdout:
              "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\nHUMANISH_BROWSER_CDP_PORT=9222\n",
          };
        }
        return undefined;
      },
    });
    const { module, created } = makeFakeModule(sandbox);
    const realCreate = module.Sandbox.create as unknown as (
      ...args: unknown[]
    ) => Promise<E2BDesktopSandbox>;
    let attempts = 0;
    const failingOnce = async (...args: unknown[]): Promise<E2BDesktopSandbox> => {
      attempts += 1;
      // The measured shape: the API allocated the sandbox, the desktop SDK's first envd request
      // (its Xvfb start) hit the proxy instead, and Sandbox.create threw without an id.
      if (attempts === 1) throw new Error("12: [unimplemented] HTTP 404");
      return realCreate(...args);
    };
    module.Sandbox.create = failingOnce as unknown as typeof module.Sandbox.create;
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-create-retry",
      title: "Sandbox create retry",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Explore the app and stop.",
        },
      ],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { browser: "chrome" } },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const phases: string[] = [];
    const outcome = await runStudyWith(
      parsed.config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
        subjectPhaseSink: (event) => phases.push(event.type),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(created).toHaveLength(1);
    const retryWarnings = (outcome.result.warnings ?? []).filter((warning: string) =>
      warning.includes("retried once after a transient provider error"),
    );
    expect(retryWarnings).toHaveLength(1);
    expect(retryWarnings[0]).toContain("[unimplemented] HTTP 404");
    // Cleanup evidence now comes from the guarded SDK error when a handle was acquired.
    expect(retryWarnings[0]).not.toContain("not known to this run");
    expect(phases).toContain("cua-lab.sandbox.create.retry");
  });

  it("sandbox create is not retried on an auth failure: the participant fails closed on the first attempt", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    let attempts = 0;
    const alwaysUnauthorized = async (): Promise<E2BDesktopSandbox> => {
      attempts += 1;
      throw new Error("401 Unauthorized: invalid API key");
    };
    module.Sandbox.create = alwaysUnauthorized as unknown as typeof module.Sandbox.create;
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-create-no-retry",
      title: "Sandbox create, no retry",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Explore the app and stop.",
        },
      ],
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runStudyWith(
      parsed.config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("mobile emulation leaves a desktop-preset participant alone: no launch flags, no holder, no fidelity block", async () => {
    const commands: string[] = [];
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        commands.push(command);
        if (command.includes("browser_preference='chrome'")) {
          return {
            exitCode: 0,
            stdout:
              "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\nHUMANISH_BROWSER_CDP_PORT=9222\n",
          };
        }
        return undefined;
      },
    });
    const { module } = makeFakeModule(sandbox);
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-mobile-fidelity-desktop-lane",
      title: "Mobile fidelity, desktop lane",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Explore the app and stop.",
        },
      ],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { device: "desktop", browser: "chrome", fidelity: { mobileEmulation: true } },
      },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runStudyWith(
      parsed.config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    const launch = commands.find((command) => command.includes("browser_preference='chrome'"))!;
    expect(launch).not.toContain("--user-agent=");
    expect(
      sandbox.calls.some(
        (call) => call[0] === "files.write" && String(call[1]).includes("mobile-emulation-"),
      ),
    ).toBe(false);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.streams[0].desktopGeometry.fidelity).toBeUndefined();
    expect(
      outcome.result.warnings.some((warning) => warning.includes("pointer-to-touch conversion")),
    ).toBe(false);
  });

  it("mobile emulation fails the participant closed when the launched browser is not Chromium", async () => {
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("browser_preference='firefox'")) {
          return {
            exitCode: 0,
            stdout:
              "HUMANISH_BROWSER_RESOLVED=firefox\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\n",
          };
        }
        return undefined;
      },
    });
    const { module, killed } = makeFakeModule(sandbox);
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-mobile-fidelity-firefox",
      title: "Mobile fidelity on Firefox",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Explore the app and stop.",
        },
      ],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { device: "mobile", browser: "firefox", fidelity: { mobileEmulation: true } },
      },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runStudyWith(
      parsed.config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
      },
    );
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.message).toContain("mobileEmulation needs Chrome or Chromium");
    expect(outcome.result.error?.message).toContain("firefox");
    expect(killed).toEqual(["fake-sandbox-001"]);
  });

  it("stops a clipped browser before the participant session and still reclaims the desktop", async () => {
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("xdpyinfo"))
          return { exitCode: 0, stdout: "dimensions: 1280x800 pixels\n" };
        if (command.includes("find_chrome_window"))
          return { exitCode: 0, stdout: "WINDOW_ID=7340035\n" };
        if (command.includes("xwininfo -id"))
          return {
            exitCode: 0,
            stdout:
              "Absolute upper-left X: 0\nAbsolute upper-left Y: 32\nWidth: 1280\nHeight: 800\nMap State: IsViewable\n",
          };
        if (command.includes("browser_preference='default'"))
          return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n" };
        return undefined;
      },
    });
    const { module, killed } = makeFakeModule(sandbox);
    let participantSessions = 0;
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async () => {
          participantSessions++;
          throw new Error("participant must not start");
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("wrong route");
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_DEVICE_GEOMETRY");
    expect(outcome.result.error?.message).toContain("Participant actions were not started");
    expect(participantSessions).toBe(0);
    expect(killed).toEqual(["fake-sandbox-001"]);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.streams[0].desktopGeometry.browserWindow).toMatchObject({
      y: 32,
      height: 800,
      source: "xwininfo",
    });
    expect(bundle.streams[0].desktopGeometry.warnings.join(" ")).toContain("outside the captured");
  });

  it("persists requested/verified screen, browser bounds, and a distinct measured CSS viewport", async () => {
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("xdpyinfo")) {
          return { exitCode: 0, stdout: "dimensions: 1280x800 pixels (300x200 millimeters)\n" };
        }
        if (command.includes("find_chrome_window")) {
          return { exitCode: 0, stdout: "WINDOW_ID=7340035\n" };
        }
        if (command.includes("xwininfo -id")) {
          return {
            exitCode: 0,
            stdout:
              "Absolute upper-left X: 0\nAbsolute upper-left Y: 0\nWidth: 1280\nHeight: 800\nMap State: IsViewable\n",
          };
        }
        if (command.includes("browserWindow: { x: window.screenX")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              browserWindow: { x: 0, y: 0, width: 1280, height: 800 },
              viewport: { width: 1280, height: 661, deviceScaleFactor: 1 },
            }),
          };
        }
        if (command.includes("browser_preference='default'")) {
          return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n" };
        }
        return undefined;
      },
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.streams[0].desktopGeometry).toEqual({
      screen: {
        requested: { width: 1280, height: 800 },
        verified: { width: 1280, height: 800, source: "xdpyinfo" },
      },
      browserWindow: { x: 0, y: 0, width: 1280, height: 800, source: "xwininfo" },
      viewport: { width: 1280, height: 661, deviceScaleFactor: 1, source: "cdp" },
    });
    expect(bundle.streams[0].viewport).toEqual({
      width: 1280,
      height: 661,
      deviceScaleFactor: 1,
      isMobile: false,
    });
    expect(bundle.streams[0].viewport.height).not.toBe(
      bundle.streams[0].desktopGeometry.screen.requested.height,
    );

    // Duplicate measured geometry must remain exact; a forged stream-level mismatch is invalid.
    bundle.streams[0].viewport.height = 660;
    await writeFile(
      path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"),
      `${JSON.stringify(bundle, null, 2)}\n`,
      "utf8",
    );
    const inconsistent = await verifyRun(cwd, outcome.result.runId);
    expect(inconsistent.ok).toBe(false);
    expect(inconsistent.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");

    // Optional geometry is backward-compatible, but a present block is validated fail-closed.
    bundle.streams[0].viewport.height = 661;
    bundle.streams[0].desktopGeometry.viewport.source = "declared";
    await writeFile(
      path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"),
      `${JSON.stringify(bundle, null, 2)}\n`,
      "utf8",
    );
    const malformed = await verifyRun(cwd, outcome.result.runId);
    expect(malformed.ok).toBe(false);
    expect(malformed.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
  });

  it("does not treat a negated blocker phrase in a success message as a self-reported blocker", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: {
              apiKey: "test-openai-key",
              fetchFn: scriptedFetch(SUCCESS_WITH_NEGATED_BLOCKER_SESSION),
            },
          }),
      },
    );

    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("NOT counted as a pass"))).toBe(
      false,
    );

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.review.verdict).toBe("pass");
    expect(bundle.review.gaps).toEqual([
      "Participant reports alone do not establish task success. A matched stop condition establishes only its declared condition. Run gate and share-safety results are separate.",
    ]);
  });

  const fakeBlockerSession = (
    reason: string,
    opts?: { completionReason?: string; stopWhenMatched?: boolean },
  ): CuaLoopResult =>
    ({
      completionReason: opts?.completionReason ?? "goal_satisfied",
      reason,
      trace: {
        items: opts?.stopWhenMatched
          ? [{ kind: "notice", status: "matched", title: "stopWhen matched: done" }]
          : [],
      },
    }) as unknown as CuaLoopResult;

  it("flags a goal_satisfied participant whose own narrative reports a real blocker", () => {
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession("I could not complete the task; the delete button was disabled"),
      ),
    ).toContain("could not complete");
  });

  it("tallies a refused goal_satisfied under the status the participant judged, one rule for N=1 and fan-out", () => {
    expect(
      participantStatusForCredibility("passed", { noEngagement: false, selfReportedBlocker: true }),
    ).toBe("blocked");
    expect(
      participantStatusForCredibility("passed", { noEngagement: true, selfReportedBlocker: false }),
    ).toBe("incomplete");
    expect(
      participantStatusForCredibility("passed", {
        noEngagement: false,
        selfReportedBlocker: false,
      }),
    ).toBe("passed");
    expect(participantStatusForCredibility("passed", undefined)).toBe("passed");
    // A session that did not claim a pass is not re-judged.
    expect(
      participantStatusForCredibility("abandoned", {
        noEngagement: false,
        selfReportedBlocker: true,
      }),
    ).toBe("abandoned");
  });

  it("does not flag 'can't' + a perception verb: a display defect reported after the goal", () => {
    // Five of five completed live runs on 2026-09-01 were refused on sentences like these. Each
    // participant had reached the goal and was describing what the screen showed.
    for (const message of [
      "Done. I added two tables. It looks like an internal ID leaked into the UI, and the canvas truncates it so you can't even read the whole thing.",
      "Done. I renamed the table. I can't tell from the screen whether that rename is persisted or only in memory.",
      "The long task was cut off at \u201cPrepare notes for Friday proje\u201d rather than wrapping, so I could not read its full description.",
      "Clicking Save twice did not close edit mode or give confirmation, so I could not tell whether the rename had actually been saved.",
      "I was unable to verify from the canvas alone that both tables were still there.",
    ]) {
      expect(resolveSelfReportedBlocker(fakeBlockerSession(message)), message).toBeUndefined();
      // They are still friction, and still count as such.
      expect(resolveSelfReportedFriction(fakeBlockerSession(message)), message).toBeDefined();
    }
  });

  it("every computer-use participant is asked for the fixed closing line, after the mission and the participant focus", () => {
    const composed = composeParticipantInstructions({
      mission: "Add two tables.",
      instruction: "keyboard only",
      device: { name: "desktop", preset: DEVICE_PRESETS.desktop },
    });
    expect(composed.instructions).toContain(CLOSING_LINE_DIRECTIVE);
    expect(composed.instructions.indexOf("Lane focus: keyboard only")).toBeLessThan(
      composed.instructions.indexOf(CLOSING_LINE_DIRECTIVE),
    );
    // A report format, never a behavioural instruction: it does not tell the participant what to do.
    expect(CLOSING_LINE_DIRECTIVE).not.toMatch(/never|always|do not (type|click|use)/i);
  });

  it("the participant's declared outcome wins over the paragraph, both ways", () => {
    const declared = (reason: string, outcome: "reached" | "blocked" | "not_reached") => {
      const session = fakeBlockerSession(reason);
      session.trace.declaredOutcome = outcome;
      return session;
    };
    // A declared "reached" is not re-read for blocker phrases, however the paragraph is worded.
    expect(
      resolveSelfReportedBlocker(
        declared("I could not complete the last step but marked it done anyway.", "reached"),
      ),
    ).toBeUndefined();
    // A declared "blocked" is a blocker even when the paragraph is mild.
    expect(
      resolveSelfReportedBlocker(declared("Stopped at the database dialog.", "blocked")),
    ).toContain("database dialog");
    expect(
      resolveSelfReportedFriction(declared("Stopped at the database dialog.", "blocked")),
    ).toContain("database dialog");
    // No declaration: the paragraph is read, as before.
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession("I could not complete the task; the delete button was disabled."),
      ),
    ).toBeDefined();
  });

  it("counts a finished participant's report of defects or confusion as friction, so it becomes a candidate", () => {
    // Eleven drawDB reports on 2026-09-01, all "What confused me" / "Accessibility defects:",
    // none a blocker, none a candidate; the draft said "completed without a participant-reported
    // finding" for a run that had just replicated a keyboard-accessibility defect.
    for (const message of [
      "Done. Confused by: \u201cAdd table\u201d immediately created a table with a long random name; the renaming method was not obvious.",
      "Created and saved a PostgreSQL diagram. Accessibility defects: the database chooser and confirmation control were not keyboard-accessible; focus escaped behind the modal, requiring mouse clicks.",
      "Done. The second table was placed exactly on top of the first one, so the two overlapped.",
      "Done. Clicking Save did nothing; pressing Enter saved the name.",
    ]) {
      expect(resolveSelfReportedFriction(fakeBlockerSession(message)), message).toBeDefined();
      // Friction, and only friction: none of these refuses the pass.
      expect(resolveSelfReportedBlocker(fakeBlockerSession(message)), message).toBeUndefined();
    }
    // A report with nothing to say stays silent.
    expect(
      resolveSelfReportedFriction(
        fakeBlockerSession(
          "Done. I added two tables named customers and orders; both are visible in the sidebar.",
        ),
      ),
    ).toBeUndefined();
  });

  it("still flags an inability to act, which is what a blocker is", () => {
    for (const message of [
      "Blocked after partial completion. Could not connect the two tables because every new table appeared on top of the previous one.",
      "I could not complete the task; the delete button was disabled.",
      "I can tab to the signature box but cannot get focus into the typed-signature entry area.",
      "I was unable to proceed past the login screen.",
    ]) {
      expect(resolveSelfReportedBlocker(fakeBlockerSession(message)), message).toBeDefined();
    }
  });

  it("does not flag a clean pass that says nothing blocked it", () => {
    // Found on 2026-09-01 by a real benchmark run: a passing participant ended "No functional
    // failures blocked me, and cleanup left the app back at an empty list" and was downgraded from
    // a pass to a study failure. The negation list only knew real/remaining/actual, so the ordinary
    // qualifier "functional" slipped through and the trailing verb "blocked" tripped the scan.
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession("No functional failures blocked me, and cleanup left the app empty."),
      ),
    ).toBeUndefined();
  });

  it("does not flag other ordinary ways of saying it went fine", () => {
    for (const message of [
      // A clean benchmark run on 2026-09-01 was refused on this exact sentence.
      "Overall, the main list actions were straightforward and worked on the first try. I encountered no blockers or unclear error output.",
      "I hit no obvious errors during the trial.",
      "There were no significant problems with the main flow.",
      "Nothing really stopped me from finishing the task.",
      "No blocking issues prevented me from completing it.",
    ]) {
      expect(resolveSelfReportedBlocker(fakeBlockerSession(message))).toBeUndefined();
    }
  });

  it("still flags a real blocker that happens to sit near the word no", () => {
    // The negation widening must not swallow an actual report. "no" here belongs to a different
    // clause than the blocker.
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession(
          "There was no undo button, and I could not complete the checkout at all.",
        ),
      ),
    ).toContain("could not complete");
  });

  it("does not flag a participant that merely quotes the subject app's copy containing a blocker word", () => {
    // The persona faithfully relays the app's banner text; a quoted span is not the actor's own
    // status and must not trip the blocker scan.
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession(
          'I confirmed the deletion. The banner read "This action cannot be undone." The item is gone.',
        ),
      ),
    ).toBeUndefined();
  });

  it("does not flag a blocker narrative when the run's own stopWhen predicate matched", () => {
    // A matched stopWhen is independent, structured completion evidence and overrides the text scan.
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession("the page shows an error but I reached the target state", {
          stopWhenMatched: true,
        }),
      ),
    ).toBeUndefined();
  });

  it("does not flag a clean goal_satisfied success", () => {
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession("Success: the target state is visible. No blocker encountered."),
      ),
    ).toBeUndefined();
  });

  it("only inspects goal_satisfied participants", () => {
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession("cannot proceed", { completionReason: "timeout" }),
      ),
    ).toBeUndefined();
    expect(resolveSelfReportedBlocker(undefined)).toBeUndefined();
  });

  it("a defect report after demonstrated success keeps the pass and counts as friction", () => {
    // The live run-1 report shape, verbatim in structure: mission done, then a defect-notes
    // section whose failure narration reports its own recovery in the same segment.
    const report = [
      "Done. Created three tables and one relationship. Final state shows Tables (3) and Relationships (1), which matches the requested task.",
      "Notes / defects observed:",
      "- The SQL import editor output was somewhat ambiguous; my first import failed with a parser error that was hard to interpret. A simpler SQL import succeeded.",
      "- Dragging tables around the canvas did not work reliably for me.",
    ].join("\n");
    // Strict (verdict): the resolved arc never blocks the pass.
    expect(resolveSelfReportedBlocker(fakeBlockerSession(report))).toBeUndefined();
    // Inclusive (tally/candidates): the friction is still reported evidence.
    expect(resolveSelfReportedFriction(fakeBlockerSession(report))).toContain("parser error");
  });

  it("an unresolved failure still blocks the verdict: the strip needs the recovery in the segment", () => {
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession(
          "The import failed with a parser error, so I gave up on that path and stopped.",
        ),
      ),
    ).toContain("failed");
    // And a recovery in a different segment does not launder an unresolved failure.
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession(
          "Login failed and I could not get in. Separately, the search box worked.",
        ),
      ),
    ).toContain("Login failed");
  });

  it("adapter fail score turns an otherwise goal_satisfied browser run red while keeping the bundle verifiable", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        scorer: browserScorer({
          score: failingBrowserScore,
          deriveFeedback: browserFeedback,
          deriveArtifacts: async (ctx) => {
            await mkdir(path.join(ctx.runDir, "adapter"), { recursive: true });
            await writeFile(
              path.join(ctx.runDir, "adapter", "browser-state-proof.json"),
              `${JSON.stringify(
                {
                  schema: "example.adapter-state-proof.v1",
                  runId: ctx.runId,
                  status: "failed-product-acceptance",
                  route: ctx.route,
                },
                null,
                2,
              )}\n`,
              "utf8",
            );
            return [
              {
                schema: "humanish.adapter-artifact.v1",
                namespace: BROWSER_ADAPTER_NAMESPACE,
                label: "Browser adapter state proof",
                path: "adapter/browser-state-proof.json",
                kind: "state",
                note: "Adapter-owned product/state readback proof.",
              },
            ];
          },
        }),
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );

    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Adapter scorer failed the run");

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore?.namespace).toBe(BROWSER_ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("Adapter scorer failed the run");
    expect(bundle.review.gaps.some((gap) => gap.includes("Adapter scorer failed the run"))).toBe(
      true,
    );
    expect(bundle.feedbackCandidates).toHaveLength(1);
    expect(bundle.feedbackCandidates[0]?.adapter?.namespace).toBe(BROWSER_ADAPTER_NAMESPACE);
    expect(bundle.feedbackCandidates[0]?.substrate).toBe("e2b-desktop");
    expect(bundle.adapterArtifacts).toEqual([
      {
        schema: "humanish.adapter-artifact.v1",
        namespace: BROWSER_ADAPTER_NAMESPACE,
        label: "Browser adapter state proof",
        path: "adapter/browser-state-proof.json",
        kind: "state",
        note: "Adapter-owned product/state readback proof.",
      },
    ]);
    const observerData = JSON.parse(
      await readFile(path.join(runDir, "observer", "observer-data.json"), "utf8"),
    );
    expect(observerData.artifactLinks).toContainEqual({
      label: "Browser adapter state proof",
      href: "../adapter/browser-state-proof.json",
      kind: "state",
    });

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);

    await rm(path.join(runDir, "adapter", "browser-state-proof.json"), { force: true });
    const missing = await verifyRun(cwd, result.runId);
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toBe("Run bundle failed verification.");
    expect(
      missing.checks.find((check) => check.name === "local evidence artifacts exist")?.message,
    ).toContain("adapter/browser-state-proof.json");
  });

  it("malformed browser adapter outputs are dropped, preserving default green behavior", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        scorer: {
          score: () =>
            ({
              schema: "humanish.adapter-score.v1",
              namespace: "",
              status: "fail",
              score: 0,
              summary: "bad",
            }) as RunAdapterScore,
          deriveArtifacts: () => [
            {
              schema: "humanish.adapter-artifact.v1",
              namespace: BROWSER_ADAPTER_NAMESPACE,
              label: "Bad artifact",
              path: "../secret.json",
              kind: "state",
              note: "bad path",
            },
          ],
          deriveFeedback: () =>
            [
              {
                schema: "humanish.feedback-candidate.v1",
                id: "bad",
                summary: "Malformed candidate missing required run fields.",
                evidence: [],
                redaction: { status: "passed", notes: "shape test" },
              },
            ] as unknown as RunFeedbackCandidate[],
        },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );

    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("adapter-score.v1") || warning.includes("feedback-candidate.v1"),
      ),
    ).toBe(true);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.adapterScore).toBeUndefined();
    expect(bundle.adapterArtifacts).toBeUndefined();
    expect(bundle.feedbackCandidates).toHaveLength(0);
    expect(bundle.review.verdict).toBe("pass");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("default persists raw screenshots (full fidelity, local) and warns the bundle is not publish-safe as-is", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.redaction.screenshots).toBe("raw");
    expect(
      bundle.streams[0].actor.items
        .filter((i: { kind: string }) => i.kind === "screenshot")
        .every(
          (i: { screenshotRef?: { redaction: string } }) => i.screenshotRef?.redaction === "none",
        ),
    ).toBe(true);
    expect(outcome.result.warnings.some((w) => w.toLowerCase().includes("unblurred"))).toBe(true);

    // Claims match mechanism: a raw run must never be labeled "redacted" anywhere.
    expect(bundle.streams[0].embed.title).toBe("Desktop (raw)");
    const screenshotLabels = bundle.streams[0].artifacts
      .filter((a: { kind: string }) => a.kind === "screenshot")
      .map((a: { label: string }) => a.label);
    expect(screenshotLabels.length).toBeGreaterThan(0);
    expect(screenshotLabels.every((label: string) => label.endsWith("(raw)"))).toBe(true);
    expect(bundle.redaction.notes).toContain("Screenshots are unblurred");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toMatch(/\d+ raw screenshots?/);
    for (const text of [JSON.stringify(bundle), reviewMd]) {
      expect(text).not.toContain("(redacted)");
      expect(text).not.toContain("redacted screenshot");
    }
    // The raw warning must not promise a commit-blocking scan downstream users do not have
    // (the binary-asset scan is humanish's own CI, not part of the package).
    const rawWarning = outcome.result.warnings.find((w) => w.includes("unblurred"));
    expect(rawWarning).toContain(".humanish");
    expect(rawWarning).toContain("review");
    expect(rawWarning).not.toContain("binary-asset scan");
    expect(rawWarning).not.toContain("blocked from commit");
  });

  it("policies.redactScreenshots: true persists blurred screenshots and drops the raw warning", async () => {
    const config = cuaConfig();
    const redactedConfig: StudyConfig = {
      ...config,
      policies: { ...config.policies, redactScreenshots: true },
    };
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      redactedConfig,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.redaction.screenshots).toBe("blurred");
    expect(outcome.result.warnings.some((w) => w.toLowerCase().includes("full-fidelity"))).toBe(
      false,
    );

    // Claims match mechanism: the blurred mode is named as such, not a vague "redacted".
    expect(bundle.streams[0].embed.title).toBe("Desktop (blurred)");
    const screenshotLabels = bundle.streams[0].artifacts
      .filter((a: { kind: string }) => a.kind === "screenshot")
      .map((a: { label: string }) => a.label);
    expect(screenshotLabels.length).toBeGreaterThan(0);
    expect(screenshotLabels.every((label: string) => label.endsWith("(blurred)"))).toBe(true);
    expect(bundle.redaction.notes).toContain("blurred at capture");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toMatch(/\d+ blurred screenshots?/);
    expect(reviewMd).not.toContain("redacted screenshot");
  });

  it("policies.allowPublicTargets lets the engine drive a declared public app-url target", async () => {
    const config = cuaConfig();
    const publicConfig: StudyConfig = {
      ...config,
      subject: { source: "app-url", appUrl: "https://preview-xyz.vercel.app/" },
      policies: { allowPublicTargets: true },
    };
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      publicConfig,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.error).toBeUndefined();
    expectSafeBrowserOpen(sandbox.calls, "https://preview-xyz.vercel.app/");

    // Without the policy, the engine fails closed even if a config bypasses the parser.
    const sandbox2 = makeFakeSandbox();
    const { module: module2 } = makeFakeModule(sandbox2);
    const blocked = await runStudyWith(
      { ...publicConfig, policies: {} },
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module2,
      },
    );
    if (blocked.route !== "computer-use") throw new Error("expected cua backend");
    expect(blocked.result.ok).toBe(false);
    expect(blocked.result.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_UNSAFE");
  });

  it("comms:email:fake: injects the catch env, deploys the catch, and drains captured mail into a digest-only evidence artifact", async () => {
    const commsPort = 8025;
    const base = cloneCuaConfig();
    const config: StudyConfig = {
      ...base,
      comms: {
        email: {
          kind: "fake",
          injectEnv: "RESEND_API_URL",
          port: commsPort,
          recipients: [{ lane: "user", address: "user@example.test" }],
        },
      },
    };
    // What the (simulated) subject app POSTed to its Resend-shaped base URL during the run: a
    // verification email to the declared recipient, captured by the in-sandbox catch as NDJSON.
    const verificationHtml =
      '<p>Confirm.</p><a href="https://app.example.test/verify?token=abc123XYZ-9">Verify</a><p>Code: 481920</p>';
    const capturedNdjson =
      JSON.stringify({
        t: 1,
        path: "/emails",
        body: JSON.stringify({
          from: "no-reply@example.test",
          to: ["user@example.test"],
          subject: "Confirm your email",
          html: verificationHtml,
        }),
      }) + "\n";
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        // the comms catch readiness probe must see our service marker (not the subject's plain `READY`)
        if (command.includes(`${commsPort}/health`))
          return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        // the teardown drain `cat`s the in-sandbox NDJSON of captured sends
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson"))
          return { stdout: capturedNdjson };
        return undefined;
      }),
    });
    const { module, created } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // The adopter-named base-URL env was injected into the subject sandbox at create (the app boots reading it).
    expect(created[0]?.envs?.RESEND_API_URL).toBe(`http://127.0.0.1:${commsPort}`);
    // And the in-sandbox capture script was written into the subject sandbox (the catch was deployed).
    expect(
      sandbox.calls.some(
        ([name, p]) => name === "files.write" && typeof p === "string" && p.endsWith("catch.py"),
      ),
    ).toBe(true);

    // The captured mail was drained + routed + written as a digest-only comms-thread artifact, and
    // registered in the participant's stream artifacts (so the bundle's existence-verify + scan
    // cover it).
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const commsArtifact = bundle.streams[0].artifacts.find(
      (a: { path: string; kind: string }) => a.path === "comms/thread.json",
    );
    expect(commsArtifact).toMatchObject({ kind: "log", label: "comms thread" });
    const threadRaw = await readFile(path.join(runDir, "comms", "thread.json"), "utf8");
    const thread = JSON.parse(threadRaw) as {
      schema: string;
      count: number;
      thread: Array<{ toDigests: string[]; codeCount: number }>;
    };
    expect(thread.schema).toBe("humanish.comms-thread.v1");
    expect(thread.count).toBe(1);
    expect(thread.thread[0]!.codeCount).toBe(1); // the OTP is a count, never stored
    // Public-safety: no raw address / link / OTP / subject text in the persisted evidence.
    expect(threadRaw).not.toContain("user@example.test");
    expect(threadRaw).not.toContain("app.example.test/verify");
    expect(threadRaw).not.toContain("481920");
    expect(threadRaw).not.toContain("Confirm your email");
  });

  it("comms:email:fake: tells the persona its address and inbox URL, and stays silent for a participant that has neither", async () => {
    // The half no test covered. Capture and drain were proven; whether the actor is ever told an
    // inbox exists was not. That is the gap a live run hit: mail landing in a catch nobody opened,
    // because the persona was never handed the address to sign up with or the URL to read.
    const commsPort = 8025;
    const base = cloneCuaConfig();
    const config: StudyConfig = {
      ...base,
      comms: {
        email: {
          kind: "fake",
          injectEnv: "RESEND_BASE_URL",
          port: commsPort,
          recipients: [{ lane: "lane-01", address: "signup-a@example.test" }],
        },
      },
    };
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes(`${commsPort}/health`))
          return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson"))
          return { stdout: "" };
        return undefined;
      }),
    });
    const { module } = makeFakeModule(sandbox);
    let t = 0;
    const seenInstructions: string[] = [];
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) => {
          seenInstructions.push(options.instructions);
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    const prompt = seenInstructions[0] ?? "";
    // The address, because the drain matches captured mail against the declared address: an actor
    // that invents its own at signup gets an inbox that stays empty forever.
    expect(prompt).toContain("signup-a@example.test");
    // The inbox URL, because otherwise there is nowhere to go when the app says "we emailed you".
    expect(prompt).toContain(`http://127.0.0.1:${commsPort}`);
    // Delivery context is supplied without commanding persistence.
    expect(prompt.toLowerCase()).toContain("delivery may take a little time");
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.streams[0].assignment).toEqual({ mission: config.actors[0]!.mission });
    expect(JSON.stringify(bundle.streams[0].assignment)).not.toContain("signup-a@example.test");
    expect(JSON.stringify(bundle.streams[0].assignment)).not.toContain(String(commsPort));
  });

  it("comms:email:fake: does not tell a participant about an inbox it could never receive into", async () => {
    // A participant with no addressed recipient must not be sent to an inbox that will stay empty:
    // it would refresh forever and burn the session on a promise the harness cannot keep.
    const commsPort = 8025;
    const base = cloneCuaConfig();
    const config: StudyConfig = {
      ...base,
      comms: {
        email: {
          kind: "fake",
          injectEnv: "RESEND_BASE_URL",
          port: commsPort,
          recipients: [{ lane: "lane-01" }],
        },
      },
    };
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes(`${commsPort}/health`))
          return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson"))
          return { stdout: "" };
        return undefined;
      }),
    });
    const { module } = makeFakeModule(sandbox);
    let t = 0;
    const seenInstructions: string[] = [];
    await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) => {
          seenInstructions.push(options.instructions);
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      },
    );
    expect(seenInstructions[0] ?? "").not.toContain("Email inbox:");
  });

  it("comms:email:fake: warns (never silently loses) when captured mail matches no declared recipient", async () => {
    const commsPort = 8025;
    const base = cloneCuaConfig();
    // comms declared but no recipients → the app's send is captured but matches no provisioned inbox.
    const config: StudyConfig = {
      ...base,
      comms: { email: { kind: "fake", injectEnv: "RESEND_API_URL", port: commsPort } },
    };
    const capturedNdjson =
      JSON.stringify({
        t: 1,
        path: "/emails",
        body: JSON.stringify({
          from: "no-reply@example.test",
          to: ["user@example.test"],
          subject: "Confirm",
          html: "<p>Code: 481920</p>",
        }),
      }) + "\n";
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes(`${commsPort}/health`))
          return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson"))
          return { stdout: capturedNdjson };
        return undefined;
      }),
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // Captured-but-unevidenced mail surfaces as a warning (not lost silently); no artifact registered.
    expect(
      outcome.result.warnings.some(
        (w) => w.includes("captured") && w.includes("no email evidence"),
      ),
    ).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(
      bundle.streams[0].artifacts.find((a: { path: string }) => a.path === "comms/thread.json"),
    ).toBeUndefined();
  });

  it("comms:email:fake: tells the persona its inbox URL and renders the live surface mid-run", async () => {
    const commsPort = 8025;
    const base = cloneCuaConfig();
    // The recipient's `lane` must match the N=1 participant id (`lane-01`) for the inbox
    // instruction to be injected.
    const config: StudyConfig = {
      ...base,
      comms: {
        email: {
          kind: "fake",
          injectEnv: "RESEND_API_URL",
          port: commsPort,
          recipients: [{ lane: "lane-01", address: "user@example.test" }],
        },
      },
    };
    const verificationHtml =
      '<p>Confirm.</p><a href="http://127.0.0.1:3000/verify?token=abc123XYZ-9">Verify</a><p>Code: 481920</p>';
    const capturedNdjson =
      JSON.stringify({
        t: 1,
        path: "/emails",
        body: JSON.stringify({
          from: "no-reply@example.test",
          to: ["user@example.test"],
          subject: "Confirm your email",
          html: verificationHtml,
        }),
      }) + "\n";
    let t = 0;
    let seenInstructions = "";
    const streamLifecycle: string[] = [];
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes(`${commsPort}/health`))
          return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson"))
          return { stdout: capturedNdjson };
        return undefined;
      }),
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        // Stream lifecycle: ready fires while the sandbox lives and ended after its teardown.
        // The pair lets the watch overlay stop serving a dead stream URL.
        onStream: (event) => {
          streamLifecycle.push(`${event.type}:${event.streamId}:${event.recordId}`);
        },
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) => {
          seenInstructions = options.instructions;
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // The persona actually received the inbox URL in its prompt (loopback, same sandbox as its browser).
    expect(seenInstructions).toContain(`http://127.0.0.1:${commsPort}/inbox`);
    // The full handoff: the persona is told which address to sign up with (the drain matches
    // the declared address, so an invented one would leave the inbox empty forever) and that
    // delivery can take time while stopping remains the participant's decision.
    expect(seenInstructions).toContain("Your email address is user@example.test");
    expect(seenInstructions).toContain("stop based on your situation and what you observe");
    // The live inbox surface was rendered into the sandbox during the run (the mid-run loop wrote the list).
    expect(
      sandbox.calls.some(
        ([name, p]) =>
          name === "files.write" && typeof p === "string" && p.endsWith("/surface/inbox/index"),
      ),
    ).toBe(true);
    // Stream lifecycle: the participant announced its live stream while the sandbox lived, and announced
    // the end after teardown: ready strictly before ended, one pair, same stream id.
    expect(streamLifecycle).toEqual(["ready:stream-001:sim-001", "ended:stream-001:sim-001"]);
  });

  it("comms:email:fake: writes an empty inbox up front so /inbox never 404s before mail arrives", async () => {
    const commsPort = 8025;
    const base = cloneCuaConfig();
    const config: StudyConfig = {
      ...base,
      comms: {
        email: {
          kind: "fake",
          injectEnv: "RESEND_API_URL",
          port: commsPort,
          recipients: [{ lane: "lane-01", address: "user@example.test" }],
        },
      },
    };
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes(`${commsPort}/health`))
          return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson"))
          return { stdout: "" }; // no mail captured
        return undefined;
      }),
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // The empty inbox list was written up front, so a persona opening /inbox gets "No messages yet.", not a 404.
    const write = sandbox.calls.find(
      ([name, p]) =>
        name === "files.write" && typeof p === "string" && p.endsWith("/surface/inbox/index"),
    );
    expect(write).toBeDefined();
    expect(String(write![2])).toContain("No messages yet");
  });

  it("honors subject.clone.keep on failure: leaves the sandbox up for debugging instead of killing it", async () => {
    const config = cloneCuaConfig();
    const keepConfig: StudyConfig = {
      ...config,
      subject: { ...config.subject, clone: { ...config.subject.clone, keep: true } },
    };
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      keepConfig,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async () => {
          throw new Error("boom during session");
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);
    // Failure + keep → not killed, with a debug warning naming the sandbox.
    expect(killed).toEqual([]);
    expect(outcome.result.sandbox?.killed).toBe(false);
    expect(outcome.result.warnings.some((w) => w.includes("kept for debugging"))).toBe(true);
  });

  it("does not pass a goal_satisfied run with zero actions and zero messages (blank-screen guard)", async () => {
    // Model immediately returns done with no action and no message, i.e. it saw a blank/loading
    // screen and stopped. This must not be reported as a pass.
    const noEngagementSession = [
      { id: "r1", output: [{ type: "message", content: [] }] }, // no actions, no text
    ];
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(noEngagementSession) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    // The session itself is goal_satisfied, but a run with zero engagement is not reported as a pass.
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("no actions");
    expect(result.warnings.some((w) => w.includes("no actions and no messages"))).toBe(true);

    // The independent verifier reaches the same judgment from the persisted bundle alone:
    // a hollow bundle must not verify ok even though the producer wrote redaction: passed.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
    expect(verified.checks.find((check) => check.name === "actor engagement")?.ok).toBe(false);
  });

  it("a participant the harness refused as 'not a credible pass' is not written up as a pass", async () => {
    // Found on a real run: the participant said ok:false / HUMANISH_COMPUTER_USE_FAILED / "not a
    // credible pass", and the bundle said verdict pass, 1/1 reached the goal. Every projection of
    // the bundle (Observer tally, `humanish runs`, the status index, a share) repeated the pass.
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(BLOCKED_AFTER_PARTIAL_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    // The participant's judgment, unchanged: the actor claimed goal_satisfied, the harness refused
    // it.
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_FAILED");
    expect(result.error?.message).toContain("not a credible pass");

    // The durable evidence now says the same thing the participant said.
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.review.verdict).toBe("blocked");
    expect(bundle.review.summary).toContain(
      "Recorded summary: Not counted as a pass: the participant's final message described a blocker.",
    );
    // Zero recorded completions, 1 blocked, 1 reported friction: what that run recorded.
    expect(bundle.review.participants).toMatchObject({
      total: 1,
      reachedGoal: 0,
      blocked: 1,
      reportedFriction: 1,
    });
    // The trace keeps the claim: what the actor said is evidence, what the harness counted is the review.
    expect(bundle.streams[0].actor.completionReason).toBe("goal_satisfied");

    // The status index copies the review verbatim, so it inherits the fix rather than needing one.
    const status = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "status.json"), "utf8"),
    );
    expect(status.outcome?.verdict).toBe("blocked");
    expect(status.outcome?.participants).toMatchObject({ total: 1, reachedGoal: 0 });

    // The evidence is sound (the harness did what it said) so verify still passes. A blocked
    // participant is a finding, not a broken instrument.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("device preset drives the E2B desktop resolution + tells the model it's mobile (sim-parity)", async () => {
    const config = cuaConfig();
    const mobileConfig: StudyConfig = {
      ...config,
      execution: { ...config.execution, target: "e2b-desktop", desktop: { device: "mobile" } },
    };
    const sandbox = makeFakeSandbox();
    const { module, created } = makeFakeModule(sandbox);
    const sessionOptionsSeen: CuaActorSessionOptions[] = [];
    const outcome = await runStudyWith(
      mobileConfig,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) => {
          sessionOptionsSeen.push(options);
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // The mobile preset (414x896) sizes the E2B desktop (not 1280x800) but its width is floored to
    // Chrome's ~500px window minimum, so the rendered screen the window fits is 500x896 (no clip).
    expect(created[0]?.resolution).toEqual([500, 896]);
    // And the model is told it's a 414 mobile device (the device identity / sim-parity prompt signal is
    // the unfloored preset, even though the screen renders at the 500px floor).
    expect(sessionOptionsSeen[0]?.instructions).toContain("mobile user");
    expect(sessionOptionsSeen[0]?.instructions).toContain("414x896");
    // The bundle records the requested screen (the floored render target we actually asked E2B for), but
    // this fake exposes no CDP measurement and therefore cannot claim a CSS viewport.
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.streams[0].desktopGeometry.screen.requested).toEqual({ width: 500, height: 896 });
    expect(bundle.streams[0].viewport).toBeUndefined();
  });

  it("device resolution order: raw resolution overrides the preset; default is desktop 1440x950", async () => {
    const def = makeFakeSandbox();
    const defMod = makeFakeModule(def);
    const defConfig: StudyConfig = { ...cuaConfig(), execution: { target: "e2b-desktop" } };
    const r1 = await runStudyWith(
      defConfig,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => defMod.module,
        runSession: async (o) =>
          runCuaActorSession({
            ...o,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (r1.route !== "computer-use") throw new Error("expected cua");
    expect(defMod.created[0]?.resolution).toEqual([1440, 950]);

    const ov = makeFakeSandbox();
    const ovMod = makeFakeModule(ov);
    const ovConfig: StudyConfig = {
      ...cuaConfig(),
      execution: { target: "e2b-desktop", desktop: { device: "mobile", resolution: [1024, 768] } },
    };
    const ovSeen: CuaActorSessionOptions[] = [];
    const r2 = await runStudyWith(
      ovConfig,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => ovMod.module,
        runSession: async (o) => {
          ovSeen.push(o);
          return runCuaActorSession({
            ...o,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
      },
    );
    if (r2.route !== "computer-use") throw new Error("expected cua");
    expect(ovMod.created[0]?.resolution).toEqual([1024, 768]);
    // Consistency: a raw resolution override must not inherit a named preset's mobile/DSF; the
    // prompt + requested-screen metadata reflect the custom non-mobile geometry, not "mobile".
    expect(ovSeen[0]?.instructions).not.toContain("mobile user");
    const ovBundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", r2.result.runId, "run.json"), "utf8"),
    );
    expect(ovBundle.streams[0].desktopGeometry.screen.requested).toEqual({
      width: 1024,
      height: 768,
    });
    expect(ovBundle.streams[0].viewport).toBeUndefined();
  });

  it("opens HTTP targets with a shell-quoted browser command so query params survive", async () => {
    const targetUrl =
      "http://127.0.0.1:3000/api/bootstrap?origin=http%3A%2F%2F127.0.0.1%3A3000&scenario=alpha&redirect=%2Fdashboard";
    const sandbox = makeFakeSandbox({ withOpen: false });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(targetUrl),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    const openIndex = expectSafeBrowserOpen(sandbox.calls, targetUrl);
    const openCommand = String(sandbox.calls[openIndex]?.[1] ?? "");
    expect(openCommand).toContain("&scenario=alpha&redirect=");
    expect(openCommand).toContain("--disable-component-update");
    expect(openCommand).toContain("--disable-extensions");
    expect(openCommand).toContain("--password-store=basic");
    expect(openCommand).toContain("credentials_enable_service");
    expect(openCommand).toContain('"custom_chrome_frame":false');
    expect(openCommand).toContain('"password_manager_enabled":false');
    expect(sandbox.calls.some((call) => call[0] === "open")).toBe(false);
    expect(sandbox.calls.some((call) => call[0] === "launch")).toBe(false);
  });

  it("launches the requested desktop browser and records browser provenance", async () => {
    const targetUrl =
      "http://127.0.0.1:3000/api/bootstrap?scenario=chrome-proof&redirect=%2Fdashboard";
    const config: StudyConfig = {
      ...cuaConfig(targetUrl),
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { resolution: [1280, 800], browser: "chrome" },
      },
    };
    const sandbox = makeFakeSandbox({
      commandHandler: (command) =>
        command.includes("browser_preference='chrome'")
          ? { stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n", exitCode: 0 }
          : undefined,
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    const openIndex = expectSafeBrowserOpen(sandbox.calls, targetUrl);
    const openCommand = String(sandbox.calls[openIndex]?.[1] ?? "");
    expect(openCommand).toContain("browser_preference='chrome'");
    expect(openCommand).toContain("launch_browser google-chrome google-chrome");
    expect(sandbox.calls.some((call) => call[0] === "open")).toBe(false);
    expect(sandbox.calls.some((call) => call[0] === "launch")).toBe(false);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.desktopBrowser).toEqual({ requested: "chrome", resolved: "google-chrome" });
  });

  it("attributes explicit Firefox geometry to Firefox even when stale Chrome CDP is present", async () => {
    const config: StudyConfig = {
      ...cuaConfig(),
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { resolution: [1280, 800], browser: "firefox" },
      },
    };
    const firefoxWindowId = "9437185";
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("browser_preference='firefox'")) {
          return { stdout: "HUMANISH_BROWSER_RESOLVED=firefox\n", exitCode: 0 };
        }
        if (command.includes("xdpyinfo")) {
          return { stdout: "dimensions: 1280x800 pixels (300x200 millimeters)\n", exitCode: 0 };
        }
        if (command.includes("find_firefox_window()")) {
          return { stdout: `WINDOW_ID=${firefoxWindowId}\n`, exitCode: 0 };
        }
        if (command.includes("find_chrome_window()")) {
          return { stdout: "WINDOW_ID=7340035\n", exitCode: 0 };
        }
        if (command.includes("xwininfo -id")) {
          return {
            stdout:
              "Absolute upper-left X: 0\nAbsolute upper-left Y: 0\nWidth: 1280\nHeight: 800\nMap State: IsViewable\n",
            exitCode: 0,
          };
        }
        if (command.includes("browserWindow: { x: window.screenX")) {
          return {
            stdout: JSON.stringify({
              browserWindow: { x: 0, y: 0, width: 777, height: 555 },
              viewport: { width: 777, height: 444, deviceScaleFactor: 1 },
            }),
            exitCode: 0,
          };
        }
        return undefined;
      },
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    const commands = sandbox.calls
      .filter((call) => call[0] === "commands.run")
      .map((call) => String(call[1]));
    expect(commands.some((command) => command.includes("find_firefox_window()"))).toBe(true);
    expect(commands.some((command) => command.includes("find_chrome_window()"))).toBe(false);
    expect(commands.some((command) => command.includes("browserWindow: { x: window.screenX"))).toBe(
      false,
    );
    expect(commands.some((command) => command.includes(`win='${firefoxWindowId}'`))).toBe(true);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.desktopBrowser).toEqual({ requested: "firefox", resolved: "firefox" });
    expect(bundle.streams[0].desktopGeometry.browserWindow).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
      source: "xwininfo",
    });
    expect(bundle.streams[0].desktopGeometry.viewport).toBeUndefined();
    expect(bundle.streams[0].viewport).toBeUndefined();
    expect(bundle.streams[0].desktopGeometry.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("unavailable in Firefox")]),
    );
  });

  it("live with missing keys fails closed, names the variables, and never creates a sandbox", async () => {
    const sandbox = makeFakeSandbox();
    const { module, created } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "present-key" },
      },
      {
        desktopModule: async () => module,
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_KEYS_MISSING");
    expect(result.error?.message).toContain("E2B_API_KEY");
    expect(result.error?.message).not.toContain("OPENAI_API_KEY and");
    expect(result.error?.message).not.toContain("present-key");
    expect(created).toHaveLength(0);
    expect(result.runId).toBe("not-created");
  });

  it("kills the sandbox and still persists a failed-evidence bundle when the session throws", async () => {
    const sandbox: FakeSandbox = makeFakeSandbox({
      commandHandler: measuredChromeDesktop(() => sandbox.screen),
    });
    const { module, killed } = makeFakeModule(sandbox);
    // A stepped clock fixes the sandbox's measured desktop minutes for the failure golden.
    let clock = 0;
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        now: () => (clock += 30_000),
        desktopModule: async () => module,
        runSession: async () => {
          throw new Error("provider exploded mid-session");
        },
      },
    ).finally(stderr.stop);
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_FAILED");
    expect(result.error?.message).toContain("provider exploded");
    expect(killed).toEqual(["fake-sandbox-001"]);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.simulations[0].status).toBe("failed");
    expect(bundle.review.verdict).toBe("fail");
    await expectFailureGolden(
      "computer-use/session-throws",
      path.join(cwd, ".humanish", "runs", result.runId),
      {
        result,
        stderr: stderr.text(),
        replace: [
          [result.runId, "[run]"],
          [cwd, "[cwd]"],
        ],
      },
    );
  });

  it("rejects a non-computer-use actor at the engine even if a config bypasses the parser", async () => {
    const config = cuaConfig();
    const tampered = { ...config, actors: [{ type: "codex-app-server" }] };
    const result = await runCuaActorStudy({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_ACTOR_UNSUPPORTED");
  });

  it("rejects path-shaped runtime participant ids before provider or desktop hooks", async () => {
    const config = cuaConfig();
    const actor = config.actors[0]!;
    const { laneFocus: _laneFocus, ...actorWithoutLaneFocus } = actor;
    const tampered: StudyConfig = {
      ...config,
      actors: [{ ...actorWithoutLaneFocus, lanes: [{ id: "../escape" }] }],
    };
    let desktopLoads = 0;
    const result = await runCuaActorStudy({
      cwd,
      config: tampered,
      dryRun: false,
      deps: {
        desktopModule: async () => {
          desktopLoads += 1;
          throw new Error("must not load");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_FANOUT_INVALID");
    expect(result.runId).toBe("not-created");
    expect(desktopLoads).toBe(0);
  });

  it("re-enforces the loopback entry boundary at the engine even if a config bypasses the parser", async () => {
    const config = cuaConfig();
    const tampered = {
      ...config,
      subject: { source: "app-url" as const, appUrl: "https://example.com/" },
    };
    const result = await runCuaActorStudy({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_UNSAFE");
    // Nothing was persisted, so no artifact can mislabel the public URL as loopback.
    expect(result.runId).toBe("not-created");
    await expect(readdir(path.join(cwd, ".humanish", "runs"))).rejects.toThrow();
  });

  it("redacts harness-level session errors before they reach any persisted artifact", async () => {
    // Built dynamically so no secret-shaped literal ever appears in this source file.
    const secretToken = "Bearer " + "a1b2c3d4e5".repeat(4);
    const hostPath = "/home/" + "someuser/private-checkout/app";
    const sandbox = makeFakeSandbox();
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async () => {
          throw new Error(`request failed with ${secretToken} while reading ${hostPath}`);
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(killed).toEqual(["fake-sandbox-001"]);
    // The error is reported (but scrubbed) and the bundle still verifies (the gate must not
    // trip on the lab's own error report).
    expect(result.error?.message).toContain("[REDACTED_SECRET]");
    expect(result.error?.message).not.toContain(secretToken);
    expect(result.observer?.ok).toBe(true);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(secretToken);
      expect(text, file).not.toContain(hostPath);
    }
  });

  it("turns a missing @e2b/desktop peer into a structured failure with a complete failed bundle (no raw throw, no orphan dir)", async () => {
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => {
          throw new Error(
            "Live E2B desktop launch requires optional peer dependency @e2b/desktop.",
          );
        },
      },
    ).finally(stderr.stop);
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_FAILED");
    expect(result.error?.message).toContain("@e2b/desktop");
    // The run dir is a complete failed-evidence bundle, not an orphan screenshots/ shell.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const files = await readdir(runDir);
    expect(files).toContain("run.json");
    expect(files).toContain("review.md");
    expect(result.observer?.ok).toBe(true);
    await expectFailureGolden("computer-use/desktop-module-missing", runDir, {
      result,
      stderr: stderr.text(),
      replace: [
        [result.runId, "[run]"],
        [cwd, "[cwd]"],
      ],
    });
  });

  it("writes lab identity into the bundle and a finalized status record on disk", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        lab: { id: "cua-demo", path: "humanish/labs/cua-demo.yaml", origin: "committed" },
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const runId = outcome.result.runId;

    // Durable identity on the evidence-of-record.
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8"),
    ) as {
      lab?: { id: string; path?: string; origin?: string };
      review: { verdict: string };
    };
    expect(bundle.lab).toEqual({
      id: "cua-demo",
      path: "humanish/labs/cua-demo.yaml",
      origin: "committed",
    });

    // And the index/liveness record, finalized from that same bundle, never claiming more.
    const status = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", runId, "status.json"), "utf8"),
    ) as {
      schema: string;
      state: string;
      lab?: { id: string };
      outcome?: { verdict?: string };
      completedAt?: string;
    };
    expect(status.schema).toBe("humanish.run-status.v1");
    expect(status.state).toBe("finished");
    expect(status.lab?.id).toBe("cua-demo");
    expect(status.outcome?.verdict).toBe(bundle.review.verdict);
    expect(typeof status.completedAt).toBe("string");
  });

  it("points .humanish/runs/latest.json at the cua run so `verify --run latest` verifies this run", async () => {
    const outcome = await runStudyWith(cuaConfig(), { cwd, dryRun: true });
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);

    const pointer = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", "latest.json"), "utf8"),
    );
    expect(pointer.schema).toBe("humanish.latest-run.v1");
    expect(pointer.runId).toBe(result.runId);

    const verified = await verifyRun(cwd, "latest");
    expect(verified.ok).toBe(true);
    expect(verified.run).toBe("latest");
    expect(verified.bundlePath).toContain(result.runId);
  });

  it("releases the acquired identity when a preparation hook mutates the handle and fails", async () => {
    const sandbox = makeFakeSandbox();
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        prepareDesktop: async (desktop) => {
          desktop.sandboxId = "unrelated-sandbox";
          throw new Error("synthetic provisioning failure");
        },
      },
      {
        desktopModule: async () => module,
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(killed).toEqual(["fake-sandbox-001"]);
    expect(outcome.result.sandbox).toMatchObject({ sandboxId: "fake-sandbox-001", killed: true });
  });

  it("passes a managed executor to the participant and closes it after the run", async () => {
    const { module } = makeFakeModule(makeFakeSandbox());
    let executor: CuaExecutor | undefined;
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) => {
          executor = options.executor;
          expect(options.desktop).toBeUndefined();
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.sandbox?.killed).toBe(true);
    expect(executor).toBeDefined();
    await expect(executor!.observe()).rejects.toThrow("closed");
  });

  it("records prior sandbox absence without claiming its exact termination time", async () => {
    const { module } = makeFakeModule(makeFakeSandbox());
    module.Sandbox.kill = async () => false;
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        prepareDesktop: async () => {
          throw new Error("synthetic startup failure");
        },
      },
      {
        desktopModule: async () => module,
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.sandbox?.killed).toBe(true);
    expect(outcome.result.warnings).toContainEqual(
      expect.stringContaining("exact termination time is unknown"),
    );
  });

  it("keeps malformed cleanup responses unconfirmed in the run and its cost evidence", async () => {
    const sandbox: FakeSandbox = makeFakeSandbox({
      commandHandler: measuredChromeDesktop(() => sandbox.screen),
    });
    const { module } = makeFakeModule(sandbox);
    module.Sandbox.kill = async () => undefined as unknown as boolean;
    // A stepped clock fixes the sandbox's measured desktop minutes for the failure golden.
    let clock = 0;
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        now: () => (clock += 30_000),
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    ).finally(stderr.stop);
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.sandbox?.killed).toBe(false);
    expect(outcome.result.warnings).toContainEqual(
      expect.stringContaining("release is unconfirmed"),
    );
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.cost.fullyEstimated).toBe(false);
    expect(bundle.cost.breakdown).toContainEqual(
      expect.objectContaining({ reason: "desktop_lifetime_incomplete", estimatedCostUsd: null }),
    );
    // The sandbox may still be running: the run stays ok, and status.json and the bundle say so.
    expect(bundle.providerResources[0]).toMatchObject({
      status: "unknown",
      cleanup: { killed: false, reason: expect.stringContaining("release is unconfirmed") },
    });
    const status = JSON.parse(
      await readFile(
        path.join(cwd, ".humanish", "runs", outcome.result.runId, "status.json"),
        "utf8",
      ),
    );
    expect(status.outcome).toMatchObject({
      ok: true,
      execution: { succeeded: true, failures: [] },
    });
    expect(status.outcome.execution.warnings).toEqual([
      {
        kind: "sandbox-cleanup",
        message: expect.stringMatching(
          new RegExp(
            `^lane-01: .*release is unconfirmed.*humanish reclaim --run ${outcome.result.runId}`,
          ),
        ),
      },
    ]);
    await expectFailureGolden(
      "computer-use/cleanup-unconfirmed",
      path.join(cwd, ".humanish", "runs", outcome.result.runId),
      {
        result: outcome.result,
        stderr: stderr.text(),
        replace: [
          [outcome.result.runId, "[run]"],
          [cwd, "[cwd]"],
        ],
      },
    );
  });

  it("reports killed=false (with a warning) when the installed SDK lacks Sandbox.kill", async () => {
    const sandbox = makeFakeSandbox();
    const module: E2BDesktopModule = {
      Sandbox: { create: async () => sandbox },
    };
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.sandbox?.killed).toBe(false);
    expect(outcome.result.warnings.some((warning) => warning.includes("Sandbox.kill"))).toBe(true);
  });

  it("clone route: clones, installs, builds, serves, probes, and drives the subject, with provenance and zero value leaks", async () => {
    const config = cloneCuaConfig({ env: ["DATABASE_URL"] });
    const cloneHead = "8758a953415e1f60091d";
    const servedHead = "859043fc8dec448d2ac3";
    let revParseCount = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (!command.includes("rev-parse")) return undefined;
        revParseCount += 1;
        return { stdout: `${revParseCount === 1 ? cloneHead : servedHead}\n` };
      }),
    });
    const { module, created, killed } = makeFakeModule(sandbox);

    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: {
          OPENAI_API_KEY: "test-openai-key",
          E2B_API_KEY: "test-e2b-key",
          DATABASE_URL: "postgres-secret-value",
          HUMANISH_E2B_REQUEST_TIMEOUT_MS: "45000",
        },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.session?.status).toBe("passed");
    expect(result.appUrl).toBe("http://127.0.0.1:3000/");

    // Env placement: exactly the declared subject names, never the actor keys.
    expect(created[0]?.envs).toEqual({ DATABASE_URL: "postgres-secret-value" });
    // The operator's E2B request timeout reaches the desktop create.
    expect(created[0]?.requestTimeoutMs).toBe(45_000);

    // Provisioning sequence: the wrapper scripts carry the declared commands.
    const scriptFor = (name: string): string => {
      const entry = sandbox.calls.find(
        (call): call is [string, string, string] =>
          call[0] === "files.write" && String(call[1]).endsWith(`${name}/run.sh`),
      );
      if (!entry) throw new Error(`missing script for ${name}`);
      return entry[2];
    };
    expect(scriptFor("subject-clone")).toContain(
      "git clone --depth 2 https://github.com/example-org/example-app.git",
    );
    expect(scriptFor("subject-install")).toContain("( pnpm install --frozen-lockfile )");
    expect(scriptFor("subject-install")).toContain("cd '/home/user/subject'");
    expect(scriptFor("subject-build")).toContain("( pnpm build )");
    expect(scriptFor("subject-start")).toContain("( pnpm start )");

    // Readiness was probed before the browser opened on the served URL.
    const probeIndex = sandbox.calls.findIndex(
      (call) => call[0] === "commands.run" && String(call[1]).includes("curl"),
    );
    const openIndex = expectSafeBrowserOpen(sandbox.calls, "http://127.0.0.1:3000/");
    expect(probeIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeGreaterThan(probeIndex);

    // The model's click actuated the real executor against the served subject.
    expect(sandbox.calls).toContainEqual(["leftClick", 11, 22]);
    expect(killed).toEqual(["fake-sandbox-001"]);

    // Provenance: repo + commit + env names, on the result and in evidence.
    // No subject.state declared → the state story is explicitly "undeclared", never silent.
    expect(result.subject).toEqual({
      source: "clone",
      repo: "example-org/example-app",
      commit: servedHead,
      envNames: ["DATABASE_URL"],
      state: { provenance: "undeclared" },
    });
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(revParseCount).toBeGreaterThan(1);
    expect(bundle.subject.commit).toBe(servedHead);
    expect(JSON.stringify(bundle.subject)).not.toContain(cloneHead);
    const provenance = bundle.events.find(
      (event: { type: string }) => event.type === "cua-lab.subject.provenance",
    );
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

  it("clone route: the injected phase sink and onEvent both receive the ordered started/completed sequence for clone/install/build/ready", async () => {
    const config = cloneCuaConfig();
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);
    const phaseEvents: SubjectPhaseEvent[] = [];
    const phaseCtxs: Array<{ id: string; index: number; count: number }> = [];
    const emitted: StudyEvent[] = [];

    const outcome = await runStudyWith(
      config,
      {
        cwd,
        onEvent: (event) => {
          if (event.type === "subject-phase") emitted.push(event);
        },
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      // The default sink is process.stderr.write. The subjectPhaseSink seam replaces it so the
      // ordering below is captured deterministically instead of scraping stderr. onEvent observes
      // the same phases beside the sink, so they stay on stderr when a caller sets it.
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),

        subjectPhaseSink: (event, ctx) => {
          phaseEvents.push(event);
          phaseCtxs.push(ctx!);
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    // One event per boundary, never per poll tick: exactly clone/install/build (started+completed),
    // the lone fire-and-forget serve.started, then ready (started+completed). No subject.state
    // events: cloneCuaConfig() declares no seed steps.
    expect(phaseEvents.map((event) => event.type)).toEqual([
      "cua-lab.subject.clone.started",
      "cua-lab.subject.clone.completed",
      "cua-lab.subject.runtime.started",
      "cua-lab.subject.runtime.completed",
      "cua-lab.subject.install.started",
      "cua-lab.subject.install.completed",
      "cua-lab.subject.build.started",
      "cua-lab.subject.build.completed",
      "cua-lab.subject.serve.started",
      "cua-lab.subject.ready.started",
      "cua-lab.subject.ready.completed",
    ]);
    expect(emitted).toEqual(
      phaseEvents.map((event) =>
        phaseEvent(event, {
          kind: "participant",
          participant: { id: "lane-01", index: 0, count: 1 },
        }),
      ),
    );

    // Started events (including the lone serve.started) carry neither ok nor durationMs;
    // every completed event on this all-succeeding fake run carries both.
    for (const event of phaseEvents) {
      if (event.type.endsWith(".started")) {
        expect(event.ok).toBeUndefined();
        expect(event.durationMs).toBeUndefined();
      } else {
        expect(event.ok).toBe(true);
        expect(typeof event.durationMs).toBe("number");
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
      }
    }

    // Messages are public-safe by construction: no URLs, no paths, no command text.
    for (const event of phaseEvents) {
      expect(event.message).not.toContain("http://");
      expect(event.message).not.toContain("https://");
      expect(event.message).not.toContain("/home/user");
      expect(event.message).not.toContain("pnpm");
    }

    // One participant: every sink call names lane-01 with count 1 (no fan-out prefixing).
    for (const ctx of phaseCtxs) {
      expect(ctx).toEqual({ id: "lane-01", index: 0, count: 1 });
    }
  });

  it("clone route: the completed phase trail persists into bundle.events with durationMs folded into each message", async () => {
    const config = cloneCuaConfig();
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);

    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const phaseRunEvents = (
      bundle.events as Array<{ type: string; level: string; message: string }>
    ).filter(
      (event) => event.type.startsWith("cua-lab.subject.") && event.type.endsWith(".completed"),
    );
    // Only completed phases persist (started events carry no durationMs, so nothing to fold);
    // subject.serve.started never persists here either (no completed pair, no durationMs).
    expect(phaseRunEvents.map((event) => event.type)).toEqual([
      "cua-lab.subject.clone.completed",
      "cua-lab.subject.runtime.completed",
      "cua-lab.subject.install.completed",
      "cua-lab.subject.build.completed",
      "cua-lab.subject.ready.completed",
    ]);
    for (const event of phaseRunEvents) {
      expect(event.level).toBe("info");
      expect(event.message).toMatch(/\(\d+ms\)$/);
    }

    const verified = await verifyRun(cwd, outcome.result.runId);
    expect(verified.ok).toBe(true);
  });

  it("clone route with GITHUB_TOKEN: the clone authenticates via in-sandbox env; the token value never appears in any script or artifact", async () => {
    const config = cloneCuaConfig({ env: ["GITHUB_TOKEN"] });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created } = makeFakeModule(sandbox);

    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", GITHUB_TOKEN: "ghp-token-value" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    // The token is provisioned as sandbox env…
    expect(created[0]?.envs).toEqual({ GITHUB_TOKEN: "ghp-token-value" });
    // …and the clone script references the variable, never the value, never a token-in-URL.
    const cloneScript = sandbox.calls.find(
      (call): call is [string, string, string] =>
        call[0] === "files.write" && String(call[1]).endsWith("subject-clone/run.sh"),
    );
    expect(cloneScript?.[2]).toContain("$GITHUB_TOKEN");
    expect(cloneScript?.[2]).toContain("http.extraHeader");
    expect(cloneScript?.[2]).not.toContain("ghp-token-value");
    expect(cloneScript?.[2]).not.toMatch(/https:\/\/[^@\s]+@github\.com/);

    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("ghp-token-value");
    }
  });

  it("fails closed before any sandbox exists when a declared subject env name is missing", async () => {
    const config = cloneCuaConfig({ env: ["DATABASE_URL"] });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_ENV_MISSING");
    expect(outcome.result.error?.message).toContain("DATABASE_URL");
    expect(created).toHaveLength(0);
  });

  it("retries a subject install that exits non-zero exactly once, and the phase stream says so", async () => {
    // A transient registry/TLS error inside the sandbox's npm install cost a cold adopter their
    // whole first live study; the parallel install twenty seconds later passed. First attempt
    // exits 1, the retry (its own step dir, so both logs survive) exits 0.
    const config = cloneCuaConfig();
    const statusReads: string[] = [];
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-install") && command.includes("/status")) {
          statusReads.push(command.includes("subject-install-retry") ? "retry" : "first");
          return { stdout: command.includes("subject-install-retry") ? "0" : "1" };
        }
        if (command.includes("subject-install") && command.includes("tail -c")) {
          return { stdout: "npm error code ERR_SSL_CIPHER_OPERATION_FAILED" };
        }
        return undefined;
      }),
    });
    const { module } = makeFakeModule(sandbox);
    const phaseEvents: Array<{ type: string; ok?: boolean; message: string }> = [];
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),

        subjectPhaseSink: (event) => {
          phaseEvents.push(event);
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(statusReads).toEqual(["first", "retry"]);
    const installPhases = phaseEvents.filter((event) => event.type.includes(".install"));
    expect(installPhases.map((event) => event.type)).toEqual([
      "cua-lab.subject.install.started",
      "cua-lab.subject.install-retry.started",
      "cua-lab.subject.install-retry.completed",
      "cua-lab.subject.install.completed",
    ]);
    expect(installPhases[1]?.message).toContain("first attempt exited 1; retrying once");
    expect(installPhases[2]?.ok).toBe(true);
    expect(installPhases[3]?.ok).toBe(true);
    expect(installPhases[3]?.message).toBe(
      "subject dependencies installed (on the second attempt)",
    );
  });

  it("a subject install that fails twice reports one actionable line before npm's own output", async () => {
    const config = cloneCuaConfig();
    let attempts = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-install") && command.includes("/status")) {
          attempts += 1;
          return { stdout: "1" };
        }
        if (command.includes("subject-install") && command.includes("tail -c")) {
          return {
            stdout:
              "npm error code ERR_SSL_CIPHER_OPERATION_FAILED\nnpm error ossl_gcm_stream_update",
          };
        }
        return undefined;
      }),
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);
    expect(attempts).toBe(2);
    expect(killed).toEqual(["fake-sandbox-001"]);
    const message = outcome.result.error?.message ?? "";
    expect(
      message.indexOf(
        "subject install failed twice (exit 1, then exit 1); the sandbox could not complete serve.install",
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(message.indexOf("subject install failed twice")).toBeLessThan(
      message.indexOf("ERR_SSL_CIPHER_OPERATION_FAILED"),
    );
  });

  it("scrubs provisioned values (no secret shape) from every artifact and the result when a serve step echoes them", async () => {
    // The P0 class: an app dumps its config on boot failure. The value is arbitrary; no
    // pattern can catch it; only literal scrubbing of known provisioned values can.
    const plainValue = "plain-text-pw-" + "12345678";
    const config = cloneCuaConfig({ env: ["DATABASE_PASSWORD"] });
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        // Both attempts fail (an exit-code failure is retried once under `subject-install-retry`).
        if (command.includes("subject-install") && command.includes("/status"))
          return { stdout: "1" };
        if (command.includes("subject-install") && command.includes("tail -c")) {
          return { stdout: `boot dump: DATABASE_PASSWORD=${plainValue} (config echo)` };
        }
        return undefined;
      }),
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", DATABASE_PASSWORD: plainValue },
      },
      {
        desktopModule: async () => module,
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(killed).toEqual(["fake-sandbox-001"]);
    // The error is still diagnosable (the log tail rides along) but the value is gone,
    // replaced by the scrub marker, on the result and in every persisted artifact.
    expect(result.error?.message).toContain("subject install failed");
    expect(result.error?.message).toContain("[REDACTED_SECRET]");
    expect(result.error?.message).not.toContain(plainValue);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(plainValue);
    }
    // And the bundle still verifies: the gate must not trip on the scrubbed error report.
    expect(result.observer?.ok).toBe(true);
  });

  it("pattern-redacts a secret-shaped token in a log tail before truncation can slice through it", async () => {
    // A distinct, properly-bounded token (not a known provisioned value: only pattern
    // redaction can catch it). It sits at the front of the log with ~2000 chars after it, so
    // the last-2000 truncation cuts through the token. Truncate-then-redact would leave a
    // prefix-less fragment that no longer matches `\bghp_…`; redact-then-truncate erases it.
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"; // 44 chars, matches whole
    const midChunk = token.slice(26, 44); // 18 distinct chars, all after the cut at 22: truncate-first would expose this
    const log = token + " " + "z".repeat(1977); // total 2022; cut lands inside the token
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("curl")) return { stdout: "WAIT" };
        if (command.includes("subject-start") && command.includes("tail -c"))
          return { stdout: log };
        return undefined;
      }),
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cloneCuaConfig({ readyTimeoutMs: 5000 }),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, `${file} full token`).not.toContain(token);
      expect(text, `${file} token fragment`).not.toContain(midChunk);
    }
    expect(result.observer?.ok).toBe(true);
  });

  it("provenance wording matches each phase: dry-run declares, failed provisioning never claims 'served'", async () => {
    // Dry-run: nothing cloned; the event must say so.
    const dry = await runStudyWith(cloneCuaConfig(), { cwd, dryRun: true });
    if (dry.route !== "computer-use") throw new Error("expected cua backend");
    const dryBundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", dry.result.runId, "run.json"), "utf8"),
    );
    const dryProvenance = dryBundle.events.find(
      (event: { type: string }) => event.type === "cua-lab.subject.provenance",
    );
    expect(dryProvenance?.message).toContain("dry run; nothing cloned");
    expect(dryProvenance?.message).not.toContain("Subject cloned from");

    // Probe failure: cloned at a real commit, but serving never completed; say exactly that.
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) =>
        command.includes("curl") ? { stdout: "WAIT" } : undefined,
      ),
    });
    const { module } = makeFakeModule(sandbox);
    let t = 0;
    const failed = await runStudyWith(
      cloneCuaConfig({ readyTimeoutMs: 5000 }),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      },
    );
    if (failed.route !== "computer-use") throw new Error("expected cua backend");
    const failedBundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", failed.result.runId, "run.json"), "utf8"),
    );
    const failedProvenance = failedBundle.events.find(
      (event: { type: string }) => event.type === "cua-lab.subject.provenance",
    );
    expect(failedProvenance?.message).toContain("did not complete");
    expect(failedProvenance?.message).not.toContain("and served at");
  });

  it("redacts the repo slug in provenance by default for token-authenticated clones (policies.redactRepos overrides)", async () => {
    // Token present, no explicit policy → redacted by default.
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);
    const tokenEnv = { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", GITHUB_TOKEN: "ghp-token-value" };
    const tokenDeps: StudyDeps = {
      desktopModule: async () => module,
      runSession: async (options) =>
        runCuaActorSession({
          ...options,
          openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
        }),
    };
    const redacted = await runStudyWith(
      cloneCuaConfig({ env: ["GITHUB_TOKEN"] }),
      { cwd, env: tokenEnv },
      tokenDeps,
    );
    if (redacted.route !== "computer-use") throw new Error("expected cua backend");
    expect(redacted.result.subject?.repo).toBe("repo-01");
    const runDir = path.join(cwd, ".humanish", "runs", redacted.result.runId);
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("example-org/example-app");
    }

    // Explicit policies.redactRepos: false wins over the token default.
    const explicit = cloneCuaConfig({ env: ["GITHUB_TOKEN"] });
    const explicitConfig: StudyConfig = { ...explicit, policies: { redactRepos: false } };
    const sandbox2 = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module: module2 } = makeFakeModule(sandbox2);
    const unredacted = await runStudyWith(
      explicitConfig,
      { cwd, env: tokenEnv },
      { ...tokenDeps, desktopModule: async () => module2 },
    );
    if (unredacted.route !== "computer-use") throw new Error("expected cua backend");
    expect(unredacted.result.subject?.repo).toBe("example-org/example-app");
  });

  it("re-enforces the clone-route structure at the engine (tampered config without serve)", async () => {
    const config = cloneCuaConfig();
    const { serve: _serve, ...subjectWithoutServe } = config.subject;
    const tampered: StudyConfig = { ...config, subject: subjectWithoutServe };
    const result = await runCuaActorStudy({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_INVALID");
  });

  it("persists a failed-evidence bundle (with the server log tail) when the subject never answers the probe", async () => {
    const config = cloneCuaConfig({ readyTimeoutMs: 5000 });
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("curl")) return { stdout: "WAIT" };
        if (command.includes("tail -c")) return { stdout: "server crashed at boot" };
        return undefined;
      }),
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_FAILED");
    expect(result.error?.message).toContain("did not answer");
    expect(result.error?.message).toContain("server crashed at boot");
    expect(killed).toEqual(["fake-sandbox-001"]);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.simulations[0].status).toBe("failed");
  });
});

describe("execution.desktop.template (custom E2B desktop image, single-participant computer-use route)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-template-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function templatedConfig(template?: string): StudyConfig {
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-template-proof",
      title: "CUA template proof",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Explore the app and stop.",
        },
      ],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { resolution: [1280, 800], ...(template === undefined ? {} : { template }) },
      },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  async function runWith(config: StudyConfig) {
    const sandbox = makeFakeSandbox();
    const { module, created, templates } = makeFakeModule(sandbox);
    const deps: StudyDeps = {
      desktopModule: async () => module,
      runSession: async (options) =>
        runCuaActorSession({
          ...options,
          openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
        }),
    };
    const outcome = await runStudyWith(
      config,
      { cwd, env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" } },
      deps,
    );
    if (outcome.route !== "computer-use") throw new Error("expected the cua backend");
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    return { created, templates, bundle };
  }

  it("threads the template into Sandbox.create(template, opts) and records it in the bundle (provenance)", async () => {
    const { created, templates, bundle } = await runWith(
      templatedConfig("acme-desktop-with-runtimes"),
    );
    expect(created).toHaveLength(1);
    // The desktop create received the configured template as its first (template) argument.
    expect(templates).toEqual(["acme-desktop-with-runtimes"]);
    // The options object is otherwise unchanged: the template is an added selector, not a rewrite.
    expect(created[0]?.resolution).toEqual([1280, 800]);
    expect(created[0]?.lifecycle).toEqual({ onTimeout: "kill" });
    // Evidence shows which image ran (public-safe: a template name is not a secret).
    expect(bundle.desktopTemplate).toBe("acme-desktop-with-runtimes");
  });

  it("byte-stable default: no template → Sandbox.create called with no template arg, bundle omits desktopTemplate", async () => {
    const { created, templates, bundle } = await runWith(templatedConfig());
    expect(created).toHaveLength(1);
    // undefined == create(opts): the historical single-argument call shape, unchanged.
    expect(templates).toEqual([undefined]);
    expect(bundle.desktopTemplate).toBeUndefined();
    expect("desktopTemplate" in bundle).toBe(false);
  });
});

describe("Chrome DevTools readiness after launch", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-devtools-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function chromeConfig(device: "mobile" | "desktop"): StudyConfig {
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-devtools-readiness",
      title: "DevTools readiness",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Explore the app and stop.",
        },
      ],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: {
          device,
          browser: "chrome",
          ...(device === "mobile" ? { fidelity: { mobileEmulation: true } } : {}),
        },
      },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  /** Runs one participant whose launch command printed `markers` after the usual identity lines. */
  async function runWithLaunch(config: StudyConfig, markers: string) {
    const sandbox = makeFakeSandbox({
      commandHandler: (command) =>
        command.includes("browser_preference='chrome'")
          ? {
              exitCode: 0,
              stdout: `HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\n${markers}`,
            }
          : undefined,
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
        subjectPhaseSink: () => undefined,
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected the cua backend");
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    const phase = bundle.events.find(
      (event) => event.type === "cua-lab.browser.devtools.completed",
    );
    return { sandbox, result: outcome.result, bundle, phase };
  }

  it("fails an emulated participant closed when Chrome exited before DevTools answered, before any holder starts", async () => {
    const { sandbox, result, bundle, phase } = await runWithLaunch(
      chromeConfig("mobile"),
      "HUMANISH_BROWSER_CDP_NOT_READY=exited\nHUMANISH_BROWSER_CDP_WAITED_MS=900\nHUMANISH_BROWSER_LOG_TAIL=[1:1:ERROR] Missing X server or $DISPLAY\n",
    );
    expect(result.ok).toBe(false);
    expect(bundle.review.summary).toContain(
      "mobile emulation could not be applied: Chrome exited 900 ms after launch, before DevTools answered on 127.0.0.1:9222 (browser log: [1:1:ERROR] Missing X server or $DISPLAY)",
    );
    const holderStarted = sandbox.calls.some(
      (call) => call[0] === "files.write" && String(call[1]).includes("mobile-emulation-"),
    );
    expect(holderStarted).toBe(false);
    expect(phase).toMatchObject({
      level: "warn",
      message: "Chrome DevTools did not answer on 127.0.0.1:9222 (900ms)",
    });
  });

  it("keeps a participant without emulation running, with a warning, when DevTools never answered", async () => {
    const { result, phase } = await runWithLaunch(
      chromeConfig("desktop"),
      "HUMANISH_BROWSER_CDP_NOT_READY=timeout\nHUMANISH_BROWSER_CDP_WAITED_MS=30000\nHUMANISH_BROWSER_LOG_TAIL=\n",
    );
    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.stringContaining(
        "Chrome DevTools did not answer on 127.0.0.1:9222 within 30000 ms of launch while the browser process was still running (the browser log was empty).",
      ),
    );
    expect(phase).toMatchObject({ level: "warn" });
  });

  it("records the DevTools wait as a timed phase, and warns only past 10 s", async () => {
    const slow = await runWithLaunch(
      chromeConfig("desktop"),
      "HUMANISH_BROWSER_CDP_READY_MS=12000\n",
    );
    expect(slow.phase).toMatchObject({
      level: "info",
      message: "Chrome DevTools answered on 127.0.0.1:9222 (12000ms)",
    });
    expect(slow.result.warnings).toContainEqual(
      expect.stringContaining("answered 12000 ms after launch; the browser started slowly"),
    );
    const quick = await runWithLaunch(
      chromeConfig("desktop"),
      "HUMANISH_BROWSER_CDP_READY_MS=7700\n",
    );
    expect(quick.phase).toMatchObject({ level: "info" });
    expect(quick.result.warnings.join("\n")).not.toContain("started slowly");
  });
});

describe("subject.state (seed/migrate/fixtures on the clone route)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-state-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const sha16 = (command: string): string =>
    createHash("sha256").update(command).digest("hex").slice(0, 16);

  const THREE_PHASE_STATE = {
    seed: [
      {
        name: "prebuild",
        command: "node scripts/prebuild-fixtures.js",
        when: "before-build",
        timeoutMs: 300_000,
      },
      {
        name: "db-up",
        command: "sudo service postgresql start && pg_isready -t 30",
        timeoutMs: 120_000,
      },
      {
        name: "admin-user",
        command: "curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin",
        when: "after-ready",
        timeoutMs: 60_000,
      },
    ],
  };

  it("runs seed steps in their declared phases with exact commands, records seeded provenance with digests, and grows the sandbox deadline", async () => {
    const config = cloneCuaConfig({ state: THREE_PHASE_STATE });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created, killed } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        // Fixed clock so per-step durationMs is deterministic (0) in the record assertions.
        detachedTimers: { now: () => 0, sleep: async () => {} },
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);
    expect(killed).toEqual(["fake-sandbox-001"]);

    // Each step runs through the detached primitive under the reserved prefix, with the
    // exact declared command and cwd inside the subject checkout.
    const writeIndexFor = (name: string): number =>
      sandbox.calls.findIndex(
        (call) => call[0] === "files.write" && String(call[1]).endsWith(`${name}/run.sh`),
      );
    const scriptFor = (name: string): string => {
      const entry = sandbox.calls.find(
        (call): call is [string, string, string] =>
          call[0] === "files.write" && String(call[1]).endsWith(`${name}/run.sh`),
      );
      if (!entry) throw new Error(`missing script for ${name}`);
      return entry[2];
    };
    expect(scriptFor("subject-state-db-up")).toContain(
      "( sudo service postgresql start && pg_isready -t 30 )",
    );
    expect(scriptFor("subject-state-db-up")).toContain("cd '/home/user/subject'");
    expect(scriptFor("subject-state-admin-user")).toContain("bootstrap-admin");

    // Phase ordering from the recorded call sequence: install → before-build → build →
    // before-start → start → readiness probe → after-ready → browser open.
    const probeIndex = sandbox.calls.findIndex(
      (call) => call[0] === "commands.run" && String(call[1]).includes("curl -sf -o /dev/null"),
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
      60_000 + // execution.timeoutMs
        30 * 60_000 + // SUBJECT_PROVISION_BUDGET_MS
        (300_000 + 120_000 + 60_000) + // Σ step.timeoutMs
        10 * 60_000, // SANDBOX_TIMEOUT_BUFFER_MS
    );

    // Provenance: marker seeded, per-step records with sha256-16 digests of the exact
    // commands, and never the command text itself.
    const expectedSeed = [
      {
        name: "prebuild",
        when: "before-build",
        commandDigest: sha16("node scripts/prebuild-fixtures.js"),
        ok: true,
        exitCode: 0,
        durationMs: 0,
      },
      {
        name: "db-up",
        when: "before-start",
        commandDigest: sha16("sudo service postgresql start && pg_isready -t 30"),
        ok: true,
        exitCode: 0,
        durationMs: 0,
      },
      {
        name: "admin-user",
        when: "after-ready",
        commandDigest: sha16("curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin"),
        ok: true,
        exitCode: 0,
        durationMs: 0,
      },
    ];
    expect(result.subject?.state).toEqual({ provenance: "seeded", seed: expectedSeed });

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.subject).toEqual({
      source: "clone",
      repo: "example-org/example-app",
      commit: "abc123def4567890abc1",
      envNames: [],
      state: { provenance: "seeded", seed: expectedSeed },
    });
    const provenance = bundle.events.find(
      (event: { type: string }) => event.type === "cua-lab.subject.provenance",
    );
    expect(provenance?.message).toContain("state: seeded (3 steps: prebuild, db-up, admin-user)");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toContain("state: seeded");
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("pg_isready"); // digests only, never command text
      expect(text, file).not.toContain("prebuild-fixtures.js");
    }

    // The independent verifier accepts the seeded claim against its evidence.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(
      true,
    );
    // No undeclared-state nudge: the state story is declared.
    expect(verified.warnings.some((w) => w.includes("no state is declared"))).toBe(false);
  });

  it("fails closed on a mid-sequence step failure: partial provenance, no actor session, scrubbed tail, failed bundle that still verifies", async () => {
    const plainValue = "plain-state-pw-" + "87654321";
    const config = cloneCuaConfig({
      env: ["DATABASE_PASSWORD"],
      state: {
        seed: [
          { name: "db-up", command: "start the db" },
          { name: "db-migrate", command: "run migrations" },
          { name: "fixtures", command: "load fixtures" },
        ],
      },
    });
    let sessionStarted = false;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-state-db-migrate/status")) return { stdout: "1" };
        if (command.includes("subject-state-db-migrate") && command.includes("tail -c")) {
          return { stdout: `migration blew up: DATABASE_PASSWORD=${plainValue}` };
        }
        return undefined;
      }),
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", DATABASE_PASSWORD: plainValue },
      },
      {
        desktopModule: async () => module,
        detachedTimers: { now: () => 0, sleep: async () => {} },
        runSession: async () => {
          sessionStarted = true;
          throw new Error("session must never start after a failed state step");
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(sessionStarted).toBe(false);
    expect(killed).toEqual(["fake-sandbox-001"]);
    expect(result.error?.message).toContain('subject state step "db-migrate" failed (exit 1)');
    expect(result.error?.message).toContain("[REDACTED_SECRET]");
    expect(result.error?.message).not.toContain(plainValue);

    // Partial state provenance: the succeeded step ok:true, the failing step ok:false with
    // its exit code, the unreached step absent, and the marker stays declared-not-run.
    expect(result.subject?.state.provenance).toBe("declared-not-run");
    expect(result.subject?.state.seed).toEqual([
      {
        name: "db-up",
        when: "before-start",
        commandDigest: sha16("start the db"),
        ok: true,
        exitCode: 0,
        durationMs: 0,
      },
      {
        name: "db-migrate",
        when: "before-start",
        commandDigest: sha16("run migrations"),
        ok: false,
        exitCode: 1,
        durationMs: 0,
      },
    ]);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
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

    // A failed bundle with partial provenance still verifies its state claim
    // (verdict is fail, so the passed-live-with-failed-step rule does not trip).
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(
      true,
    );
  });

  it("times out a hung state step (kill + timedOut record) and honors clone.keep on that failure", async () => {
    const config = cloneCuaConfig({
      keep: true,
      state: { seed: [{ name: "slow", command: "sleep forever", timeoutMs: 5_000 }] },
    });
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-state-slow/status")) return { stdout: "" };
        if (command.includes("subject-state-slow") && command.includes("tail -c"))
          return { stdout: "still sleeping" };
        return undefined;
      }),
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('subject state step "slow" timed out after 5000ms');
    expect(result.subject?.state.seed?.[0]).toMatchObject({
      name: "slow",
      ok: false,
      timedOut: true,
    });
    // keep-on-failure applies to state failures exactly as to serve failures.
    expect(killed).toEqual([]);
    expect(result.warnings.some((w) => w.includes("kept for debugging"))).toBe(true);
  });

  it("dry-run records the declared recipe as declared-not-run: digests and phases only, no execution fields, event wording says not run", async () => {
    const outcome = await runStudyWith(cloneCuaConfig({ state: THREE_PHASE_STATE }), {
      cwd,
      dryRun: true,
    });
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);

    expect(result.subject?.state).toEqual({
      provenance: "declared-not-run",
      seed: [
        {
          name: "prebuild",
          when: "before-build",
          commandDigest: sha16("node scripts/prebuild-fixtures.js"),
        },
        {
          name: "db-up",
          when: "before-start",
          commandDigest: sha16("sudo service postgresql start && pg_isready -t 30"),
        },
        {
          name: "admin-user",
          when: "after-ready",
          commandDigest: sha16("curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin"),
        },
      ],
    });

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.subject.state.provenance).toBe("declared-not-run");
    expect(
      bundle.subject.state.seed.every((record: Record<string, unknown>) => !("ok" in record)),
    ).toBe(true);
    const provenance = bundle.events.find(
      (event: { type: string }) => event.type === "cua-lab.subject.provenance",
    );
    expect(provenance?.message).toContain("state: declared, not run (dry run)");

    // The contract bundle verifies: declared-not-run is the dry-run marker.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(
      true,
    );
  });

  it("declared external state records unpinned provenance (seed digests still attached when both are declared)", async () => {
    const config = cloneCuaConfig({
      env: ["DATABASE_URL"],
      state: {
        seed: [{ name: "db-migrate", command: "run migrations" }],
        external: ["DATABASE_URL"],
      },
    });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", DATABASE_URL: "postgres-external-value" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);

    // Migrating an external DB is still unpinned overall: marker unpinned, digests attached.
    expect(result.subject?.state.provenance).toBe("unpinned");
    expect(result.subject?.state.externalEnvNames).toEqual(["DATABASE_URL"]);
    expect(result.subject?.state.seed?.[0]).toMatchObject({ name: "db-migrate", ok: true });

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const provenance = bundle.events.find(
      (event: { type: string }) => event.type === "cua-lab.subject.provenance",
    );
    expect(provenance?.message).toContain("state: unpinned (external: DATABASE_URL)");
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("postgres-external-value");
    }
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(
      true,
    );
  });

  it("app-url bundles carry the uniform subject block: source app-url, state undeclared", async () => {
    const outcome = await runStudyWith(cuaConfig(), { cwd, dryRun: true });
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.subject).toEqual({ source: "app-url", state: { provenance: "undeclared" } });
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.subject).toEqual({ source: "app-url", state: { provenance: "undeclared" } });
  });

  it("re-enforces the state declaration at the engine for configs that bypass the parser", async () => {
    const base = cloneCuaConfig();
    const tamper = (state: unknown): StudyConfig =>
      ({ ...base, subject: { ...base.subject, state } }) as StudyConfig;

    // Bad step name (interpolates into in-sandbox paths: must fail closed).
    const badName = await runCuaActorStudy({
      cwd,
      config: tamper({ seed: [{ name: "Bad Name!", command: "true" }] }),
      dryRun: true,
    });
    expect(badName.ok).toBe(false);
    expect(badName.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_INVALID");
    expect(badName.runId).toBe("not-created");

    // Duplicate step names.
    const dupe = await runCuaActorStudy({
      cwd,
      config: tamper({
        seed: [
          { name: "a", command: "true" },
          { name: "a", command: "false" },
        ],
      }),
      dryRun: true,
    });
    expect(dupe.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_INVALID");

    // external must name a provisioned channel (subset of subject.env).
    const unbacked = await runCuaActorStudy({
      cwd,
      config: tamper({ external: ["REDIS_URL"] }),
      dryRun: true,
    });
    expect(unbacked.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_INVALID");

    // state on an app-url subject is rejected, never silently inert.
    const appUrlBase = cuaConfig();
    const appUrlTampered = {
      ...appUrlBase,
      subject: { ...appUrlBase.subject, state: { seed: [{ name: "a", command: "true" }] } },
    } as StudyConfig;
    const onAppUrl = await runCuaActorStudy({ cwd, config: appUrlTampered, dryRun: true });
    expect(onAppUrl.ok).toBe(false);
    expect(onAppUrl.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_INVALID");
    expect(onAppUrl.error?.message).toContain("clone subjects");
  });
});

describe("buildSingleParticipantBundle", () => {
  describe("local-tree route (subject.source: local-tree, computer-use)", () => {
    let cwd: string;
    beforeEach(async () => {
      cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-local-tree-"));
    });
    afterEach(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    function localTreeCuaConfig(extra?: {
      env?: string[];
      state?: unknown;
      count?: number;
      caps?: { maxUsd?: number };
      localTree?: { keep?: boolean; exclude?: string[]; maxArchiveBytes?: number };
    }): StudyConfig {
      const parsed = parseStudy({
        schema: V2_SCHEMA,
        id: "cua-local-tree-proof",
        title: "CUA local-tree proof",
        subject: {
          source: "local-tree",
          serve: {
            install: "pnpm install --frozen-lockfile",
            build: "pnpm build",
            start: "pnpm start",
            url: "http://127.0.0.1:3000/",
          },
          ...(extra?.env ? { env: extra.env } : {}),
          ...(extra?.state === undefined ? {} : { state: extra.state }),
          ...(extra?.localTree === undefined ? {} : { localTree: extra.localTree }),
        },
        actors: [
          {
            type: "openai-computer-use",
            persona: "first-time-visitor",
            mission: "Explore the app and stop.",
            ...(extra?.count === undefined ? {} : { count: extra.count }),
          },
        ],
        execution: {
          target: "e2b-desktop",
          timeoutMs: 60_000,
          ...(extra?.caps ? { caps: extra.caps } : {}),
        },
        scenario: { mode: "live" },
      });
      if (!parsed.ok) throw new Error(parsed.error.message);
      return parsed.config;
    }

    // 64-hex archiveSha256 and a 40-hex commit: shape-valid fixtures, not real digests.
    const FIXED_ARCHIVE: LocalTreeArchive = {
      archivePath: "/unused-in-fake/source.tar.gz",
      archiveSha256: "ab".repeat(32),
      fileCount: 3,
      totalBytes: 42,
      git: { commit: "cd".repeat(20), dirty: true },
    };
    const FAKE_ARCHIVE_BYTES = new TextEncoder().encode("fake-packed-archive-bytes").buffer;

    it("dry-run yields the contract bundle with subject.source local-tree and no archiveSha256", async () => {
      const config = localTreeCuaConfig();
      const outcome = await runStudyWith(config, { cwd, dryRun: true });
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");
      const result = outcome.result;

      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.sandbox).toBeUndefined();
      expect(result.subject).toEqual({
        source: "local-tree",
        envNames: [],
        state: { provenance: "undeclared" },
      });

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
      );
      expect(bundle.subject).toEqual({
        source: "local-tree",
        envNames: [],
        state: { provenance: "undeclared" },
      });
      expect("archiveSha256" in bundle.subject).toBe(false);

      const verified = await verifyRun(cwd, result.runId);
      expect(verified.ok).toBe(true);
    });

    it("live (single participant): the injected phase sink emits the upload/extract phase boundaries, then install/build/ready", async () => {
      const config = localTreeCuaConfig();
      const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
      const { module } = makeFakeModule(sandbox);
      const phaseEvents: Array<{ type: string; ok?: boolean; durationMs?: number }> = [];

      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        },
        {
          desktopModule: async () => module,
          packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
          runSession: async (options) =>
            runCuaActorSession({
              ...options,
              openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
            }),

          subjectPhaseSink: (event) => {
            phaseEvents.push(event);
          },
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");
      expect(outcome.result.ok).toBe(true);

      const types = phaseEvents.map((event) => event.type);
      expect(types).toEqual([
        "cua-lab.subject.upload.started",
        "cua-lab.subject.upload.completed",
        "cua-lab.subject.extract.started",
        "cua-lab.subject.extract.completed",
        "cua-lab.subject.runtime.started",
        "cua-lab.subject.runtime.completed",
        "cua-lab.subject.install.started",
        "cua-lab.subject.install.completed",
        "cua-lab.subject.build.started",
        "cua-lab.subject.build.completed",
        "cua-lab.subject.serve.started",
        "cua-lab.subject.ready.started",
        "cua-lab.subject.ready.completed",
      ]);
      // The local-tree route never runs git: no clone phase on this route, ever.
      expect(types.some((type) => type.includes(".clone."))).toBe(false);
    });

    it("live fan-out (2 participants): packs the working tree once, uploads it per participant, extracts via tar, and carries archive provenance on every participant + the aggregate", async () => {
      const config = localTreeCuaConfig({ count: 2 });
      const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
      const { module, created, killed } = makeFakeModule(sandbox);
      const packCalls: Array<{ root: string; extraExclude?: string[]; maxArchiveBytes?: number }> =
        [];

      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        },
        {
          desktopModule: async () => module,
          packLocalTree: async (args) => {
            packCalls.push(args);
            return { archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES };
          },
          runSession: async (options) =>
            runCuaActorSession({
              ...options,
              openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
            }),
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");
      const result = outcome.result;
      expect(result.ok).toBe(true);
      expect(created.length).toBe(2);

      // Packed exactly once for the whole 2-participant fan-out, rooted at the study's resolution
      // cwd.
      expect(packCalls).toHaveLength(1);
      expect(packCalls[0]?.root).toBe(await realpath(cwd));

      // Every participant uploaded the same archive bytes to the same remote path, octet-stream.
      const uploads = sandbox.calls.filter(
        (call): call is [string, string, ArrayBuffer, { useOctetStream?: boolean } | undefined] =>
          call[0] === "files.write" && call[1] === "/home/user/.humanish-source.tar.gz",
      );
      expect(uploads).toHaveLength(2);
      for (const upload of uploads) {
        expect(upload[2]).toBeInstanceOf(ArrayBuffer);
        expect(upload[2]).toBe(FAKE_ARCHIVE_BYTES);
        expect(upload[3]?.useOctetStream).toBe(true);
      }

      // The extract step ran one command: rm -rf/mkdir -p SUBJECT_DIR, tar -xzf, then rm -f the
      // uploaded archive.
      const extractScript = sandbox.calls.find(
        (call): call is [string, string, string] =>
          call[0] === "files.write" && String(call[1]).endsWith("subject-extract/run.sh"),
      );
      expect(extractScript?.[2]).toContain("rm -rf /home/user/subject");
      expect(extractScript?.[2]).toContain("mkdir -p /home/user/subject");
      expect(extractScript?.[2]).toContain(
        "tar -xzf /home/user/.humanish-source.tar.gz -C /home/user/subject",
      );
      expect(extractScript?.[2]).toContain("rm -f /home/user/.humanish-source.tar.gz");

      // Provenance: aggregate + every participant carry archiveSha256/commit/dirty from the hook
      // result.
      const expectedSubject = {
        source: "local-tree",
        archiveSha256: FIXED_ARCHIVE.archiveSha256,
        commit: FIXED_ARCHIVE.git!.commit,
        dirty: true,
        envNames: [],
        state: { provenance: "undeclared" },
      };
      expect(result.subject).toEqual(expectedSubject);
      expect(result.lanes).toHaveLength(2);
      for (const lane of result.lanes ?? []) {
        expect(lane.subject).toEqual(expectedSubject);
      }

      const runDir = path.join(cwd, ".humanish", "runs", result.runId);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
      expect(bundle.subject).toEqual(expectedSubject);

      expect(killed.length).toBeGreaterThan(0);
    });

    it("live fan-out (2 participants) with maxUsd: warns that maxUsd is a per-participant cap and cites the ~N × cap ceiling", async () => {
      const config = localTreeCuaConfig({ count: 2, caps: { maxUsd: 3 } });
      const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
      const { module } = makeFakeModule(sandbox);

      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        },
        {
          desktopModule: async () => module,
          packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
          runSession: async (options) =>
            runCuaActorSession({
              ...options,
              openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
            }),
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");
      const result = outcome.result;

      const capWarning = result.warnings.find((w) => w.includes("caps each participant"));
      expect(capWarning).toBeDefined();
      // 2 participants × $3 → the true ~$6 ceiling is surfaced, not the per-participant $3, and the
      // warning points at the shared study budget as the fix, since it exists now.
      expect(capWarning).toContain("2 × $3");
      expect(capWarning).toContain("about $6");
      expect(capWarning).toContain("maxTotalUsd");
    });

    it("live fan-out (2 participants): the injected phase sink captures both participants under their own participant id with the total laneCount, and the persisted bundle attributes each participant's phase events to that participant's own simId/streamId", async () => {
      const config = localTreeCuaConfig({ count: 2 });
      const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
      const { module } = makeFakeModule(sandbox);
      const phaseCalls: Array<{
        event: { type: string; ok?: boolean };
        ctx: { id: string; count: number };
      }> = [];

      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        },
        {
          desktopModule: async () => module,
          packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
          runSession: async (options) =>
            runCuaActorSession({
              ...options,
              openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
            }),

          subjectPhaseSink: (event, ctx) => {
            phaseCalls.push({ event, ctx: ctx! });
          },
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");
      expect(outcome.result.ok).toBe(true);

      // (c) count > 1: the default-sink prefix logic (defaultSubjectPhaseSink) reads ctx.count to
      // decide whether to prefix lines with the participant id. Every captured ctx here carries
      // the total fan-out width (2), never a per-participant count.
      expect(phaseCalls.length).toBeGreaterThan(0);
      expect(phaseCalls.every(({ ctx }) => ctx.count === 2)).toBe(true);

      // (a) both participants reported phase events under their own distinct participant id, and
      // each participant's own boundary sequence is the full upload/extract/install/build/ready
      // chain (no participant silently skipped, no cross-participant mixing within a single
      // participant's sequence).
      const participantIds = [...new Set(phaseCalls.map(({ ctx }) => ctx.id))].sort();
      expect(participantIds).toEqual(["lane-01", "lane-02"]);
      const expectedTypes = [
        "cua-lab.subject.upload.started",
        "cua-lab.subject.upload.completed",
        "cua-lab.subject.extract.started",
        "cua-lab.subject.extract.completed",
        "cua-lab.subject.runtime.started",
        "cua-lab.subject.runtime.completed",
        "cua-lab.subject.install.started",
        "cua-lab.subject.install.completed",
        "cua-lab.subject.build.started",
        "cua-lab.subject.build.completed",
        "cua-lab.subject.serve.started",
        "cua-lab.subject.ready.started",
        "cua-lab.subject.ready.completed",
      ];
      for (const participantId of participantIds) {
        const types = phaseCalls
          .filter(({ ctx }) => ctx.id === participantId)
          .map(({ event }) => event.type);
        expect(types).toEqual(expectedTypes);
      }

      // (b) the persisted fan-out bundle attributes each participant's completed phase events to
      // that participant's own simId/streamId (lane-01 -> sim-001/stream-001, lane-02 ->
      // sim-002/stream-002): no cross-participant leakage into the wrong participant's stream.
      const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
      const persistedPhaseEvents = (
        bundle.events as Array<{ id: string; type: string; simId?: string; streamId?: string }>
      ).filter(
        (event) => event.type.startsWith("cua-lab.subject.") && event.type.endsWith(".completed"),
      );
      expect(persistedPhaseEvents.length).toBeGreaterThan(0);
      for (const event of persistedPhaseEvents) {
        if (event.id.includes("lane-01")) {
          expect(event.simId).toBe("sim-001");
          expect(event.streamId).toBe("stream-001");
        } else if (event.id.includes("lane-02")) {
          expect(event.simId).toBe("sim-002");
          expect(event.streamId).toBe("stream-002");
        } else {
          throw new Error(`unexpected phase event id shape: ${event.id}`);
        }
      }
      // Both participants actually persisted (neither participant's phase trail silently
      // swallowed).
      expect(persistedPhaseEvents.some((event) => event.simId === "sim-001")).toBe(true);
      expect(persistedPhaseEvents.some((event) => event.simId === "sim-002")).toBe(true);

      const verified = await verifyRun(cwd, outcome.result.runId);
      expect(verified.ok).toBe(true);
    });

    it("extract failure, throwing CommandExitError shape: fails the participant with a scrubbed tail", async () => {
      const config = localTreeCuaConfig();
      const sandbox = makeFakeSandbox({
        commandHandler: cloneCommandHandler(),
        commandThrow: (command) =>
          command.includes("setsid -f") && command.includes("subject-extract/run.sh")
            ? { exitCode: 2, message: "tar: unexpected end of archive (extract failed)" }
            : undefined,
      });
      const { module, created } = makeFakeModule(sandbox);

      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        },
        {
          desktopModule: async () => module,
          packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
          runSession: async () => {
            throw new Error("runSession must not be reached: extract should fail first");
          },
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");

      expect(outcome.result.ok).toBe(false);
      // The sandbox was created (provisioning is in-sandbox); only packing skips sandbox creation.
      expect(created.length).toBe(1);
      const message =
        outcome.result.lanes?.[0]?.error?.message ?? outcome.result.error?.message ?? "";
      expect(message).toContain("tar: unexpected end of archive");
    });

    it("extract failure, structural fake returning a nonzero exitCode (not throwing): fails the participant with a scrubbed tail", async () => {
      const config = localTreeCuaConfig();
      const sandbox = makeFakeSandbox({
        commandHandler: cloneCommandHandler((command) => {
          if (command.includes("subject-extract/status")) return { stdout: "2" };
          if (command.includes("subject-extract/log.txt"))
            return { stdout: "tar: unexpected end of archive (exit 2)" };
          return undefined;
        }),
      });
      const { module } = makeFakeModule(sandbox);

      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        },
        {
          desktopModule: async () => module,
          packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
          runSession: async () => {
            throw new Error("runSession must not be reached: extract should fail first");
          },
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");

      expect(outcome.result.ok).toBe(false);
      const message =
        outcome.result.lanes?.[0]?.error?.message ?? outcome.result.error?.message ?? "";
      expect(message).toContain("subject extract");
      expect(message).toContain("tar: unexpected end of archive");
    });

    it("failing extract: the injected phase sink receives a completed event with ok false before the participant fails", async () => {
      const config = localTreeCuaConfig();
      const sandbox = makeFakeSandbox({
        commandHandler: cloneCommandHandler((command) => {
          if (command.includes("subject-extract/status")) return { stdout: "2" };
          if (command.includes("subject-extract/log.txt"))
            return { stdout: "tar: unexpected end of archive (exit 2)" };
          return undefined;
        }),
      });
      const { module } = makeFakeModule(sandbox);
      const phaseEvents: Array<{ type: string; ok?: boolean; durationMs?: number }> = [];

      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        },
        {
          desktopModule: async () => module,
          packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
          runSession: async () => {
            throw new Error("runSession must not be reached: extract should fail first");
          },

          subjectPhaseSink: (event) => {
            phaseEvents.push(event);
          },
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");
      expect(outcome.result.ok).toBe(false);

      // Upload succeeded (started+completed ok:true); the failing extract still gets its
      // completed event, with ok false and a real durationMs, before the thrown error unwinds.
      // install/build/ready never ran.
      expect(phaseEvents.map((event) => event.type)).toEqual([
        "cua-lab.subject.upload.started",
        "cua-lab.subject.upload.completed",
        "cua-lab.subject.extract.started",
        "cua-lab.subject.extract.completed",
      ]);
      const extractCompleted = phaseEvents[3];
      expect(extractCompleted?.ok).toBe(false);
      expect(typeof extractCompleted?.durationMs).toBe("number");
      expect(extractCompleted?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("packing failure (hook throws) fails the run closed before any sandbox is created", async () => {
      const config = localTreeCuaConfig();
      const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
      const { module, created } = makeFakeModule(sandbox);

      const analysis = automaticAnalysisBoundary();
      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        },
        {
          analysis: { run: analysis },

          desktopModule: async () => module,
          packLocalTree: async () => {
            // A realistic createLocalTreeArchive-shaped failure: names counts, includes an
            // absolute path the redaction pipeline must scrub before it reaches the result.
            // Built from joined fragments (never a literal /Users/... path in source) so this
            // fixture itself never trips the repo's own public-surface path scan.
            const fakeAbsoluteRoot = ["", "Users", "fake-operator", "project"].join("/");
            throw new Error(
              `Local tree root "${fakeAbsoluteRoot}" produced zero packable entries after the always-on denylist; local-tree packing requires at least one non-denylisted file or symlink.`,
            );
          },
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");

      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_INVALID");
      expect(outcome.result.error?.message).toContain("zero packable entries");
      expect(outcome.result.error?.message).not.toContain(["", "Users", "fake-operator"].join("/"));
      expect(created).toHaveLength(0);
      // Packing runs before the run starts: no run directory, no run id, and a refusal is never
      // analyzed.
      expect(analysis).not.toHaveBeenCalled();
      expect(outcome.result.runId).toBe("not-created");
      expect(await readdir(path.join(cwd, ".humanish", "runs")).catch(() => [])).toEqual([]);
    });

    it("subject.localTree.keep: true preserves the sandbox on a failed participant (mirrors subject.clone.keep)", async () => {
      const config = localTreeCuaConfig({ localTree: { keep: true } });
      const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
      const { module, killed } = makeFakeModule(sandbox);

      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        },
        {
          desktopModule: async () => module,
          packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
          runSession: async () => {
            throw new Error("boom during session");
          },
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");

      expect(outcome.result.ok).toBe(false);
      // Failure + keep -> not killed, with a debug warning naming the flag that caused it.
      expect(killed).toEqual([]);
      expect(outcome.result.sandbox?.killed).toBe(false);
      expect(outcome.result.warnings.some((w) => w.includes("kept for debugging"))).toBe(true);
      expect(outcome.result.warnings.some((w) => w.includes("subject.localTree.keep"))).toBe(true);
    });
  });

  it("dry-run bundle shape: contract verdict, no actor seam, public cwd", () => {
    const bundle = buildSingleParticipantBundle({
      verdict: judgeOneParticipant({ dryRun: true, inProgress: false, participant: undefined })
        .verdict,
      actorId: "openai-computer-use",
      appUrl: "http://127.0.0.1:3000/",
      run: { runId: "cua-test-run", mode: "dry-run", createdAt: "2026-01-01T00:00:00.000Z" },
      dryRun: true,
      labId: "shape-proof",
      mission: "Explore.",
      persona: { id: "p1", traitsApplied: [], promptDigest: "digest" },
      resolution: [1440, 960],
      screenshots: [],
      source: {
        packageName: "humanish",
        humanishSource: "present",
        git: {
          schema: "humanish.git-state.v1",
          capturedAt: "2026-01-01T00:00:00.000Z",
          present: false,
          refState: "unknown",
          note: "test",
        } as never,
      },
    });
    expect(bundle.streams[0]?.actor).toBeUndefined();
    expect(bundle.streams[0]?.embed?.kind).toBe("placeholder");
    expect(bundle.review.verdict).toBe("contract_proof_only");
    expect(bundle.review.gaps.length).toBeGreaterThan(0);
    expect(bundle.cwd).toBe("[target-cwd]");
    expect(bundle.simCount).toBe(1);
    expect(bundle.simulations[0]?.progress).toBe(100);
    // No-session notes: zero frames exist, so no redaction (blur or raw) is claimed.
    expect(bundle.redaction.notes).toContain("No screenshots captured");
    expect(bundle.redaction.notes).not.toContain("blurred fail-closed");
    // Stream artifact references are unique and relative (verifyRun's evidence rules).
    const keys =
      bundle.streams[0]?.artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
    for (const artifact of bundle.streams[0]?.artifacts ?? []) {
      expect(path.isAbsolute(artifact.path)).toBe(false);
    }
  });

  it("keeps sensitive public target URLs out of persisted bundle text while preserving participant metadata", () => {
    const rawUrl = "https://3000-example-sandbox.e2b.app/bootstrap/session";
    const bundle = buildSingleParticipantBundle({
      verdict: "contract_proof_only",
      actorId: "openai-computer-use",
      actorType: "reviewer",
      surface: "inbox",
      caseGroup: "message-flow",
      appUrl: rawUrl,
      run: { runId: "cua-test-run", mode: "dry-run", createdAt: "2026-01-01T00:00:00.000Z" },
      dryRun: true,
      labId: "shape-proof",
      mission: "Explore.",
      persona: { id: "p1", traitsApplied: [], promptDigest: "digest" },
      resolution: [414, 896],
      screenshots: [],
      source: {
        packageName: "humanish",
        humanishSource: "present",
        git: {
          schema: "humanish.git-state.v1",
          capturedAt: "2026-01-01T00:00:00.000Z",
          present: false,
          refState: "unknown",
          note: "test",
        } as never,
      },
    });

    const text = JSON.stringify(bundle);
    expect(text).not.toContain(rawUrl);
    expect(text).not.toContain("e2b.app");
    expect(containsSensitive(text)).toBe(false);
    expect(bundle.streams[0]?.ui?.route).toMatch(/^\[target-url:[a-f0-9]{16}\]$/);
    expect(bundle.streams[0]).toMatchObject({
      actorType: "reviewer",
      surface: "inbox",
      caseGroup: "message-flow",
    });
  });

  it("labels mid-failure frames by capture policy when the session died before a trace existed", () => {
    // A session can throw after frames were already written: no trace exists to testify, so
    // the labels fall back to the capture-time policy the lab actually ran with.
    const base = {
      // No session and a session error: the judge fails the run (judgeOneParticipant).
      verdict: "fail" as const,
      actorId: "openai-computer-use",
      appUrl: "http://127.0.0.1:3000/",
      run: { runId: "cua-test-run", mode: "live" as const, createdAt: "2026-01-01T00:00:00.000Z" },
      dryRun: false,
      labId: "shape-proof",
      mission: "Explore.",
      persona: { id: "p1", traitsApplied: [], promptDigest: "digest" },
      resolution: [1440, 960] as [number, number],
      screenshots: ["screenshots/turn-001.png"],
      sessionError: "provider exploded mid-loop",
      source: {
        packageName: "humanish",
        humanishSource: "present" as const,
        git: {
          schema: "humanish.git-state.v1",
          capturedAt: "2026-01-01T00:00:00.000Z",
          present: false,
          refState: "unknown",
          note: "test",
        } as never,
      },
    };

    const blurred = buildSingleParticipantBundle({ ...base, captureRedaction: "blurred" });
    expect(blurred.simulations[0]?.progress).toBe(100);
    expect(blurred.streams[0]?.embed?.title).toBe("Desktop (blurred)");
    expect(blurred.streams[0]?.artifacts.some((a) => a.label === "screenshot 01 (blurred)")).toBe(
      true,
    );
    expect(blurred.redaction.notes).toContain("capture policy (blurred)");

    const raw = buildSingleParticipantBundle({ ...base, captureRedaction: "raw" });
    expect(raw.streams[0]?.embed?.title).toBe("Desktop (raw)");
    expect(raw.streams[0]?.artifacts.some((a) => a.label === "screenshot 01 (raw)")).toBe(true);
    expect(raw.redaction.notes).toContain("capture policy (raw)");
    expect(JSON.stringify(raw)).not.toContain("(redacted)");

    // Real email restricts publication on a live run only, saved right after the schema.
    const restricted = buildSingleParticipantBundle({ ...base, realEmail: true });
    expect(restricted.publication).toEqual({ restrictions: ["real-communications"] });
    expect(Object.keys(restricted).slice(0, 2)).toEqual(["schema", "publication"]);
    expect(
      "publication" in buildSingleParticipantBundle({ ...base, realEmail: true, dryRun: true }),
    ).toBe(false);
    expect("publication" in raw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The in-process (state-driven, no-E2B) route: a live run with no sandbox, then the boot guards.
// ---------------------------------------------------------------------------

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

// A fake state executor: drives an in-memory app (route advances each action), returns no
// screenshot and a distinct appState per turn so the real loop's friction keys off app state.
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
    },
  };
}

// A fake state "brain": reasons over appState, takes one real action, then stops (so the run
// bumps counts.actions and passes the noEngagement guard), with no requiresFrame.
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
        ? {
            actions: [],
            pendingSafetyChecks: [],
            done: true,
            message: "Reached the goal via getState().",
          }
        : {
            actions: [{ kind: "type", text: "hello" }],
            pendingSafetyChecks: [],
            done: false,
            reasoning: "state looks right",
          };
    },
  };
}

function localAppConfig(appUrl = "http://localhost:5173/"): StudyConfig {
  const parsed = parseStudy({
    schema: V2_SCHEMA,
    id: "downstream-local-app-state",
    title: "State-driven local app",
    subject: { source: "local-app", appUrl },
    actors: [
      {
        type: "openai-computer-use",
        persona: "pixel-pat",
        mission: "Drive the app via its state contract.",
      },
    ],
    scenario: { mode: "live" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("runCuaActorLab in-process (state-driven, no E2B)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-inproc-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // Live mode: a custom executor + provider drive the real loop, a
  // loadDesktopModule whose Sandbox.create pushes to created[]. Assert created.length === 0,
  // result.sandbox === undefined, and the produced bundle passes verifyRun (the hollow-pass net).
  it("drives the real loop with no E2B sandbox created, omits result.sandbox, and the bundle passes verifyRun", async () => {
    const sandbox = makeFakeSandbox();
    const { module, created, killed } = makeFakeModule(sandbox);
    const stateExecutor = makeStateExecutor();

    const outcome = await runStudyWith(
      localAppConfig(),
      {
        cwd,
        inProcess: { executor: async () => stateExecutor },
        createProvider: async () => makeStateProvider(),
      },
      {
        // If anything on this route touched E2B, created[] would grow: this is the proof probe.
        desktopModule: async () => module,
      },
    );

    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;

    // The verifiable "no E2B SDK call" proof: no sandbox was ever created or killed.
    expect(created).toHaveLength(0);
    expect(killed).toHaveLength(0);
    expect(result.sandbox).toBeUndefined();
    expect("streamUrl" in result).toBe(false);

    // The real loop ran: the state executor was actuated by the brain's action.
    expect(stateExecutor.actuated).toContainEqual({ kind: "type", text: "hello" });

    // The lab reached a terminal verdict and the bundle verified.
    expect(result.dryRun).toBe(false);
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(true);
    expect(result.observer?.ok).toBe(true);

    // The trace's provider id is the injected brain's id (no new participant needed); zero
    // screenshots.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.provider).toBe("fake-state-brain");
    expect(bundle.streams[0].actor.lane).toBe("computer-use");
    expect(bundle.streams[0].actor.redaction.screenshots).toBe("n/a");
    expect(bundle.streams[0].actor.counts.screenshots).toBe(0);
    expect(bundle.streams[0].actor.redaction.notes).toContain("App state was read");
    // No screenshots dir contents on disk.
    const shotFiles = await readdir(path.join(runDir, "screenshots")).catch(() => [] as string[]);
    expect(shotFiles).toHaveLength(0);

    // Unpinned provenance: the bundle declares the un-pinnable local app.
    const subjectEvent = bundle.events.find(
      (e: { type: string }) => e.type === "cua-lab.subject.declared",
    );
    expect(subjectEvent.message).toContain("unpinned");
    expect(subjectEvent.message).toContain("no E2B desktop");
    expect(bundle.subject).toEqual({ source: "app-url", state: { provenance: "undeclared" } });

    // appState never persists anywhere in the bundle (runtime-only).
    const bundleText = await readFile(path.join(runDir, "run.json"), "utf8");
    expect(bundleText).not.toContain("/step-1");
    expect(bundleText).not.toContain('"appState"');

    // The hollow-pass net: the independent verifier passes the real (action-bearing) bundle.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "actor engagement")?.ok).toBe(true);
  });

  it("builds the caller's executor and provider once, closes the provider once, and prices the trace", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const stateExecutor = makeStateExecutor();
    const provider = { ...makeStateProvider(), close: vi.fn(async () => undefined) };
    const executor = vi.fn(async () => stateExecutor);
    const createProvider = vi.fn(async (_context: { executor: CuaExecutor }) => provider);
    const onStream = vi.fn();

    const outcome = await runStudyWith(
      localAppConfig(),
      {
        cwd,
        onStream,
        inProcess: { executor },
        createProvider,
      },
      {
        desktopModule: async () => module,
      },
    );

    if (outcome.route !== "computer-use") throw new Error("expected the cua backend");
    expect(outcome.result.ok).toBe(true);
    // No desktop starts in process, so no stream event fires.
    expect(onStream).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalledOnce();
    expect(createProvider).toHaveBeenCalledOnce();
    expect(createProvider.mock.calls[0]![0].executor).toBe(stateExecutor);
    expect(provider.close).toHaveBeenCalledOnce();
    expect(created).toHaveLength(0);
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    // The trace is priced like a hosted participant's; the caller's model has no rate, so the
    // estimate is declared unknown and the run's cost block says so.
    expect(bundle.streams[0].actor.estimatedCost).toMatchObject({ estimatedCostUsd: null });
    expect(bundle.cost).toMatchObject({ estimatedTotalUsd: null, fullyEstimated: false });
  });

  it.each([{ maxUsd: 0.01 }, { maxTotalUsd: 0.01 }])(
    "stops an in-process participant under a dollar cap when its provider reports no usage (%j)",
    async (caps) => {
      const { module } = makeFakeModule(makeFakeSandbox());
      const config = localAppConfig();
      config.execution = { caps };

      const outcome = await runStudyWith(
        config,
        {
          cwd,
          inProcess: { executor: async () => makeStateExecutor() },
          createProvider: async () => makeStateProvider(),
        },
        {
          desktopModule: async () => module,
        },
      );

      if (outcome.route !== "computer-use") throw new Error("expected the cua backend");
      expect(outcome.result.session?.stopCause).toBe("usage_unreported");
      expect(outcome.result.ok).toBe(false);
    },
  );

  // The Codex review's case: a passed session followed by an unconfirmed provider cleanup. The
  // participant passed, so the verdict is pass; the run failed as an execution, so ok is false.
  it("records an unconfirmed provider close on an in-process run as a warning and an error", async () => {
    const { module } = makeFakeModule(makeFakeSandbox());
    const provider = {
      ...makeStateProvider(),
      close: async () => {
        throw new Error("synthetic close failure");
      },
    };

    const outcome = await runStudyWith(
      localAppConfig(),
      {
        cwd,
        inProcess: { executor: async () => makeStateExecutor() },
        createProvider: async () => provider,
      },
      {
        desktopModule: async () => module,
      },
    );

    if (outcome.route !== "computer-use") throw new Error("expected the cua backend");
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.warnings).toContain("Model provider cleanup is unconfirmed.");
    expect(outcome.result.error?.message).toContain("Model provider cleanup is unconfirmed.");
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      outcome?: {
        verdict?: string;
        ok?: boolean;
        execution?: { failures: Array<{ kind: string }> };
      };
    };
    expect(bundle.review.verdict).toBe("pass");
    expect(status.outcome?.verdict).toBe("pass");
    expect(status.outcome?.ok).toBe(false);
    expect(status.outcome?.execution?.failures.map((failure) => failure.kind)).toEqual([
      "provider-cleanup",
    ]);
  });

  it("scrubs a known value from an in-process participant's blocker warning", async () => {
    const { module } = makeFakeModule(makeFakeSandbox());
    const canary = "synthetic-in-process-canary-value";
    const provider: CuaProvider = {
      ...makeStateProvider(),
      nextTurn: async () => ({
        actions: [],
        message: `I could not save the note: the form rejected ${canary}.`,
        outcome: "blocked",
        pendingSafetyChecks: [],
        done: true,
      }),
    };

    const outcome = await runStudyWith(
      localAppConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: canary },
        inProcess: { executor: async () => makeStateExecutor() },
        createProvider: async () => provider,
      },
      {
        desktopModule: async () => module,
      },
    );

    if (outcome.route !== "computer-use") throw new Error("expected the cua backend");
    const blocker = outcome.result.warnings.find((warning) =>
      warning.includes("describes a blocker"),
    );
    expect(blocker).toContain("[REDACTED_SECRET]");
    expect(blocker).not.toContain(canary);
  });

  it("a hollow in-process run (zero actions/messages) still fails the no-engagement guard + verifyRun", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runStudyWith(
      localAppConfig(),
      {
        cwd,
        inProcess: { executor: async () => makeStateExecutor() },
        // A brain that immediately reports done with no action and no message → hollow.
        createProvider: async (): Promise<CuaProvider> => ({
          id: "hollow-brain",
          capabilities: STATE_CAPS,
          async nextTurn(): Promise<CuaTurn> {
            return { actions: [], pendingSafetyChecks: [], done: true };
          },
        }),
      },
      {
        desktopModule: async () => module,
      },
    );
    expect(created).toHaveLength(0);
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("no actions");
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
  });

  it("a gave_up in-process run is an abandoned participant: a participant outcome, still not an engaged pass", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runStudyWith(
      localAppConfig(),
      {
        cwd,
        inProcess: { executor: async () => makeStateExecutor() },
        createProvider: async (): Promise<CuaProvider> => ({
          id: "idle-brain",
          capabilities: STATE_CAPS,
          async nextTurn(): Promise<CuaTurn> {
            return {
              actions: [{ kind: "wait", ms: 1 }],
              pendingSafetyChecks: [],
              done: false,
              message: "Still waiting.",
            };
          },
        }),
      },
      {
        desktopModule: async () => module,
      },
    );
    expect(created).toHaveLength(0);
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;
    // The participant stopped trying. That is a finding about the product, not the harness
    // malfunctioning, but it is still not a pass, and the participant must not be counted as one.
    expect(result.session?.status).toBe("abandoned");
    expect(result.session?.completionReason).toBe("gave_up");
    expect(result.ok).toBe(false);
    const lanes = result.lanes ?? [];
    const laneSummary = result.laneSummary;
    if (!laneSummary) throw new Error("expected lane summary");
    expect(lanes[0]?.status).toBe("abandoned");
    expect(lanes[0]?.ok).toBe(false);
    expect(laneSummary.passed).toBe(0);
    // The error names what actually happened to the participant, not a generic failure.
    expect(result.error?.message).toContain("abandoned");

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("gave up");
  });

  // The two boot-time fail-closed guards, both before any key check / any E2B touch.
  it("inProcess without createProvider → EXECUTOR_NO_PROVIDER (before any key check)", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runCuaActorStudy({
      cwd,
      config: localAppConfig(),
      dryRun: false,
      env: {},
      deps: {
        // No keys: proves the guard precedes key-gating
        desktopModule: async () => module,
      },
      // createProvider deliberately omitted
      inProcess: { executor: async () => makeStateExecutor() },
    });
    expect(created).toHaveLength(0);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("HUMANISH_COMPUTER_USE_EXECUTOR_NO_PROVIDER");
    expect(outcome.sandbox).toBeUndefined();
  });

  it("local-app subject with no hooks → LOCAL_APP_NO_EXECUTOR (a structured error, never a desktop attempt, before key-gating)", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runCuaActorStudy({
      cwd,
      config: localAppConfig(),
      dryRun: false,
      env: {},
      deps: {
        // No keys: the local-app guard must win over KEYS_MISSING
        desktopModule: async () => module,
      },
    });
    expect(created).toHaveLength(0);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("HUMANISH_COMPUTER_USE_LOCAL_APP_NO_EXECUTOR");
    expect(outcome.error?.message).toContain("inProcess: { executor }, createProvider");
    expect(outcome.error?.message).not.toContain("cuaHooks");
    expect(outcome.sandbox).toBeUndefined();
  });

  it("createProvider alone (a model swap) does not take the in-process route: it still provisions E2B", async () => {
    // createProvider without inProcess is allowed and stays on the normal E2B route; with no
    // keys/dry-run we just confirm it does not trip EXECUTOR_NO_PROVIDER and is not treated as
    // in-process (a dry-run produces a contract bundle with no sandbox, the normal route).
    const outcome = await runStudyWith(cuaConfig(), {
      cwd,
      dryRun: true,
      createProvider: async () => makeStateProvider(),
    });
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.error?.code).not.toBe("HUMANISH_COMPUTER_USE_EXECUTOR_NO_PROVIDER");
  });
});

// Observe-time CDP port re-resolution: the probe re-reads DevToolsActivePort at observe time (the
// resolution itself is contract-tested under the real python3 in tests/chrome-cdp-probe.test.ts);
// this pins that the shipped in-sandbox command carries the seam.
describe("chromium browser-state observer command (observe-time CDP port re-resolution)", () => {
  it("the chromium browser-state observer embeds the re-read seam (profile dir + marker path) in its in-sandbox script", async () => {
    const commands: string[] = [];
    const desktop = {
      commands: {
        run: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, stdout: "{}" };
        },
      },
    } as unknown as E2BDesktopSandbox;
    const observe = makeChromeBrowserStateObserver(desktop, 5_000, {
      profileDir: "/tmp/humanish-profile-x",
      targetUrl: "http://127.0.0.1:3000/",
    });
    // The fake endpoint answers with an empty page set, so the observer degrades to {}.
    expect(await observe()).toEqual({});
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("DevToolsActivePort");
    expect(commands[0]).toContain("/tmp/humanish-profile-x");
  });
});

// Budget vs. timed_out semantics through the lab, and live-serve-during-run wiring. Every session
// is driven by the real loop against an injected clock + state executor/provider (no vision, no
// screenshots, $0). The fake sandbox provisions a stream URL before the session runs, so the live
// Observer picks it up even when the session ends timed_out/failed.
describe("runCuaActorLab budget/timeout semantics + live serve", () => {
  let cwd: string;
  const openServers: ObserverServer[] = [];

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-budget-"));
  });
  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((server) => server.close()));
    await rm(cwd, { recursive: true, force: true });
  });

  // A state executor (no screenshot) reading a shared clock so the loop's deadline is deterministic.
  function clockExecutor(clock: { t: number }): CuaExecutor {
    let turn = 0;
    return {
      async observe(): Promise<CuaObservation> {
        turn += 1;
        return { stateSignature: `sig-${turn}`, appState: { turn, t: clock.t } };
      },
      async execute(): Promise<void> {},
    };
  }

  // Reaches budget: takes one material action, then the clock jumps past the deadline.
  function budgetProvider(clock: { t: number }): CuaProvider {
    return {
      id: "budget-brain",
      version: "0.1.0",
      requiresFrame: false,
      capabilities: STATE_CAPS,
      async nextTurn(): Promise<CuaTurn> {
        clock.t = 1000;
        return { actions: [{ kind: "type", text: "hello" }], pendingSafetyChecks: [], done: false };
      },
    };
  }

  // Zero material progress: only an idle wait, then the clock jumps past the deadline → timed_out.
  function idleTimeoutProvider(clock: { t: number }): CuaProvider {
    return {
      id: "idle-brain",
      version: "0.1.0",
      requiresFrame: false,
      capabilities: STATE_CAPS,
      async nextTurn(): Promise<CuaTurn> {
        clock.t = 1000;
        return { actions: [{ kind: "wait", ms: 1 }], pendingSafetyChecks: [], done: false };
      },
    };
  }

  it("classifies a productive budget stop as incomplete: no pass claimed, and the evidence still verifies", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) => {
          const clock = { t: 0 };
          return runCuaActorSession({
            ...options,
            provider: budgetProvider(clock),
            executor: clockExecutor(clock),
            now: () => clock.t,
            timeoutMs: 100,
          });
        },
      },
    );

    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;
    // The session ran out before reaching its goal. It did real work on the way: that is what
    // separates it from a zero-progress timeout, but "productive" is not "finished", and calling it
    // a pass is how a truncated study came to be reported green.
    expect(result.session?.completionReason).toBe("budget_reached");
    expect(result.session?.status).toBe("incomplete");
    expect(result.ok).toBe(false);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.review.verdict).not.toBe("pass");
    expect(bundle.streams[0].actor.completionReason).toBe("budget_reached");
    // The verdict collapses the run to one word; the participant tally does not. A reader can see
    // that nobody reached the goal and that the denominator was one (three-roles.md).
    expect(bundle.review.participants).toMatchObject({
      total: 1,
      reachedGoal: 0,
      ranOut: 1,
      harnessFailed: 0,
    });

    // The distinction that matters: the study is incomplete, but the evidence is sound. The harness
    // did exactly what it said it did, so verify still passes: an unfinished study is a finding
    // about the session, not a reason to distrust the bundle.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("keeps a zero-progress timeout a failure (timed_out → result.ok false)", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) => {
          const clock = { t: 0 };
          return runCuaActorSession({
            ...options,
            provider: idleTimeoutProvider(clock),
            executor: clockExecutor(clock),
            now: () => clock.t,
            timeoutMs: 100,
          });
        },
      },
    );

    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;
    expect(result.session?.completionReason).toBe("timed_out");
    expect(result.session?.status).toBe("timed_out");
    expect(result.ok).toBe(false);
  });

  it("flushes liveActor items into the in-progress bundle mid-run, and the final write replaces them", async () => {
    const secret = "synthetic-live-assignment-secret";
    const config = cuaConfig();
    config.actors[0]!.mission = `Explore with ${secret}.`;
    config.actors[0]!.tasks = [
      {
        id: "settings",
        goal: `Save with ${secret}.`,
        success: { any: [{ textIncludes: "hidden-success-marker" }] },
      },
    ];
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    type MidRunBundle = {
      streams: Array<{
        status: string;
        assignment?: unknown;
        liveActor?: { schema: string; items: Array<{ kind: string; at?: string }> };
      }>;
    };
    let midRunBundle: MidRunBundle | undefined;

    // Two material turns then done. Turn 2's nextTurn polls the persisted run.json for the
    // flush of turn 1's items: the flush is fire-and-forget, so a bounded poll (real fs,
    // fake substrate, $0) observes it without a test-only seam.
    const runJsonPath = (): string => path.join(cwd, ".humanish", "runs", "run-flush", "run.json");
    function flushProvider(clock: { t: number }): CuaProvider {
      let turn = 0;
      return {
        id: "flush-brain",
        version: "0.1.0",
        requiresFrame: false,
        capabilities: STATE_CAPS,
        async nextTurn(): Promise<CuaTurn> {
          clock.t += 10;
          turn += 1;
          if (turn === 2) {
            for (let attempt = 0; attempt < 100 && midRunBundle === undefined; attempt += 1) {
              try {
                const parsed = JSON.parse(await readFile(runJsonPath(), "utf8")) as MidRunBundle;
                const flushed = parsed.streams.some(
                  (stream) =>
                    stream.liveActor?.items.some((item) => item.kind === "ui_action") === true,
                );
                if (flushed) midRunBundle = parsed;
              } catch {
                // Bundle mid-write or not yet flushed; keep polling.
              }
              if (midRunBundle === undefined)
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          if (turn >= 3)
            return {
              actions: [],
              pendingSafetyChecks: [],
              done: true,
              message: "The settings button is hard to find.",
            };
          return {
            actions: [{ kind: "type", text: `t${turn}` }],
            pendingSafetyChecks: [],
            done: false,
          };
        },
      };
    }

    const outcome = await runStudyWith(
      config,
      {
        cwd,
        runId: "run-flush",
        onObserverReady: async () => {
          const initial = await readFile(runJsonPath(), "utf8");
          expect(initial).not.toContain(secret);
          expect(JSON.parse(initial).streams[0].assignment.mission).toBe(
            "Explore with [REDACTED_SECRET].",
          );
        },
        env: { OPENAI_API_KEY: secret, E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) => {
          expect(options.instructions).toContain(secret);
          expect(options.instructions).toContain(`Save with ${secret}.`);
          expect(options.instructions).not.toContain("hidden-success-marker");
          const clock = { t: 0 };
          return runCuaActorSession({
            ...options,
            provider: flushProvider(clock),
            executor: clockExecutor(clock),
            now: () => clock.t,
            timeoutMs: 10_000,
          });
        },
      },
    );

    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;

    // Mid-run: the persisted in-progress bundle carried the partial; schema'd, stamped items,
    // on a stream still marked running (no completion claims anywhere).
    expect(midRunBundle).toBeTruthy();
    expect(JSON.stringify(midRunBundle)).not.toContain(secret);
    const liveStream = midRunBundle?.streams.find((stream) => stream.liveActor !== undefined);
    expect(liveStream?.status).toBe("running");
    expect(liveStream?.assignment).toEqual({
      mission: "Explore with [REDACTED_SECRET].",
      focus: "Focus on the landing page.",
      tasks: [{ id: "settings", goal: "Save with [REDACTED_SECRET]." }],
    });
    const live = liveStream?.liveActor;
    expect(live?.schema).toBe("humanish.live-actor.v1");
    expect(live?.items.some((item) => item.kind === "ui_action")).toBe(true);
    expect(live?.items.every((item) => typeof item.at === "string")).toBe(true);

    // Final: the real actor replaces the partial; liveActor never survives completion.
    const finalBundle = JSON.parse(await readFile(runJsonPath(), "utf8")) as {
      streams: Array<{
        status: string;
        assignment?: unknown;
        actor?: { items: unknown[] };
        liveActor?: unknown;
      }>;
      feedbackCandidates: unknown[];
    };
    expect(finalBundle.streams[0]?.assignment).toEqual(liveStream?.assignment);
    expect(finalBundle.feedbackCandidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(finalBundle)).not.toContain(secret);
    expect(
      await readFile(
        path.join(path.dirname(runJsonPath()), "observer", "observer-data.json"),
        "utf8",
      ),
    ).not.toContain(secret);
    expect(finalBundle.streams.every((stream) => stream.status !== "running")).toBe(true);
    expect(finalBundle.streams.every((stream) => stream.liveActor === undefined)).toBe(true);
    expect(finalBundle.streams.some((stream) => (stream.actor?.items.length ?? 0) > 0)).toBe(true);
  });

  it("awaits onObserverReady before any desktop is created", async () => {
    const sandbox = makeFakeSandbox();
    const { module, created } = makeFakeModule(sandbox);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runStudyWith(
      cuaConfig(),
      {
        cwd,
        onObserverReady: async () => {
          enter();
          await gate;
        },
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async () => {
          throw new Error("synthetic session end");
        },
      },
    );
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(created).toHaveLength(0);
    release();
    await running;
    expect(created.length).toBeGreaterThan(0);
  });

  it("a throwing onObserverReady creates no desktop, closes the run and runs no analysis", async () => {
    const sandbox = makeFakeSandbox();
    const { module, created } = makeFakeModule(sandbox);
    const analysis = automaticAnalysisBoundary();
    const tunnelFailure = new Error("synthetic tunnel failure");
    await expect(
      runStudyWith(
        cuaConfig(),
        {
          cwd,
          onObserverReady: async () => {
            throw tunnelFailure;
          },
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        },
        {
          analysis: { run: analysis },

          desktopModule: async () => module,
        },
      ),
    ).rejects.toBe(tunnelFailure);
    expect(created).toHaveLength(0);
    expect(analysis).not.toHaveBeenCalled();
    const runsRoot = path.join(cwd, ".humanish", "runs");
    const [runId] = (await readdir(runsRoot)).filter((entry) => entry !== "latest.json");
    const status = JSON.parse(await readFile(path.join(runsRoot, runId!, "status.json"), "utf8"));
    expect(status.state).toBe("finished");
    expect(status).not.toHaveProperty("outcome");
  });

  it("fires onObserverReady for a single participant and serves the live in-progress bundle (incl. the stream URL) even after a timed_out run", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    let readyObserver: (ObserverResult & { ok: true }) | undefined;
    let server: ObserverServer | undefined;

    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd,
        onObserverReady: async (observer) => {
          // Invoked before the actor loop, for laneCount === 1, with an ok in-progress bundle.
          readyObserver = observer;
          expect(observer.ok).toBe(true);
          server = await serveObserver(observer, { port: 0 });
          openServers.push(server);
        },
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
      },
      {
        desktopModule: async () => module,
        runSession: async (options) => {
          const clock = { t: 0 };
          return runCuaActorSession({
            ...options,
            provider: idleTimeoutProvider(clock),
            executor: clockExecutor(clock),
            now: () => clock.t,
            timeoutMs: 100,
          });
        },
      },
    );

    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;

    // Serve-on-failure: the run ended timed_out (not ok) but the attached server still came up.
    expect(result.ok).toBe(false);
    expect(readyObserver).toBeTruthy();
    expect(server).toBeTruthy();

    const served = await fetch(new URL("observer-data.json", server!.url));
    expect(served.status).toBe(200);
    const observerData = (await served.json()) as {
      streams: Array<{ transport?: string; url?: string; embed?: { kind: string } }>;
    };
    // The run is over (the participant tore down and reported its stream ended), so the server no
    // longer injects the now-dead stream URL: the tile falls back to recorded evidence and the
    // stream says why (liveEnded). Serving the URL here was exactly the "board full of 'sandbox
    // not found'" failure the field run hit.
    expect(observerData.streams[0]?.transport).not.toBe("sse");
    expect(observerData.streams[0]?.url).toBeUndefined();
    expect((observerData.streams[0] as { liveEnded?: boolean } | undefined)?.liveEnded).toBe(true);
    // The runtime URL is never persisted to disk in any state.
    const persisted = await readFile(
      path.join(cwd, ".humanish", "runs", result.runId, "observer", "observer-data.json"),
      "utf8",
    );
    expect(persisted).not.toContain("fake-auth-key");
    expect(persisted).not.toContain("stream.invalid");
  });
});

describe("runCuaActorLab cost estimates", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-cost-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // A stepped clock: runCuaParticipant reads it exactly twice (right after create() and right after
  // teardown), so delta == one step == the deterministic billed span.
  function steppedClock(stepMs: number): () => number {
    let t = 0;
    return () => (t += stepMs);
  }
  // A scripted OpenAI Responses session that reports token usage, so a real estimate is produced.
  const usageSession = (input: number, output: number): unknown[] => [
    {
      id: "resp_1",
      output: [
        { type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] },
      ],
      usage: { input_tokens: input, output_tokens: output },
    },
    {
      id: "resp_2",
      output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  ];
  function configWithModel(model?: string, caps?: { maxUsd?: number }): StudyConfig {
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "cua-cost-proof",
      title: "CUA cost proof",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Explore the app and stop.",
          ...(model ? { model } : {}),
        },
      ],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { resolution: [1280, 800] },
        ...(caps ? { caps } : {}),
      },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }
  const readBundle = async (runId: string): Promise<any> =>
    JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8"));

  it("attaches a labeled per-participant + run-level estimated cost with provenance and deterministic desktop-minutes; verify passes", async () => {
    const { module, killed } = makeFakeModule(makeFakeSandbox());
    const result = await runCuaActorStudy({
      cwd,
      config: configWithModel(), // default resolves to gpt-5.6-sol, the 5.6-generation flagship
      dryRun: false,
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k" },
      deps: {
        desktopModule: async () => module,
        now: steppedClock(60_000),
        // create → 60000ms, teardown → 120000ms → 1 billed minute
        runSession: async (o) =>
          runCuaActorSession({
            ...o,
            openai: {
              ...o.openai,
              apiKey: "k",
              fetchFn: scriptedFetch(usageSession(2_000_000, 4_000)),
            },
          }),
      },
    });
    expect(result.ok).toBe(true);
    expect(killed).toEqual(["fake-sandbox-001"]);

    const bundle = await readBundle(result.runId);
    // Per-actor estimate on the persisted trace: labeled with provenance; gpt-5.6-sol is a
    // confirmed (non-placeholder) rate. The single 2M-input request crosses the 272K
    // long-context threshold, so the whole request re-tiers (2x input-side, 1.5x output):
    // exact because the trace now records per-request turns.
    const est = bundle.streams[0].actor.estimatedCost;
    expect(est.schema).toBe("humanish.actor-estimated-cost.v1");
    // gpt-5.6-sol long tier (promo sheet 2026-09-03): 2_000_000*4e-6*2 + 4_000*20e-6*1.5
    // = 16 + 0.12 = 16.12.
    expect(est.estimatedCostUsd).toBeCloseTo(16.12, 6);
    expect(est.ratesAsOf).toBe("2026-09-03");
    expect(est.source).toContain("developers.openai.com/api/docs/pricing");
    expect(est.placeholder).toBeUndefined();
    expect(est.modelId).toBe("gpt-5.6-sol");
    expect(est.breakdown.longContextTurns).toBe(1);
    // The trace records the per-request usage ledger the tiering priced from.
    expect(bundle.streams[0].actor.tokenUsage.turns).toHaveLength(2);

    const cost = bundle.cost;
    expect(cost.schema).toBe("humanish.run-cost-summary.v1");
    expect(cost.currency).toBe("usd");
    expect(cost.desktopMinutes).toBe(1);
    expect(cost.tokenUsage).toEqual({ input: 2_000_000, output: 4_000, total: 2_004_000 });
    const modelLine = cost.breakdown.find((l: any) => l.kind === "model-tokens");
    const desktopLine = cost.breakdown.find((l: any) => l.kind === "desktop-minutes");
    expect(modelLine.estimatedCostUsd).toBeCloseTo(16.12, 6);
    expect(modelLine.ratesAsOf).toBe("2026-09-03");
    expect(modelLine.source).toContain("developers.openai.com/api/docs/pricing");
    expect(desktopLine.estimatedCostUsd).toBeCloseTo(0.00888, 6);
    expect(desktopLine.desktop).toMatchObject({
      resources: { cpuCount: 8, memoryMiB: 8192 },
      resourceSource: "e2b.getInfo",
    });
    expect(cost.estimatedTotalUsd).toBeCloseTo(16.12888, 6);
    expect(cost.placeholder).toBe(false);
    expect(cost.fullyEstimated).toBe(true);
    expect(cost.ratesAsOf).toBe("2026-09-03");

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.checks.find((c) => c.name === "cost estimate labeling")?.ok).toBe(true);
    expect(verify.ok).toBe(true);
  });

  it.each(["absent", "rejected"] as const)(
    "keeps metadata %s unpriced while the actual participant still reclaims its handle",
    async (mode) => {
      const sandbox = makeFakeSandbox();
      if (mode === "absent") delete sandbox.getInfo;
      else
        sandbox.getInfo = async () => {
          throw new Error("synthetic metadata failure");
        };
      const { module, killed } = makeFakeModule(sandbox);
      const result = await runCuaActorStudy({
        cwd,
        config: configWithModel(),
        dryRun: false,
        env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k" },
        deps: {
          desktopModule: async () => module,
          now: steppedClock(60_000),
          runSession: async (o) =>
            runCuaActorSession({
              ...o,
              openai: { ...o.openai, apiKey: "k", fetchFn: scriptedFetch(usageSession(1000, 200)) },
            }),
        },
      });
      expect(result.ok).toBe(true);
      expect(killed).toEqual(["fake-sandbox-001"]);
      const bundle = await readBundle(result.runId);
      expect(bundle.cost.fullyEstimated).toBe(false);
      expect(
        bundle.cost.breakdown.find((line: any) => line.kind === "desktop-minutes"),
      ).toMatchObject({ estimatedCostUsd: null, reason: "no_desktop_resources" });
    },
  );

  it("aggregate ratesAsOf is the oldest contributing asOf, never the newest: an aggregate is only as fresh as its stalest input", () => {
    const costTrace = (
      estimatedCostUsd: number,
      ratesAsOf: string,
      input: number,
      output: number,
    ): ActorTrace => ({
      schema: ACTOR_TRACE_SCHEMA,
      provider: "openai-responses-cu",
      protocol: "cua-loop",
      lane: "computer-use",
      persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "d" },
      redaction: { status: "passed", screenshots: "n/a", notes: "" },
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
      durationMs: 1000,
      status: "passed",
      completionReason: "goal_satisfied",
      reason: "done",
      ids: {},
      counts: {},
      items: [],
      tokenUsage: { input, output, total: input + output },
      estimatedCost: {
        schema: "humanish.actor-estimated-cost.v1",
        estimatedCostUsd,
        ratesAsOf,
        source: "openai.com/api/pricing",
        modelId: "computer-use-preview",
      },
      capabilities: STATE_CAPS,
    });

    // Two priced model-token lines with divergent asOf dates (an operator edited one rate later).
    const cost = buildRunCostSummary({
      participants: [
        { participantId: "lane-01", trace: costTrace(1, "2026-08-01", 1000, 100) },
        { participantId: "lane-02", trace: costTrace(2, "2026-01-15", 2000, 200) },
      ],
      desktopMinutes: undefined,
    });

    expect(cost).toBeDefined();
    // The aggregate reports the older date (min), never the newer one (max would overclaim freshness).
    expect(cost!.ratesAsOf).toBe("2026-01-15");
    expect(cost!.note).toContain("2026-01-15");
    expect(cost!.note).toContain("the oldest rate used");
    // Per-line breakdown keeps each line's own true asOf: only the aggregate is conservative.
    const asOfById = new Map(cost!.breakdown.map((l) => [l.laneId, l.ratesAsOf]));
    expect(asOfById.get("lane-01")).toBe("2026-08-01");
    expect(asOfById.get("lane-02")).toBe("2026-01-15");
    expect(cost!.estimatedTotalUsd).toBeCloseTo(3, 6);
  });

  it("declares absent (null + reason) for an unpriced model and sums only the known lines into the total", async () => {
    const { module } = makeFakeModule(makeFakeSandbox());
    const result = await runCuaActorStudy({
      cwd,
      config: configWithModel("gpt-4o-unpriced-xyz"),
      dryRun: false,
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k" },
      deps: {
        desktopModule: async () => module,
        now: steppedClock(60_000),
        runSession: async (o) =>
          runCuaActorSession({
            ...o,
            openai: { ...o.openai, apiKey: "k", fetchFn: scriptedFetch(usageSession(1000, 200)) },
          }),
      },
    });

    const bundle = await readBundle(result.runId);
    const est = bundle.streams[0].actor.estimatedCost;
    expect(est.estimatedCostUsd).toBeNull();
    expect(est.reason).toBe("no_rate_for_model");
    expect(est.ratesAsOf).toBeNull();

    const cost = bundle.cost;
    const modelLine = cost.breakdown.find((l: any) => l.kind === "model-tokens");
    const desktopLine = cost.breakdown.find((l: any) => l.kind === "desktop-minutes");
    expect(modelLine.estimatedCostUsd).toBeNull();
    expect(modelLine.reason).toBe("no_rate_for_model");
    // The total is the desktop line alone: the null model line is never coerced to 0.
    expect(cost.estimatedTotalUsd).toBeCloseTo(desktopLine.estimatedCostUsd, 6);
    expect(cost.fullyEstimated).toBe(false);
    // token usage is still summed even though the model could not be priced.
    expect(cost.tokenUsage).toEqual({ input: 1000, output: 200, total: 1200 });

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.checks.find((c) => c.name === "cost estimate labeling")?.ok).toBe(true);
  });

  it("dry-run invents no spend: the bundle carries no cost block", async () => {
    const result = await runCuaActorStudy({
      cwd,
      config: configWithModel(),
      dryRun: true,
      runId: "cost-dry-run",
    });
    expect(result.ok).toBe(true);
    const bundle = await readBundle("cost-dry-run");
    expect(bundle.cost).toBeUndefined();
  });

  it("refuses a maxUsd cap on a model src/run/pricing.ts cannot price, before creating any sandbox", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const result = await runCuaActorStudy({
      cwd,
      config: configWithModel("gpt-4o-unpriced-xyz", { maxUsd: 5 }),
      dryRun: false,
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k" },
      deps: {
        desktopModule: async () => module,
        runSession: async () => {
          throw new Error("a session must never run under an unenforceable cap");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_UNPRICED_CAP");
    expect(created).toHaveLength(0);
  });

  it("accepts a maxUsd cap on a priced model and runs: a priced cap is wired, never a refusal", async () => {
    const { module } = makeFakeModule(makeFakeSandbox());
    const result = await runCuaActorStudy({
      cwd,
      config: configWithModel("computer-use-preview", { maxUsd: 50 }),
      dryRun: false,
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k" },
      deps: {
        desktopModule: async () => module,
        now: steppedClock(60_000),
        runSession: async (o) =>
          runCuaActorSession({
            ...o,
            openai: { ...o.openai, apiKey: "k", fetchFn: scriptedFetch(usageSession(1000, 200)) },
          }),
      },
    });
    expect(result.error?.code).not.toBe("HUMANISH_COMPUTER_USE_UNPRICED_CAP");
    expect(result.ok).toBe(true);
    const bundle = await readBundle(result.runId);
    // computer-use-preview is a confirmed (non-placeholder) model rate: the per-actor estimate
    // and its model-tokens line carry no placeholder flag.
    expect(bundle.streams[0].actor.estimatedCost.placeholder).toBeUndefined();
    const modelLine = bundle.cost.breakdown.find((l: any) => l.kind === "model-tokens");
    expect(modelLine.placeholder).toBeUndefined();
    // Both the model rate and this allocation's observed resource rate are confirmed.
    expect(bundle.cost.placeholder).toBe(false);
  });
});

describe("adopter-hosted comms on the app-url route", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-external-cwd-"));
  });
  afterEach(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  it("refuses an older catch before allocating a desktop or starting a participant", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, service: "humanish-comms-catch" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const parsed = parseStudy({
        schema: V2_SCHEMA,
        id: "older-external-catch",
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
        comms: { email: { external: { catchBaseUrl: `http://127.0.0.1:${port}` } } },
        actors: [{ type: "openai-computer-use", mission: "Sign up." }],
        execution: { target: "e2b-desktop" },
        scenario: { mode: "live" },
      });
      if (!parsed.ok) throw new Error(parsed.error.message);
      const loadDesktopModule = vi.fn(async () => {
        throw new Error("Desktop allocation must not start");
      });
      const runSession = vi.fn(async () => {
        throw new Error("Participant must not start");
      });
      const outcome = await runStudyWith(
        parsed.config,
        {
          cwd,
          env: { OPENAI_API_KEY: "synthetic", E2B_API_KEY: "synthetic" },
        },
        {
          desktopModule: loadDesktopModule,
          runSession: runSession,
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");
      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_COMMS_CATCH_UNREACHABLE");
      expect(outcome.result.error?.message).toContain("restart");
      expect(outcome.result.error?.message).toContain("recipient-inbox-v1");
      expect(loadDesktopModule).not.toHaveBeenCalled();
      expect(runSession).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("tells each persona its inbox, drains the adopter catch once, and writes digest-only evidence", async () => {
    // The real python catch as a subprocess: the same bytes an adopter runs via `humanish comms
    // catch`, so the health probe, the token guard, and the drain contract are proven against the
    // actual implementation.
    const TOKEN = "test-token-not-a-secret";
    const dir = await mkdtemp(path.join(tmpdir(), "humanish-cua-external-"));
    const scriptPath = path.join(dir, "catch.py");
    const surface = path.join(dir, "surface");
    await mkdir(surface, { recursive: true });
    await writeFile(scriptPath, SANDBOX_CATCH_SCRIPT, "utf8");
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(
      "python3",
      [scriptPath, String(port), path.join(dir, "deliveries.ndjson"), surface, "0", TOKEN],
      { stdio: "ignore" },
    );
    try {
      let healthy = false;
      for (let i = 0; i < 100 && !healthy; i += 1) {
        healthy = await externalCatchHealthy({ catchBaseUrl: baseUrl }, { timeoutMs: 1000 });
        if (!healthy) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(healthy).toBe(true);

      // The app's send, captured by the adopter's catch, addressed to lane-01's filled
      // deterministic address (recipients omitted in the study on purpose: the parser fills one
      // per participant, and this proves the filled address is what the funnel matches).
      const posted = await fetch(`${baseUrl}/emails`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: "no-reply@example.test",
          to: ["lane-01@example.test"],
          subject: "Confirm your email",
          html: '<a href="https://app.example.test/verify?token=xyz789">Verify</a>',
        }),
      });
      expect(posted.ok).toBe(true);

      const parsed = parseStudy({
        schema: V2_SCHEMA,
        id: "cua-external-comms",
        title: "CUA adopter-hosted comms",
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
        comms: { email: { external: { catchBaseUrl: baseUrl, authTokenEnv: "CATCH_TOKEN" } } },
        actors: [
          {
            type: "openai-computer-use",
            mission: "Sign up using the email address in your instructions.",
            count: 2,
          },
        ],
        execution: { target: "e2b-desktop", desktop: { resolution: [1280, 800] } },
        scenario: { mode: "live" },
      });
      if (!parsed.ok) throw new Error(parsed.error.message);

      const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
      const { module } = makeFakeModule(sandbox);
      const seenInstructions: string[] = [];
      const outcome = await runStudyWith(
        parsed.config,
        {
          cwd,
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", CATCH_TOKEN: TOKEN },
        },
        {
          desktopModule: async () => module,
          runSession: async (options) => {
            seenInstructions.push(options.instructions);
            return runCuaActorSession({
              ...options,
              openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
            });
          },
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");
      const result = outcome.result;

      // Every persona was told its own filled address and the adopter's inbox URL (this
      // route previously ignored the whole block).
      expect(seenInstructions).toHaveLength(2);
      for (const address of ["lane-01@example.test", "lane-02@example.test"]) {
        const scopedUrl = recipientInboxUrl(`${baseUrl}/inbox`, address);
        expect(
          seenInstructions.filter((text) => text.includes(scopedUrl) && text.includes(address)),
        ).toHaveLength(1);
      }

      // The drain ran once at run level, matched the captured send, and wrote the digest-only
      // artifact: no raw address, subject, or link may appear in it.
      const threadPath = path.join(cwd, ".humanish", "runs", result.runId, "comms", "thread.json");
      const thread = await readFile(threadPath, "utf8");
      expect(thread).toContain("humanish.comms-thread.v1");
      expect(thread).not.toContain("lane-01@example.test");
      expect(thread).not.toContain("Confirm your email");
      expect(thread).not.toContain("xyz789");
      expect(result.warnings.some((w) => w.includes("captured no email sends"))).toBe(false);
    } finally {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("computer-use run id reuse", () => {
  it("refuses a live run whose run id names an existing run, before any sandbox or analysis", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-run-id-"));
    try {
      const older = await runStudyWith(cuaConfig(), { cwd, dryRun: true, runId: "older-run" });
      expect(older.result.ok).toBe(true);
      const runsRoot = path.join(cwd, ".humanish", "runs");
      const snapshot = async () => ({
        files: (await readdir(path.join(runsRoot, "older-run"), { recursive: true })).sort(),
        run: await readFile(path.join(runsRoot, "older-run", "run.json"), "utf8"),
        status: await readFile(path.join(runsRoot, "older-run", "status.json"), "utf8"),
        latest: await readFile(path.join(runsRoot, "latest.json"), "utf8"),
      });
      const before = await snapshot();
      const loadDesktopModule = vi.fn(async () => {
        throw new Error("no sandbox may be created for a refused run id");
      });
      const analysis = automaticAnalysisBoundary();

      const outcome = await runStudyWith(
        cuaConfig(),
        {
          cwd,
          dryRun: false,
          runId: "older-run",
          env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        },
        {
          analysis: { run: analysis },

          desktopModule: loadDesktopModule,
        },
      );

      expect(outcome.result).toMatchObject({
        ok: false,
        runId: "older-run",
        error: { code: "HUMANISH_RUN_ID_IN_USE" },
        automaticAnalysis: { state: "skipped", reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE" },
      });
      expect(loadDesktopModule).not.toHaveBeenCalled();
      expect(analysis).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// Characterization: the complete run directory and returned result of a single-participant
// computer-use run, on the fake E2B module with a scripted provider transport and on the in-process
// route with a state executor, pinned so a refactor of bundle assembly or artifact writing shows up
// as a diff. Regenerate with `pnpm vitest run tests/routes/computer-use/lab.test.ts -u`.
describe("computer-use run directory goldens", () => {
  let goldenCwd: string;
  beforeEach(async () => {
    goldenCwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-golden-"));
  });
  afterEach(async () => {
    await rm(goldenCwd, { recursive: true, force: true });
  });

  it.each([
    ["dry run", true, "computer-use-dry-run.json"],
    ["live run", false, "computer-use-live.json"],
  ] as const)("%s with one participant", async (_label, dryRun, golden) => {
    const sandbox: FakeSandbox = makeFakeSandbox({
      commandHandler: measuredChromeDesktop(() => sandbox.screen),
    });
    const { module } = makeFakeModule(sandbox);
    let clock = 0;
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd: goldenCwd,
        dryRun,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        analysis: { run: automaticAnalysisBoundary() },

        desktopModule: async () => module,
        now: () => (clock += 30_000),
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    ).finally(stderr.stop);
    const runId = outcome.result.runId;
    if (!runId) throw new Error("the run wrote no bundle");
    const snapshot = await runDirSnapshot(path.join(goldenCwd, ".humanish", "runs", runId), {
      result: outcome.result,
      stderr: stderr.text(),
      replace: [
        [runId, "[run]"],
        [goldenCwd, "[cwd]"],
      ],
    });
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      `../../golden/routes/${golden}`,
    );
  });

  // The goldens above use a desktop whose Chrome reports its geometry. This one answers no
  // geometry command, so every unmeasured-geometry warning is pinned here, in each place a run
  // records it: the result, the stream's desktopGeometry and the events.
  it("live run whose desktop measures no browser geometry", async () => {
    const { module } = makeFakeModule(makeFakeSandbox());
    let clock = 0;
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      cuaConfig(),
      {
        cwd: goldenCwd,
        dryRun: false,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        analysis: { run: automaticAnalysisBoundary() },
        desktopModule: async () => module,
        now: () => (clock += 30_000),
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
      },
    ).finally(stderr.stop);
    const runId = outcome.result.runId;
    if (!runId) throw new Error("the run wrote no bundle");
    const bundle = JSON.parse(
      await readFile(path.join(goldenCwd, ".humanish", "runs", runId, "run.json"), "utf8"),
    ) as RunBundle;
    const stream = bundle.streams[0];
    const geometryWarnings = stream?.desktopGeometry?.warnings ?? [];
    const geometry = {
      resultWarnings: outcome.result.warnings.filter((warning) =>
        geometryWarnings.includes(warning),
      ),
      streamViewport: stream?.viewport ?? null,
      desktopGeometry: stream?.desktopGeometry ?? null,
      // Event times come from the wall clock; the other run-directory goldens mask them too.
      events: bundle.events
        .filter((event) => event.type === "cua-lab.geometry.warning")
        .map((event) => ({ ...event, at: "[ts]" })),
    };
    await expect(`${JSON.stringify(geometry, null, 2)}\n`).toMatchFileSnapshot(
      "../../golden/routes/computer-use-unmeasured-geometry.json",
    );
  });

  it("in-process local-app run with a state executor", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    let clock = 0;
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      localAppConfig(),
      {
        cwd: goldenCwd,
        // The in-process route needs no keys; an empty env keeps the operator's env out of the result.
        env: {},
        inProcess: { executor: async () => makeStateExecutor() },
        createProvider: async () => makeStateProvider(),
      },
      {
        analysis: { run: automaticAnalysisBoundary() },

        desktopModule: async () => module,
        now: () => (clock += 30_000),
      },
    ).finally(stderr.stop);
    expect(created).toHaveLength(0);
    const runId = outcome.result.runId;
    if (!runId) throw new Error("the run wrote no bundle");
    const snapshot = await runDirSnapshot(path.join(goldenCwd, ".humanish", "runs", runId), {
      result: outcome.result,
      stderr: stderr.text(),
      replace: [
        [runId, "[run]"],
        [goldenCwd, "[cwd]"],
      ],
    });
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      "../../golden/routes/computer-use-in-process-live.json",
    );
  });
});
