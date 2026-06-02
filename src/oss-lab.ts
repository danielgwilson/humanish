import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { runInit } from "./init.js";
import type { InitResult } from "./init.js";
import { renderObserver } from "./observer.js";
import type { ObserverResult } from "./observer.js";
import {
  doctor,
  runDryRun,
  verifyRun
} from "./run.js";
import type {
  DoctorResult,
  RunResult,
  VerifyResult
} from "./run.js";

const execFileAsync = promisify(execFile);

export const OSS_LAB_SCHEMA = "mimetic.oss-lab-result.v1";

export const DEFAULT_OSS_REPOS = [
  "developit/mitt",
  "lukeed/clsx",
  "sindresorhus/is-plain-obj",
  "ai/nanoid"
] as const;

export interface OssLabOptions {
  cwd: string;
  keep?: boolean;
  limit?: number;
  repos?: string[];
  runId?: string;
}

export interface OssLabStep {
  durationMs: number;
  name: string;
  ok: boolean;
  summary: string;
}

export interface OssLabRepoResult {
  changedFiles: string[];
  clonePath: string;
  mimeticRunId?: string;
  observerPath?: string;
  ok: boolean;
  repo: string;
  steps: OssLabStep[];
  url: string;
  warnings: string[];
}

export interface OssLabResult {
  schema: typeof OSS_LAB_SCHEMA;
  ok: boolean;
  cleanup: {
    kept: boolean;
    sandboxRemoved: boolean;
  };
  completedAt: string;
  cwd: string;
  error?: {
    code: "MIMETIC_INVALID_OSS_REPO" | "MIMETIC_INVALID_OSS_LIMIT";
    message: string;
  };
  reportJsonPath?: string;
  reportMarkdownPath?: string;
  repos: OssLabRepoResult[];
  runId: string;
  sandboxPath: string;
  startedAt: string;
  warnings: string[];
}

interface CommandResult {
  exitCode: number;
  ok: boolean;
  stderr: string;
  stdout: string;
}

export function normalizeOssRepoSlugs(input: string[] | undefined): string[] {
  const values = input && input.length > 0 ? input : [...DEFAULT_OSS_REPOS];
  const seen = new Set<string>();
  const repos: string[] = [];

  for (const value of values) {
    const slug = value.trim();
    if (slug.length === 0 || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    repos.push(slug);
  }

  return repos;
}

export function validateOssRepoSlug(slug: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)
    && !slug.includes("..")
    && !slug.includes("//");
}

export async function runOssLab(options: OssLabOptions): Promise<OssLabResult> {
  const cwd = path.resolve(options.cwd);
  const startedAt = new Date().toISOString();
  const runId = options.runId ?? makeRunId();
  const reportRoot = path.join(cwd, ".mimetic", "lab", "oss", runId);
  const sandboxPath = path.join(cwd, ".mimetic", "tmp", "oss-lab", runId);
  const warnings: string[] = [];
  const repos = normalizeOssRepoSlugs(options.repos);
  const limit = options.limit ?? repos.length;

  if (!Number.isInteger(limit) || limit < 1 || limit > 16) {
    return {
      schema: OSS_LAB_SCHEMA,
      ok: false,
      cleanup: { kept: Boolean(options.keep), sandboxRemoved: false },
      completedAt: new Date().toISOString(),
      cwd,
      error: {
        code: "MIMETIC_INVALID_OSS_LIMIT",
        message: "--limit must be an integer between 1 and 16."
      },
      repos: [],
      runId,
      sandboxPath: relativeToCwd(cwd, sandboxPath),
      startedAt,
      warnings
    };
  }

  const selectedRepos = repos.slice(0, limit);
  const invalid = selectedRepos.find((repo) => !validateOssRepoSlug(repo));
  if (invalid) {
    return {
      schema: OSS_LAB_SCHEMA,
      ok: false,
      cleanup: { kept: Boolean(options.keep), sandboxRemoved: false },
      completedAt: new Date().toISOString(),
      cwd,
      error: {
        code: "MIMETIC_INVALID_OSS_REPO",
        message: `Only public GitHub owner/repo slugs are supported: ${invalid}`
      },
      repos: [],
      runId,
      sandboxPath: relativeToCwd(cwd, sandboxPath),
      startedAt,
      warnings
    };
  }

  await mkdir(reportRoot, { recursive: true });
  await mkdir(sandboxPath, { recursive: true });

  const repoResults: OssLabRepoResult[] = [];
  for (const repo of selectedRepos) {
    repoResults.push(await runRepoTrial({ cwd, repo, runId, sandboxPath }));
  }

  let sandboxRemoved = false;
  if (!options.keep) {
    await rm(sandboxPath, { force: true, recursive: true });
    sandboxRemoved = true;
  }

  const completedAt = new Date().toISOString();
  const result: OssLabResult = {
    schema: OSS_LAB_SCHEMA,
    ok: repoResults.every((repo) => repo.ok),
    cleanup: { kept: Boolean(options.keep), sandboxRemoved },
    completedAt,
    cwd,
    reportJsonPath: relativeToCwd(cwd, path.join(reportRoot, "report.json")),
    reportMarkdownPath: relativeToCwd(cwd, path.join(reportRoot, "report.md")),
    repos: repoResults.map((repo) => ({
      ...repo,
      clonePath: relativeToCwd(cwd, repo.clonePath)
    })),
    runId,
    sandboxPath: relativeToCwd(cwd, sandboxPath),
    startedAt,
    warnings
  };

  await writeFile(path.join(reportRoot, "report.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(path.join(reportRoot, "report.md"), renderOssLabMarkdown(result), "utf8");

  return result;
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `oss-lab-${stamp}-${randomBytes(4).toString("hex")}`;
}

async function runRepoTrial(args: {
  cwd: string;
  repo: string;
  runId: string;
  sandboxPath: string;
}): Promise<OssLabRepoResult> {
  const clonePath = path.join(args.sandboxPath, args.repo.replace(/\//g, "__"));
  const url = `https://github.com/${args.repo}.git`;
  const steps: OssLabStep[] = [];
  const warnings: string[] = [];
  const mimeticRunId = `${args.runId}-${repoRunSuffix(args.repo)}`;

  const clone = await measureStep("clone", async () => {
    const result = await runCommand(args.cwd, "git", [
      "clone",
      "--depth",
      "1",
      url,
      clonePath
    ], 120_000);
    return {
      ok: result.ok,
      summary: result.ok ? "shallow public clone created" : compactCommandFailure(result)
    };
  });
  steps.push(clone);

  if (!clone.ok) {
    return {
      changedFiles: [],
      clonePath,
      ok: false,
      repo: args.repo,
      steps,
      url,
      warnings
    };
  }

  const init = await measureStep("mimetic init", async () => {
    const result: InitResult = await runInit({ cwd: clonePath, yes: true });
    warnings.push(...result.warnings.map((warning) => `init: ${warning}`));
    return {
      ok: result.ok,
      summary: result.ok
        ? summarizeInit(result)
        : result.error?.message ?? "init failed"
    };
  });
  steps.push(init);

  const readiness = await measureStep("mimetic doctor", async () => {
    const result: DoctorResult = await doctor(clonePath);
    return {
      ok: result.ok,
      summary: `${result.checks.filter((check) => check.ok).length}/${result.checks.length} checks passed`
    };
  });
  steps.push(readiness);

  const run = await measureStep("mimetic watch evidence", async () => {
    const runResult: RunResult = await runDryRun({
      cwd: clonePath,
      dryRun: true,
      runId: mimeticRunId,
      simCount: 4
    });
    if (!runResult.ok || !runResult.runId) {
      return {
        ok: false,
        summary: runResult.error?.message ?? "dry-run bundle failed"
      };
    }

    const observer: ObserverResult = await renderObserver(clonePath, runResult.runId, { open: false });
    return {
      ok: observer.ok,
      summary: observer.ok
        ? `observer rendered at ${observer.observerPath}`
        : observer.error?.message ?? "observer render failed"
    };
  });
  steps.push(run);

  const verify = await measureStep("mimetic verify", async () => {
    const result: VerifyResult = await verifyRun(clonePath, mimeticRunId);
    return {
      ok: result.ok,
      summary: `${result.checks.filter((check) => check.ok).length}/${result.checks.length} checks passed`
    };
  });
  steps.push(verify);

  const status = await runCommand(clonePath, "git", ["status", "--short", "--untracked-files=all"], 30_000);
  const changedFiles = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    changedFiles,
    clonePath,
    mimeticRunId,
    observerPath: `.mimetic/runs/${mimeticRunId}/observer/index.html`,
    ok: steps.every((step) => step.ok),
    repo: args.repo,
    steps,
    url,
    warnings
  };
}

async function measureStep(
  name: string,
  callback: () => Promise<{ ok: boolean; summary: string }>
): Promise<OssLabStep> {
  const started = Date.now();
  const result = await callback();
  return {
    durationMs: Date.now() - started,
    name,
    ok: result.ok,
    summary: result.summary
  };
}

async function runCommand(
  cwd: string,
  command: string,
  args: string[],
  timeout: number
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0"
      },
      maxBuffer: 1024 * 1024,
      timeout
    });
    return {
      exitCode: 0,
      ok: true,
      stderr: result.stderr,
      stdout: result.stdout
    };
  } catch (error) {
    const commandError = error as Partial<Error> & {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stderr?: string;
      stdout?: string;
    };
    return {
      exitCode: typeof commandError.code === "number" ? commandError.code : 1,
      ok: false,
      stderr: commandError.stderr ?? commandError.message ?? "",
      stdout: commandError.stdout ?? ""
    };
  }
}

function compactCommandFailure(result: CommandResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim().replace(/\s+/g, " ");
  return text.length > 180 ? `${text.slice(0, 177)}...` : text || `exit ${result.exitCode}`;
}

function summarizeInit(result: InitResult): string {
  const created = result.changes.filter((change) => change.action === "create").length;
  const updated = result.changes.filter((change) => change.action === "update").length;
  const mkdirs = result.changes.filter((change) => change.action === "mkdir").length;
  return `${created} files created, ${updated} files updated, ${mkdirs} runtime dirs planned/applied`;
}

function repoRunSuffix(repo: string): string {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function relativeToCwd(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  return relative.length === 0 ? "." : relative;
}

function renderOssLabMarkdown(result: OssLabResult): string {
  return [
    "# OSS Lab Report",
    "",
    `Run: \`${result.runId}\``,
    `Started: ${result.startedAt}`,
    `Completed: ${result.completedAt}`,
    `Sandbox: ${result.cleanup.kept ? result.sandboxPath : "removed"}`,
    "",
    "| Repo | Result | Steps | Changed files |",
    "| --- | --- | --- | --- |",
    ...result.repos.map((repo) => {
      const steps = repo.steps
        .map((step) => `${step.ok ? "ok" : "fail"} ${step.name}`)
        .join("<br>");
      const changed = repo.changedFiles.length > 0
        ? repo.changedFiles.map((file) => `\`${file}\``).join("<br>")
        : "none";
      return `| \`${repo.repo}\` | ${repo.ok ? "pass" : "fail"} | ${steps} | ${changed} |`;
    }),
    "",
    "All clones are disposable public OSS trials. Do not commit cloned target changes."
  ].join("\n") + "\n";
}
