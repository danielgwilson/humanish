// The execution failures computer use and shared world record when participants fail in the
// harness, leave a provider's cleanup unconfirmed, report a disallowed item after their last
// request, or leave a sandbox unreleased. Both routes list them by kind in that order, and
// participants in plan order within each kind. Shared world puts its run error first and its
// subject sandbox last. These read status.json, so they hold whichever code builds the list.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../src/actors/computer-use/actor.js";
import type { CuaExecutor, CuaProvider } from "../../src/actors/computer-use/loop.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES } from "../../src/actors/computer-use/openai-provider.js";
import { createRestrictedCodexParticipant } from "../../src/actors/codex/restricted-participant.js";
import type { DesktopParticipantRun } from "../../src/routes/computer-use/types.js";
import type { ParticipantDesktop } from "../../src/routes/computer-use/participant-desktop.js";
import { parseStudy } from "../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import type { StudyDeps } from "../../src/study/study-deps.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../src/substrates/e2b/sdk.js";
import { runComputerUse, runSharedWorld } from "../helpers/route-run.js";

vi.mock("../../src/routes/computer-use/e2b-desktop/desktop.js", () => ({
  createE2BParticipantDesktop: vi.fn((spec: DesktopParticipantRun) => unreleasedDesktop(spec)),
}));
vi.mock("../../src/actors/codex/restricted-participant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/actors/codex/restricted-participant.js")>()),
  createRestrictedCodexParticipant: vi.fn(),
}));
// The local CLIs are not installed here; their readiness is tested on its own.
vi.mock("../../src/actors/local-agent/readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/actors/local-agent/readiness.js")>()),
  localAgentRefusal: vi.fn(async () => undefined),
}));

const CODEX = { type: "local-agent", localAgent: "codex" };
const ENV = {
  OPENAI_API_KEY: "synthetic-openai-key",
  E2B_API_KEY: "synthetic-e2b-key",
  DATABASE_URL: "postgres://synthetic-database",
} as const;
const UNRELEASED = "Sandbox release is unconfirmed.";

function doneProvider(): CuaProvider {
  return {
    id: "codex-participant",
    capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
    nextTurn: async () => ({
      actions: [],
      message: "Done.",
      outcome: "reached",
      pendingSafetyChecks: [],
      done: true,
    }),
  };
}

function fakeExecutor(): CuaExecutor {
  const screenshot = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  return {
    observe: async () => ({
      screenshot,
      stateSignature: "page",
      text: "Notes",
      url: "http://127.0.0.1:3000/",
    }),
    execute: async () => undefined,
  };
}

/** A participant desktop whose sandbox release the provider never confirms. */
function unreleasedDesktop(spec: DesktopParticipantRun): ParticipantDesktop {
  return {
    prepare: async () => undefined,
    openSession: async () => ({ executor: fakeExecutor() }),
    finalize: async () => undefined,
    snapshot: () => ({
      released: false,
      sandboxId: `synthetic-sandbox-${spec.planned.id}`,
      sandboxRelease: { state: "unconfirmed", warning: UNRELEASED },
      streamUrlPresent: false,
      stateStepRecords: [],
      phaseRecords: [],
    }),
  };
}

/**
 * The provisioned plane's one subject sandbox, whose kill answers with something other than a
 * boolean, so its release is unconfirmed. With `hostFails`, exposing the served app fails, which
 * ends the plane with a run error before any participant starts.
 */
function unreleasedSubjectModule(hostFails = false): E2BDesktopModule {
  let reads = 0;
  const handle = (command: string): { exitCode?: number; stdout?: string } => {
    if (command.includes("/status")) return { stdout: "0" };
    if (command.includes("curl")) return { stdout: "READY" };
    if (command.includes("checkpoint-") && command.includes("tail -c"))
      return { stdout: `world=${(reads += 1)}\n` };
    return { exitCode: 0, stdout: "" };
  };
  const sandbox = {
    sandboxId: "synthetic-subject-sandbox",
    commands: { run: async (command: string) => ({ exitCode: 0, ...handle(command) }) },
    files: { write: async () => undefined },
    getHost: (port: number) => {
      if (hostFails) throw new Error("synthetic getHost failure");
      return `${port}-synthetic-subject-sandbox.e2b.app`;
    },
  } as unknown as E2BDesktopSandbox;
  return {
    Sandbox: {
      create: async (_template: string | E2BDesktopCreateOptions) => sandbox,
      kill: async () => "ok" as unknown as boolean,
    },
  } as unknown as E2BDesktopModule;
}

function seams(desktopModule: E2BDesktopModule): StudyDeps {
  return {
    desktopModule: async () => desktopModule,
    detachedTimers: { now: () => 0, sleep: async () => {} },
    proberCadenceMs: 100_000,
    readLobbyCodeFromFrame: async () => undefined,
    subjectPhaseSink: () => {},
  };
}

/**
 * A session runner where every session waits until `together` have started, so concurrent
 * participants overlap, and the participant whose persona is `throwsFor` fails in the harness.
 */
function sessions(together: number, throwsFor: string, holdMs = 15) {
  let started = 0;
  let release: () => void = () => {};
  const everyone = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (options: CuaActorSessionOptions) => {
    started += 1;
    if (started >= together) release();
    await everyone;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, holdMs);
    });
    if (options.persona.id === throwsFor) throw new Error("synthetic harness failure");
    return runCuaActorSession(options);
  };
}

function parsed(study: Record<string, unknown>): StudyConfig {
  const result = parseStudy(study);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

function provisionedStudy() {
  return parsed({
    schema: STUDY_SCHEMA,
    id: "execution-failures-shared-world",
    route: "shared-world",
    mode: "live",
    subject: {
      source: "clone",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: {
        install: "pnpm install",
        start: "pnpm start -H 0.0.0.0",
        url: "http://127.0.0.1:3000/",
      },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [{ name: "notes-count", command: "psql query notes" }],
      },
    },
    actor: { ...CODEX, mission: "Use the shared app." },
    participants: [
      { id: "persona-01", persona: "persona-1" },
      { id: "persona-02", persona: "persona-2" },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
    review: { analysis: false },
  });
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-execution-failures-"));
  // Every participant's provider leaves its cleanup unconfirmed and reports a disallowed item.
  vi.mocked(createRestrictedCodexParticipant).mockImplementation(
    () =>
      ({
        provider: doneProvider(),
        close: async () => ({
          status: "unconfirmed" as const,
          refusal: "codex_tool_call" as const,
        }),
      }) as unknown as ReturnType<typeof createRestrictedCodexParticipant>,
  );
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

interface Failure {
  kind: string;
  message: string;
}

/** The execution failures and warnings the finished run's status.json records. */
async function recorded(runId: string): Promise<{ failures: Failure[]; warnings: Failure[] }> {
  const status = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", runId, "status.json"), "utf8"),
  ) as { outcome: { execution: { failures?: Failure[]; warnings?: Failure[] } } };
  return {
    failures: status.outcome.execution.failures ?? [],
    warnings: status.outcome.execution.warnings ?? [],
  };
}

const POLICY =
  "Codex reported a disallowed item after the participant's last request (codex_tool_call).";
const CLEANUP = "Model provider cleanup is unconfirmed.";
const reclaim = (owner: string, runId: string) =>
  `${owner}: ${UNRELEASED} Reclaim it by recorded id with \`humanish reclaim --run ${runId}\`.`;

describe("computer use records its participants' execution failures by kind", () => {
  it("harness, provider cleanup and provider policy fail the run; unreleased sandboxes warn", async () => {
    const result = await runComputerUse({
      cwd,
      config: parsed({
        schema: STUDY_SCHEMA,
        id: "execution-failures-computer-use",
        route: "computer-use",
        mode: "live",
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
        actor: { ...CODEX, mission: "Save a note." },
        participants: [
          { id: "first", persona: "first-time-visitor" },
          { id: "second", persona: "impatient-skimmer" },
        ],
        execution: { target: "e2b-desktop", timeoutMs: 60_000 },
        review: { analysis: false },
      }),
      dryRun: false,
      env: ENV,
      deps: { ...seams(unreleasedSubjectModule()), runSession: sessions(2, "impatient-skimmer") },
    });
    expect(result.ok).toBe(false);
    const { failures, warnings } = await recorded(result.runId);
    expect(failures).toEqual([
      { kind: "harness", message: "second: synthetic harness failure" },
      { kind: "provider-cleanup", message: `first: ${CLEANUP}` },
      { kind: "provider-cleanup", message: `second: ${CLEANUP}` },
      { kind: "provider-policy", message: `first: ${POLICY}` },
      { kind: "provider-policy", message: `second: ${POLICY}` },
    ]);
    expect(warnings).toEqual([
      { kind: "sandbox-cleanup", message: reclaim("first", result.runId) },
      { kind: "sandbox-cleanup", message: reclaim("second", result.runId) },
    ]);
  });
});

describe("shared world records its run error first and its subject sandbox last", () => {
  it("participants' failures by kind, then their sandboxes and the subject's", async () => {
    const result = await runSharedWorld({
      cwd,
      config: provisionedStudy(),
      dryRun: false,
      env: ENV,
      deps: { ...seams(unreleasedSubjectModule()), runSession: sessions(2, "persona-2") },
    });
    expect(result.ok).toBe(false);
    const { failures, warnings } = await recorded(result.runId);
    expect(failures).toEqual([
      { kind: "harness", message: "persona-02: synthetic harness failure" },
      { kind: "provider-cleanup", message: `persona-01: ${CLEANUP}` },
      { kind: "provider-cleanup", message: `persona-02: ${CLEANUP}` },
      { kind: "provider-policy", message: `persona-01: ${POLICY}` },
      { kind: "provider-policy", message: `persona-02: ${POLICY}` },
    ]);
    expect(warnings.map((warning) => warning.kind)).toEqual([
      "sandbox-cleanup",
      "sandbox-cleanup",
      "sandbox-cleanup",
    ]);
    expect(warnings.slice(0, 2)).toEqual([
      { kind: "sandbox-cleanup", message: reclaim("persona-01", result.runId) },
      { kind: "sandbox-cleanup", message: reclaim("persona-02", result.runId) },
    ]);
    expect(warnings[2]!.message).toMatch(/^subject: /);
  });

  it("a run error comes before the subject sandbox it left unreleased", async () => {
    const result = await runSharedWorld({
      cwd,
      config: provisionedStudy(),
      dryRun: false,
      env: ENV,
      deps: { ...seams(unreleasedSubjectModule(true)), runSession: sessions(2, "") },
    });
    expect(result.ok).toBe(false);
    const { failures, warnings } = await recorded(result.runId);
    expect(failures.map((failure) => failure.kind)).toEqual(["run", "evidence"]);
    expect(failures[0]!.message).toBe("synthetic getHost failure");
    expect(warnings.map((warning) => warning.kind)).toEqual(["sandbox-cleanup"]);
    expect(warnings[0]!.message).toMatch(/^subject: /);
  });

  it("an external-public run error comes before the participants' failures", async () => {
    const result = await runSharedWorld({
      cwd,
      config: parsed({
        schema: STUDY_SCHEMA,
        id: "execution-failures-external-public",
        route: "shared-world",
        mode: "live",
        subject: {
          source: "app-url",
          appUrl: "https://lobby-trivia.example.test/",
          publicTarget: { owner: "example-operator/lobby-trivia", authorized: true },
        },
        policies: { allowPublicTargets: true },
        actor: { ...CODEX, mission: "Play the example multiplayer app with your friends." },
        participants: [
          { id: "host", host: true, persona: "party-host", instruction: "Create a lobby." },
          { id: "player-2", persona: "casual-friend", instruction: "Join the lobby." },
        ],
        execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
        review: { analysis: false },
      }),
      dryRun: false,
      env: ENV,
      // The host never shows a lobby code and outlasts the handoff deadline, so the follower
      // stops before opening and the plane reports the timeout as its run error.
      deps: {
        ...seams(unreleasedSubjectModule()),
        handoffDeadlineMs: 20,
        runSession: sessions(1, "", 200),
      },
    });
    expect(result.ok).toBe(false);
    const { failures, warnings } = await recorded(result.runId);
    // The Observer's evidence failure follows: the renderer adds it after the route's list.
    expect(failures.map((failure) => failure.kind)).toEqual([
      "run",
      "harness",
      "provider-cleanup",
      "provider-policy",
      "evidence",
    ]);
    expect(failures[0]!.message).toMatch(/handoff deadline/);
    expect(failures[1]!.message).toMatch(/^player-2: handoff barrier: /);
    expect(failures.slice(2, 4)).toEqual([
      { kind: "provider-cleanup", message: `host: ${CLEANUP}` },
      { kind: "provider-policy", message: `host: ${POLICY}` },
    ]);
    expect(warnings).toEqual([{ kind: "sandbox-cleanup", message: reclaim("host", result.runId) }]);
  });
});
