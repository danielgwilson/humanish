import { CommanderError } from "commander";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OSS_REPOS,
  normalizeOssRepoSlugs,
  runOssLab,
  validateOssRepoSlug
} from "../src/oss-lab.js";
import { buildObserverData } from "../src/observer-data.js";
import {
  buildOssMetaBootstrapScriptFixture,
  buildOssMetaBundleFixture,
  buildOssRepoAssignments,
  cleanupOssMetaLabSandboxes,
  cleanupStaleOssMetaLabSandboxes,
  collectOssMetaLabRemoteEnv,
  normalizeHostActorRecommendedProof,
  preflightOssMetaActorApiKey,
  preflightOssMetaRepoAccess,
  publicSafeOssMetaBundle,
  runOssMetaLab
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
    schema: "humanish.setup-quality.v1",
    generatedAt: "2026-06-04T10:06:00.000Z",
    redaction: {
      status: "passed",
      rawPreviews: "included",
      notes: "Only allowlisted setup files are previewed."
    },
    summary: "Humanish setup is app-specific and proof-oriented.",
    status: "passed",
    checks: [
      {
        id: "humanish-config",
        label: "Humanish config",
        ok: true,
        detail: "humanish/config.ts exists."
      },
      {
        id: "package-script",
        label: "Package script",
        ok: true,
        detail: "package.json exposes a Humanish watch script."
      },
      {
        id: "runtime-ignore",
        label: "Runtime ignore",
        ok: true,
        detail: ".gitignore excludes .humanish/ runtime state."
      }
    ],
    tree: [
      { path: "package.json", type: "file", sizeBytes: 540 },
      { path: "humanish", type: "directory" },
      { path: "humanish/config.ts", type: "file", sizeBytes: 180 },
      { path: "humanish/personas/product-researcher.yaml", type: "file", sizeBytes: 220 },
      { path: "humanish/scenarios/desktop-core-flow.yaml", type: "file", sizeBytes: 260 }
    ],
    previews: [
      {
        path: "humanish/config.ts",
        language: "typescript",
        truncated: false,
        text: "export default { run: { appUrl: 'http://127.0.0.1:5173', sims: 2 } };"
      }
    ],
    studyQuality: {
      schema: "humanish.study-quality.v1",
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
      humanish: "humanish watch"
    },
    humanish: {
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
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
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
      schema: "humanish.oss-meta-lab-result.v1",
      ok: true,
      assignments: [],
      count: 1,
      cwd: "/tmp/humanish",
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
        code: "HUMANISH_META_RUN_FAILED",
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
      HUMANISH_OSS_META_ACTOR_FIRST: "1",
      HUMANISH_OSS_META_ACTOR_MODEL: "gpt-5.4-mini",
      HUMANISH_OSS_META_HOST_CODEX_ACTOR: "1",
      HUMANISH_OSS_META_CODEX_APP_SERVER: "1",
      HUMANISH_OSS_META_CODEX_APP_SERVER_URL: "https://codex-app-server.example/session/private-token-test",
      HUMANISH_OSS_META_ACTOR_TIMEOUT_MS: "240000",
      HUMANISH_OSS_META_REQUIRE_ACTOR: "1",
      OPENAI_API_KEY: "must-not-forward-from-helper"
    })).toEqual({
      HUMANISH_OSS_META_ACTOR_FIRST: "1",
      HUMANISH_OSS_META_ACTOR_MODEL: "gpt-5.4-mini",
      HUMANISH_OSS_META_HOST_CODEX_ACTOR: "1",
      HUMANISH_OSS_META_CODEX_APP_SERVER: "1",
      HUMANISH_OSS_META_ACTOR_TIMEOUT_MS: "240000",
      HUMANISH_OSS_META_REQUIRE_ACTOR: "1"
    });
  });

  it("preflights private GitHub repo clone access with askpass-scoped token auth after anonymous access fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-repo-preflight-"));
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
          if (!options?.env?.HUMANISH_GITHUB_TOKEN_RUNTIME) {
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
      expect(calls[0]?.env.HUMANISH_GITHUB_TOKEN_RUNTIME).toBeUndefined();
      expect(calls[0]?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(calls[0]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(calls[1]?.env.GIT_ASKPASS).toContain("git-askpass-");
      expect(calls[1]?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(calls[1]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(calls[1]?.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(calls[1]?.env.HUMANISH_GITHUB_TOKEN_RUNTIME).toBe("github-token-test");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prefers anonymous repo access when token auth is present for a public repo", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-repo-preflight-fallback-"));
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
      expect(envs[0]?.HUMANISH_GITHUB_TOKEN_RUNTIME).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("cleans only its captured physical repo-preflight temp root after a cwd alias retarget", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "humanish-oss-repo-preflight-alias-"));
    const physicalA = path.join(tempRoot, "physical-a");
    const physicalB = path.join(tempRoot, "physical-b");
    const cwdAlias = path.join(tempRoot, "cwd-alias");
    await mkdir(physicalA);
    await mkdir(physicalB);
    await symlink(physicalA, cwdAlias, "dir");
    const [assignment] = buildOssRepoAssignments(["example/public-fixture"], 1);
    if (!assignment) throw new Error("Missing assignment.");

    let capturedRoot = "";
    let decoySentinel = "";
    try {
      const result = await preflightOssMetaRepoAccess({
        assignments: [assignment],
        cwd: cwdAlias,
        env: {},
        execFileImpl: async (_file, _args, options) => {
          capturedRoot = options.cwd ?? "";
          const rootId = path.basename(capturedRoot);
          await unlink(cwdAlias);
          await symlink(physicalB, cwdAlias, "dir");
          decoySentinel = path.join(physicalB, ".humanish", "tmp", rootId, "must-survive.txt");
          await mkdir(path.dirname(decoySentinel), { recursive: true });
          await writeFile(decoySentinel, "B-SENTINEL", "utf8");
          return { stderr: "", stdout: "" };
        }
      });

      expect(result[0]?.ok).toBe(true);
      expect(capturedRoot).toContain(`${path.sep}physical-a${path.sep}`);
      await expect(stat(capturedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(decoySentinel, "utf8")).toBe("B-SENTINEL");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("classifies missing GitHub clone auth without leaking private repo labels when redacted", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-repo-preflight-fail-"));
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
        HUMANISH_OSS_META_ACTOR_PREFLIGHT_MODEL: "gpt-test"
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
        code: "HUMANISH_META_RUN_FAILED",
        message: "OSS meta-lab failed 2/4 live desktop or bootstrap launches."
      }
    }))).toBe(2);
  });

  it("serves the OSS meta-lab Observer when a failed live run still produced evidence", () => {
    const failedWithObserver = liveMetaResult({
      ok: false,
      error: {
        code: "HUMANISH_META_RUN_FAILED",
        message: "OSS meta-lab failed 4/4 live desktop or bootstrap launches."
      },
      observer: {
        schema: "humanish.observer-result.v1",
        ok: true,
        cwd: "/tmp/humanish",
        run: "oss-live-fixture",
        observerPath: ".humanish/runs/oss-live-fixture/observer/index.html",
        observerDataPath: ".humanish/runs/oss-live-fixture/observer/observer-data.json",
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

  it("never authorizes provider cleanup from mutable result sandbox IDs", async () => {
    const result = liveMetaResult({
      sandboxes: [
        { repo: "repo-01", sandboxId: "sandbox-a", streamId: "oss-01-desktop", urlPresent: true },
        { repo: "repo-02", sandboxId: "sandbox-b", streamId: "oss-02-desktop", urlPresent: true },
        { repo: "repo-02", sandboxId: "sandbox-b", streamId: "oss-02-desktop-retry", urlPresent: true },
        { repo: "repo-03", streamId: "oss-03-desktop", urlPresent: false }
      ]
    });
    const killed: string[] = [];

    await expect(cleanupOssMetaLabSandboxes(result, {
      killSandbox: async (sandboxId) => {
        killed.push(sandboxId);
      },
      requestTimeoutMs: 123
    })).resolves.toEqual({
      killed: 0,
      skipped: 4,
      errors: ["Stored OSS meta-lab sandbox IDs cannot authorize provider mutation; use the explicit metadata-verified orphan sweep."]
    });
    expect(killed).toEqual([]);
  });

  it("cleans up stale OSS meta-lab sandboxes by provider metadata without exposing ids (explicit listSandboxes DI = opted in)", async () => {
    const killed = new Set<string>();
    const listSandboxes = async () => [
      { sandboxId: "sandbox-a", metadata: { mode: "oss-meta-lab", tool: "humanish" } },
      { id: "sandbox-b", metadata: { mode: "oss-meta-lab", tool: "humanish" } },
      { sandboxID: "sandbox-c", metadata: { mode: "oss-meta-lab", tool: "humanish" } },
      { sandboxID: "sandbox-missing-metadata" },
      { sandboxId: "sandbox-paused", metadata: { mode: "oss-meta-lab", tool: "humanish" }, state: "paused" },
      { sandboxId: "sandbox-other", metadata: { mode: "other", tool: "humanish" } }
    ].filter((sandbox) => {
      const id = sandbox.sandboxId ?? sandbox.sandboxID ?? sandbox.id;
      return !id || !killed.has(id);
    });

    // Passing an explicit listSandboxes callback IS the opt-in for this test (it bypasses the
    // HUMANISH_OSS_META_ALLOW_PROVIDER_LIST gate, which only guards the REAL @e2b/desktop path).
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

  it("never enumerates the E2B account by default: cleanupStaleOssMetaLabSandboxes without listSandboxes DI and without the opt-in env skips Sandbox.list", async () => {
    const previous = process.env.HUMANISH_OSS_META_ALLOW_PROVIDER_LIST;
    delete process.env.HUMANISH_OSS_META_ALLOW_PROVIDER_LIST;
    try {
      const cleanup = await cleanupStaleOssMetaLabSandboxes({ requestTimeoutMs: 123 });
      // No account-wide discovery happened: nothing was found to kill, and the honest reason is
      // recorded, never a silent no-op pretending success.
      expect(cleanup.killed).toBe(0);
      expect(cleanup.errors.join("\n")).toContain("disabled by default");
      expect(cleanup.errors.join("\n")).toContain("HUMANISH_OSS_META_ALLOW_PROVIDER_LIST");
    } finally {
      if (previous === undefined) delete process.env.HUMANISH_OSS_META_ALLOW_PROVIDER_LIST;
      else process.env.HUMANISH_OSS_META_ALLOW_PROVIDER_LIST = previous;
    }
  });

  it("HUMANISH_OSS_META_ALLOW_PROVIDER_LIST=1 opts back into the real-SDK discovery path (advances past the default-disabled gate)", async () => {
    const previousEnvFlag = process.env.HUMANISH_OSS_META_ALLOW_PROVIDER_LIST;
    const previousE2b = process.env.E2B_API_KEY;
    process.env.HUMANISH_OSS_META_ALLOW_PROVIDER_LIST = "1";
    delete process.env.E2B_API_KEY;
    try {
      const cleanup = await cleanupStaleOssMetaLabSandboxes({ requestTimeoutMs: 123 });
      // The gate no longer blocks: execution advanced to the NEXT honest check (no E2B_API_KEY),
      // proving the opt-in was read, without needing a live E2B account for this test.
      expect(cleanup.errors.join("\n")).toContain("E2B_API_KEY is not present");
      expect(cleanup.errors.join("\n")).not.toContain("disabled by default");
    } finally {
      if (previousEnvFlag === undefined) delete process.env.HUMANISH_OSS_META_ALLOW_PROVIDER_LIST;
      else process.env.HUMANISH_OSS_META_ALLOW_PROVIDER_LIST = previousEnvFlag;
      if (previousE2b === undefined) delete process.env.E2B_API_KEY;
      else process.env.E2B_API_KEY = previousE2b;
    }
  });

  it("redacts metadata-verified provider ids from orphan-sweep errors", async () => {
    const cleanup = await cleanupStaleOssMetaLabSandboxes({
      listSandboxes: async () => [{
        sandboxId: "sandbox-secret",
        metadata: { mode: "oss-meta-lab", tool: "humanish" }
      }],
      killSandbox: async () => {
        throw new Error("failed to kill sandbox-secret");
      }
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
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-meta-count-"));
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

  it("normalizes host actor recommended proof to supported Humanish flags", () => {
    expect(normalizeHostActorRecommendedProof(
      "Start Vite, then run humanish run --app-url http://127.0.0.1:4173 --browser chromium --viewport desktop,mobile"
    )).toBe("Start the target app on a loopback URL, then run `humanish run --app-url http://127.0.0.1:<port> --sims 2`.");

    expect(normalizeHostActorRecommendedProof(
      "Run humanish run --app-url http://127.0.0.1:5173 --sims 2 after the app starts."
    )).toContain("humanish run --app-url");
  });

  it("renders a bash-valid remote bootstrap script with app surfaces and optional required actor readback", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-bootstrap-script-"));
    const scriptPath = path.join(cwd, "bootstrap.sh");
    try {
      const script = buildOssMetaBootstrapScriptFixture();
      await writeFile(scriptPath, script, "utf8");
      await execFileAsync("bash", ["-n", scriptPath]);

      expect(script).toContain("STATE_DIR='/home/user/.humanish-oss-lab/maciekt07-todoapp'");
      expect(script).toContain("ROOT_DIR=\"$STATE_DIR\"");
      expect(script).toContain("APP_DIR='/home/user/maciekt07-todoapp'");
      expect(script).toContain("NESTED_OBSERVER='/home/user/maciekt07-todoapp/.humanish/runs/nested-maciekt07-todoapp/observer/index.html'");
      expect(script).not.toContain("/home/user/humanish-oss-lab/maciekt07-todoapp/repo");
      expect(script).toContain("start_target_app_surface");
      expect(script).toContain("write_app_specific_browser_scenario");
      expect(script).toContain("app-surface-browser.yaml");
      expect(script).toContain("browser_scenario=authored");
      expect(script).toContain("selectorVisible: body");
      expect(script).toContain('npx --no-install humanish run --app-url "$APP_URL" --sims 2');
      expect(script).toContain('open_browser_url "$APP_URL" app-desktop');
      expect(script).toContain("arrange_lab_windows");
      expect(script).toContain("visualStatus");
      expect(script).toContain("windowlower");
      expect(script).toContain("start_actor_attempt");
      expect(script).toContain("apply_host_actor_plan");
      expect(script).toContain("host_actor_plan=applied");
      expect(script).toContain("source=host-codex-plan");
      expect(script).toContain("reason=remote-actor-not-run");
      expect(script).toContain("humanish/personas");
      expect(script).toContain("humanish/scenarios");
      expect(script).toContain("HUMANISH_OSS_META_HOST_CODEX_ACTOR");
      expect(script).toContain("HUMANISH_OSS_META_CODEX_APP_SERVER");
      expect(script).toContain("HUMANISH_PRIVATE_CODEX_APP_SERVER_URL");
      expect(script).toContain("HUMANISH_CODEX_APP_SERVER_URL");
      expect(script).toContain("wait_for_actor_attempt_if_required");
      expect(script).toContain("HUMANISH_OSS_META_ACTOR_FIRST");
      expect(script).toContain("HUMANISH_OSS_META_REQUIRE_ACTOR");
      expect(script).toContain("HUMANISH_OSS_META_ACTOR_TIMEOUT_MS");
      expect(script).toContain('HUMANISH_OSS_META_ACTOR_TIMEOUT_MS:-480000');
      expect(script).toContain("ACTOR_TIMEOUT_SECONDS");
      expect(script).toContain("Do not wait on long-running watchers");
      expect(script).toContain("coverage-map.md");
      expect(script).toContain("Do not stop at install/init proof");
      expect(script).toContain("Run npx --no-install humanish run --help and verify --app-url is available");
      expect(script).toContain("do not use humanish watch --sims as app behavior proof");
      expect(script).toContain("HUMANISH_OSS_META_ACTOR_MODEL");
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
      expect(script).toContain("humanish.codex-app-server-trace.projected.v1");
      expect(script).toContain("projectTraceJson");
      expect(script).toContain("humanish.oss-meta-nested-step-trace-summary.v1");
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
      expect(script).toContain('HUMANISH_PRIVATE_CODEX_API_KEY="${HUMANISH_CODEX_API_KEY:-}"');
      expect(script).toContain('HUMANISH_PRIVATE_CODEX_APP_SERVER_URL="${HUMANISH_CODEX_APP_SERVER_URL:-}"');
      expect(script).toContain("unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN E2B_API_KEY GH_TOKEN GITHUB_TOKEN");
      expect(script).toContain("unset HUMANISH_CODEX_API_KEY HUMANISH_CODEX_ACCESS_TOKEN HUMANISH_CODEX_APP_SERVER_URL HUMANISH_GITHUB_TOKEN");
      expect(script).toContain('CODEX_API_KEY="\\$HUMANISH_PRIVATE_CODEX_API_KEY" CODEX_ACCESS_TOKEN="\\$HUMANISH_PRIVATE_CODEX_ACCESS_TOKEN" timeout "\\$ACTOR_TIMEOUT_SECONDS" bash -lc "\\$CODEX_COMMAND"');
      expect(script).toContain('CODEX_ACCESS_TOKEN="\\$HUMANISH_PRIVATE_CODEX_ACCESS_TOKEN" timeout "\\$ACTOR_TIMEOUT_SECONDS" bash -lc "\\$CODEX_COMMAND"');
      expect(script).toContain('HUMANISH_PRIVATE_CODEX_API_KEY="$HUMANISH_PRIVATE_CODEX_API_KEY" HUMANISH_PRIVATE_CODEX_ACCESS_TOKEN="$HUMANISH_PRIVATE_CODEX_ACCESS_TOKEN" nohup bash "$actor_script"');
      expect(script).toContain("GIT_ASKPASS=false SSH_ASKPASS=false GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone");
      expect(script).toContain("clone_auth=anonymous");
      expect(script).toContain("clone_auth=anonymous_failed retry=token_clone");
      expect(script).toContain('HUMANISH_GITHUB_TOKEN_RUNTIME="$HUMANISH_PRIVATE_GITHUB_TOKEN" git -c credential.helper= clone');
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
    expect(result.stdout).toContain("Usage: humanish lab oss");
    expect(result.stdout).toContain("Alias: run the bundled OSS meta-lab dry-run contract");
    expect(result.stdout).toContain("--repos");
    expect(result.stdout).toContain("humanish lab run oss --dry-run");
    expect(result.stdout).toContain("humanish lab oss-smoke");
    expect(result.stdout).toContain("No repo clone, provider sandbox, credential forwarding, or Codex actor runs");
    expect(result.stdout).toContain("fails closed pending credential isolation");
  });

  it("keeps disposable-clone safety on lab oss-smoke", async () => {
    const result = await runCli(["lab", "oss-smoke", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: humanish lab oss-smoke");
    expect(result.stdout).toContain("Clone lightweight public OSS repos");
    expect(result.stdout).toContain("--keep");
    expect(result.stdout).toContain("removed by default");
  });

  it("defaults the OSS alias to a no-network dry-run contract", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-meta-"));
    const result = await runCli([
      "lab",
      "oss",
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
      dryRun: boolean;
      liveRequested: boolean;
      observer: { observerPath: string };
      schema: string;
    };
    expect(json.schema).toBe("humanish.oss-meta-lab-result.v1");
    expect(json.dryRun).toBe(true);
    expect(json.liveRequested).toBe(false);
    expect(json.assignments.map((assignment) => assignment.repo)).toEqual([
      "repo-01",
      "repo-02",
      "repo-03",
      "repo-04"
    ]);
    expect(json.observer.observerPath).toBe(".humanish/runs/oss-meta-test/observer/index.html");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", "oss-meta-test", "run.json"), "utf8")) as {
      cwd: string;
      mode: string;
      streams: Array<{
        terminal: { tail: string };
        ui: { route: string };
      }>;
    };
    expect(bundle.cwd).toBe(PUBLIC_TARGET_CWD);
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.streams[0]?.terminal.tail).toContain("npx --no-install humanish init --yes");
    expect(bundle.streams[0]?.terminal.tail).toContain("npx --no-install humanish run --app-url");
    expect(bundle.streams[0]?.ui.route).toBe("e2b://desktop/repo-01");
  });

  it("runs the bundled OSS meta-lab through the generic lab runner", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-meta-generic-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture-app" }), "utf8");
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
    const bundledManifest = await readFile(path.join(process.cwd(), "humanish", "labs", "oss.yaml"), "utf8");
    await writeFile(path.join(cwd, "humanish", "labs", "oss.yaml"), bundledManifest, "utf8");

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
    expect(json.schema).toBe("humanish.oss-meta-lab-result.v1");
    expect(json.dryRun).toBe(true);
    expect(json.assignments.map((assignment) => assignment.repo)).toEqual([
      "CorentinTh/it-tools",
      "drawdb-io/drawdb",
      "maciekt07/TodoApp",
      "lissy93/dashy"
    ]);
  });

  it("stops the OSS smoke trial after init fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-smoke-init-failure-"));
    const binDir = path.join(cwd, "bin");
    const gitLogPath = path.join(cwd, "git-calls.log");
    const previousPath = process.env.PATH;
    const previousGitLog = process.env.HUMANISH_OSS_TEST_GIT_LOG;
    await mkdir(binDir);
    await writeFile(path.join(binDir, "git"), [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$HUMANISH_OSS_TEST_GIT_LOG\"",
      "if [ \"$1\" != clone ]; then exit 97; fi",
      "for arg in \"$@\"; do clone_path=\"$arg\"; done",
      "mkdir -p \"$clone_path\"",
      "printf '{invalid-json' > \"$clone_path/package.json\"",
      "exit 0",
      ""
    ].join("\n"), { encoding: "utf8", mode: 0o700 });
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.HUMANISH_OSS_TEST_GIT_LOG = gitLogPath;

    try {
      const result = await runOssLab({
        cwd,
        keep: true,
        repos: ["example/broken-init"],
        runId: "init-failure-stop"
      });

      expect(result.ok).toBe(false);
      expect(result.repos).toHaveLength(1);
      expect(result.repos[0]?.steps.map((step) => step.name)).toEqual([
        "clone",
        "humanish init"
      ]);
      expect(result.repos[0]?.steps[1]?.ok).toBe(false);
      expect((await readFile(gitLogPath, "utf8")).trim().split("\n")).toHaveLength(1);
      await expect(stat(path.join(
        cwd,
        ".humanish",
        "tmp",
        "oss-lab",
        "init-failure-stop",
        "example__broken-init",
        ".humanish"
      ))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousGitLog === undefined) delete process.env.HUMANISH_OSS_TEST_GIT_LOG;
      else process.env.HUMANISH_OSS_TEST_GIT_LOG = previousGitLog;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a hardlinked OSS report target without mutating the external inode", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-report-hardlink-"));
    const runId = "report-hardlink";
    const reportRoot = path.join(cwd, ".humanish", "lab", "oss", runId);
    const externalReport = path.join(cwd, "external-report.json");
    const original = "{\"sentinel\":true}\n";
    const binDir = path.join(cwd, "bin");
    const previousPath = process.env.PATH;

    await mkdir(reportRoot, { recursive: true });
    await mkdir(binDir);
    await writeFile(externalReport, original, "utf8");
    await link(externalReport, path.join(reportRoot, "report.json"));
    await writeFile(path.join(binDir, "git"), [
      "#!/bin/sh",
      "exit 1",
      ""
    ].join("\n"), { encoding: "utf8", mode: 0o700 });
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

    try {
      await expect(runOssLab({
        cwd,
        keep: true,
        repos: ["example/unavailable"],
        runId
      })).rejects.toThrow(/single-link regular files|hardlinks/);
      expect(await readFile(externalReport, "utf8")).toBe(original);
      await expect(stat(path.join(reportRoot, "report.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("forces repo-label redaction when repos are overridden on the CLI (privacy invariant)", async () => {
    // Regression: a CLI --repos override must force redactRepos=true so an authorized private
    // slug never reaches durable artifacts, even with no policies.redactRepos in the lab.
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-meta-redact-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture-app" }), "utf8");
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
    await writeFile(path.join(cwd, "humanish", "labs", "oss.yaml"), [
      "schema: humanish.lab.v2",
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

  it("rejects live OSS meta-lab execution before callbacks, filesystem writes, or host commands", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-meta-live-gate-"));
    const binDir = path.join(cwd, "bin");
    const markerPath = path.join(cwd, "host-command-invoked");
    await mkdir(binDir);
    await writeFile(path.join(binDir, "git"), [
      "#!/bin/sh",
      `printf invoked > ${JSON.stringify(markerPath)}`,
      "exit 97",
      ""
    ].join("\n"), { encoding: "utf8", mode: 0o700 });

    const envKeys = [
      "CODEX_API_KEY",
      "E2B_API_KEY",
      "HUMANISH_OSS_META_HOST_CODEX_ACTOR",
      "HUMANISH_OSS_META_REQUIRE_ACTOR",
      "HUMANISH_OSS_META_SKIP_REPO_ACCESS_PREFLIGHT",
      "PATH"
    ] as const;
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<(typeof envKeys)[number], string | undefined>;
    process.env.CODEX_API_KEY = "test-codex-key";
    process.env.E2B_API_KEY = "test-e2b-key";
    process.env.HUMANISH_OSS_META_HOST_CODEX_ACTOR = "1";
    process.env.HUMANISH_OSS_META_REQUIRE_ACTOR = "1";
    process.env.HUMANISH_OSS_META_SKIP_REPO_ACCESS_PREFLIGHT = "1";
    process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;

    let observerReady = false;
    try {
      const result = await runOssMetaLab({
        count: 1,
        cwd,
        onObserverReady: () => {
          observerReady = true;
        },
        repos: ["private-owner/private-repo"],
        runId: "live-isolation-gate"
      });

      expect(result).toMatchObject({
        ok: false,
        dryRun: false,
        liveRequested: true,
        error: { code: "HUMANISH_OSS_META_LIVE_ISOLATION_REQUIRED" },
        repos: ["repo-01"],
        sandboxes: []
      });
      expect(result.error?.message).toContain("Use --dry-run");
      expect(JSON.stringify(result)).not.toContain("private-owner/private-repo");
      expect(observerReady).toBe(false);
      await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(cwd, ".humanish"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the OSS meta-lab dry-run contract available behind the live isolation gate", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-oss-meta-dry-run-gate-"));
    let observerReady = false;
    try {
      const result = await runOssMetaLab({
        count: 1,
        cwd,
        dryRun: true,
        onObserverReady: () => {
          observerReady = true;
        },
        repos: ["CorentinTh/it-tools"],
        runId: "dry-run-isolation-gate"
      });

      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(observerReady).toBe(true);
      expect(await stat(path.join(cwd, ".humanish", "runs", "dry-run-isolation-gate", "run.json")))
        .toMatchObject({});
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps OSS meta-lab writes on the captured physical run after an Observer-ready cwd retarget", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "humanish-oss-meta-callback-retarget-"));
    const physicalA = path.join(tempRoot, "physical-a");
    const physicalB = path.join(tempRoot, "physical-b");
    const cwdAlias = path.join(tempRoot, "cwd-alias");
    const runId = "callback-retarget";
    await mkdir(physicalA);
    await mkdir(physicalB);
    await symlink(physicalA, cwdAlias, "dir");

    try {
      const result = await runOssMetaLab({
        count: 1,
        cwd: cwdAlias,
        dryRun: true,
        onObserverReady: async () => {
          await unlink(cwdAlias);
          await symlink(physicalB, cwdAlias, "dir");
          const decoyRun = path.join(physicalB, ".humanish", "runs", runId);
          await mkdir(decoyRun, { recursive: true });
          await writeFile(path.join(decoyRun, "must-survive.txt"), "B-SENTINEL", "utf8");
        },
        repos: ["CorentinTh/it-tools"],
        runId
      });

      expect(result.ok).toBe(true);
      expect(await readFile(path.join(physicalB, ".humanish", "runs", runId, "must-survive.txt"), "utf8"))
        .toBe("B-SENTINEL");
      await expect(stat(path.join(physicalB, ".humanish", "runs", runId, "run.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await stat(path.join(physicalA, ".humanish", "runs", runId, "run.json")))
        .toMatchObject({});
      expect(await stat(path.join(physicalA, ".humanish", "runs", runId, "observer", "index.html")))
        .toMatchObject({});
    } finally {
      await unlink(cwdAlias).catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("surfaces host actor plan artifacts even when provider launch fails", () => {
    const assignments = buildOssRepoAssignments(["maciekt07/TodoApp"], 1);
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt: "2026-06-04T10:00:00.000Z",
      cwd: "/tmp/humanish-oss-meta-fixture",
      dryRun: false,
      lanes: [
        {
          error: "Invalid API key format: expected [redacted-e2b-key].",
          hostActorPlan: {
            schema: "humanish.oss-host-actor-plan.v1",
            generatedAt: "2026-06-04T10:00:00.000Z",
            personas: [
              {
                id: "learner",
                name: "Learner",
                intent: "Inspect the app as a synthetic user.",
                traits: ["public_safe"]
              }
            ],
            recommendedProof: "Start the app, then run humanish run --app-url http://127.0.0.1:5173 --sims 2.",
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
      cwd: "/tmp/humanish-oss-meta-app-server-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "app-server-client",
            completionPath: "/remote/todoapp/completion.json",
            logPath: "/remote/todoapp/bootstrap.log",
            humanishPackageUploaded: true,
            nestedObserverPath: "/remote/todoapp/repo/.humanish/runs/nested/observer/index.html",
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
            reason: "Target app surface, nested Humanish proof, and nested Observer were checked.",
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
      schema: "humanish.meaningful-use-score.v1",
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
        schema: "humanish.oss-meta-nested-step-trace-summary.v1",
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
          source: "humanish/scenarios/todo-list-browser.yaml",
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
      reason: "Target app surface, nested Humanish proof, nested Observer, and Codex app-server actor evidence were checked.",
      setupQuality: highLeverageSetupQualityFixture(),
      status: "passed",
      visualReason: "Detected 4 visible Chrome windows including target app, nested Observer, and Codex app-server client surface.",
      visualStatus: "visible",
      visualWindowCount: 4
    };
    const bundle = buildOssMetaBundleFixture({
      assignments,
      createdAt: "2026-06-04T10:05:00.000Z",
      cwd: "/tmp/humanish-oss-meta-app-server-evidence-fixture",
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
            humanishPackageUploaded: true,
            nestedObserverPath: "/remote/todoapp/repo/.humanish/runs/nested/observer/index.html",
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
      label: "nested Humanish proof",
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
      schema: "humanish.meaningful-use-score.v1",
      status: "pass",
      score: 100,
      hardFailures: []
    });
    expect(bundle.streams[0]?.completion?.meaningfulUse?.components.map((component) => component.id)).toEqual([
      "setup-correctness",
      "filesystem-evidence",
      "nested-humanish-evidence",
      "actor-activity",
      "product-surface",
      "feedback-quality"
    ]);

    const persisted = publicSafeOssMetaBundle(bundle);
    const persistedSerialized = JSON.stringify(persisted);
    const persistedRefs = persisted.streams[0]?.artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`) ?? [];
    expect(persisted.cwd).toBe("[target-cwd]");
    expect(persistedSerialized).not.toContain("/tmp/humanish-oss-meta-app-server-evidence-fixture");
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
      label: "nested Humanish proof",
      path: "nested-evidence/oss-01-desktop-nested-proof.json",
      kind: "trace"
    });
    expect(observerData.streams[0]?.timeline.map((event) => event.type)).toContain("oss-meta.nested.step_trace.summary");
  });

  it("redacts structured Codex app-server trace evidence for private repo meta-labs", () => {
    const assignments = buildOssRepoAssignments(["maintainer/private-cinema-app"], 1);
    const appServerCompletion: OssMetaLabCompletion = {
      actorLastMessageTail: "Set up private-cinema-app and ran Humanish.",
      actorStatus: "passed",
      appServerActorEvidence: {
        eventsPath: "codex-app-server/oss-01-desktop-events.ndjson",
        eventsText: "agent mentioned maintainer/private-cinema-app",
        traceJson: {
          schema: "humanish.codex-app-server-trace.projected.v1",
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
        schema: "humanish.oss-meta-nested-step-trace-summary.v1",
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
          source: "/remote/private-cinema-app/humanish/scenarios/private.yaml",
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
      cwd: "/tmp/humanish-oss-meta-app-server-redaction-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "app-server-client",
            completionPath: "/remote/repo/completion.json",
            logPath: "/remote/repo/bootstrap.log",
            humanishPackageUploaded: true,
            nestedObserverPath: "/remote/repo/.humanish/runs/nested/observer/index.html",
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
      cwd: "/tmp/humanish-oss-meta-fixture",
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
            humanishPackageUploaded: true,
            nestedObserverPath: "/remote/it-tools/repo/.humanish/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started"
          },
          completion: {
            actorLogPath: "/remote/it-tools/actor.log",
            actorLogTail: "codex actor attempt\nnpx --no-install humanish init --yes\nactor_exit=0",
            actorLastMessageTail: "Set up Humanish, but the installed CLI does **not** expose run --app-url in the proof path.",
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
            reason: "Nested Humanish proof completed and nested Observer path was checked.",
            setupQuality: {
              schema: "humanish.setup-quality.v1",
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
                  id: "humanish-config",
                  label: "Humanish config",
                  ok: true,
                  detail: "humanish/config.ts exists."
                },
                {
                  id: "package-script",
                  label: "Package script",
                  ok: false,
                  detail: "package.json does not expose a Humanish script."
                }
              ],
              tree: [
                { path: "package.json", type: "file", sizeBytes: 240 },
                { path: "humanish", type: "directory" },
                { path: "humanish/config.ts", type: "file", sizeBytes: 120 }
              ],
              previews: [
                {
                  path: "humanish/config.ts",
                  language: "typescript",
                  truncated: false,
                  text: "export default { run: { appUrl: 'http://127.0.0.1:5173' } };"
                }
              ],
              studyQuality: {
                schema: "humanish.study-quality.v1",
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
              humanish: {
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
            humanishPackageUploaded: true,
            nestedObserverPath: "/remote/todoapp/repo/.humanish/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started"
          },
          completion: {
            checkedAt: "2026-06-02T08:31:10.000Z",
            exitCode: 1,
            logTail: "npx --no-install humanish verify --run latest\nverification failed",
            nestedObserverPresent: false,
            nestedVerifyPassed: false,
            reason: "Bootstrap exited before nested Humanish proof completed.",
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
      actorLogTail: "codex actor attempt\nnpx --no-install humanish init --yes\nactor_exit=0",
      actorLastMessageTail: "Set up Humanish, but the installed CLI does **not** expose run --app-url in the proof path.",
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
      schema: "humanish.meaningful-use-score.v1",
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
    expect(bundle.streams[0]?.terminal?.tail).toContain("npx --no-install humanish init --yes");
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
      schema: "humanish.feedback-candidate.v1",
      failure_owner: "actor",
      proposed_next_state: "setup-quality-review",
      summary: "Generated Humanish setup for CorentinTh/it-tools needs review"
    });
    expect(bundle.feedbackCandidates[0]?.evidence).toContainEqual({
      path: "setup-quality/oss-01-desktop-setup-quality.json",
      kind: "filesystem",
      note: "Setup-quality snapshot with tree, checks, package scripts, and allowlisted previews."
    });
    expect(bundle.feedbackCandidates[1]).toMatchObject({
      schema: "humanish.feedback-candidate.v1",
      failure_owner: "harness",
      proposed_next_state: "adapter-hardening",
      summary: "Published Humanish install path blocked app-url proof"
    });
    expect(bundle.feedbackCandidates[1]?.evidence).toContainEqual({
      path: "actor-evidence/oss-01-desktop-actor-last-message-tail.txt",
      kind: "log",
      note: "Public-safe actor last-message tail."
    });
    expect(bundle.feedbackCandidates[2]).toMatchObject({
      schema: "humanish.feedback-candidate.v1",
      failure_owner: "actor",
      proposed_next_state: "study-quality-review",
      summary: "Generated Humanish setup for CorentinTh/it-tools was ceremonial"
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
      cwd: "/tmp/humanish-oss-meta-timeout-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "tui-attempted",
            completionPath: "/remote/drawdb/completion.json",
            logPath: "/remote/drawdb/bootstrap.log",
            humanishPackageUploaded: true,
            nestedObserverPath: "/remote/drawdb/repo/.humanish/runs/nested/observer/index.html",
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
      schema: "humanish.meaningful-use-score.v1",
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
      cwd: "/tmp/humanish-oss-meta-private-fixture",
      dryRun: false,
      lanes: [
        {
          bootstrap: {
            codexMode: "tui-attempted",
            completionPath: "/remote/repo-01/completion.json",
            logPath: "/remote/repo-01/bootstrap.log",
            humanishPackageUploaded: true,
            nestedObserverPath: "/remote/repo-01/repo/.humanish/runs/nested/observer/index.html",
            status: "started",
            tail: "bootstrap started",
            terminalTitle: "Humanish 1 repo-01"
          },
          completion: {
            actorLastMessageTail: "Configured Humanish for maintainer/private-app in sandbox-private-123 and opened the private-app Observer.",
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
            reason: "Target app surface, nested Humanish proof, and nested Observer were checked in sandbox-private-123.",
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
