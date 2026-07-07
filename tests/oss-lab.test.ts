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
  cleanupStaleOssMetaLabSandboxes,
  collectOssMetaLabPrivateEnv,
  collectOssMetaLabRemoteEnv,
  normalizeHostActorRecommendedProof,
  preflightOssMetaActorApiKey,
  preflightOssMetaRepoAccess,
  publicSafeOssMetaBundle,
  runOssMetaLab,
  sandboxIdsForOssMetaLabCleanup
} from "../src/oss-meta-lab.js";
import type { OssMetaLabCompletion, OssMetaLabResult } from "../src/oss-meta-lab.js";
import {
  createProgram,
  exitCodeForOssMetaLab,
  shouldForceExitAfterOssMetaLab,
  shouldServeOssMetaLabObserver
} from "../src/program.js";
import { PUBLIC_TARGET_CWD, type RunSetupQualitySnapshot } from "../src/run.js";

const execFileAsync = promisify(execFile);

function highLeverageSetupQualityFixture(): RunSetupQualitySnapshot {
  return {
    schema: "homun.setup-quality.v1",
    generatedAt: "2026-06-04T10:06:00.000Z",
    redaction: {
      status: "passed",
      rawPreviews: "included",
      notes: "Only allowlisted setup files are previewed."
    },
    summary: "Homun setup is app-specific and proof-oriented.",
    status: "passed",
    checks: [
      {
        id: "homun-config",
        label: "Homun config",
        ok: true,
        detail: "homun/config.ts exists."
      },
      {
        id: "package-script",
        label: "Package script",
        ok: true,
        detail: "package.json exposes a Homun watch script."
      },
      {
        id: "runtime-ignore",
        label: "Runtime ignore",
        ok: true,
        detail: ".gitignore excludes .homun/ runtime state."
      }
    ],
    tree: [
      { path: "package.json", type: "file", sizeBytes: 540 },
      { path: "homun", type: "directory" },
      { path: "homun/config.ts", type: "file", sizeBytes: 180 },
      { path: "homun/personas/product-researcher.yaml", type: "file", sizeBytes: 220 },
      { path: "homun/scenarios/desktop-core-flow.yaml", type: "file", sizeBytes: 260 }
    ],
    previews: [
      {
        path: "homun/config.ts",
        language: "typescript",
        truncated: false,
        text: "export default { run: { appUrl: 'http://127.0.0.1:5173', sims: 2 } };"
      }
    ],
    studyQuality: {
      schema: "homun.study-quality.v1",
      rating: "high_leverage",
      summary: "Study-quality rating high_leverage from app-specific personas, scenarios, app URL proof, and actor insight.",
      checks: [
        {
          id: "coverage-customized",
          label: "Coverage customized",
          ok: true,
          detail: "Coverage map names concrete screens and friction paths."
        },
        {
          id: "persona-customized",
          label: "Persona customized",
          ok: true,
          detail: "Personas are specific to the product audience."
        }
      ],
      signals: {
        appUrlProofBlocked: false,
        appUrlProofMentioned: true,
        actorInsightCaptured: true,
        coverageCustomized: true,
        personaCustomized: true,
        scenarioCustomized: true
      }
    },
    packageScripts: {
      dev: "vite",
      homun: "homun watch"
    },
    homun: {
      configPresent: true,
      gitignoreContainsRuntimeIgnore: true,
      packageScriptPresent: true,
      personaCount: 2,
      scenarioCount: 2
    }
  };
}

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
    await program.parseAsync(["node", "homun", ...args], { from: "node" });
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
      schema: "homun.oss-meta-lab-result.v1",
      ok: true,
      assignments: [],
      count: 1,
      cwd: "/tmp/homun",
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
        code: "HOMUN_META_RUN_FAILED",
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
      HOMUN_OSS_META_ACTOR_FIRST: "1",
      HOMUN_OSS_META_ACTOR_MODEL: "gpt-5.4-mini",
      HOMUN_OSS_META_HOST_CODEX_ACTOR: "1",
      HOMUN_OSS_META_CODEX_APP_SERVER: "1",
      HOMUN_OSS_META_CODEX_APP_SERVER_URL: "https://codex-app-server.example/session/private-token-test",
      HOMUN_OSS_META_ACTOR_TIMEOUT_MS: "240000",
      HOMUN_OSS_META_REQUIRE_ACTOR: "1",
      OPENAI_API_KEY: "must-not-forward-from-helper"
    })).toEqual({
      HOMUN_OSS_META_ACTOR_FIRST: "1",
      HOMUN_OSS_META_ACTOR_MODEL: "gpt-5.4-mini",
      HOMUN_OSS_META_HOST_CODEX_ACTOR: "1",
      HOMUN_OSS_META_CODEX_APP_SERVER: "1",
      HOMUN_OSS_META_ACTOR_TIMEOUT_MS: "240000",
      HOMUN_OSS_META_REQUIRE_ACTOR: "1"
    });
  });

  it("isolates provider secrets under Homun-private remote env names", () => {
    expect(collectOssMetaLabPrivateEnv({
      CODEX_ACCESS_TOKEN: "codex-access-token-test",
      CODEX_APP_SERVER_CLIENT_URL: "https://codex-app-server.example/session/client-token-test",
      E2B_API_KEY: "must-not-forward-to-remote-env",
      GH_TOKEN: "github-token-test",
      OPENAI_API_KEY: "openai-token-test"
    })).toEqual({
      HOMUN_CODEX_ACCESS_TOKEN: "codex-access-token-test",
      HOMUN_CODEX_API_KEY: "openai-token-test",
      HOMUN_CODEX_APP_SERVER_URL: "https://codex-app-server.example/session/client-token-test",
      HOMUN_GITHUB_TOKEN: "github-token-test"
    });

    expect(collectOssMetaLabPrivateEnv({
      GITHUB_PAT: "github-pat-test"
    })).toEqual({
      HOMUN_GITHUB_TOKEN: "github-pat-test"
    });
  });

  it("preflights private GitHub repo clone access with askpass-scoped token auth after anonymous access fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-repo-preflight-"));
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
          if (!options?.env?.HOMUN_GITHUB_TOKEN_RUNTIME) {
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
      expect(calls[0]?.env.HOMUN_GITHUB_TOKEN_RUNTIME).toBeUndefined();
      expect(calls[0]?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(calls[0]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(calls[1]?.env.GIT_ASKPASS).toContain("git-askpass-");
      expect(calls[1]?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(calls[1]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(calls[1]?.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(calls[1]?.env.HOMUN_GITHUB_TOKEN_RUNTIME).toBe("github-token-test");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prefers anonymous repo access when token auth is present for a public repo", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-repo-preflight-fallback-"));
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
      expect(envs[0]?.HOMUN_GITHUB_TOKEN_RUNTIME).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("classifies missing GitHub clone auth without leaking private repo labels when redacted", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-repo-preflight-fail-"));
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
        HOMUN_OSS_META_ACTOR_PREFLIGHT_MODEL: "gpt-test"
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
        code: "HOMUN_META_RUN_FAILED",
        message: "OSS meta-lab failed 2/4 live desktop or bootstrap launches."
      }
    }))).toBe(2);
  });

  it("serves the OSS meta-lab Observer when a failed live run still produced evidence", () => {
    const failedWithObserver = liveMetaResult({
      ok: false,
      error: {
        code: "HOMUN_META_RUN_FAILED",
        message: "OSS meta-lab failed 4/4 live desktop or bootstrap launches."
      },
      observer: {
        schema: "homun.observer-result.v1",
        ok: true,
        cwd: "/tmp/homun",
        run: "oss-live-fixture",
        observerPath: ".homun/runs/oss-live-fixture/observer/index.html",
        observerDataPath: ".homun/runs/oss-live-fixture/observer/observer-data.json",
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

  it("cleans up stale OSS meta-lab sandboxes by provider metadata without exposing ids", async () => {
    const killed = new Set<string>();
    const listSandboxes = async () => [
      { sandboxId: "sandbox-a", metadata: { mode: "oss-meta-lab", tool: "homun" } },
      { id: "sandbox-b", metadata: { mode: "oss-meta-lab", tool: "homun" } },
      { sandboxID: "sandbox-c", metadata: { mode: "oss-meta-lab", tool: "homun" } },
      { sandboxID: "sandbox-missing-metadata" },
      { sandboxId: "sandbox-paused", metadata: { mode: "oss-meta-lab", tool: "homun" }, state: "paused" },
      { sandboxId: "sandbox-other", metadata: { mode: "other", tool: "homun" } }
    ].filter((sandbox) => {
      const id = sandbox.sandboxId ?? sandbox.sandboxID ?? sandbox.id;
      return !id || !killed.has(id);
    });

    await expect(cleanupStaleOssMetaLabSandboxes({
      killSandbox: async (sandboxId) => {
        killed.add(sandboxId);
      },
      listSandboxes,
      requestTimeoutMs: 123
    })).resolves.toEqual({
      killed: 3,
      matched: 3,
      remaining: 0,
      skipped: 3,
      errors: []
    });
    expect([...killed]).toEqual(["sandbox-a", "sandbox-b", "sandbox-c"]);
  });

  it("redacts provider ids from cleanup errors when requested", async () => {
    const result = liveMetaResult({
      sandboxes: [
        { repo: "repo-01", sandboxId: "sandbox-secret", streamId: "oss-01-desktop", urlPresent: true }
      ]
    });

    const cleanup = await cleanupOssMetaLabSandboxes(result, {
      killSandbox: async () => {
        throw new Error("failed to kill sandbox-secret");
      },
      redactIds: true
    });

    expect(cleanup.killed).toBe(0);
    expect(cleanup.errors.join("\n")).toContain("[provider-runtime]");
    expect(cleanup.errors.join("\n")).not.toContain("sandbox-secret");
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
    const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-meta-count-"));
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

  it("normalizes host actor recommended proof to supported Homun flags", () => {
    expect(normalizeHostActorRecommendedProof(
      "Start Vite, then run homun run --app-url http://127.0.0.1:4173 --browser chromium --viewport desktop,mobile"
    )).toBe("Start the target app on a loopback URL, then run `homun run --app-url http://127.0.0.1:<port> --sims 2`.");

    expect(normalizeHostActorRecommendedProof(
      "Run homun run --app-url http://127.0.0.1:5173 --sims 2 after the app starts."
    )).toContain("homun run --app-url");
  });

  it("renders a bash-valid remote bootstrap script with app surfaces and optional required actor readback", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "homun-bootstrap-script-"));
    const scriptPath = path.join(cwd, "bootstrap.sh");
    try {
      const script = buildOssMetaBootstrapScriptFixture();
      await writeFile(scriptPath, script, "utf8");
      await execFileAsync("bash", ["-n", scriptPath]);

      expect(script).toContain("STATE_DIR='/home/user/.homun-oss-lab/maciekt07-todoapp'");
      expect(script).toContain("ROOT_DIR=\"$STATE_DIR\"");
      expect(script).toContain("APP_DIR='/home/user/maciekt07-todoapp'");
      expect(script).toContain("NESTED_OBSERVER='/home/user/maciekt07-todoapp/.homun/runs/nested-maciekt07-todoapp/observer/index.html'");
      expect(script).not.toContain("/home/user/homun-oss-lab/maciekt07-todoapp/repo");
      expect(script).toContain("start_target_app_surface");
      expect(script).toContain("write_app_specific_browser_scenario");
      expect(script).toContain("app-surface-browser.yaml");
      expect(script).toContain("browser_scenario=authored");
      expect(script).toContain("selectorVisible: body");
      expect(script).toContain('npx --no-install homun run --app-url "$APP_URL" --sims 2');
      expect(script).toContain('open_browser_url "$APP_URL" app-desktop');
      expect(script).toContain("arrange_lab_windows");
      expect(script).toContain("visualStatus");
      expect(script).toContain("windowlower");
      expect(script).toContain("start_actor_attempt");
      expect(script).toContain("apply_host_actor_plan");
      expect(script).toContain("host_actor_plan=applied");
      expect(script).toContain("source=host-codex-plan");
      expect(script).toContain("reason=remote-actor-not-run");
      expect(script).toContain("homun/personas");
      expect(script).toContain("homun/scenarios");
      expect(script).toContain("HOMUN_OSS_META_HOST_CODEX_ACTOR");
      expect(script).toContain("HOMUN_OSS_META_CODEX_APP_SERVER");
      expect(script).toContain("HOMUN_PRIVATE_CODEX_APP_SERVER_URL");
      expect(script).toContain("HOMUN_CODEX_APP_SERVER_URL");
      expect(script).toContain("wait_for_actor_attempt_if_required");
      expect(script).toContain("HOMUN_OSS_META_ACTOR_FIRST");
      expect(script).toContain("HOMUN_OSS_META_REQUIRE_ACTOR");
      expect(script).toContain("HOMUN_OSS_META_ACTOR_TIMEOUT_MS");
      expect(script).toContain('HOMUN_OSS_META_ACTOR_TIMEOUT_MS:-480000');
      expect(script).toContain("ACTOR_TIMEOUT_SECONDS");
      expect(script).toContain("Do not wait on long-running watchers");
      expect(script).toContain("coverage-map.md");
      expect(script).toContain("Do not stop at install/init proof");
      expect(script).toContain("Run npx --no-install homun run --help and verify --app-url is available");
      expect(script).toContain("do not use homun watch --sims as app behavior proof");
      expect(script).toContain("HOMUN_OSS_META_ACTOR_MODEL");
      expect(script).toContain("actor_log_tail_begin");
      expect(script).toContain("elapsed_ms=$((now_ms - started_ms))");
      expect(script).toContain("ACTOR_LAST_MESSAGE_PATH");
      expect(script).toContain("actorLogTail");
      expect(script).toContain("actorLastMessageTail");
      expect(script).toContain("open_codex_app_server_client");
      expect(script).toContain("codex_app_server_client=provided");
      expect(script).toContain("npx -y @openai/codex@latest app-server --listen stdio://");
      expect(script).toContain("codex-app-server/summary.json");
      expect(script).toContain("codex-app-server/events.ndjson");
      expect(script).toContain("codex-app-server/transcript.txt");
      expect(script).toContain("homun.codex-app-server-trace.projected.v1");
      expect(script).toContain("projectTraceJson");
      expect(script).toContain("homun.oss-meta-nested-step-trace-summary.v1");
      expect(script).toContain("nestedStepTraceSummary");
      expect(script).not.toContain("codex_app_server_client=placeholder");
      expect(script).not.toContain("source=codex-app-server-client");
      expect(script).not.toContain("remote-control-hook-pending");
      expect(script).toContain("Codex app-server mode requested.");
      expect(script).toContain("target app, nested Observer, and Codex app-server client");
      expect(script).toContain('pnpm add --save-dev --workspace-root "$spec" --ignore-scripts');
      expect(script).toContain('pnpm add --save-dev "$spec" --ignore-scripts');
      expect(script).toContain("@openai/codex@latest exec --ephemeral --ignore-user-config --skip-git-repo-check");
      expect(script).toContain("-m \\$actor_model_q");
      expect(script).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(script).toContain("--output-last-message");
      expect(script).toContain("CODEX_COMMAND=");
      expect(script).toContain('HOMUN_PRIVATE_CODEX_API_KEY="${HOMUN_CODEX_API_KEY:-}"');
      expect(script).toContain('HOMUN_PRIVATE_CODEX_APP_SERVER_URL="${HOMUN_CODEX_APP_SERVER_URL:-}"');
      expect(script).toContain("unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN E2B_API_KEY GH_TOKEN GITHUB_TOKEN");
      expect(script).toContain("unset HOMUN_CODEX_API_KEY HOMUN_CODEX_ACCESS_TOKEN HOMUN_CODEX_APP_SERVER_URL HOMUN_GITHUB_TOKEN");
      expect(script).toContain('CODEX_API_KEY="\\$HOMUN_PRIVATE_CODEX_API_KEY" CODEX_ACCESS_TOKEN="\\$HOMUN_PRIVATE_CODEX_ACCESS_TOKEN" timeout "\\$ACTOR_TIMEOUT_SECONDS" bash -lc "\\$CODEX_COMMAND"');
      expect(script).toContain('CODEX_ACCESS_TOKEN="\\$HOMUN_PRIVATE_CODEX_ACCESS_TOKEN" timeout "\\$ACTOR_TIMEOUT_SECONDS" bash -lc "\\$CODEX_COMMAND"');
      expect(script).toContain('HOMUN_PRIVATE_CODEX_API_KEY="$HOMUN_PRIVATE_CODEX_API_KEY" HOMUN_PRIVATE_CODEX_ACCESS_TOKEN="$HOMUN_PRIVATE_CODEX_ACCESS_TOKEN" nohup bash "$actor_script"');
      expect(script).toContain("GIT_ASKPASS=false SSH_ASKPASS=false GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone");
      expect(script).toContain("clone_auth=anonymous");
      expect(script).toContain("clone_auth=anonymous_failed retry=token_clone");
      expect(script).toContain('HOMUN_GITHUB_TOKEN_RUNTIME="$HOMUN_PRIVATE_GITHUB_TOKEN" git -c credential.helper= clone');
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
    expect(result.stdout).toContain("Usage: homun lab oss");
    expect(result.stdout).toContain("Alias: run the bundled OSS meta-lab manifest");
    expect(result.stdout).toContain("--repos");
    expect(result.stdout).toContain("homun lab run oss");
    expect(result.stdout).toContain("homun lab oss-smoke");
  });

  it("keeps disposable-clone safety on lab oss-smoke", async () => {
    const result = await runCli(["lab", "oss-smoke", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: homun lab oss-smoke");
    expect(result.stdout).toContain("Clone lightweight public OSS repos");
    expect(result.stdout).toContain("--keep");
    expect(result.stdout).toContain("removed by default");
  });

  it("renders a no-network OSS meta-lab contract from --repos", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-meta-"));
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
    expect(json.schema).toBe("homun.oss-meta-lab-result.v1");
    expect(json.assignments.map((assignment) => assignment.repo)).toEqual([
      "repo-01",
      "repo-02",
      "repo-03",
      "repo-04"
    ]);
    expect(json.observer.observerPath).toBe(".homun/runs/oss-meta-test/observer/index.html");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".homun", "runs", "oss-meta-test", "run.json"), "utf8")) as {
      cwd: string;
      mode: string;
      streams: Array<{
        terminal: { tail: string };
        ui: { route: string };
      }>;
    };
    expect(bundle.cwd).toBe(PUBLIC_TARGET_CWD);
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.streams[0]?.terminal.tail).toContain("npx --no-install homun init --yes");
    expect(bundle.streams[0]?.terminal.tail).toContain("npx --no-install homun run --app-url");
    expect(bundle.streams[0]?.ui.route).toBe("e2b://desktop/repo-01");
  });

  it("runs the bundled OSS meta-lab through the generic lab runner", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-meta-generic-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture-app" }), "utf8");
    await mkdir(path.join(cwd, "homun", "labs"), { recursive: true });
    await writeFile(path.join(cwd, "homun", "labs", "oss.yaml"), [
      "schema: homun.lab.v2",
      "id: oss",
      "subject:",
      "  source: clone",
      "  repos:",
      "    - CorentinTh/it-tools",
      "    - drawdb-io/drawdb",
      "  clone:",
      "    fanout: 2",
      "execution:",
      "  target: e2b-desktop",
      "actors:",
      "  - type: codex-app-server",
      "scenario:",
      "  mode: dry-run"
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
    expect(json.schema).toBe("homun.oss-meta-lab-result.v1");
    expect(json.dryRun).toBe(true);
    expect(json.assignments.map((assignment) => assignment.repo)).toEqual([
      "CorentinTh/it-tools",
      "drawdb-io/drawdb"
    ]);
  });

  it("forces repo-label redaction when repos are overridden on the CLI (privacy invariant)", async () => {
    // Regression: a CLI --repos override must force redactRepos=true so an authorized private
    // slug never reaches durable artifacts, even with no policies.redactRepos in the lab.
    const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-meta-redact-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture-app" }), "utf8");
    await mkdir(path.join(cwd, "homun", "labs"), { recursive: true });
    await writeFile(path.join(cwd, "homun", "labs", "oss.yaml"), [
      "schema: homun.lab.v2",
      "id: oss",
      "subject:",
      "  source: clone",
      "  repos:",
      "    - CorentinTh/it-tools",
      "execution:",
      "  target: e2b-desktop",
      "actors:",
      "  - type: codex-app-server",
      "scenario:",
      "  mode: dry-run"
    ].join("\n"), "utf8");

    const result = await runCli([
      "lab", "run", "oss", "--json", "--no-open", "--cwd", cwd,
      "--repos", "example-private/secret-app", "--run-id", "redact-override-test"
    ]);

    expect(result.exitCode).toBe(0);
    // The raw overridden slug must NOT appear anywhere in the public-safe output.
    expect(result.stdout).not.toContain("example-private/secret-app");
  });

  it("fails live launch closed into waiting lanes when E2B is absent", async () => {
    const previousE2b = process.env.E2B_API_KEY;
    const previousOpenai = process.env.OPENAI_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-meta-waiting-"));
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

      const bundle = JSON.parse(await readFile(path.join(cwd, ".homun", "runs", "oss-meta-waiting-test", "run.json"), "utf8")) as {
        cwd: string;
        mode: string;
        review: { verdict: string };
        simulations: Array<{ currentStep: string; status: string }>;
        streams: Array<{ embed: { kind: string }; status: string }>;
      };
      expect(bundle.cwd).toBe(PUBLIC_TARGET_CWD);
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
      const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-meta-immediate-observer-"));
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
      expect(readyObserverPath).toBe(".homun/runs/oss-meta-immediate-observer-test/observer/index.html");
      expect(readyObserverDataPath).toBe(".homun/runs/oss-meta-immediate-observer-test/observer/observer-data.json");
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
    const previousActorFirst = process.env.HOMUN_OSS_META_ACTOR_FIRST;
    const previousRequireActor = process.env.HOMUN_OSS_META_REQUIRE_ACTOR;
    process.env.E2B_API_KEY = "fake-e2b-key";
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_ACCESS_TOKEN;
    process.env.HOMUN_OSS_META_ACTOR_FIRST = "1";
    process.env.HOMUN_OSS_META_REQUIRE_ACTOR = "1";

    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-meta-actor-auth-waiting-"));
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

      const bundle = JSON.parse(await readFile(path.join(cwd, ".homun", "runs", "oss-meta-actor-auth-waiting-test", "run.json"), "utf8")) as {
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
      if (previousActorFirst === undefined) delete process.env.HOMUN_OSS_META_ACTOR_FIRST;
      else process.env.HOMUN_OSS_META_ACTOR_FIRST = previousActorFirst;
      if (previousRequireActor === undefined) delete process.env.HOMUN_OSS_META_REQUIRE_ACTOR;
      else process.env.HOMUN_OSS_META_REQUIRE_ACTOR = previousRequireActor;
    }
  });

  it("fails actor-required live launch closed before E2B when actor API quota preflight fails", async () => {
    const previousE2b = process.env.E2B_API_KEY;
    const previousOpenai = process.env.OPENAI_API_KEY;
    const previousCodexApiKey = process.env.CODEX_API_KEY;
    const previousCodexAccessToken = process.env.CODEX_ACCESS_TOKEN;
    const previousActorFirst = process.env.HOMUN_OSS_META_ACTOR_FIRST;
    const previousRequireActor = process.env.HOMUN_OSS_META_REQUIRE_ACTOR;
    const previousFetch = globalThis.fetch;
    const fakeOpenAiKey = `sk-${"testsecretvalue1234567890abcd"}`;
    process.env.E2B_API_KEY = "fake-e2b-key";
    process.env.OPENAI_API_KEY = fakeOpenAiKey;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_ACCESS_TOKEN;
    process.env.HOMUN_OSS_META_ACTOR_FIRST = "1";
    process.env.HOMUN_OSS_META_REQUIRE_ACTOR = "1";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: {
        code: "insufficient_quota",
        message: `Quota exceeded for ${fakeOpenAiKey}.`
      }
    }), { status: 429 })) as typeof fetch;

    try {
      const cwd = await mkdtemp(path.join(tmpdir(), "homun-oss-meta-actor-preflight-"));
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

      const bundle = JSON.parse(await readFile(path.join(cwd, ".homun", "runs", "oss-meta-actor-preflight-test", "run.json"), "utf8")) as {
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
      if (previousActorFirst === undefined) delete process.env.HOMUN_OSS_META_ACTOR_FIRST;
      else process.env.HOMUN_OSS_META_ACTOR_FIRST = previousActorFirst;
      if (previousRequireActor === undefined) delete process.env.HOMUN_OSS_META_REQUIRE_ACTOR;
      else process.env.HOMUN_OSS_META_REQUIRE_ACTOR = previousRequireActor;
    }
  });

  it("surfaces host actor plan artifacts even when provider launch fails", () => {
    const assignments = buildOssRepoAssignments(["maciekt07/TodoApp"], 1);
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt: "2026-06-04T10:00:00.000Z",
      cwd: "/tmp/homun-oss-meta-fixture",
      dryRun: false,
      lanes: [
        {
          error: "Invalid API key format: expected [redacted-e2b-key].",
          hostActorPlan: {
            schema: "homun.oss-host-actor-plan.v1",
            generatedAt: "2026-06-04T10:00:00.000Z",
            personas: [
              {
                id: "learner",
                name: "Learner",
                intent: "Inspect the app as a synthetic user.",
                traits: ["public_safe"]
              }
            ],
            recommendedProof: "Start the app, then run homun run --app-url http://127.0.0.1:5173 --sims 2.",
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

  it("does not count suspended app-server actor completions as passed", () => {
    const assignments = buildOssRepoAssignments(["maciekt07/TodoApp"], 1);
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt: "2026-06-04T10:05:00.000Z",
      cwd: "/tmp/homun-oss-meta-app-server-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "app-server-client",
            completionPath: "/remote/todoapp/completion.json",
            logPath: "/remote/todoapp/bootstrap.log",
            homunPackageUploaded: true,
            nestedObserverPath: "/remote/todoapp/repo/.homun/runs/nested/observer/index.html",
            status: "started",
            tail: "codex_app_server_client=provided\nactor_status=suspended source=codex-app-server-client"
          },
          completion: {
            actorLastMessageTail: "Opened a headed client surface instead of launching @openai/codex exec.",
            actorLogTail: "codex_app_server_mode=1\nactor_status=suspended\nsource=codex-app-server-client",
            actorStatus: "suspended",
            appStatus: "running",
            appUrl: "http://127.0.0.1:5173",
            checkedAt: "2026-06-04T10:06:00.000Z",
            nestedObserverPresent: true,
            nestedVerifyPassed: true,
            reason: "Target app surface, nested Homun proof, and nested Observer were checked.",
            status: "passed",
            visualReason: "Detected 4 visible Chrome windows including target app, nested Observer, and Codex app-server client surface.",
            visualStatus: "visible",
            visualWindowCount: 4
          },
          repo: "maciekt07/TodoApp",
          simId: assignments[0]?.simId ?? "oss-01",
          streamId: assignments[0]?.streamId ?? "oss-01-desktop",
          url: "https://stream.example/todoapp"
        }
      ],
      liveRequested: true,
      missingKeys: [],
      runId: "oss-meta-app-server-fixture"
    });

    expect(bundle.review.verdict).not.toBe("pass");
    expect(bundle.simulations[0]?.status).not.toBe("passed");
    expect(bundle.streams[0]?.status).not.toBe("passed");
    expect(bundle.streams[0]?.completion?.status).not.toBe("passed");
    expect(bundle.streams[0]?.terminal?.title).toBe("Codex app-server bootstrap - maciekt07/TodoApp");
    expect(bundle.streams[0]?.ui?.intent).toContain("Codex app-server client surface");
    expect(bundle.streams[0]?.ui?.intent).not.toContain("attempts a Codex actor");
    expect(bundle.streams[0]?.terminal?.tail).toContain("source=codex-app-server-client");
    expect(bundle.events.find((event) => event.type === "oss-meta.codex.prompt.ready")?.message).toContain("app-server client hook");
    expect(bundle.streams[0]?.completion?.meaningfulUse).toMatchObject({
      schema: "homun.meaningful-use-score.v1",
      status: "fail"
    });
    expect(bundle.streams[0]?.completion?.meaningfulUse?.hardFailures).toContain("Required actor did not pass (suspended).");
  });

  it("labels app-server-backed OSS meta-lab actor evidence artifacts without treating them as TUI exec", () => {
    const assignments = buildOssRepoAssignments(["maciekt07/TodoApp"], 1);
    const appServerCompletion: OssMetaLabCompletion & {
      appServerActorEvidence: {
        eventsPath: string;
        tracePath: string;
        transcriptPath: string;
      };
    } = {
      actorLastMessageTail: "Completed a public-safe Codex app-server turn and wrote redacted transcript evidence.",
      actorLogTail: "codex_app_server_mode=1\nactor_status=passed\nsource=codex-app-server",
      actorStatus: "passed",
      appServerActorEvidence: {
        eventsPath: "codex-app-server/oss-01-desktop-events.ndjson",
        tracePath: "codex-app-server/oss-01-desktop-summary.json",
        transcriptPath: "codex-app-server/oss-01-desktop-transcript.txt"
      },
      appStatus: "running",
      appUrl: "http://127.0.0.1:5173",
      checkedAt: "2026-06-04T10:06:00.000Z",
      nestedObserverPresent: true,
      nestedStepTraceSummary: {
        schema: "homun.oss-meta-nested-step-trace-summary.v1",
        redaction: {
          status: "passed",
          notes: "Fixture summary stores public-safe nested trace metadata only."
        },
        counts: {
          blockedSteps: 0,
          passedSteps: 4,
          surfaces: 2,
          totalSteps: 4,
          traces: 2
        },
        scenario: {
          id: "todo-list-browser",
          source: "homun/scenarios/todo-list-browser.yaml",
          sourceDigest: "abcdef123456",
          stepCount: 2,
          title: "Todo list browser"
        },
        status: "passed",
        surfaces: [
          {
            id: "desktop",
            label: "Desktop browser surface",
            ok: true,
            reason: "Desktop browser surface completed 2/2 browser persona steps.",
            steps: [
              {
                action: "goto",
                assertionStatuses: ["text-present:passed"],
                id: "open-home",
                label: "Open home",
                reason: "goto completed for Open home.",
                status: "passed"
              },
              {
                action: "click",
                assertionStatuses: ["state-changed:passed"],
                id: "create-todo",
                label: "Create todo",
                reason: "Visible page state changed.",
                status: "passed"
              }
            ]
          },
          {
            id: "mobile",
            label: "Mobile browser surface",
            ok: true,
            reason: "Mobile browser surface completed 2/2 browser persona steps.",
            steps: [
              {
                action: "goto",
                id: "open-home",
                reason: "goto completed for Open home.",
                status: "passed"
              },
              {
                action: "click",
                id: "create-todo",
                reason: "Visible page state changed.",
                status: "passed"
              }
            ]
          }
        ]
      },
      nestedVerifyPassed: true,
      reason: "Target app surface, nested Homun proof, nested Observer, and Codex app-server actor evidence were checked.",
      setupQuality: highLeverageSetupQualityFixture(),
      status: "passed",
      visualReason: "Detected 4 visible Chrome windows including target app, nested Observer, and Codex app-server client surface.",
      visualStatus: "visible",
      visualWindowCount: 4
    };
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt: "2026-06-04T10:05:00.000Z",
      cwd: "/tmp/homun-oss-meta-app-server-evidence-fixture",
      dryRun: false,
      lanes: [
        {
          actorEvidence: {
            nestedEvidencePath: "nested-evidence/oss-01-desktop-nested-proof.json",
            setupQualityPath: "setup-quality/oss-01-desktop-setup-quality.json"
          },
          bootstrap: {
            codexMode: "app-server-client",
            completionPath: "/remote/todoapp/completion.json",
            logPath: "/remote/todoapp/bootstrap.log",
            homunPackageUploaded: true,
            nestedObserverPath: "/remote/todoapp/repo/.homun/runs/nested/observer/index.html",
            status: "started",
            tail: "codex_app_server_client=provided\nactor_status=passed source=codex-app-server"
          },
          completion: appServerCompletion,
          repo: "maciekt07/TodoApp",
          simId: assignments[0]?.simId ?? "oss-01",
          streamId: assignments[0]?.streamId ?? "oss-01-desktop",
          url: "https://stream.example/todoapp"
        }
      ],
      liveRequested: true,
      missingKeys: [],
      runId: "oss-meta-app-server-evidence-fixture"
    });

    expect(bundle.review.verdict).toBe("pass");
    expect(bundle.streams[0]?.terminal?.title).toBe("Codex app-server bootstrap - maciekt07/TodoApp");
    expect(bundle.streams[0]?.ui?.intent).toContain("Codex app-server client surface");
    expect(bundle.streams[0]?.ui?.intent).not.toContain("attempts a Codex actor");
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "codex app-server trace",
      path: "codex-app-server/oss-01-desktop-summary.json",
      kind: "trace"
    });
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "codex app-server events",
      path: "codex-app-server/oss-01-desktop-events.ndjson",
      kind: "events"
    });
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "codex app-server transcript",
      path: "codex-app-server/oss-01-desktop-transcript.txt",
      kind: "log"
    });
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "setup quality",
      path: "setup-quality/oss-01-desktop-setup-quality.json",
      kind: "filesystem"
    });
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "nested Homun proof",
      path: "nested-evidence/oss-01-desktop-nested-proof.json",
      kind: "trace"
    });
    expect(bundle.streams[0]?.codex).toMatchObject({
      provider: "codex-app-server",
      state: "completed"
    });
    expect(bundle.streams[0]?.ui?.nestedObserverPath).toBe("nested-evidence/oss-01-desktop-nested-proof.json");
    expect(bundle.events.map((event) => event.type)).toContain("oss-meta.nested.step_trace.summary");
    expect(bundle.events.find((event) => event.type === "oss-meta.nested.step_trace.summary")?.message)
      .toContain("4/4 steps across 2 surface");
    const artifactRefs = bundle.streams[0]?.artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`) ?? [];
    expect(artifactRefs.filter((ref) => ref === "trace:codex-app-server/oss-01-desktop-summary.json")).toHaveLength(1);
    expect(artifactRefs.every((ref) => !ref.includes("/remote/"))).toBe(true);
    expect(artifactRefs.every((ref) => !path.isAbsolute(ref.split(":").slice(1).join(":")))).toBe(true);
    expect(bundle.streams[0]?.completion?.meaningfulUse).toMatchObject({
      schema: "homun.meaningful-use-score.v1",
      status: "pass",
      score: 100,
      hardFailures: []
    });
    expect(bundle.streams[0]?.completion?.meaningfulUse?.components.map((component) => component.id)).toEqual([
      "setup-correctness",
      "filesystem-evidence",
      "nested-homun-evidence",
      "actor-activity",
      "product-surface",
      "feedback-quality"
    ]);

    const persisted = publicSafeOssMetaBundle(bundle);
    const persistedSerialized = JSON.stringify(persisted);
    const persistedRefs = persisted.streams[0]?.artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`) ?? [];
    expect(persisted.cwd).toBe("[target-cwd]");
    expect(persistedSerialized).not.toContain("/tmp/homun-oss-meta-app-server-evidence-fixture");
    expect(persistedSerialized).not.toContain("/remote/todoapp");
    expect(persistedSerialized).not.toContain("/home/user");
    expect(persisted.streams[0]?.codex).toMatchObject({
      provider: "codex-app-server",
      state: "completed"
    });
    expect(persisted.streams[0]?.ui?.nestedObserverPath).toBe("nested-evidence/oss-01-desktop-nested-proof.json");
    expect(persistedRefs.filter((ref) => ref === "trace:codex-app-server/oss-01-desktop-summary.json")).toHaveLength(1);
    const observerData = buildObserverData(persisted);
    expect(observerData.streams[0]?.artifacts).toContainEqual({
      label: "nested Homun proof",
      path: "nested-evidence/oss-01-desktop-nested-proof.json",
      kind: "trace"
    });
    expect(observerData.streams[0]?.timeline.map((event) => event.type)).toContain("oss-meta.nested.step_trace.summary");
  });

  it("redacts structured Codex app-server trace evidence for private repo meta-labs", () => {
    const assignments = buildOssRepoAssignments(["maintainer/private-cinema-app"], 1);
    const appServerCompletion: OssMetaLabCompletion = {
      actorLastMessageTail: "Set up private-cinema-app and ran Homun.",
      actorStatus: "passed",
      appServerActorEvidence: {
        eventsPath: "codex-app-server/oss-01-desktop-events.ndjson",
        eventsText: "agent mentioned maintainer/private-cinema-app",
        traceJson: {
          schema: "homun.codex-app-server-trace.projected.v1",
          status: "passed",
          messages: [
            { text: "Implemented private-cinema-app setup in maintainer/private-cinema-app." }
          ],
          commands: [
            { command: "git clone https://github.com/maintainer/private-cinema-app.git" }
          ]
        },
        tracePath: "codex-app-server/oss-01-desktop-summary.json",
        transcriptPath: "codex-app-server/oss-01-desktop-transcript.txt",
        transcriptText: "private-cinema-app proof passed."
      },
      appStatus: "running",
      appUrl: "http://127.0.0.1:3000",
      checkedAt: "2026-06-05T10:06:00.000Z",
      nestedObserverPresent: true,
      nestedStepTraceSummary: {
        schema: "homun.oss-meta-nested-step-trace-summary.v1",
        redaction: {
          status: "passed",
          notes: "mentions private-cinema-app /remote/private-cinema-app github_pat_fakepat123456789012"
        },
        counts: {
          blockedSteps: 0,
          passedSteps: 1,
          surfaces: 1,
          totalSteps: 1,
          traces: 1
        },
        scenario: {
          id: "private-cinema-app-flow",
          source: "/remote/private-cinema-app/homun/scenarios/private.yaml",
          sourceDigest: "abc123",
          stepCount: 1,
          title: "private-cinema-app flow"
        },
        status: "passed",
        surfaces: [
          {
            id: "desktop-private-cinema-app",
            ok: true,
            reason: "private-cinema-app passed at https://stream.example/private from /remote/private-cinema-app with github_pat_fakepat123456789012",
            steps: [
              {
                action: "goto",
                assertionStatuses: ["private-cinema-app:passed"],
                id: "open-private-cinema-app",
                label: "Open private-cinema-app",
                reason: "Loaded /remote/private-cinema-app and token github_pat_fakepat123456789012",
                status: "passed"
              }
            ]
          }
        ]
      },
      nestedVerifyPassed: true,
      reason: "private-cinema-app setup passed.",
      status: "passed",
      visualStatus: "visible"
    };
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt: "2026-06-05T10:05:00.000Z",
      cwd: "/tmp/homun-oss-meta-app-server-redaction-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "app-server-client",
            completionPath: "/remote/repo/completion.json",
            logPath: "/remote/repo/bootstrap.log",
            homunPackageUploaded: true,
            nestedObserverPath: "/remote/repo/.homun/runs/nested/observer/index.html",
            status: "started",
            tail: "actor_status=passed source=codex-app-server"
          },
          completion: appServerCompletion,
          repo: "maintainer/private-cinema-app",
          simId: assignments[0]?.simId ?? "oss-01",
          streamId: assignments[0]?.streamId ?? "oss-01-desktop",
          url: "https://stream.example/private"
        }
      ],
      liveRequested: true,
      missingKeys: [],
      redactRepoNames: true,
      runId: "oss-meta-app-server-redaction-fixture"
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("maintainer/private-cinema-app");
    expect(serialized).not.toContain("private-cinema-app");
    expect(serialized).not.toContain("github_pat_fakepat");
    expect(serialized).not.toContain("stream.example/private");
    expect(serialized).not.toContain("/remote/private");
    expect(serialized).toContain("[redacted-authorized-repo]");
  });

  it("renders public-safe terminal completion states without live provider spend", () => {
    const assignments = buildOssRepoAssignments(["CorentinTh/it-tools", "maciekt07/TodoApp"], 2);
    const createdAt = "2026-06-02T08:30:00.000Z";
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt,
      cwd: "/tmp/homun-oss-meta-fixture",
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
            homunPackageUploaded: true,
            nestedObserverPath: "/remote/it-tools/repo/.homun/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started"
          },
          completion: {
            actorLogPath: "/remote/it-tools/actor.log",
            actorLogTail: "codex actor attempt\nnpx --no-install homun init --yes\nactor_exit=0",
            actorLastMessageTail: "Set up Homun, but the installed CLI does **not** expose run --app-url in the proof path.",
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
            reason: "Nested Homun proof completed and nested Observer path was checked.",
            setupQuality: {
              schema: "homun.setup-quality.v1",
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
                  id: "homun-config",
                  label: "Homun config",
                  ok: true,
                  detail: "homun/config.ts exists."
                },
                {
                  id: "package-script",
                  label: "Package script",
                  ok: false,
                  detail: "package.json does not expose a Homun script."
                }
              ],
              tree: [
                { path: "package.json", type: "file", sizeBytes: 240 },
                { path: "homun", type: "directory" },
                { path: "homun/config.ts", type: "file", sizeBytes: 120 }
              ],
              previews: [
                {
                  path: "homun/config.ts",
                  language: "typescript",
                  truncated: false,
                  text: "export default { run: { appUrl: 'http://127.0.0.1:5173' } };"
                }
              ],
              studyQuality: {
                schema: "homun.study-quality.v1",
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
              homun: {
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
            homunPackageUploaded: true,
            nestedObserverPath: "/remote/todoapp/repo/.homun/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started"
          },
          completion: {
            checkedAt: "2026-06-02T08:31:10.000Z",
            exitCode: 1,
            logTail: "npx --no-install homun verify --run latest\nverification failed",
            nestedObserverPresent: false,
            nestedVerifyPassed: false,
            reason: "Bootstrap exited before nested Homun proof completed.",
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
      actorLogTail: "codex actor attempt\nnpx --no-install homun init --yes\nactor_exit=0",
      actorLastMessageTail: "Set up Homun, but the installed CLI does **not** expose run --app-url in the proof path.",
      actorStatus: "running",
      appStatus: "running",
      appUrl: "http://127.0.0.1:5173",
      nestedObserverPresent: true,
      nestedVerifyPassed: true,
      status: "passed",
      visualStatus: "visible",
      visualWindowCount: 3
    });
    expect(bundle.streams[0]?.completion?.meaningfulUse).toMatchObject({
      schema: "homun.meaningful-use-score.v1",
      status: "partial"
    });
    expect(bundle.streams[0]?.completion?.meaningfulUse?.score).toBeGreaterThanOrEqual(45);
    expect(bundle.streams[0]?.completion?.meaningfulUse?.score).toBeLessThan(80);
    expect(bundle.streams[0]?.completion?.meaningfulUse?.components.find((component) => component.id === "feedback-quality")).toMatchObject({
      status: "partial",
      score: 8
    });
    expect(bundle.streams[0]?.terminal?.tail).toContain("public-safe actor last message tail:");
    expect(bundle.streams[0]?.terminal?.tail).toContain("study_quality: ceremonial");
    expect(bundle.streams[0]?.terminal?.tail).toContain("public-safe actor log tail:");
    expect(bundle.streams[0]?.terminal?.tail).toContain("npx --no-install homun init --yes");
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
      schema: "homun.feedback-candidate.v1",
      failure_owner: "actor",
      proposed_next_state: "setup-quality-review",
      summary: "Generated Homun setup for CorentinTh/it-tools needs review"
    });
    expect(bundle.feedbackCandidates[0]?.evidence).toContainEqual({
      path: "setup-quality/oss-01-desktop-setup-quality.json",
      kind: "filesystem",
      note: "Setup-quality snapshot with tree, checks, package scripts, and allowlisted previews."
    });
    expect(bundle.feedbackCandidates[1]).toMatchObject({
      schema: "homun.feedback-candidate.v1",
      failure_owner: "harness",
      proposed_next_state: "adapter-hardening",
      summary: "Published Homun install path blocked app-url proof"
    });
    expect(bundle.feedbackCandidates[1]?.evidence).toContainEqual({
      path: "actor-evidence/oss-01-desktop-actor-last-message-tail.txt",
      kind: "log",
      note: "Public-safe actor last-message tail."
    });
    expect(bundle.feedbackCandidates[2]).toMatchObject({
      schema: "homun.feedback-candidate.v1",
      failure_owner: "actor",
      proposed_next_state: "study-quality-review",
      summary: "Generated Homun setup for CorentinTh/it-tools was ceremonial"
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
      cwd: "/tmp/homun-oss-meta-timeout-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "tui-attempted",
            completionPath: "/remote/drawdb/completion.json",
            logPath: "/remote/drawdb/bootstrap.log",
            homunPackageUploaded: true,
            nestedObserverPath: "/remote/drawdb/repo/.homun/runs/nested/observer/index.html",
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
    expect(bundle.streams[0]?.completion?.meaningfulUse).toMatchObject({
      schema: "homun.meaningful-use-score.v1",
      status: "fail"
    });
    expect(bundle.streams[0]?.completion?.meaningfulUse?.hardFailures).toContain("Remote bootstrap timed out.");

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
      cwd: "/tmp/homun-oss-meta-private-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "tui-attempted",
            completionPath: "/remote/repo-01/completion.json",
            logPath: "/remote/repo-01/bootstrap.log",
            homunPackageUploaded: true,
            nestedObserverPath: "/remote/repo-01/repo/.homun/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started",
            terminalTitle: "Homun 1 repo-01"
          },
          completion: {
            actorLastMessageTail: "Configured Homun for maintainer/private-app in sandbox-private-123 and opened the private-app Observer.",
            actorLogTail: [
              "git clone https://github.com/maintainer/private-app.git",
              "diff --git a/src/private-flow.ts b/src/private-flow.ts",
              "index abc123..def456 100644",
              "--- a/src/private-flow.ts",
              "+++ b/src/private-flow.ts",
              "@@ -1,2 +1,3 @@",
              "-const secretFlow = 'private-app';",
              "+const secretFlow = 'private-app-updated';",
              "tokens used",
              "12,345",
              "private-app setup complete in sandbox-private-123"
            ].join("\n"),
            appStatus: "running",
            appUrl: "http://127.0.0.1:3000",
            checkedAt: "2026-06-02T10:31:00.000Z",
            nestedObserverPresent: true,
            nestedVerifyPassed: true,
            reason: "Target app surface, nested Homun proof, and nested Observer were checked in sandbox-private-123.",
            status: "passed",
            visualStatus: "visible",
            visualWindowCount: 3
          },
          repo: "repo-01",
          sandboxId: "sandbox-private-123",
          screenshot: {
            capturedAt: "2026-06-02T10:31:05.000Z",
            observerUrl: "../screenshots/oss-01-desktop.png",
            path: "screenshots/oss-01-desktop.png"
          },
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
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("secretFlow");
    expect(serialized).toContain("[redacted-source-diff]");
    expect(serialized).not.toContain("sandbox-private-123");
    expect(serialized).not.toContain("sandboxId");
    expect(serialized).not.toContain("stream.example");
    expect(serialized).not.toContain("/remote/repo-01");
    expect(bundle.streams[0]?.completion?.actorLastMessageTail).toContain("[redacted-authorized-repo]");
    expect(bundle.streams[0]?.completion?.actorLastMessageTail).toContain("[redacted-provider-runtime-id]");
    expect(bundle.streams[0]?.url).toBeUndefined();
    expect(bundle.streams[0]?.label).toBe("E2B desktop - repo-01");
    expect(bundle.streams[0]).toMatchObject({
      embed: { kind: "screenshot", url: "../screenshots/oss-01-desktop.png" },
      ui: { screenshotUrl: "../screenshots/oss-01-desktop.png" }
    });
    expect(bundle.streams[0]?.artifacts).toContainEqual({
      label: "desktop screenshot",
      path: "screenshots/oss-01-desktop.png",
      kind: "screenshot"
    });
  });
});
