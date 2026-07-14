import { spawn } from "node:child_process";
import os from "node:os";

import {
  inspectVerifiedGitWorkspace,
  type VerifiedGitWorkspace
} from "./git-workspace.js";

export const GIT_STATE_SCHEMA = "humanish.git-state.v1";

export type GitStateStatus = "clean" | "dirty" | "missing" | "unavailable";
export type GitRefState = "attached" | "detached" | "unborn" | "unknown";

export interface GitStateChangeSummary {
  staged: number;
  unstaged: number;
  untracked: number;
  total: number;
}

export interface CapturedGitState {
  schema: typeof GIT_STATE_SCHEMA;
  status: GitStateStatus;
  capturedAt: string;
  head: {
    shortSha: string | null;
    refState: GitRefState;
  };
  changes: GitStateChangeSummary;
  note: string;
}

export interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 15_000;

export async function captureGitState(
  cwd: string,
  options: {
    capturedAt?: Date | string;
    commandTimeoutMs?: number;
    runner?: GitCommandRunner;
  } = {}
): Promise<CapturedGitState> {
  const capturedAt = toIsoString(options.capturedAt ?? new Date());
  const inspection = await inspectVerifiedGitWorkspace(cwd);
  if (inspection.status === "unsafe") {
    return unavailableState(capturedAt, inspection.note);
  }
  if (inspection.status === "missing") {
    return missingState(capturedAt);
  }

  const commandTimeoutMs = normalizeCommandTimeout(options.commandTimeoutMs);
  const runner: GitCommandRunner = options.runner
    ? (args, commandCwd) => runGitRunnerWithDeadline(options.runner!, args, commandCwd, commandTimeoutMs)
    : (args) => runGitCommand(args, inspection.workspace, commandTimeoutMs);
  const commandCwd = inspection.workspace.worktreeRoot;
  const inside = await runner(["rev-parse", "--is-inside-work-tree"], commandCwd);

  if (inside.timedOut) {
    return unavailableState(capturedAt, "Git work-tree detection timed out.");
  }
  if (inside.exitCode === null) {
    return unavailableState(capturedAt, "Git command could not be started.");
  }

  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return {
      schema: GIT_STATE_SCHEMA,
      status: "missing",
      capturedAt,
      head: {
        shortSha: null,
        refState: "unknown"
      },
      changes: emptyChanges(),
      note: "No git work tree was detected."
    };
  }

  const statusOutput = await runner([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=all"
  ], commandCwd);
  if (statusOutput.timedOut) {
    return unavailableState(capturedAt, "Git status capture timed out.");
  }
  if (statusOutput.exitCode === null) {
    return unavailableState(capturedAt, "Git status command could not be started.");
  }

  if (statusOutput.exitCode !== 0) {
    return unavailableState(capturedAt, "Git status could not be captured.");
  }

  const headOutput = await runner(["rev-parse", "--short=12", "HEAD"], commandCwd);
  if (headOutput.timedOut) {
    return unavailableState(capturedAt, "Git HEAD capture timed out.");
  }
  if (headOutput.exitCode === null) {
    return unavailableState(capturedAt, "Git HEAD command could not be started.");
  }
  const shortSha = headOutput.exitCode === 0 ? normalizeNullableText(headOutput.stdout) : null;
  const symbolicRef = await runner(["symbolic-ref", "--quiet", "HEAD"], commandCwd);
  if (symbolicRef.timedOut) {
    return unavailableState(capturedAt, "Git ref-state capture timed out.");
  }
  if (symbolicRef.exitCode === null) {
    return unavailableState(capturedAt, "Git ref-state command could not be started.");
  }
  const refState: GitRefState = symbolicRef.exitCode === 0
    ? "attached"
    : shortSha === null ? "unborn" : "detached";
  const changes = summarizePorcelainStatus(statusOutput.stdout);
  const status: GitStateStatus = changes.total === 0 ? "clean" : "dirty";

  return {
    schema: GIT_STATE_SCHEMA,
    status,
    capturedAt,
    head: {
      shortSha,
      refState
    },
    changes,
    note: status === "clean"
      ? "Git work tree was clean; branch names, remotes, paths, and file names were not captured."
      : "Git work tree had changes; only counts were captured, not branch names, remotes, paths, or file names."
  };
}

export function summarizePorcelainStatus(output: string): GitStateChangeSummary {
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of lines) {
    const indexStatus = line[0] ?? " ";
    const workTreeStatus = line[1] ?? " ";

    if (indexStatus === "?" && workTreeStatus === "?") {
      untracked += 1;
      continue;
    }

    if (indexStatus !== " ") {
      staged += 1;
    }

    if (workTreeStatus !== " ") {
      unstaged += 1;
    }
  }

  return {
    staged,
    unstaged,
    untracked,
    total: lines.length
  };
}

async function runGitCommand(
  args: string[],
  workspace: VerifiedGitWorkspace,
  timeoutMs: number
): Promise<GitCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn("git", [
      `--git-dir=${workspace.gitDir}`,
      `--work-tree=${workspace.worktreeRoot}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      `core.excludesFile=${os.devNull}`,
      "-c",
      `core.attributesFile=${os.devNull}`,
      "-c",
      "core.alternateRefsCommand=",
      "-c",
      "core.alternateRefsPrefixes=",
      ...workspace.configOverrides.flatMap((override) => ["-c", override]),
      ...args
    ], {
      cwd: workspace.worktreeRoot,
      env: isolatedGitEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const finish = (result: GitCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        exitCode: null,
        stdout: stdout.join(""),
        stderr: "Git command timed out.",
        timedOut: true
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", (error: Error) => {
      finish({
        exitCode: null,
        stdout: stdout.join(""),
        stderr: error.message
      });
    });
    child.on("close", (exitCode) => {
      finish({
        exitCode,
        stdout: stdout.join(""),
        stderr: stderr.join("")
      });
    });
  });
}

async function runGitRunnerWithDeadline(
  runner: GitCommandRunner,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<GitCommandResult> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: GitCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        exitCode: null,
        stdout: "",
        stderr: "Git command timed out.",
        timedOut: true
      });
    }, timeoutMs);

    void runner(args, cwd).then(finish, (error: unknown) => {
      finish({
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

function isolatedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (!name.toUpperCase().startsWith("GIT_")) {
      isolated[name] = value;
    }
  }
  return {
    ...isolated,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function normalizeCommandTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Git command timeout must be a positive safe integer.");
  }
  return value;
}

function unavailableState(capturedAt: string, note: string): CapturedGitState {
  return {
    schema: GIT_STATE_SCHEMA,
    status: "unavailable",
    capturedAt,
    head: {
      shortSha: null,
      refState: "unknown"
    },
    changes: emptyChanges(),
    note
  };
}

function missingState(capturedAt: string): CapturedGitState {
  return {
    schema: GIT_STATE_SCHEMA,
    status: "missing",
    capturedAt,
    head: {
      shortSha: null,
      refState: "unknown"
    },
    changes: emptyChanges(),
    note: "No git work tree was detected."
  };
}

function emptyChanges(): GitStateChangeSummary {
  return {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    total: 0
  };
}

function normalizeNullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${String(value)}`);
  }

  return date.toISOString();
}
