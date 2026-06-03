import { CommanderError } from "commander";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OSS_REPOS,
  normalizeOssRepoSlugs,
  validateOssRepoSlug
} from "../src/oss-lab.js";
import { buildObserverData } from "../src/observer-data.js";
import {
  buildOssMetaBootstrapScriptFixture,
  buildOssMetaBundleFixture,
  buildOssRepoAssignments
} from "../src/oss-meta-lab.js";
import type { OssMetaLabResult } from "../src/oss-meta-lab.js";
import {
  createProgram,
  exitCodeForOssMetaLab,
  shouldForceExitAfterOssMetaLab
} from "../src/program.js";

const execFileAsync = promisify(execFile);

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
  for (const command of program.commands) {
    command.exitOverride();
    for (const nested of command.commands) {
      nested.exitOverride();
    }
  }

  try {
    await program.parseAsync(["node", "mimetic", ...args], { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return {
        exitCode: 0,
        stderr: stderr.join(""),
        stdout: stdout.join("")
      };
    }

    throw error;
  }

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join("")
  };
}

describe("OSS lab command", () => {
  function liveMetaResult(overrides: Partial<OssMetaLabResult> = {}): OssMetaLabResult {
    return {
      schema: "mimetic.oss-meta-lab-result.v1",
      ok: true,
      assignments: [],
      count: 1,
      cwd: "/tmp/mimetic",
      dryRun: false,
      liveRequested: true,
      repos: ["developit/mitt"],
      runId: "oss-live-fixture",
      sandboxes: [
        {
          bootstrapStatus: "started",
          completionStatus: "passed",
          repo: "developit/mitt",
          streamId: "oss-01-desktop",
          urlPresent: true
        }
      ],
      warnings: [],
      ...overrides
    };
  }

  it("force-exits live OSS meta-lab JSON and detach modes after stream handles are created", () => {
    const result = liveMetaResult();

    expect(shouldForceExitAfterOssMetaLab(result, { detach: false, wantsMachine: true })).toBe(true);
    expect(shouldForceExitAfterOssMetaLab(result, { detach: true, wantsMachine: false })).toBe(true);
    expect(shouldForceExitAfterOssMetaLab(result, { detach: false, wantsMachine: false })).toBe(false);

    expect(shouldForceExitAfterOssMetaLab(liveMetaResult({
      ok: false,
      error: {
        code: "MIMETIC_META_RUN_FAILED",
        message: "OSS meta-lab failed 2/4 live desktop or bootstrap launches."
      },
      sandboxes: [
        {
          completionStatus: "passed",
          repo: "developit/mitt",
          streamId: "oss-01-desktop",
          urlPresent: true
        },
        {
          repo: "lukeed/clsx",
          streamId: "oss-02-desktop",
          urlPresent: false
        },
        {
          completionStatus: "timed_out",
          repo: "ai/nanoid",
          streamId: "oss-04-desktop",
          urlPresent: true
        }
      ]
    }), { detach: false, wantsMachine: true })).toBe(true);
  });

  it("preserves failed live OSS meta-lab exit codes through the force-exit path", () => {
    expect(exitCodeForOssMetaLab(liveMetaResult())).toBe(0);
    expect(exitCodeForOssMetaLab(liveMetaResult({
      ok: false,
      error: {
        code: "MIMETIC_META_RUN_FAILED",
        message: "OSS meta-lab failed 2/4 live desktop or bootstrap launches."
      }
    }))).toBe(2);
  });

  it("does not force-exit OSS meta-lab runs without live stream handles or machine/detach mode", () => {
    expect(shouldForceExitAfterOssMetaLab(liveMetaResult({ dryRun: true, liveRequested: false }), {
      detach: false,
      wantsMachine: true
    })).toBe(false);
    expect(shouldForceExitAfterOssMetaLab(liveMetaResult({ sandboxes: [{ repo: "developit/mitt", streamId: "oss-01-desktop", urlPresent: false }] }), {
      detach: false,
      wantsMachine: true
    })).toBe(false);
  });

  it("keeps default repo selection lightweight and public", () => {
    expect(normalizeOssRepoSlugs(undefined)).toEqual([...DEFAULT_OSS_REPOS]);
    expect(normalizeOssRepoSlugs([" developit/mitt ", "developit/mitt", "lukeed/clsx"])).toEqual([
      "developit/mitt",
      "lukeed/clsx"
    ]);
    expect(normalizeOssRepoSlugs(["developit/mitt,lukeed/clsx"])).toEqual([
      "developit/mitt",
      "lukeed/clsx"
    ]);
  });

  it("accepts only GitHub owner/repo slugs", () => {
    expect(validateOssRepoSlug("developit/mitt")).toBe(true);
    expect(validateOssRepoSlug("sindresorhus/is-plain-obj")).toBe(true);
    expect(validateOssRepoSlug("https://github.com/developit/mitt")).toBe(false);
    expect(validateOssRepoSlug("git@github.com:developit/mitt.git")).toBe(false);
    expect(validateOssRepoSlug("../private/repo")).toBe(false);
  });

  it("assigns repos across requested headed desktop lanes", () => {
    expect(buildOssRepoAssignments(["developit/mitt", "lukeed/clsx"], 4).map((assignment) => assignment.repo)).toEqual([
      "developit/mitt",
      "lukeed/clsx",
      "developit/mitt",
      "lukeed/clsx"
    ]);
  });

  it("renders a bash-valid remote bootstrap script with app surfaces before nonblocking actor attempt", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-bootstrap-script-"));
    const scriptPath = path.join(cwd, "bootstrap.sh");
    try {
      const script = buildOssMetaBootstrapScriptFixture();
      await writeFile(scriptPath, script, "utf8");
      await execFileAsync("bash", ["-n", scriptPath]);

      expect(script).toContain("start_target_app_surface");
      expect(script).toContain('open_browser_url "$APP_URL" app-desktop');
      expect(script).toContain("arrange_lab_windows");
      expect(script).toContain("visualStatus");
      expect(script).toContain("windowlower");
      expect(script).toContain("start_actor_attempt");
      expect(script).not.toContain("run_tui");
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });

  it("exposes lab oss help as the Observer-of-Observers meta-lab", async () => {
    const result = await runCli(["lab", "oss", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: mimetic lab oss");
    expect(result.stdout).toContain("Watch headed Codex/E2B meta-sims setting up Mimetic inside authorized repos");
    expect(result.stdout).toContain("--repos");
    expect(result.stdout).toContain("Observer-of-Observers");
    expect(result.stdout).toContain("mimetic lab oss-smoke");
  });

  it("keeps disposable-clone safety on lab oss-smoke", async () => {
    const result = await runCli(["lab", "oss-smoke", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: mimetic lab oss-smoke");
    expect(result.stdout).toContain("Clone lightweight public OSS repos");
    expect(result.stdout).toContain("--keep");
    expect(result.stdout).toContain("removed by default");
  });

  it("renders a no-network OSS meta-lab contract from --repos", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-meta-"));
    const result = await runCli([
      "lab",
      "oss",
      "--dry-run",
      "--json",
      "--no-open",
      "--cwd",
      cwd,
      "--run-id",
      "oss-meta-test",
      "--repos",
      "developit/mitt,lukeed/clsx",
      "--count",
      "4"
    ]);

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout) as {
      assignments: Array<{ repo: string }>;
      observer: { observerPath: string };
      schema: string;
    };
    expect(json.schema).toBe("mimetic.oss-meta-lab-result.v1");
    expect(json.assignments.map((assignment) => assignment.repo)).toEqual([
      "developit/mitt",
      "lukeed/clsx",
      "developit/mitt",
      "lukeed/clsx"
    ]);
    expect(json.observer.observerPath).toBe(".mimetic/runs/oss-meta-test/observer/index.html");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", "oss-meta-test", "run.json"), "utf8")) as {
      streams: Array<{
        terminal: { tail: string };
        ui: { route: string };
      }>;
    };
    expect(bundle.streams[0]?.terminal.tail).toContain("npx mimetic init --yes");
    expect(bundle.streams[0]?.ui.route).toBe("e2b://desktop/developit/mitt");
  });

  it("fails live launch closed into waiting lanes when keys are absent", async () => {
    const previousE2b = process.env.E2B_API_KEY;
    const previousOpenai = process.env.OPENAI_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-meta-waiting-"));
      const result = await runCli([
        "lab",
        "oss",
        "--json",
        "--no-open",
        "--detach",
        "--cwd",
        cwd,
        "--run-id",
        "oss-meta-waiting-test",
        "--repos",
        "developit/mitt",
        "--count",
        "1"
      ]);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as {
        sandboxes: Array<{ bootstrapStatus?: string; urlPresent: boolean }>;
        warnings: string[];
      };
      expect(json.sandboxes).toEqual([]);
      expect(json.warnings.join("\n")).toContain("waiting on env vars");

      const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", "oss-meta-waiting-test", "run.json"), "utf8")) as {
        review: { verdict: string };
        simulations: Array<{ currentStep: string; status: string }>;
        streams: Array<{ embed: { kind: string }; status: string }>;
      };
      expect(bundle.review.verdict).toBe("blocked");
      expect(bundle.simulations[0]).toMatchObject({
        status: "blocked",
        currentStep: "Waiting for E2B_API_KEY, OPENAI_API_KEY before launching developit/mitt."
      });
      expect(bundle.streams[0]).toMatchObject({
        status: "blocked",
        embed: { kind: "placeholder" }
      });
    } finally {
      if (previousE2b === undefined) {
        delete process.env.E2B_API_KEY;
      } else {
        process.env.E2B_API_KEY = previousE2b;
      }
      if (previousOpenai === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenai;
      }
    }
  });

  it("renders public-safe terminal completion states without live provider spend", () => {
    const assignments = buildOssRepoAssignments(["developit/mitt", "lukeed/clsx"], 2);
    const createdAt = "2026-06-02T08:30:00.000Z";
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt,
      cwd: "/tmp/mimetic-oss-meta-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "tui-attempted",
            completionPath: "/remote/developit-mitt/completion.json",
            logPath: "/remote/developit-mitt/bootstrap.log",
            mimeticPackageUploaded: true,
            nestedObserverPath: "/remote/developit-mitt/repo/.mimetic/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started"
          },
          completion: {
            actorLogPath: "/remote/developit-mitt/actor.log",
            actorPid: 4321,
            actorStatus: "running",
            appLogPath: "/remote/developit-mitt/app.log",
            appPid: 1234,
            appReason: "target app responded at http://127.0.0.1:5173",
            appStatus: "running",
            appUrl: "http://127.0.0.1:5173",
            checkedAt: "2026-06-02T08:31:00.000Z",
            exitCode: 0,
            logTail: "nested verify passed\n== bootstrap complete ==",
            nestedObserverPresent: true,
            nestedVerifyPassed: true,
            reason: "Nested Mimetic proof completed and nested Observer path was checked.",
            status: "passed",
            visualReason: "Detected 3 visible Chrome windows including nested Observer.",
            visualStatus: "visible",
            visualWindowCount: 3
          },
          repo: "developit/mitt",
          screenshot: {
            capturedAt: "2026-06-02T08:31:05.000Z",
            observerUrl: "../screenshots/oss-01-desktop.png",
            path: "screenshots/oss-01-desktop.png"
          },
          simId: assignments[0]?.simId ?? "oss-01",
          streamId: assignments[0]?.streamId ?? "oss-01-desktop",
          url: "https://stream.example/developit-mitt"
        },
        {
          bootstrap: {
            codexMode: "tui-attempted",
            completionPath: "/remote/lukeed-clsx/completion.json",
            logPath: "/remote/lukeed-clsx/bootstrap.log",
            mimeticPackageUploaded: true,
            nestedObserverPath: "/remote/lukeed-clsx/repo/.mimetic/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started"
          },
          completion: {
            checkedAt: "2026-06-02T08:31:10.000Z",
            exitCode: 1,
            logTail: "npx mimetic verify --run latest\nverification failed",
            nestedObserverPresent: false,
            nestedVerifyPassed: false,
            reason: "Bootstrap exited before nested Mimetic proof completed.",
            status: "failed"
          },
          repo: "lukeed/clsx",
          simId: assignments[1]?.simId ?? "oss-02",
          streamId: assignments[1]?.streamId ?? "oss-02-desktop",
          url: "https://stream.example/lukeed-clsx"
        }
      ],
      liveRequested: true,
      missingKeys: [],
      runId: "oss-meta-completion-fixture"
    });

    expect(bundle.simulations.map((sim) => sim.status)).toEqual(["passed", "failed"]);
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("failed");
    expect(bundle.streams.map((stream) => stream.status)).toEqual(["passed", "failed"]);
    expect(bundle.streams[0]?.completion).toMatchObject({
      actorStatus: "running",
      appStatus: "running",
      appUrl: "http://127.0.0.1:5173",
      nestedObserverPresent: true,
      nestedVerifyPassed: true,
      status: "passed",
      visualStatus: "visible",
      visualWindowCount: 3
    });
    expect(bundle.streams[0]).toMatchObject({
      transport: "sse",
      embed: { kind: "screenshot", url: "../screenshots/oss-01-desktop.png" },
      ui: {
        appStatus: "running",
        appUrl: "http://127.0.0.1:5173",
        screenshotUrl: "../screenshots/oss-01-desktop.png",
        visualStatus: "visible"
      }
    });
    expect(bundle.streams[0]?.url).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain("https://stream.example");
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "desktop screenshot",
      path: "screenshots/oss-01-desktop.png",
      kind: "screenshot"
    });
    expect(bundle.streams[1]?.terminal?.tail).toContain("verification failed");
    expect(bundle.events.map((event) => event.type)).toContain("oss-meta.bootstrap.passed");
    expect(bundle.events.map((event) => event.type)).toContain("oss-meta.bootstrap.failed");

    const observerData = buildObserverData(bundle, "2026-06-02T08:32:00.000Z");
    expect(observerData.summary.active).toBe(0);
    expect(observerData.summary.blocked).toBe(1);
    expect(observerData.streams.map((stream) => stream.statusLabel)).toEqual(["Passed", "Failed"]);
  });

  it("marks OSS meta-lab timeout completions as non-green review evidence", () => {
    const assignments = buildOssRepoAssignments(["sindresorhus/is-plain-obj"], 1);
    const createdAt = "2026-06-02T09:30:00.000Z";
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt,
      cwd: "/tmp/mimetic-oss-meta-timeout-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "tui-attempted",
            completionPath: "/remote/is-plain-obj/completion.json",
            logPath: "/remote/is-plain-obj/bootstrap.log",
            mimeticPackageUploaded: true,
            nestedObserverPath: "/remote/is-plain-obj/repo/.mimetic/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started"
          },
          completion: {
            checkedAt: "2026-06-02T09:34:00.000Z",
            reason: "Timed out waiting 240000ms for remote bootstrap completion marker.",
            status: "timed_out"
          },
          repo: "sindresorhus/is-plain-obj",
          simId: assignments[0]?.simId ?? "oss-01",
          streamId: assignments[0]?.streamId ?? "oss-01-desktop",
          url: "https://stream.example/is-plain-obj"
        }
      ],
      liveRequested: true,
      missingKeys: [],
      runId: "oss-meta-timeout-fixture"
    });

    expect(bundle.review.verdict).toBe("timed_out");
    expect(bundle.review.summary).toContain("timed out");
    expect(bundle.simulations.map((sim) => sim.status)).toEqual(["timed_out"]);
    expect(bundle.streams.map((stream) => stream.status)).toEqual(["timed_out"]);

    const observerData = buildObserverData(bundle, "2026-06-02T09:35:00.000Z");
    expect(observerData.summary.active).toBe(0);
    expect(observerData.summary.blocked).toBe(1);
    expect(observerData.streams.map((stream) => stream.statusLabel)).toEqual(["Timed out"]);
  });

  it("redacts private repo labels and live stream URLs from durable OSS meta-lab bundles", () => {
    const assignments = buildOssRepoAssignments(["maintainer/private-app"], 1);
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt: "2026-06-02T10:30:00.000Z",
      cwd: "/tmp/mimetic-oss-meta-private-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "tui-attempted",
            completionPath: "/remote/repo-01/completion.json",
            logPath: "/remote/repo-01/bootstrap.log",
            mimeticPackageUploaded: true,
            nestedObserverPath: "/remote/repo-01/repo/.mimetic/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started",
            terminalTitle: "Mimetic 1 repo-01"
          },
          completion: {
            appStatus: "running",
            appUrl: "http://127.0.0.1:3000",
            checkedAt: "2026-06-02T10:31:00.000Z",
            nestedObserverPresent: true,
            nestedVerifyPassed: true,
            reason: "Target app surface, nested Mimetic proof, and nested Observer were checked.",
            status: "passed",
            visualStatus: "visible",
            visualWindowCount: 3
          },
          repo: "repo-01",
          simId: assignments[0]?.simId ?? "oss-01",
          streamId: assignments[0]?.streamId ?? "oss-01-desktop",
          url: "https://stream.example/auth-key-should-not-persist"
        }
      ],
      liveRequested: true,
      missingKeys: [],
      redactRepoNames: true,
      runId: "oss-meta-private-fixture"
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).toContain("repo-01");
    expect(serialized).not.toContain("maintainer/private-app");
    expect(serialized).not.toContain("stream.example");
    expect(bundle.streams[0]?.url).toBeUndefined();
    expect(bundle.streams[0]?.label).toBe("E2B desktop - repo-01");
  });
});
