import { describe, expect, it } from "vitest";
import {
  measureLocality,
  measureRoutes,
  parseCommitLog,
  routeFoldersTouched,
  srcFoldersTouched,
  type CommitFiles,
} from "../../../scripts/lib/arch-bench-history.js";

// `git log --format=%x1e%H%x09%s --name-status -M` output for four commits.
const log = [
  "\u001eaaaa1111\tRecord the run outcome",
  "",
  "M\tsrc/run/run.ts",
  "M\tsrc/routes/terminal/session.ts",
  "M\tsrc/routes/computer-use/setup.ts",
  "A\tdocs/x.md",
  "\u001ebbbb2222\tMove the terminal files into src/routes/terminal",
  "",
  "R100\tsrc/terminal-ledger.ts\tsrc/routes/terminal/ledger.ts",
  "R095\tsrc/cua-actor-lab.ts\tsrc/routes/computer-use/route.ts",
  "\u001ecccc3333\tDocument the bench",
  "",
  "M\tREADME.md",
  "\u001edddd4444\tFix scripted and preview runs",
  "",
  "M\tsrc/scripted-browser-lab.ts",
  "M\tsrc/preview.ts",
  "D\tsrc/study/old.ts",
  "C075\tsrc/cli/a.ts\tsrc/cli/b.ts",
  "",
].join("\n");

describe("arch:bench history", () => {
  const commits = parseCommitLog(log);

  it("parses name-status output, keeping both sides of a rename", () => {
    expect(commits.map((commit) => [commit.sha, commit.subject])).toEqual([
      ["aaaa1111", "Record the run outcome"],
      ["bbbb2222", "Move the terminal files into src/routes/terminal"],
      ["cccc3333", "Document the bench"],
      ["dddd4444", "Fix scripted and preview runs"],
    ]);
    expect(commits[1]).toMatchObject({
      paths: [
        "src/terminal-ledger.ts",
        "src/routes/terminal/ledger.ts",
        "src/cua-actor-lab.ts",
        "src/routes/computer-use/route.ts",
      ],
      names: ["src/routes/terminal/ledger.ts", "src/routes/computer-use/route.ts"],
    });
    expect(commits[3]!.names).toEqual([
      "src/scripted-browser-lab.ts",
      "src/preview.ts",
      "src/study/old.ts",
      "src/cli/b.ts",
    ]);
  });

  it("counts top-level src folders, with a rename touching both of its folders", () => {
    expect(commits.map(srcFoldersTouched)).toEqual([
      ["routes", "run"],
      ["(root)", "routes"],
      [],
      ["(root)", "cli", "study"],
    ]);
  });

  it("counts route folders by new path, including the files each route held before the move", () => {
    expect(commits.map(routeFoldersTouched)).toEqual([
      ["computer-use", "terminal"],
      ["computer-use", "terminal"],
      [],
      ["preview", "scripted"],
    ]);
  });

  it("reports locality over commits that touch src/, with and without structural subjects", () => {
    expect(measureLocality(commits)).toEqual({
      commits: 4,
      structural: 1,
      all: { commits: 3, mean: 7 / 3, max: 3, distribution: { 2: 2, 3: 1 } },
      behavior: { commits: 2, mean: 2.5, max: 3, distribution: { 2: 1, 3: 1 } },
    });
  });

  it("computes the route baseline from git and carries the recorded replay", () => {
    const baselineCommits: CommitFiles[] = [commits[0]!, commits[3]!];
    const metric = measureRoutes(
      commits,
      {
        replayBase: "151eafea",
        commits: [
          { pr: 1, commit: "aaaa", replayed: 1 },
          { pr: 2, commit: "dddd", replayed: 0 },
        ],
      },
      baselineCommits,
    );
    expect(metric.touchingOne).toBe(3);
    expect(metric.touchingTwoOrMore).toMatchObject({ commits: 3, mean: 2 });
    expect(metric.baseline).toMatchObject({
      commits: 2,
      whenLanded: { mean: 2 },
      replayed: { mean: 0.5 },
      perCommit: [
        { pr: 1, commit: "aaaa", landed: 2, replayed: 1 },
        { pr: 2, commit: "dddd", landed: 2, replayed: 0 },
      ],
    });
    expect(() =>
      measureRoutes(
        commits,
        { replayBase: "x", commits: [{ pr: 3, commit: "ffff", replayed: 0 }] },
        [],
      ),
    ).toThrow(/ffff/);
  });
});
