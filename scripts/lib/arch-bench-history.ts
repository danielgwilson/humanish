// Locality from git history for `pnpm arch:bench`: how many top-level src folders each commit on
// main touched, and the route-folder count the route duplication review used for its baseline.
import { execFileSync } from "node:child_process";
import { srcFolderOf } from "./arch-bench-project.js";

export interface CommitFiles {
  sha: string;
  subject: string;
  /** Every path the commit changed. A rename lists its old and its new path. */
  paths: string[];
  /** The paths `git log --name-only -M` prints: a rename or a copy lists its new path only. */
  names: string[];
}

/** Subjects of commits that move code. Locality is reported with and without them. */
const STRUCTURAL_SUBJECT = /^(?:Move|Rename|Refactor|Inline|Split)\b/;

/**
 * The route folders of src/routes/ and the files each held before the move into src/routes/. A
 * commit that changed only pre-move files still changed that route's code.
 */
const ROUTE_RULES: readonly (readonly [string, RegExp])[] = [
  ["terminal", /^src\/routes\/terminal\/|^src\/(?:e2b-terminal-lab|terminal-[^/]*)\.ts$/],
  [
    "computer-use",
    /^src\/routes\/computer-use\/|^src\/(?:cua-actor-lab|cua-diagnostics|cua-desktop-lane)\.ts$/,
  ],
  [
    "shared-world",
    /^src\/routes\/shared-world\/|^src\/(?:concurrent-shared-world-lab|shared-world-lab)\.ts$/,
  ],
  [
    "scripted",
    /^src\/routes\/scripted(?:\/|-browser\/|-browser\.ts$)|^src\/scripted-browser-lab\.ts$/,
  ],
  ["preview", /^src\/routes\/preview\.ts$|^src\/preview\.ts$/],
];

const RECORD = "\u001e";
const LOG_FORMAT = ["--format=%x1e%H%x09%s", "--name-status", "-M"];

/** Parses `git log --format=%x1e%H%x09%s --name-status -M` output. */
export function parseCommitLog(text: string): CommitFiles[] {
  return text
    .split(RECORD)
    .slice(1)
    .map((block) => {
      const [header = "", ...lines] = block.split("\n");
      const tab = header.indexOf("\t");
      const commit: CommitFiles = {
        sha: header.slice(0, tab),
        subject: header.slice(tab + 1),
        paths: [],
        names: [],
      };
      for (const line of lines) {
        const [status = "", first = "", second] = line.split("\t");
        if (status === "" || first === "") continue;
        if (status.startsWith("R") && second !== undefined) {
          commit.paths.push(first, second);
          commit.names.push(second);
        } else if (status.startsWith("C") && second !== undefined) {
          commit.paths.push(second);
          commit.names.push(second);
        } else {
          commit.paths.push(first);
          commit.names.push(first);
        }
      }
      return commit;
    });
}

/** Commits reachable from `ref` and committed on or after `since` (a UTC date, `YYYY-MM-DD`). */
export function readCommitsSince(root: string, ref: string, since: string): CommitFiles[] {
  return parseCommitLog(git(root, ["log", ref, `--since=${since}T00:00:00Z`, ...LOG_FORMAT]));
}

/** The named commits, in the order given. Unknown ids fail. */
export function readCommits(root: string, shas: readonly string[]): CommitFiles[] {
  if (shas.length === 0) return [];
  return parseCommitLog(git(root, ["log", "--no-walk=unsorted", ...LOG_FORMAT, ...shas]));
}

export function resolveCommit(root: string, ref: string): string {
  return git(root, ["rev-parse", "--short=8", ref]).trim();
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function srcFoldersTouched(commit: CommitFiles): string[] {
  const folders = new Set<string>();
  for (const path of commit.paths) {
    const folder = srcFolderOf(path);
    if (folder !== undefined) folders.add(folder);
  }
  return [...folders].sort();
}

export function routeFoldersTouched(commit: CommitFiles): string[] {
  const routes = new Set<string>();
  for (const path of commit.names) {
    for (const [route, rule] of ROUTE_RULES) if (rule.test(path)) routes.add(route);
  }
  return [...routes].sort();
}

export interface Spread {
  commits: number;
  mean: number | null;
  max: number;
  /** Commits by the number of folders they touched. */
  distribution: Record<string, number>;
}

function spreadOf(counts: readonly number[]): Spread {
  const distribution: Record<string, number> = {};
  for (const count of [...counts].sort((left, right) => left - right)) {
    distribution[count] = (distribution[count] ?? 0) + 1;
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  return {
    commits: counts.length,
    mean: counts.length === 0 ? null : total / counts.length,
    max: counts.length === 0 ? 0 : Math.max(...counts),
    distribution,
  };
}

export interface Locality {
  /** Every commit in the window. */
  commits: number;
  /** Commits whose subject starts with Move, Rename, Refactor, Inline or Split and touch src/. */
  structural: number;
  /** Top-level src folders per commit, over commits that touch src/. */
  all: Spread;
  /** The same, without the structural commits. */
  behavior: Spread;
}

export function measureLocality(commits: readonly CommitFiles[]): Locality {
  const touching = commits
    .map((commit) => ({ commit, folders: srcFoldersTouched(commit).length }))
    .filter(({ folders }) => folders > 0);
  const behavior = touching.filter(({ commit }) => !STRUCTURAL_SUBJECT.test(commit.subject));
  return {
    commits: commits.length,
    structural: touching.length - behavior.length,
    all: spreadOf(touching.map(({ folders }) => folders)),
    behavior: spreadOf(behavior.map(({ folders }) => folders)),
  };
}

export interface RouteBaselineCommit {
  pr: number;
  commit: string;
  /** Route folders the same change touches on the replay base, counted by reading the code. */
  replayed: number;
}

export interface RouteBaseline {
  /** The commit the hand replay read. */
  replayBase: string;
  commits: RouteBaselineCommit[];
}

export interface RouteMetric {
  /** Commits in the window that touched one or more route folders. */
  touchingOne: number;
  /** Route folders per commit over the commits that touched two or more. */
  touchingTwoOrMore: Spread;
  baseline: {
    replayBase: string;
    commits: number;
    /** Route folders per baseline commit, computed from git. */
    whenLanded: Spread;
    /** The recorded hand replay on the replay base. */
    replayed: Spread;
    perCommit: { pr: number; commit: string; landed: number; replayed: number }[];
  };
}

export function measureRoutes(
  window: readonly CommitFiles[],
  baseline: RouteBaseline,
  baselineCommits: readonly CommitFiles[],
): RouteMetric {
  const counts = window.map((commit) => routeFoldersTouched(commit).length);
  const perCommit = baseline.commits.map((entry) => {
    const commit = baselineCommits.find((candidate) => candidate.sha.startsWith(entry.commit));
    if (commit === undefined) throw new Error(`git did not return baseline commit ${entry.commit}`);
    return { ...entry, landed: routeFoldersTouched(commit).length };
  });
  return {
    touchingOne: counts.filter((count) => count >= 1).length,
    touchingTwoOrMore: spreadOf(counts.filter((count) => count >= 2)),
    baseline: {
      replayBase: baseline.replayBase,
      commits: perCommit.length,
      whenLanded: spreadOf(perCommit.map((entry) => entry.landed)),
      replayed: spreadOf(perCommit.map((entry) => entry.replayed)),
      perCommit,
    },
  };
}
