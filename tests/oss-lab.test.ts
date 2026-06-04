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
  assessOssMetaLabProviderCapacity,
  buildOssMetaBootstrapScriptFixture,
  buildOssMetaBundleFixture,
  buildOssRepoAssignments,
  collectOssMetaLabPrivateEnv,
  collectOssMetaLabRemoteEnv,
  normalizeHostActorRecommendedProof,
  preflightOssMetaActorApiKey,
  runOssMetaLab
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

  it("fails provider capacity closed before exceeding headed desktop caps", () => {
    expect(assessOssMetaLabProviderCapacity({
      cap: 4,
      requested: 1,
      running: 3
    })).toMatchObject({
      cap: 4,
      ok: true,
      requested: 1,
      running: 3
    });

    const exceeded = assessOssMetaLabProviderCapacity({
      cap: 4,
      requested: 1,
      running: 4
    });
    expect(exceeded).toMatchObject({
      cap: 4,
      ok: false,
      requested: 1,
      running: 4
    });
    expect(exceeded.reason).toContain("Provider launch cap exceeded");
    expect(exceeded.reason).toContain("MIMETIC_OSS_META_MAX_RUNNING_DESKTOPS");
  });

  it("forwards only public-safe actor-control env flags into remote OSS meta-lab sandboxes", () => {
    expect(collectOssMetaLabRemoteEnv({
      CODEX_ACCESS_TOKEN: "must-not-forward-from-helper",
      CODEX_API_KEY: "must-not-forward-from-helper",
      E2B_API_KEY: "must-not-forward-from-helper",
      GH_TOKEN: "must-not-forward-from-helper",
      MIMETIC_OSS_META_ACTOR_FIRST: "1",
      MIMETIC_OSS_META_ACTOR_MODEL: "gpt-5.4-mini",
      MIMETIC_OSS_META_HOST_CODEX_ACTOR: "1",
      MIMETIC_OSS_META_ACTOR_TIMEOUT_MS: "240000",
      MIMETIC_OSS_META_REQUIRE_ACTOR: "1",
      OPENAI_API_KEY: "must-not-forward-from-helper"
    })).toEqual({
      MIMETIC_OSS_META_ACTOR_FIRST: "1",
      MIMETIC_OSS_META_ACTOR_MODEL: "gpt-5.4-mini",
      MIMETIC_OSS_META_HOST_CODEX_ACTOR: "1",
      MIMETIC_OSS_META_ACTOR_TIMEOUT_MS: "240000",
      MIMETIC_OSS_META_REQUIRE_ACTOR: "1"
    });
  });

  it("isolates provider secrets under Mimetic-private remote env names", () => {
    expect(collectOssMetaLabPrivateEnv({
      CODEX_ACCESS_TOKEN: "codex-access-token-test",
      E2B_API_KEY: "must-not-forward-to-remote-env",
      GH_TOKEN: "github-token-test",
      OPENAI_API_KEY: "openai-token-test"
    })).toEqual({
      MIMETIC_CODEX_ACCESS_TOKEN: "codex-access-token-test",
      MIMETIC_CODEX_API_KEY: "openai-token-test",
      MIMETIC_GITHUB_TOKEN: "github-token-test"
    });
  });

  it("classifies actor API-key quota/auth preflight failures without leaking keys", async () => {
    const fakeOpenAiKey = `sk-${"testsecretvalue1234567890abcd"}`;
    const response = new Response(JSON.stringify({
      error: {
        code: "insufficient_quota",
        message: `Quota exceeded for ${fakeOpenAiKey}.`
      }
    }), { status: 429 });

    const result = await preflightOssMetaActorApiKey({
      env: {
        OPENAI_API_KEY: fakeOpenAiKey,
        MIMETIC_OSS_META_ACTOR_PREFLIGHT_MODEL: "gpt-test"
      },
      fetchImpl: async () => response
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.reason).toContain("HTTP 429");
    expect(result.reason).toContain("[redacted-openai-key]");
    expect(result.reason).not.toContain(fakeOpenAiKey);
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

  it("allows OSS meta-lab dry-run lane counts above old magic caps", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-meta-count-"));
    try {
      const result = await runOssMetaLab({
        count: 65,
        cwd,
        dryRun: true,
        open: false,
        repos: ["developit/mitt", "lukeed/clsx"],
        runId: "oss-meta-count-65"
      });

      expect(result.ok).toBe(true);
      expect(result.count).toBe(65);
      expect(result.assignments).toHaveLength(65);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("normalizes host actor recommended proof to supported Mimetic flags", () => {
    expect(normalizeHostActorRecommendedProof(
      "Start Vite, then run mimetic run --app-url http://127.0.0.1:4173 --browser chromium --viewport desktop,mobile"
    )).toBe("Start the target app on a loopback URL, then run `mimetic run --app-url http://127.0.0.1:<port> --sims 2`.");

    expect(normalizeHostActorRecommendedProof(
      "Run mimetic run --app-url http://127.0.0.1:5173 --sims 2 after the app starts."
    )).toContain("mimetic run --app-url");
  });

  it("renders a bash-valid remote bootstrap script with app surfaces and optional required actor readback", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-bootstrap-script-"));
    const scriptPath = path.join(cwd, "bootstrap.sh");
    try {
      const script = buildOssMetaBootstrapScriptFixture();
      await writeFile(scriptPath, script, "utf8");
      await execFileAsync("bash", ["-n", scriptPath]);

      expect(script).toContain("start_target_app_surface");
      expect(script).toContain('npx mimetic run --app-url "$APP_URL" --sims 2');
      expect(script).toContain('open_browser_url "$APP_URL" app-desktop');
      expect(script).toContain("arrange_lab_windows");
      expect(script).toContain("visualStatus");
      expect(script).toContain("windowlower");
      expect(script).toContain("start_actor_attempt");
      expect(script).toContain("apply_host_actor_plan");
      expect(script).toContain("host_actor_plan=applied");
      expect(script).toContain("source=host-codex-plan");
      expect(script).toContain("reason=remote-actor-not-run");
      expect(script).toContain("mimetic/personas");
      expect(script).toContain("mimetic/scenarios");
      expect(script).toContain("MIMETIC_OSS_META_HOST_CODEX_ACTOR");
      expect(script).toContain("wait_for_actor_attempt_if_required");
      expect(script).toContain("MIMETIC_OSS_META_ACTOR_FIRST");
      expect(script).toContain("MIMETIC_OSS_META_REQUIRE_ACTOR");
      expect(script).toContain("MIMETIC_OSS_META_ACTOR_TIMEOUT_MS");
      expect(script).toContain("MIMETIC_OSS_META_ACTOR_MODEL");
      expect(script).toContain("actor_log_tail_begin");
      expect(script).toContain("@openai/codex@latest exec --ephemeral --ignore-user-config --skip-git-repo-check");
      expect(script).toContain("-m \\$actor_model_q");
      expect(script).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(script).toContain("--output-last-message");
      expect(script).toContain("CODEX_COMMAND=");
      expect(script).toContain('MIMETIC_PRIVATE_CODEX_API_KEY="${MIMETIC_CODEX_API_KEY:-}"');
      expect(script).toContain("unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN E2B_API_KEY GH_TOKEN GITHUB_TOKEN");
      expect(script).toContain('CODEX_API_KEY="\\$MIMETIC_PRIVATE_CODEX_API_KEY" timeout 240s bash -lc "\\$CODEX_COMMAND"');
      expect(script).toContain('CODEX_ACCESS_TOKEN="\\$MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN" timeout 240s bash -lc "\\$CODEX_COMMAND"');
      expect(script).toContain('MIMETIC_PRIVATE_CODEX_API_KEY="$MIMETIC_PRIVATE_CODEX_API_KEY" MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN="$MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN" nohup bash "$actor_script"');
      expect(script).toContain('MIMETIC_GITHUB_TOKEN_RUNTIME="$MIMETIC_PRIVATE_GITHUB_TOKEN" git clone');
      expect(script).not.toContain("command -v codex");
      expect(script).not.toContain("--ask-for-approval");
      expect(script).not.toContain('CODEX_API_KEY="\\$OPENAI_API_KEY"');
      expect(script).toContain('exit "\\$code"');
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
      mode: string;
      streams: Array<{
        terminal: { tail: string };
        ui: { route: string };
      }>;
    };
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.streams[0]?.terminal.tail).toContain("npx mimetic init --yes");
    expect(bundle.streams[0]?.terminal.tail).toContain("npx mimetic run --app-url");
    expect(bundle.streams[0]?.ui.route).toBe("e2b://desktop/developit/mitt");
  });

  it("fails live launch closed into waiting lanes when E2B is absent", async () => {
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
        mode: string;
        review: { verdict: string };
        simulations: Array<{ currentStep: string; status: string }>;
        streams: Array<{ embed: { kind: string }; status: string }>;
      };
      expect(bundle.mode).toBe("live");
      expect(bundle.review.verdict).toBe("blocked");
      expect(bundle.simulations[0]).toMatchObject({
        status: "blocked",
        currentStep: "Waiting for E2B_API_KEY before launching developit/mitt."
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

  it("fails actor-required live launch closed when Codex auth is absent", async () => {
    const previousE2b = process.env.E2B_API_KEY;
    const previousOpenai = process.env.OPENAI_API_KEY;
    const previousCodexApiKey = process.env.CODEX_API_KEY;
    const previousCodexAccessToken = process.env.CODEX_ACCESS_TOKEN;
    const previousActorFirst = process.env.MIMETIC_OSS_META_ACTOR_FIRST;
    const previousRequireActor = process.env.MIMETIC_OSS_META_REQUIRE_ACTOR;
    process.env.E2B_API_KEY = "fake-e2b-key";
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_ACCESS_TOKEN;
    process.env.MIMETIC_OSS_META_ACTOR_FIRST = "1";
    process.env.MIMETIC_OSS_META_REQUIRE_ACTOR = "1";

    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-meta-actor-auth-waiting-"));
      const result = await runCli([
        "lab",
        "oss",
        "--json",
        "--no-open",
        "--detach",
        "--cwd",
        cwd,
        "--run-id",
        "oss-meta-actor-auth-waiting-test",
        "--repos",
        "developit/mitt",
        "--count",
        "1"
      ]);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as { warnings: string[] };
      expect(json.warnings.join("\n")).toContain("CODEX_API_KEY or CODEX_ACCESS_TOKEN");

      const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", "oss-meta-actor-auth-waiting-test", "run.json"), "utf8")) as {
        simulations: Array<{ currentStep: string; status: string }>;
      };
      expect(bundle.simulations[0]).toMatchObject({
        status: "blocked",
        currentStep: "Waiting for CODEX_API_KEY or CODEX_ACCESS_TOKEN before launching developit/mitt."
      });
    } finally {
      if (previousE2b === undefined) delete process.env.E2B_API_KEY;
      else process.env.E2B_API_KEY = previousE2b;
      if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenai;
      if (previousCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = previousCodexApiKey;
      if (previousCodexAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
      else process.env.CODEX_ACCESS_TOKEN = previousCodexAccessToken;
      if (previousActorFirst === undefined) delete process.env.MIMETIC_OSS_META_ACTOR_FIRST;
      else process.env.MIMETIC_OSS_META_ACTOR_FIRST = previousActorFirst;
      if (previousRequireActor === undefined) delete process.env.MIMETIC_OSS_META_REQUIRE_ACTOR;
      else process.env.MIMETIC_OSS_META_REQUIRE_ACTOR = previousRequireActor;
    }
  });

  it("fails actor-required live launch closed before E2B when actor API quota preflight fails", async () => {
    const previousE2b = process.env.E2B_API_KEY;
    const previousOpenai = process.env.OPENAI_API_KEY;
    const previousCodexApiKey = process.env.CODEX_API_KEY;
    const previousCodexAccessToken = process.env.CODEX_ACCESS_TOKEN;
    const previousActorFirst = process.env.MIMETIC_OSS_META_ACTOR_FIRST;
    const previousRequireActor = process.env.MIMETIC_OSS_META_REQUIRE_ACTOR;
    const previousFetch = globalThis.fetch;
    const fakeOpenAiKey = `sk-${"testsecretvalue1234567890abcd"}`;
    process.env.E2B_API_KEY = "fake-e2b-key";
    process.env.OPENAI_API_KEY = fakeOpenAiKey;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_ACCESS_TOKEN;
    process.env.MIMETIC_OSS_META_ACTOR_FIRST = "1";
    process.env.MIMETIC_OSS_META_REQUIRE_ACTOR = "1";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: {
        code: "insufficient_quota",
        message: `Quota exceeded for ${fakeOpenAiKey}.`
      }
    }), { status: 429 })) as typeof fetch;

    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-meta-actor-preflight-"));
      const result = await runCli([
        "lab",
        "oss",
        "--json",
        "--no-open",
        "--detach",
        "--cwd",
        cwd,
        "--run-id",
        "oss-meta-actor-preflight-test",
        "--repos",
        "developit/mitt",
        "--count",
        "1"
      ]);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as { warnings: string[] };
      expect(json.warnings.join("\n")).toContain("actor API-key preflight blocked");
      expect(json.warnings.join("\n")).toContain("[redacted-openai-key]");
      expect(json.warnings.join("\n")).not.toContain("Invalid API key format");
      expect(json.warnings.join("\n")).not.toContain("sk-testsecretvalue");

      const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", "oss-meta-actor-preflight-test", "run.json"), "utf8")) as {
        review: { verdict: string };
        simulations: Array<{ currentStep: string; status: string }>;
      };
      expect(bundle.review.verdict).toBe("blocked");
      expect(bundle.simulations[0]).toMatchObject({
        status: "blocked",
        currentStep: "Waiting for Codex actor API quota/auth preflight before launching developit/mitt."
      });
      await rm(cwd, { recursive: true, force: true });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousE2b === undefined) delete process.env.E2B_API_KEY;
      else process.env.E2B_API_KEY = previousE2b;
      if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenai;
      if (previousCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = previousCodexApiKey;
      if (previousCodexAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
      else process.env.CODEX_ACCESS_TOKEN = previousCodexAccessToken;
      if (previousActorFirst === undefined) delete process.env.MIMETIC_OSS_META_ACTOR_FIRST;
      else process.env.MIMETIC_OSS_META_ACTOR_FIRST = previousActorFirst;
      if (previousRequireActor === undefined) delete process.env.MIMETIC_OSS_META_REQUIRE_ACTOR;
      else process.env.MIMETIC_OSS_META_REQUIRE_ACTOR = previousRequireActor;
    }
  });

  it("surfaces host actor plan artifacts even when provider launch fails", () => {
    const assignments = buildOssRepoAssignments(["reduxjs/redux-essentials-example-app"], 1);
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt: "2026-06-04T10:00:00.000Z",
      cwd: "/tmp/mimetic-oss-meta-fixture",
      dryRun: false,
      lanes: [
        {
          error: "Invalid API key format: expected [redacted-e2b-key].",
          hostActorPlan: {
            schema: "mimetic.oss-host-actor-plan.v1",
            generatedAt: "2026-06-04T10:00:00.000Z",
            personas: [
              {
                id: "learner",
                name: "Learner",
                intent: "Inspect the app as a synthetic user.",
                traits: ["public_safe"]
              }
            ],
            recommendedProof: "Start the app, then run mimetic run --app-url http://127.0.0.1:5173 --sims 2.",
            repo: "reduxjs/redux-essentials-example-app",
            scenarios: [
              {
                id: "desktop-smoke",
                title: "Desktop smoke",
                goal: "Verify the app loads.",
                steps: ["Open the app.", "Check the primary UI."]
              }
            ],
            source: "local-codex-exec",
            status: "passed",
            summary: "Host actor authored a public-safe plan."
          },
          hostActorPlanPath: "host-actors/redux/actor-plan.json",
          repo: "reduxjs/redux-essentials-example-app",
          simId: "oss-01",
          streamId: "oss-01-desktop"
        }
      ],
      liveRequested: true,
      missingKeys: [],
      runId: "oss-meta-host-plan-failed-launch"
    });

    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "host Codex actor plan",
      path: "host-actors/redux/actor-plan.json",
      kind: "trace"
    });
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

    expect(bundle.mode).toBe("live");
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

    expect(bundle.mode).toBe("live");
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
