// Computer use and shared world check the run directory again after caller code runs with this
// process's file access: an Observer renderer that reports success, and the caller's prepareDesktop
// on each desktop. A link planted in the run directory stops the run there, as it does on the
// scripted and terminal routes.

import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderObserver } from "../../src/observer/render.js";
import { parseStudy } from "../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import type { StudyDeps } from "../../src/study/study-deps.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../src/substrates/e2b/sdk.js";
import { runComputerUse, runSharedWorld } from "../helpers/route-run.js";

const ENV = {
  OPENAI_API_KEY: "synthetic-openai-key",
  E2B_API_KEY: "synthetic-e2b-key",
} as const;
const LINK_REFUSED = /must not contain symbolic links/;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-desktop-path-checks-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Plants a link inside the run directory, pointing back at the project. */
async function plantLink(runId: string): Promise<void> {
  await symlink(cwd, path.join(cwd, ".humanish", "runs", runId, "planted-link"));
}

function parsed(study: Record<string, unknown>): StudyConfig {
  const result = parseStudy(study);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

function computerUseStudy(): StudyConfig {
  return parsed({
    schema: STUDY_SCHEMA,
    id: "path-checks-computer-use",
    route: "computer-use",
    mode: "live",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actor: { type: "openai-computer-use", mission: "Explore the app and stop." },
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    review: { analysis: false },
  });
}

function sharedWorldStudy(): StudyConfig {
  return parsed({
    schema: STUDY_SCHEMA,
    id: "path-checks-shared-world",
    route: "shared-world",
    mode: "live",
    subject: {
      source: "clone",
      exposure: "synthetic",
      repos: ["example-org/example-app"],
      serve: { start: "HOST=0.0.0.0 python3 server.py", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "seed", command: "python3 seed.py" }],
        checkpoint: [{ name: "task-count", command: "python3 checkpoint.py" }],
      },
    },
    actor: { type: "openai-computer-use", mission: "Add one task." },
    participants: [
      { id: "persona-01", persona: "persona-1" },
      { id: "persona-02", persona: "persona-2" },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
    review: { analysis: false },
  });
}

/** A renderer that renders the real Observer, then plants a link and reports success. */
const linkingRenderer: NonNullable<StudyDeps["renderObserver"]> = async (
  project,
  runId,
  options,
) => {
  const observer = await renderObserver(project, runId, options);
  await plantLink(runId);
  return observer;
};

describe("after a caller's Observer renderer returns", () => {
  it("computer use refuses a run directory the renderer left a link in", async () => {
    await expect(
      runComputerUse({
        cwd,
        config: computerUseStudy(),
        dryRun: true,
        deps: { renderObserver: linkingRenderer },
      }),
    ).rejects.toThrow(LINK_REFUSED);
  });

  it("shared world refuses a run directory the renderer left a link in", async () => {
    await expect(
      runSharedWorld({
        cwd,
        config: sharedWorldStudy(),
        dryRun: true,
        deps: { renderObserver: linkingRenderer },
      }),
    ).rejects.toThrow(LINK_REFUSED);
  });
});

/**
 * An E2B module whose sandboxes serve a clone subject: every step succeeds and the app answers
 * its readiness probe. `after` holds the commands each sandbox ran after the caller's
 * prepareDesktop returned for it.
 */
function recordingModule(hooked: Set<string>): {
  module: E2BDesktopModule;
  after: Map<string, string[]>;
} {
  const after = new Map<string, string[]>();
  let created = 0;
  const record = (id: string, command: string): void => {
    if (hooked.has(id)) after.set(id, [...(after.get(id) ?? []), command]);
  };
  const sandbox = (id: string): E2BDesktopSandbox =>
    ({
      sandboxId: id,
      commands: {
        run: async (command: string) => {
          record(id, command);
          if (command.includes("/status")) return { exitCode: 0, stdout: "0\n" };
          if (command.includes("curl")) return { exitCode: 0, stdout: "READY\n" };
          return { exitCode: 0, stdout: "" };
        },
      },
      files: {
        write: async (filePath: string) => {
          record(id, `write ${filePath}`);
        },
      },
      getHost: (port: number) => `${port}-${id}.e2b.app`,
    }) as unknown as E2BDesktopSandbox;
  return {
    module: {
      Sandbox: {
        create: async (
          _templateOrOptions: string | E2BDesktopCreateOptions,
          _options?: E2BDesktopCreateOptions,
        ) => sandbox(`synthetic-sandbox-${(created += 1)}`),
        kill: async () => true,
      },
    },
    after,
  };
}

/** Run deps whose sessions never start in these tests; reaching one fails the test. */
function liveDeps(module: E2BDesktopModule): StudyDeps {
  // Detached steps wait on this clock, which only moves when they sleep.
  let clock = 0;
  return {
    desktopModule: async () => module,
    runSession: async () => {
      throw new Error("a participant session started after the run directory changed");
    },
    detachedTimers: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    proberCadenceMs: 100_000,
    subjectPhaseSink: () => {},
  };
}

/** Plants a link in the project's one run directory, whatever its minted id. */
async function plantLinkInOnlyRun(): Promise<void> {
  const entries = await readdir(path.join(cwd, ".humanish", "runs"), { withFileTypes: true });
  const runs = entries.filter((entry) => entry.isDirectory());
  expect(runs).toHaveLength(1);
  await plantLink(runs[0]!.name);
}

describe("after a caller's prepareDesktop returns", () => {
  it("computer use stops the participant before its screen check", async () => {
    const hooked = new Set<string>();
    const { module, after } = recordingModule(hooked);
    await expect(
      runComputerUse({
        cwd,
        config: computerUseStudy(),
        dryRun: false,
        env: ENV,
        deps: liveDeps(module),
        prepareDesktop: async (desktop) => {
          await plantLinkInOnlyRun();
          hooked.add(desktop.sandboxId);
        },
      }),
    ).rejects.toThrow(LINK_REFUSED);
    expect(hooked.size).toBe(1);
    const screenChecks = [...after.values()]
      .flat()
      .filter((command) => command.includes("xdpyinfo"));
    expect(screenChecks).toEqual([]);
  });

  it("shared world stops before it provisions the subject", async () => {
    const hooked = new Set<string>();
    const { module, after } = recordingModule(hooked);
    const targets: string[] = [];
    await expect(
      runSharedWorld({
        cwd,
        config: sharedWorldStudy(),
        dryRun: false,
        env: ENV,
        deps: liveDeps(module),
        prepareDesktop: async (desktop, target) => {
          targets.push(target.kind);
          if (target.kind !== "subject") return;
          await plantLinkInOnlyRun();
          hooked.add(desktop.sandboxId);
        },
      }),
    ).rejects.toThrow(LINK_REFUSED);
    expect(targets).toEqual(["subject"]);
    expect(after.size).toBe(0);
  });
});
