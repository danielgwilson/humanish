import { spawn } from "node:child_process";

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
}

export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

export async function captureGitState(
  cwd: string,
  options: {
    capturedAt?: Date | string;
    runner?: GitCommandRunner;
  } = {}
): Promise<CapturedGitState> {
  const capturedAt = toIsoString(options.capturedAt ?? new Date());
  const runner = options.runner ?? runGitCommand;
  const inside = await runner(["rev-parse", "--is-inside-work-tree"], cwd);

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

  const statusOutput = await runner(["status", "--porcelain=v1"], cwd);
  if (statusOutput.exitCode === null) {
    return unavailableState(capturedAt, "Git status command could not be started.");
  }

  if (statusOutput.exitCode !== 0) {
    return unavailableState(capturedAt, "Git status could not be captured.");
  }

  const headOutput = await runner(["rev-parse", "--short=12", "HEAD"], cwd);
  const shortSha = headOutput.exitCode === 0 ? normalizeNullableText(headOutput.stdout) : null;
  const refState = await captureRefState(runner, cwd, shortSha);
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

async function captureRefState(
  runner: GitCommandRunner,
  cwd: string,
  shortSha: string | null
): Promise<GitRefState> {
  const symbolicRef = await runner(["symbolic-ref", "--quiet", "HEAD"], cwd);

  if (symbolicRef.exitCode === 0) {
    return "attached";
  }

  return shortSha === null ? "unborn" : "detached";
}

async function runGitCommand(args: string[], cwd: string): Promise<GitCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", (error: Error) => {
      resolve({
        exitCode: null,
        stdout: stdout.join(""),
        stderr: error.message
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: stdout.join(""),
        stderr: stderr.join("")
      });
    });
  });
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
