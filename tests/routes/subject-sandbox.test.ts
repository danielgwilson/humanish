// The one subject sandbox that the scripted clone route and the shared-world provisioned plane
// create: the request that creates it, its one retry, the size and span the run prices, and the
// release it records when the SDK cannot kill. Shared world's participants run on stub desktops,
// so on both routes the fake E2B module serves only the subject.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CuaExecutor } from "../../src/actors/computer-use/loop.js";
import type { ParticipantDesktop } from "../../src/routes/computer-use/participant-desktop.js";
import { parseSandboxReceipts, SANDBOX_RECEIPTS_ARTIFACT } from "../../src/run/sandbox-receipts.js";
import { parseStudy } from "../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../src/substrates/e2b/sdk.js";
import { runScripted, runSharedWorld } from "../helpers/route-run.js";

vi.mock("../../src/routes/computer-use/e2b-desktop/desktop.js", () => ({
  createE2BParticipantDesktop: vi.fn(() => releasedDesktop()),
}));

const ROOT = process.cwd();
const TEMPLATE = "synthetic-subject-template";
const SUBJECT_ENV = "DATABASE_URL";
const ENV = {
  OPENAI_API_KEY: "synthetic-openai-key",
  E2B_API_KEY: "synthetic-e2b-key",
  [SUBJECT_ENV]: "postgres://synthetic-database",
} as const;
const MINUTE_MS = 60_000;
// The subject sandbox outlives the session by the provision budget (30 min), the one seed step's
// default budget (5 min) and the reclamation buffer (10 min).
const SUBJECT_ROOM_MS = 45 * MINUTE_MS;

function fakeExecutor(): CuaExecutor {
  const screenshot = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  return {
    observe: async () => ({ screenshot, stateSignature: "page", text: "Tasks", url: "/" }),
    execute: async () => undefined,
  };
}

/** A participant desktop that owns no sandbox on the fake module and reports itself released. */
function releasedDesktop(): ParticipantDesktop {
  return {
    prepare: async () => undefined,
    openSession: async () => ({ executor: fakeExecutor() }),
    finalize: async () => undefined,
    snapshot: () => ({
      released: true,
      streamUrlPresent: false,
      stateStepRecords: [],
      phaseRecords: [],
    }),
  };
}

interface SubjectModuleOptions {
  /** Thrown by the first create, before any sandbox exists. */
  firstCreateError?: Error;
  /** What the sandbox's getInfo reports; absent leaves the sandbox without getInfo. */
  resources?: { cpuCount: number; memoryMB: number };
  /** False builds a module whose Sandbox has no kill method. */
  canKill?: boolean;
  /** Runs when the subject is killed, before kill answers. */
  onKill?: () => void;
}

interface SubjectModule {
  module: E2BDesktopModule;
  /** Every create attempt, the failed one included. */
  attempts: Array<{ template: string | undefined; options: E2BDesktopCreateOptions }>;
  killed: string[];
}

/** An E2B module that serves one clone subject: clone, seed, start and probe all succeed. */
function subjectModule(options: SubjectModuleOptions = {}): SubjectModule {
  const attempts: SubjectModule["attempts"] = [];
  const killed: string[] = [];
  const commit = "5".repeat(40);
  const answer = (command: string): { exitCode: number; stdout: string } => {
    if (command.includes("/status")) return { exitCode: 0, stdout: "0\n" };
    if (command.includes("rev-parse")) return { exitCode: 0, stdout: `${commit}\n` };
    if (command.includes("curl")) return { exitCode: 0, stdout: "READY\n" };
    if (command.includes("checkpoint-") && command.includes("tail -c"))
      return { exitCode: 0, stdout: "tasks=1\n" };
    return { exitCode: 0, stdout: "" };
  };
  const sandbox = (id: string): E2BDesktopSandbox => {
    const base = {
      sandboxId: id,
      commands: { run: async (command: string) => answer(command) },
      files: { write: async () => undefined },
      getHost: (port: number) => `${port}-${id}.e2b.app`,
    };
    const resources = options.resources;
    return (resources === undefined
      ? base
      : { ...base, getInfo: async () => resources }) as unknown as E2BDesktopSandbox;
  };
  const sandboxApi: E2BDesktopModule["Sandbox"] = {
    create: async (
      templateOrOptions: string | E2BDesktopCreateOptions,
      maybeOptions?: E2BDesktopCreateOptions,
    ) => {
      const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
      const createOptions =
        typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
      attempts.push({ template, options: createOptions });
      if (attempts.length === 1 && options.firstCreateError) throw options.firstCreateError;
      return sandbox(`synthetic-subject-${attempts.length}`);
    },
  };
  if (options.canKill !== false)
    sandboxApi.kill = async (sandboxId: string) => {
      options.onKill?.();
      killed.push(sandboxId);
      return true;
    };
  return { module: { Sandbox: sandboxApi }, attempts, killed };
}

function parsed(study: Record<string, unknown>): StudyConfig {
  const result = parseStudy(study);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

/** A clone subject whose state seed has one step. Only shared world reads a checkpoint. */
function cloneSubject(route: RouteCase["name"]): Record<string, unknown> {
  return {
    source: "clone",
    exposure: "synthetic",
    repos: ["example-org/example-app"],
    clone: { depth: 1 },
    env: [SUBJECT_ENV],
    serve: { start: "HOST=0.0.0.0 python3 server.py", url: "http://127.0.0.1:3000/" },
    state: {
      seed: [{ name: "seed", command: "python3 seed.py" }],
      ...(route === "shared-world"
        ? { checkpoint: [{ name: "task-count", command: "python3 checkpoint.py" }] }
        : {}),
    },
  };
}

interface SubjectRun {
  runId: string;
  warnings: string[];
  subjectKilled: boolean | undefined;
}

interface RouteCase {
  name: "scripted" | "shared-world";
  sessionTimeoutMs: number;
  /** The route's own metadata labels on the subject create. */
  labels: Record<string, string>;
  run(cwd: string, module: E2BDesktopModule, now?: () => number): Promise<SubjectRun>;
}

const ROUTES: RouteCase[] = [
  {
    name: "scripted",
    sessionTimeoutMs: 30_000,
    labels: {
      mode: "scripted-browser-lab",
      tool: "humanish",
      labId: "subject-sandbox-scripted",
      kind: "subject",
      actor: "scripted-browser",
    },
    async run(cwd, module, now) {
      const scenario = await readFile(
        path.join(ROOT, "humanish", "scenarios", "scripted-first-run.yaml"),
        "utf8",
      );
      await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
      await writeFile(path.join(cwd, "humanish", "scenarios", "scripted-first-run.yaml"), scenario);
      const result = await runScripted({
        cwd,
        config: parsed({
          schema: STUDY_SCHEMA,
          id: "subject-sandbox-scripted",
          route: "scripted",
          mode: "live",
          subject: cloneSubject("scripted"),
          actor: { type: "scripted-browser", persona: "synthetic-provider" },
          surfaces: ["desktop"],
          scenario: "scripted-first-run",
          execution: {
            target: "e2b-desktop",
            timeoutMs: 30_000,
            desktop: { template: TEMPLATE },
          },
        }),
        dryRun: false,
        env: ENV,
        deps: {
          desktopModule: async () => module,
          browserCommand: "/synthetic/browser",
          // The subject's lifecycle does not depend on how the session ends.
          runScriptedSession: async () => {
            throw new Error("synthetic session stop");
          },
          detachedTimers: { now: () => 0, sleep: async () => {} },
          ...(now === undefined ? {} : { now }),
        },
      });
      return {
        runId: result.runId,
        warnings: result.warnings,
        subjectKilled: result.subjectSandbox?.killed,
      };
    },
  },
  {
    name: "shared-world",
    sessionTimeoutMs: 60_000,
    labels: {
      mode: "concurrent-shared-world-lab",
      tool: "humanish",
      labId: "subject-sandbox-shared-world",
      topology: "shared-world",
      topologyMode: "concurrent",
      kind: "subject",
      participantCount: "2",
    },
    async run(cwd, module, now) {
      const result = await runSharedWorld({
        cwd,
        config: parsed({
          schema: STUDY_SCHEMA,
          id: "subject-sandbox-shared-world",
          route: "shared-world",
          mode: "live",
          subject: cloneSubject("shared-world"),
          actor: { type: "openai-computer-use", mission: "Add one task." },
          participants: [
            { id: "persona-01", persona: "persona-1" },
            { id: "persona-02", persona: "persona-2" },
          ],
          execution: {
            target: "e2b-desktop",
            timeoutMs: 60_000,
            concurrency: 2,
            desktop: { template: TEMPLATE },
          },
          review: { analysis: false },
        }),
        dryRun: false,
        env: ENV,
        deps: {
          desktopModule: async () => module,
          runSession: async () => {
            throw new Error("synthetic session stop");
          },
          detachedTimers: { now: () => 0, sleep: async () => {} },
          proberCadenceMs: 100_000,
          subjectPhaseSink: () => {},
          ...(now === undefined ? {} : { now }),
        },
      });
      return {
        runId: result.runId,
        warnings: result.warnings,
        subjectKilled: result.subjectSandbox?.killed,
      };
    },
  },
];

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-subject-sandbox-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function runFile(runId: string, file: string): Promise<string> {
  return readFile(path.join(cwd, ".humanish", "runs", runId, file), "utf8");
}

interface CostLine {
  kind: string;
  laneId?: string;
  estimatedCostUsd: number | null;
  reason?: string;
  desktop?: Record<string, unknown>;
}

async function subjectCostLines(runId: string): Promise<CostLine[]> {
  const bundle = JSON.parse(await runFile(runId, "run.json")) as {
    cost: { breakdown: CostLine[] };
  };
  return bundle.cost.breakdown.filter((line) => line.laneId === "subject");
}

describe.each(ROUTES)("the $name subject sandbox", (route) => {
  it("is created with the session budget, the route labels, the subject env and the template", async () => {
    const fake = subjectModule();
    const run = await route.run(cwd, fake.module);

    expect(fake.attempts).toHaveLength(1);
    const [attempt] = fake.attempts;
    expect(attempt?.template).toBe(TEMPLATE);
    const timeoutMs = route.sessionTimeoutMs + SUBJECT_ROOM_MS;
    expect(attempt?.options).toEqual({
      apiKey: ENV.E2B_API_KEY,
      requestTimeoutMs: 60_000,
      timeoutMs,
      metadata: {
        ...route.labels,
        runId: run.runId,
        runKey: expect.stringMatching(/^[a-f0-9]{16}$/),
      },
      envs: { [SUBJECT_ENV]: ENV[SUBJECT_ENV] },
      dpi: 96,
      lifecycle: { onTimeout: "kill" },
    });
    const receipts = parseSandboxReceipts(await runFile(run.runId, SANDBOX_RECEIPTS_ARTIFACT));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ laneId: "subject", provider: "e2b", timeoutMs });
    expect(fake.killed).toEqual(["synthetic-subject-1"]);
    expect(run.subjectKilled).toBe(true);
  });

  it("retries one transient create error and receipts only the sandbox it got", async () => {
    const fake = subjectModule({
      firstCreateError: new Error("2: [unavailable] synthetic envd not routable yet"),
    });
    const run = await route.run(cwd, fake.module);

    expect(fake.attempts).toHaveLength(2);
    expect(fake.attempts[1]?.options).toBe(fake.attempts[0]?.options);
    const receipts = parseSandboxReceipts(await runFile(run.runId, SANDBOX_RECEIPTS_ARTIFACT));
    expect(receipts.map((receipt) => receipt.laneId)).toEqual(["subject"]);
    expect(fake.killed).toEqual(["synthetic-subject-2"]);
    expect(run.subjectKilled).toBe(true);
  });

  it("prices its measured size over the span from create to release", async () => {
    let clock = Date.parse("2026-10-06T00:00:00.000Z");
    const fake = subjectModule({
      resources: { cpuCount: 4, memoryMB: 4096 },
      onKill: () => {
        clock += 5 * MINUTE_MS;
      },
    });
    const run = await route.run(cwd, fake.module, () => clock);

    const lines = await subjectCostLines(run.runId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "desktop-minutes",
      estimatedCostUsd: expect.any(Number),
      desktop: {
        minutes: 5,
        durationBasis: "host-acquired-to-cleanup",
        resources: { cpuCount: 4, memoryMiB: 4096 },
        resourceSource: "e2b.getInfo",
      },
    });
  });

  it("records why its size is unknown and leaves that line unpriced", async () => {
    const fake = subjectModule();
    const run = await route.run(cwd, fake.module);

    const lines = await subjectCostLines(run.runId);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.estimatedCostUsd).toBeNull();
    expect(lines[0]?.desktop).toMatchObject({ resourceUnavailableReason: "metadata_unavailable" });
  });

  it("records no release time and no confirmed kill when the SDK has no kill method", async () => {
    const fake = subjectModule({ canKill: false, resources: { cpuCount: 4, memoryMB: 4096 } });
    const run = await route.run(cwd, fake.module);

    expect(run.subjectKilled).toBe(false);
    expect(run.warnings.join("\n")).toContain(
      "Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the subject sandbox.",
    );
    const lines = await subjectCostLines(run.runId);
    expect(lines.map((line) => line.reason)).toEqual([
      expect.any(String),
      "desktop_lifetime_incomplete",
    ]);
    expect(lines[0]?.estimatedCostUsd).toBeNull();
    expect(lines[0]?.desktop).toMatchObject({ minutes: null });
  });
});
