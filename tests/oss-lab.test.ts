import { CommanderError } from "commander";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  buildOssRepoAssignments,
  cleanupOssMetaLabSandboxes,
  collectOssMetaLabPrivateEnv,
  collectOssMetaLabRemoteEnv,
  normalizeHostActorRecommendedProof,
  preflightOssMetaActorApiKey,
  preflightOssMetaRepoAccess,
  runOssMetaLab,
  sandboxIdsForOssMetaLabCleanup
} from "../src/oss-meta-lab.js";
import type { OssMetaLabResult } from "../src/oss-meta-lab.js";
import {
  createProgram,
  exitCodeForOssMetaLab,
  shouldForceExitAfterOssMetaLab,
  shouldServeOssMetaLabObserver
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
      repos: ["CorentinTh/it-tools"],
      runId: "oss-live-fixture",
      sandboxes: [
        {
          bootstrapStatus: "started",
          completionStatus: "passed",
          repo: "CorentinTh/it-tools",
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
          repo: "CorentinTh/it-tools",
          streamId: "oss-01-desktop",
          urlPresent: true
        },
        {
          repo: "maciekt07/TodoApp",
          streamId: "oss-02-desktop",
          urlPresent: false
        },
        {
          completionStatus: "timed_out",
          repo: "lissy93/dashy",
          streamId: "oss-04-desktop",
          urlPresent: true
        }
      ]
    }), { detach: false, wantsMachine: true })).toBe(true);
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

    expect(collectOssMetaLabPrivateEnv({
      GITHUB_PAT: "github-pat-test"
    })).toEqual({
      MIMETIC_GITHUB_TOKEN: "github-pat-test"
    });
  });

  it("preflights private GitHub repo clone access with askpass-scoped token auth after anonymous access fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-repo-preflight-"));
    const [assignment] = buildOssRepoAssignments(["example/private-fixture"], 1);
    if (!assignment) {
      throw new Error("Missing assignment.");
    }
    const calls: Array<{
      args: string[];
      env: NodeJS.ProcessEnv;
      file: string;
    }> = [];

    try {
      const result = await preflightOssMetaRepoAccess({
        assignments: [assignment],
        cwd,
        env: {
          GITHUB_TOKEN: "github-token-test"
        },
        execFileImpl: async (file, args, options) => {
          calls.push({
            args: args.map(String),
            env: options?.env ?? {},
            file
          });
          if (!options?.env?.MIMETIC_GITHUB_TOKEN_RUNTIME) {
            throw new Error("anonymous access rejected");
          }
          return { stderr: "", stdout: "" };
        }
      });

      expect(result).toEqual([expect.objectContaining({
        ok: true,
        reason: "GitHub repo clone access preflight passed with token auth after anonymous clone access failed.",
        tokenPresent: true
      })]);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.file).toBe("git");
      expect(calls[0]?.args).toEqual([
        "-c",
        "credential.helper=",
        "ls-remote",
        "--exit-code",
        "https://github.com/example/private-fixture.git",
        "HEAD"
      ]);
      expect(calls[0]?.env.GIT_ASKPASS).toBe("false");
      expect(calls[0]?.env.MIMETIC_GITHUB_TOKEN_RUNTIME).toBeUndefined();
      expect(calls[0]?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(calls[0]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(calls[1]?.env.GIT_ASKPASS).toContain("git-askpass-");
      expect(calls[1]?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(calls[1]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(calls[1]?.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(calls[1]?.env.MIMETIC_GITHUB_TOKEN_RUNTIME).toBe("github-token-test");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prefers anonymous repo access when token auth is present for a public repo", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-repo-preflight-fallback-"));
    const [assignment] = buildOssRepoAssignments(["example/public-fixture"], 1);
    if (!assignment) {
      throw new Error("Missing assignment.");
    }
    let calls = 0;
    const envs: NodeJS.ProcessEnv[] = [];

    try {
      const result = await preflightOssMetaRepoAccess({
        assignments: [assignment],
        cwd,
        env: {
          GIT_ASKPASS: "must-not-leak-to-fallback",
          GIT_CONFIG_COUNT: "1",
          GITHUB_TOKEN: "bad-token-test"
        },
        execFileImpl: async (_file, _args, options) => {
          calls += 1;
          envs.push(options.env ?? {});
          return { stderr: "", stdout: "" };
        }
      });

      expect(calls).toBe(1);
      expect(result).toEqual([expect.objectContaining({
        ok: true,
        reason: "GitHub repo clone access preflight passed with anonymous public clone access.",
        tokenPresent: true
      })]);
      expect(envs[0]?.GIT_ASKPASS).toBe("false");
      expect(envs[0]?.SSH_ASKPASS).toBe("false");
      expect(envs[0]?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(envs[0]?.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(envs[0]?.GIT_CONFIG_COUNT).toBeUndefined();
      expect(envs[0]?.GITHUB_TOKEN).toBeUndefined();
      expect(envs[0]?.MIMETIC_GITHUB_TOKEN_RUNTIME).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("classifies missing GitHub clone auth without leaking private repo labels when redacted", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-repo-preflight-fail-"));
    const [assignment] = buildOssRepoAssignments(["example/private-fixture"], 1);
    if (!assignment) {
      throw new Error("Missing assignment.");
    }

    try {
      const result = await preflightOssMetaRepoAccess({
        assignments: [assignment],
        cwd,
        env: {},
        redactRepoNames: true,
        execFileImpl: async () => {
          throw new Error("Command failed: git ls-remote https://github.com/example/private-fixture.git HEAD");
        }
      });

      expect(result).toEqual([expect.objectContaining({
        ok: false,
        tokenPresent: false
      })]);
      expect(result[0]?.reason).toContain("private repos need GH_TOKEN, GITHUB_TOKEN, or GITHUB_PAT");
      expect(result[0]?.reason).toContain("[redacted-authorized-repo]");
      expect(result[0]?.reason).not.toContain("example/private-fixture");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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

  it("serves the OSS meta-lab Observer when a failed live run still produced evidence", () => {
    const failedWithObserver = liveMetaResult({
      ok: false,
      error: {
        code: "MIMETIC_META_RUN_FAILED",
        message: "OSS meta-lab failed 4/4 live desktop or bootstrap launches."
      },
      observer: {
        schema: "mimetic.observer-result.v1",
        ok: true,
        cwd: "/tmp/mimetic",
        run: "oss-live-fixture",
        observerPath: ".mimetic/runs/oss-live-fixture/observer/index.html",
        observerDataPath: ".mimetic/runs/oss-live-fixture/observer/observer-data.json",
        warnings: []
      }
    });

    expect(shouldServeOssMetaLabObserver(failedWithObserver, { wantsFollow: true })).toBe(true);
    expect(shouldServeOssMetaLabObserver(failedWithObserver, { wantsFollow: false })).toBe(false);
  });

  it("does not force-exit OSS meta-lab runs without live stream handles or machine/detach mode", () => {
    expect(shouldForceExitAfterOssMetaLab(liveMetaResult({ dryRun: true, liveRequested: false }), {
      detach: false,
      wantsMachine: true
    })).toBe(false);
    expect(shouldForceExitAfterOssMetaLab(liveMetaResult({ sandboxes: [{ repo: "CorentinTh/it-tools", streamId: "oss-01-desktop", urlPresent: false }] }), {
      detach: false,
      wantsMachine: true
    })).toBe(false);
  });

  it("cleans up unique OSS meta-lab sandboxes from attached watch stop", async () => {
    const result = liveMetaResult({
      sandboxes: [
        { repo: "repo-01", sandboxId: "sandbox-a", streamId: "oss-01-desktop", urlPresent: true },
        { repo: "repo-02", sandboxId: "sandbox-b", streamId: "oss-02-desktop", urlPresent: true },
        { repo: "repo-02", sandboxId: "sandbox-b", streamId: "oss-02-desktop-retry", urlPresent: true },
        { repo: "repo-03", streamId: "oss-03-desktop", urlPresent: false }
      ]
    });
    const killed: string[] = [];

    expect(sandboxIdsForOssMetaLabCleanup(result)).toEqual(["sandbox-a", "sandbox-b"]);

    await expect(cleanupOssMetaLabSandboxes(result, {
      killSandbox: async (sandboxId) => {
        killed.push(sandboxId);
      },
      requestTimeoutMs: 123
    })).resolves.toEqual({
      killed: 2,
      skipped: 2,
      errors: []
    });
    expect(killed).toEqual(["sandbox-a", "sandbox-b"]);
  });

  it("keeps default repo selection lightweight and public", () => {
    expect(normalizeOssRepoSlugs(undefined)).toEqual([...DEFAULT_OSS_REPOS]);
    expect(normalizeOssRepoSlugs([" CorentinTh/it-tools ", "CorentinTh/it-tools", "drawdb-io/drawdb"])).toEqual([
      "CorentinTh/it-tools",
      "drawdb-io/drawdb"
    ]);
    expect(normalizeOssRepoSlugs(["CorentinTh/it-tools,drawdb-io/drawdb"])).toEqual([
      "CorentinTh/it-tools",
      "drawdb-io/drawdb"
    ]);
  });

  it("accepts only GitHub owner/repo slugs", () => {
    expect(validateOssRepoSlug("CorentinTh/it-tools")).toBe(true);
    expect(validateOssRepoSlug("maciekt07/TodoApp")).toBe(true);
    expect(validateOssRepoSlug("https://github.com/CorentinTh/it-tools")).toBe(false);
    expect(validateOssRepoSlug("git@github.com:CorentinTh/it-tools.git")).toBe(false);
    expect(validateOssRepoSlug("../private/repo")).toBe(false);
  });

  it("assigns repos across requested headed desktop lanes", () => {
    expect(buildOssRepoAssignments(["CorentinTh/it-tools", "drawdb-io/drawdb"], 4).map((assignment) => assignment.repo)).toEqual([
      "CorentinTh/it-tools",
      "drawdb-io/drawdb",
      "CorentinTh/it-tools",
      "drawdb-io/drawdb"
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
        repos: ["CorentinTh/it-tools", "drawdb-io/drawdb"],
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
      expect(script).toContain('npx --no-install mimetic run --app-url "$APP_URL" --sims 2');
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
      expect(script).toContain("ACTOR_TIMEOUT_SECONDS");
      expect(script).toContain("Do not wait on long-running watchers");
      expect(script).toContain("coverage-map.md");
      expect(script).toContain("Do not stop at install/init proof");
      expect(script).toContain("Run npx --no-install mimetic run --help and verify --app-url is available");
      expect(script).toContain("do not use mimetic watch --sims as app behavior proof");
      expect(script).toContain("MIMETIC_OSS_META_ACTOR_MODEL");
      expect(script).toContain("actor_log_tail_begin");
      expect(script).toContain("ACTOR_LAST_MESSAGE_PATH");
      expect(script).toContain("actorLogTail");
      expect(script).toContain("actorLastMessageTail");
      expect(script).toContain('pnpm add --save-dev --workspace-root "$spec" --ignore-scripts');
      expect(script).not.toContain('pnpm add -D "$spec" --ignore-scripts');
      expect(script).toContain("@openai/codex@latest exec --ephemeral --ignore-user-config --skip-git-repo-check");
      expect(script).toContain("-m \\$actor_model_q");
      expect(script).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(script).toContain("--output-last-message");
      expect(script).toContain("CODEX_COMMAND=");
      expect(script).toContain('MIMETIC_PRIVATE_CODEX_API_KEY="${MIMETIC_CODEX_API_KEY:-}"');
      expect(script).toContain("unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN E2B_API_KEY GH_TOKEN GITHUB_TOKEN");
      expect(script).toContain('CODEX_API_KEY="\\$MIMETIC_PRIVATE_CODEX_API_KEY" CODEX_ACCESS_TOKEN="\\$MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN" timeout "\\$ACTOR_TIMEOUT_SECONDS" bash -lc "\\$CODEX_COMMAND"');
      expect(script).toContain('CODEX_ACCESS_TOKEN="\\$MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN" timeout "\\$ACTOR_TIMEOUT_SECONDS" bash -lc "\\$CODEX_COMMAND"');
      expect(script).toContain('MIMETIC_PRIVATE_CODEX_API_KEY="$MIMETIC_PRIVATE_CODEX_API_KEY" MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN="$MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN" nohup bash "$actor_script"');
      expect(script).toContain("GIT_ASKPASS=false SSH_ASKPASS=false GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone");
      expect(script).toContain("clone_auth=anonymous");
      expect(script).toContain("clone_auth=anonymous_failed retry=token_clone");
      expect(script).toContain('MIMETIC_GITHUB_TOKEN_RUNTIME="$MIMETIC_PRIVATE_GITHUB_TOKEN" git -c credential.helper= clone');
      expect(script).toContain("clone_auth=token_failed");
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
    expect(result.stdout).toContain("Alias: run the bundled OSS meta-lab manifest");
    expect(result.stdout).toContain("--repos");
    expect(result.stdout).toContain("mimetic lab run oss");
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
      "CorentinTh/it-tools,drawdb-io/drawdb",
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
      "repo-01",
      "repo-02",
      "repo-03",
      "repo-04"
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
    expect(bundle.streams[0]?.terminal.tail).toContain("npx --no-install mimetic init --yes");
    expect(bundle.streams[0]?.terminal.tail).toContain("npx --no-install mimetic run --app-url");
    expect(bundle.streams[0]?.ui.route).toBe("e2b://desktop/repo-01");
  });

  it("runs the bundled OSS meta-lab through the generic lab runner", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-meta-generic-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture-app" }), "utf8");
    await mkdir(path.join(cwd, "mimetic", "labs"), { recursive: true });
    await writeFile(path.join(cwd, "mimetic", "labs", "oss.yaml"), [
      "schema: mimetic.lab.v1",
      "id: oss",
      "kind: oss-meta",
      "count: 2",
      "repos:",
      "  - CorentinTh/it-tools",
      "  - drawdb-io/drawdb",
      "defaults:",
      "  dryRun: true"
    ].join("\n"), "utf8");

    const result = await runCli([
      "lab",
      "run",
      "oss",
      "--json",
      "--no-open",
      "--cwd",
      cwd,
      "--run-id",
      "oss-meta-generic-test"
    ]);

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout) as {
      assignments: Array<{ repo: string }>;
      dryRun: boolean;
      schema: string;
    };
    expect(json.schema).toBe("mimetic.oss-meta-lab-result.v1");
    expect(json.dryRun).toBe(true);
    expect(json.assignments.map((assignment) => assignment.repo)).toEqual([
      "CorentinTh/it-tools",
      "drawdb-io/drawdb"
    ]);
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
        "CorentinTh/it-tools",
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
        currentStep: "Waiting for E2B_API_KEY before launching repo-01."
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

  it("renders an OSS meta-lab placeholder Observer before live substrate is available", async () => {
    const previousE2b = process.env.E2B_API_KEY;
    const previousOpenai = process.env.OPENAI_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "mimetic-oss-meta-immediate-observer-"));
      let readyObserverPath = "";
      let readyObserverDataPath = "";
      const result = await runOssMetaLab({
        count: 1,
        cwd,
        onObserverReady: async (observer) => {
          readyObserverPath = observer.observerPath ?? "";
          readyObserverDataPath = observer.observerDataPath ?? "";
          const observerData = JSON.parse(await readFile(path.join(cwd, readyObserverDataPath), "utf8")) as {
            streams: Array<{ embed: { kind: string }; status: string }>;
          };
          expect(observerData.streams[0]).toMatchObject({
            embed: { kind: "placeholder" },
            status: "blocked"
          });
        },
        redactRepoNames: true,
        repos: ["CorentinTh/it-tools"],
        runId: "oss-meta-immediate-observer-test"
      });

      expect(result.ok).toBe(true);
      expect(readyObserverPath).toBe(".mimetic/runs/oss-meta-immediate-observer-test/observer/index.html");
      expect(readyObserverDataPath).toBe(".mimetic/runs/oss-meta-immediate-observer-test/observer/observer-data.json");
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
        "CorentinTh/it-tools",
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
        currentStep: "Waiting for CODEX_API_KEY or CODEX_ACCESS_TOKEN before launching repo-01."
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
        "CorentinTh/it-tools",
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
        currentStep: "Waiting for Codex actor API quota/auth preflight before launching repo-01."
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
    const assignments = buildOssRepoAssignments(["maciekt07/TodoApp"], 1);
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
            repo: "maciekt07/TodoApp",
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
          hostActorPlanPath: "host-actors/todoapp/actor-plan.json",
          repo: "maciekt07/TodoApp",
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
      path: "host-actors/todoapp/actor-plan.json",
      kind: "trace"
    });
  });

  it("renders public-safe terminal completion states without live provider spend", () => {
    const assignments = buildOssRepoAssignments(["CorentinTh/it-tools", "maciekt07/TodoApp"], 2);
    const createdAt = "2026-06-02T08:30:00.000Z";
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt,
      cwd: "/tmp/mimetic-oss-meta-fixture",
      dryRun: false,
      lanes: [
        {
          actorEvidence: {
            actorLastMessageTailPath: "actor-evidence/oss-01-desktop-actor-last-message-tail.txt",
            actorLogTailPath: "actor-evidence/oss-01-desktop-actor-log-tail.txt",
            setupQualityPath: "setup-quality/oss-01-desktop-setup-quality.json"
          },
          bootstrap: {
            codexMode: "tui-attempted",
            completionPath: "/remote/it-tools/completion.json",
            logPath: "/remote/it-tools/bootstrap.log",
            mimeticPackageUploaded: true,
            nestedObserverPath: "/remote/it-tools/repo/.mimetic/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started"
          },
          completion: {
            actorLogPath: "/remote/it-tools/actor.log",
            actorLogTail: "codex actor attempt\nnpx --no-install mimetic init --yes\nactor_exit=0",
            actorLastMessageTail: "Set up Mimetic, but the installed CLI does **not** expose run --app-url in the proof path.",
            actorPid: 4321,
            actorStatus: "running",
            appLogPath: "/remote/it-tools/app.log",
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
            setupQuality: {
              schema: "mimetic.setup-quality.v1",
              generatedAt: "2026-06-02T08:31:00.000Z",
              redaction: {
                status: "passed",
                rawPreviews: "included",
                notes: "Only allowlisted setup files are previewed."
              },
              summary: "1 setup-quality gap(s) need review.",
              status: "needs_review",
              checks: [
                {
                  id: "mimetic-config",
                  label: "Mimetic config",
                  ok: true,
                  detail: "mimetic/config.ts exists."
                },
                {
                  id: "package-script",
                  label: "Package script",
                  ok: false,
                  detail: "package.json does not expose a Mimetic script."
                }
              ],
              tree: [
                { path: "package.json", type: "file", sizeBytes: 240 },
                { path: "mimetic", type: "directory" },
                { path: "mimetic/config.ts", type: "file", sizeBytes: 120 }
              ],
              previews: [
                {
                  path: "mimetic/config.ts",
                  language: "typescript",
                  truncated: false,
                  text: "export default { run: { appUrl: 'http://127.0.0.1:5173' } };"
                }
              ],
              studyQuality: {
                schema: "mimetic.study-quality.v1",
                rating: "ceremonial",
                summary: "Study-quality rating ceremonial from 2/5 app-specific leverage signals.",
                checks: [
                  {
                    id: "coverage-customized",
                    label: "Coverage customized",
                    ok: false,
                    detail: "Coverage map/matrix still appears starter-level or absent."
                  },
                  {
                    id: "app-url-proof",
                    label: "App-url proof",
                    ok: false,
                    detail: "Actor evidence reports that app-url proof was blocked."
                  }
                ],
                signals: {
                  appUrlProofBlocked: true,
                  appUrlProofMentioned: false,
                  actorInsightCaptured: false,
                  coverageCustomized: false,
                  personaCustomized: false,
                  scenarioCustomized: true
                }
              },
              packageScripts: {
                dev: "vite"
              },
              mimetic: {
                configPresent: true,
                personaCount: 1,
                scenarioCount: 1,
                packageScriptPresent: false,
                gitignoreContainsRuntimeIgnore: true
              }
            },
            status: "passed",
            visualReason: "Detected 3 visible Chrome windows including nested Observer.",
            visualStatus: "visible",
            visualWindowCount: 3
          },
          repo: "CorentinTh/it-tools",
          screenshot: {
            capturedAt: "2026-06-02T08:31:05.000Z",
            observerUrl: "../screenshots/oss-01-desktop.png",
            path: "screenshots/oss-01-desktop.png"
          },
          simId: assignments[0]?.simId ?? "oss-01",
          streamId: assignments[0]?.streamId ?? "oss-01-desktop",
          url: "https://stream.example/it-tools"
        },
        {
          bootstrap: {
            codexMode: "tui-attempted",
            completionPath: "/remote/todoapp/completion.json",
            logPath: "/remote/todoapp/bootstrap.log",
            mimeticPackageUploaded: true,
            nestedObserverPath: "/remote/todoapp/repo/.mimetic/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started"
          },
          completion: {
            checkedAt: "2026-06-02T08:31:10.000Z",
            exitCode: 1,
            logTail: "npx --no-install mimetic verify --run latest\nverification failed",
            nestedObserverPresent: false,
            nestedVerifyPassed: false,
            reason: "Bootstrap exited before nested Mimetic proof completed.",
            status: "failed"
          },
          repo: "maciekt07/TodoApp",
          simId: assignments[1]?.simId ?? "oss-02",
          streamId: assignments[1]?.streamId ?? "oss-02-desktop",
          url: "https://stream.example/todoapp"
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
      actorLogTail: "codex actor attempt\nnpx --no-install mimetic init --yes\nactor_exit=0",
      actorLastMessageTail: "Set up Mimetic, but the installed CLI does **not** expose run --app-url in the proof path.",
      actorStatus: "running",
      appStatus: "running",
      appUrl: "http://127.0.0.1:5173",
      nestedObserverPresent: true,
      nestedVerifyPassed: true,
      status: "passed",
      visualStatus: "visible",
      visualWindowCount: 3
    });
    expect(bundle.streams[0]?.terminal?.tail).toContain("public-safe actor last message tail:");
    expect(bundle.streams[0]?.terminal?.tail).toContain("study_quality: ceremonial");
    expect(bundle.streams[0]?.terminal?.tail).toContain("public-safe actor log tail:");
    expect(bundle.streams[0]?.terminal?.tail).toContain("npx --no-install mimetic init --yes");
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
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "actor last-message tail",
      path: "actor-evidence/oss-01-desktop-actor-last-message-tail.txt",
      kind: "log"
    });
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "actor log tail",
      path: "actor-evidence/oss-01-desktop-actor-log-tail.txt",
      kind: "log"
    });
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "setup quality",
      path: "setup-quality/oss-01-desktop-setup-quality.json",
      kind: "filesystem"
    });
    expect(bundle.feedbackCandidates).toHaveLength(3);
    expect(bundle.feedbackCandidates[0]).toMatchObject({
      schema: "mimetic.feedback-candidate.v1",
      failure_owner: "actor",
      proposed_next_state: "setup-quality-review",
      summary: "CorentinTh/it-tools Mimetic setup needs review"
    });
    expect(bundle.feedbackCandidates[0]?.evidence).toContainEqual({
      path: "setup-quality/oss-01-desktop-setup-quality.json",
      kind: "filesystem",
      note: "Setup-quality snapshot with tree, checks, package scripts, and allowlisted previews."
    });
    expect(bundle.feedbackCandidates[1]).toMatchObject({
      schema: "mimetic.feedback-candidate.v1",
      failure_owner: "harness",
      proposed_next_state: "adapter-hardening",
      summary: "Published Mimetic install path blocked app-url proof"
    });
    expect(bundle.feedbackCandidates[1]?.evidence).toContainEqual({
      path: "actor-evidence/oss-01-desktop-actor-last-message-tail.txt",
      kind: "log",
      note: "Public-safe actor last-message tail."
    });
    expect(bundle.feedbackCandidates[2]).toMatchObject({
      schema: "mimetic.feedback-candidate.v1",
      failure_owner: "actor",
      proposed_next_state: "study-quality-review",
      summary: "CorentinTh/it-tools Mimetic setup was ceremonial"
    });
    expect(bundle.feedbackCandidates[2]?.evidence).toContainEqual({
      path: "setup-quality/oss-01-desktop-setup-quality.json",
      kind: "filesystem",
      note: "Setup-quality snapshot includes study-quality checks and public-safe structural signals."
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
    const assignments = buildOssRepoAssignments(["drawdb-io/drawdb"], 1);
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
            completionPath: "/remote/drawdb/completion.json",
            logPath: "/remote/drawdb/bootstrap.log",
            mimeticPackageUploaded: true,
            nestedObserverPath: "/remote/drawdb/repo/.mimetic/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started"
          },
          completion: {
            checkedAt: "2026-06-02T09:34:00.000Z",
            reason: "Timed out waiting 240000ms for remote bootstrap completion marker.",
            status: "timed_out"
          },
          repo: "drawdb-io/drawdb",
          simId: assignments[0]?.simId ?? "oss-01",
          streamId: assignments[0]?.streamId ?? "oss-01-desktop",
          url: "https://stream.example/drawdb"
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
            actorLastMessageTail: "Configured Mimetic for maintainer/private-app in sandbox-private-123 and opened the private-app Observer.",
            actorLogTail: "git clone https://github.com/maintainer/private-app.git\nprivate-app setup complete in sandbox-private-123",
            appStatus: "running",
            appUrl: "http://127.0.0.1:3000",
            checkedAt: "2026-06-02T10:31:00.000Z",
            nestedObserverPresent: true,
            nestedVerifyPassed: true,
            reason: "Target app surface, nested Mimetic proof, and nested Observer were checked in sandbox-private-123.",
            status: "passed",
            visualStatus: "visible",
            visualWindowCount: 3
          },
          repo: "repo-01",
          sandboxId: "sandbox-private-123",
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
    expect(serialized).not.toContain("private-app");
    expect(serialized).not.toContain("sandbox-private-123");
    expect(serialized).not.toContain("sandboxId");
    expect(serialized).not.toContain("stream.example");
    expect(bundle.streams[0]?.completion?.actorLastMessageTail).toContain("[redacted-authorized-repo]");
    expect(bundle.streams[0]?.completion?.actorLastMessageTail).toContain("[redacted-provider-runtime-id]");
    expect(bundle.streams[0]?.url).toBeUndefined();
    expect(bundle.streams[0]?.label).toBe("E2B desktop - repo-01");
  });
});
