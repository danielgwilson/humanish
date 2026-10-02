import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { completeAutomaticAnalysis } from "../../src/analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../src/analysis/automatic-config.js";
import { serveObserver } from "../../src/observer/render.js";
import { liveObserverResult } from "../../src/observer/live.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { readRunIndex } from "../../src/run/run-index.js";
import { FinishedRun, runScope, type RunScope } from "../../src/run/run.js";
import {
  writeContainedOutputFile,
  writePreparedRunLatestPointer,
} from "../../src/run/contained-output.js";
import { classifyRunStatus, RUN_STATUS_STALE_MS } from "../../src/run/status.js";

// A narrow wrapper around the two writers, so a test can fail or hold one exact publication step.
vi.mock("../../src/run/contained-output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/contained-output.js")>();
  return {
    ...actual,
    writeContainedOutputFile: vi.fn(actual.writeContainedOutputFile),
    writePreparedRunLatestPointer: vi.fn(actual.writePreparedRunLatestPointer),
  };
});

const actualWriters = await vi.importActual<typeof import("../../src/run/contained-output.js")>(
  "../../src/run/contained-output.js",
);

let template: RunBundle;
let templateRoot: string;
let cwd: string;

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(tmpdir(), "humanish-run-template-"));
  expect((await runDryRun({ cwd: templateRoot, dryRun: true, runId: "template" })).ok).toBe(true);
  template = JSON.parse(
    await readFile(path.join(templateRoot, ".humanish", "runs", "template", "run.json"), "utf8"),
  ) as RunBundle;
});

afterAll(async () => {
  await rm(templateRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-lifecycle-"));
});

afterEach(async () => {
  vi.mocked(writeContainedOutputFile).mockImplementation(actualWriters.writeContainedOutputFile);
  vi.mocked(writePreparedRunLatestPointer).mockImplementation(
    actualWriters.writePreparedRunLatestPointer,
  );
  await rm(cwd, { recursive: true, force: true });
});

const runDir = (runId: string) => path.join(cwd, ".humanish", "runs", runId);
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const readStatus = (runId: string) => readJson(path.join(runDir(runId), "status.json"));
const readLatest = () => readJson(path.join(cwd, ".humanish", "runs", "latest.json"));

function bundleFor(runId: string, gap = "synthetic gap"): RunBundle {
  return {
    ...template,
    runId,
    artifactRoot: path.join(".humanish", "runs", runId),
    review: { ...template.review, gaps: [gap] },
  };
}

function start(scope: RunScope, runId: string, now?: () => number) {
  return scope.startRun({
    cwd,
    runId,
    mintRunId: () => "minted",
    mode: "dry-run",
    renderReview: (bundle) => `# Review ${bundle.runId}\n`,
    observer: { open: false },
    ...(now === undefined ? {} : { now }),
  });
}

async function startOk(scope: RunScope, runId: string, now?: () => number) {
  const started = await start(scope, runId, now);
  if (!started.ok) throw new Error(started.message);
  return started.run;
}

async function publish(runId: string) {
  const { finished } = await runScope(async (scope) => {
    await (await startOk(scope, runId)).finish(bundleFor(runId));
  });
  return finished;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("runScope closes a run on every exit", () => {
  it("a return before finish leaves a finished status with no outcome and no token", async () => {
    const { result, finished } = await runScope(async (scope) => {
      await startOk(scope, "returned");
      return "refused";
    });
    expect(result).toBe("refused");
    expect(finished).toBeUndefined();
    const status = await readStatus("returned");
    expect(status.state).toBe("finished");
    expect(status).not.toHaveProperty("outcome");
    await expect(readLatest()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a throw after startRun closes the run and rethrows the original error", async () => {
    const failure = new Error("route failed");
    await expect(
      runScope(async (scope) => {
        await startOk(scope, "thrown");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect((await readStatus("thrown")).state).toBe("finished");
    expect(await readStatus("thrown")).not.toHaveProperty("outcome");
  });

  it("parallel scopes each close only their own run", async () => {
    const release = deferred();
    const [abandoned, published] = await Promise.all([
      runScope(async (scope) => {
        await startOk(scope, "abandoned");
        await release.promise;
      }),
      runScope(async (scope) => {
        const run = await startOk(scope, "published");
        release.resolve();
        return run.finish(bundleFor("published"));
      }),
    ]);
    expect(abandoned.finished).toBeUndefined();
    expect(published.finished?.runId).toBe("published");
    expect(await readStatus("abandoned")).not.toHaveProperty("outcome");
    expect((await readStatus("published")).outcome).toEqual({ verdict: "contract_proof_only" });
  });

  it("a scope or run leaked out of the scope admits nothing after it closes", async () => {
    let leakedScope: RunScope | undefined;
    let leakedRun: Awaited<ReturnType<typeof startOk>> | undefined;
    await runScope(async (scope) => {
      leakedScope = scope;
      leakedRun = await startOk(scope, "leaked");
    });
    await expect(start(leakedScope!, "second")).rejects.toThrow(/closed/);
    await expect(leakedRun!.finish(bundleFor("leaked"))).rejects.toThrow(/closed/);
    await expect(readFile(path.join(runDir("leaked"), "run.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("Run.finish publishes once, in order", () => {
  it("a failure at review.md leaves run.json and the status outcome, and no pointer", async () => {
    await expect(
      runScope(async (scope) => {
        const run = await startOk(scope, "review-fault");
        await mkdir(path.join(run.paths.physicalRunRoot, "review.md"));
        await run.finish(bundleFor("review-fault"));
      }),
    ).rejects.toThrow(/single-link regular files/);
    expect((await readStatus("review-fault")).outcome).toEqual({ verdict: "contract_proof_only" });
    expect((await readJson(path.join(runDir("review-fault"), "run.json"))).runId).toBe(
      "review-fault",
    );
    await expect(readLatest()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a failure at run.json leaves a status with no outcome", async () => {
    await expect(
      runScope(async (scope) => {
        const run = await startOk(scope, "bundle-fault");
        await mkdir(path.join(run.paths.physicalRunRoot, "run.json"));
        await run.finish(bundleFor("bundle-fault"));
      }),
    ).rejects.toThrow(/single-link regular files/);
    const status = await readStatus("bundle-fault");
    expect(status.state).toBe("finished");
    expect(status).not.toHaveProperty("outcome");
  });

  it("a failed pointer write keeps the previous pointer and issues no token", async () => {
    await publish("previous");
    vi.mocked(writePreparedRunLatestPointer).mockRejectedValueOnce(new Error("pointer failed"));
    let observerData = "";
    await expect(
      runScope(async (scope) => {
        const run = await startOk(scope, "pointer-fault");
        try {
          await run.finish(bundleFor("pointer-fault"));
        } finally {
          const file = path.join(run.paths.physicalRunRoot, "observer", "observer-data.json");
          observerData = await readFile(file, "utf8");
        }
      }),
    ).rejects.toThrow("pointer failed");
    expect(observerData).toContain("pointer-fault");
    expect((await readLatest()).runId).toBe("previous");
  });

  it("finish admits one call, sequential or concurrent, and keeps the first bytes", async () => {
    await runScope(async (scope) => {
      const run = await startOk(scope, "twice");
      await run.finish(bundleFor("twice", "first"));
      const bytes = await readFile(path.join(run.paths.physicalRunRoot, "run.json"), "utf8");
      const status = await readFile(path.join(run.paths.physicalRunRoot, "status.json"), "utf8");
      await expect(run.finish(bundleFor("twice", "second"))).rejects.toThrow(/one call/);
      expect(await readFile(path.join(run.paths.physicalRunRoot, "run.json"), "utf8")).toBe(bytes);
      expect(await readFile(path.join(run.paths.physicalRunRoot, "status.json"), "utf8")).toBe(
        status,
      );
    });
    await runScope(async (scope) => {
      const run = await startOk(scope, "racing");
      const settled = await Promise.allSettled([
        run.finish(bundleFor("racing", "first")),
        run.finish(bundleFor("racing", "second")),
      ]);
      expect(settled.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
      const written = await readJson(path.join(run.paths.physicalRunRoot, "run.json"));
      expect(written.review.gaps).toEqual(["first"]);
    });
  });

  it("startRun admits one call, and a bundle for another run or mode writes nothing", async () => {
    await runScope(async (scope) => {
      const concurrent = await Promise.allSettled([start(scope, "one"), start(scope, "two")]);
      expect(concurrent.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
      await expect(start(scope, "three")).rejects.toThrow(/one run/);
      const first = concurrent[0];
      if (first.status !== "fulfilled" || !first.value.ok) throw new Error("no run");
      const run = first.value.run;
      await expect(run.finish(bundleFor("other"))).rejects.toThrow(/another run or mode/);
      await expect(run.finish({ ...bundleFor("one"), mode: "live" })).rejects.toThrow(
        /another run or mode/,
      );
      await expect(
        readFile(path.join(run.paths.physicalRunRoot, "run.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await run.finish(bundleFor("one"));
    });
  });

  it("createdAt and the pointer's updatedAt come from the injected clock", async () => {
    const at = Date.parse("2026-09-30T12:00:00.000Z");
    await runScope(async (scope) => {
      const run = await startOk(scope, "clocked", () => at);
      expect(run.createdAt).toBe("2026-09-30T12:00:00.000Z");
      await run.finish(bundleFor("clocked"));
    });
    expect(await readLatest()).toEqual({
      schema: "humanish.latest-run.v1",
      runId: "clocked",
      path: path.join(".humanish", "runs", "clocked"),
      updatedAt: "2026-09-30T12:00:00.000Z",
    });
  });

  it("readers see the status after run.json and the pointer only at the end", async () => {
    await publish("previous");
    const atReview = deferred();
    const releaseReview = deferred();
    const atPointer = deferred();
    const releasePointer = deferred();
    vi.mocked(writeContainedOutputFile).mockImplementation(async (root, file, data, encoding) => {
      if (file === "review.json") {
        atReview.resolve();
        await releaseReview.promise;
      }
      return actualWriters.writeContainedOutputFile(root, file, data, encoding);
    });
    vi.mocked(writePreparedRunLatestPointer).mockImplementation(async (paths, data, encoding) => {
      atPointer.resolve();
      await releasePointer.promise;
      return actualWriters.writePreparedRunLatestPointer(paths, data, encoding);
    });
    await runScope(async (scope) => {
      const run = await startOk(scope, "barrier");
      const finishing = run.finish(bundleFor("barrier", "barrier final gap"));

      await atReview.promise;
      const index = await readRunIndex(cwd);
      expect(index.runs.find((entry) => entry.runId === "barrier")).toMatchObject({
        liveness: "finished",
        verdict: "contract_proof_only",
      });
      const live = liveObserverResult(cwd, "barrier", run.paths.absoluteRunRoot);
      const server = await serveObserver(live, { open: false, port: 0 });
      try {
        const served = await fetch(new URL("observer-data.json", server.url));
        expect(await served.text()).toContain("barrier final gap");
      } finally {
        await server.close();
      }
      expect((await readLatest()).runId).toBe("previous");
      releaseReview.resolve();

      await atPointer.promise;
      expect((await readLatest()).runId).toBe("previous");
      releasePointer.resolve();
      await finishing;
    });
    expect((await readLatest()).runId).toBe("barrier");
  });
});

describe("the run's start and its token", () => {
  it("an existing entry under the id is refused, and a symlinked runs root rejects", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "humanish-run-outside-"));
    try {
      await mkdir(path.join(cwd, ".humanish", "runs"), { recursive: true });
      await symlink(outside, runDir("linked"));
      const { result } = await runScope((scope) => start(scope, "linked"));
      expect(result).toMatchObject({ ok: false, code: "HUMANISH_RUN_ID_IN_USE" });

      await rm(path.join(cwd, ".humanish", "runs"), { recursive: true });
      await symlink(outside, path.join(cwd, ".humanish", "runs"));
      await expect(runScope((scope) => start(scope, "rooted"))).rejects.toThrow(/symbolic link/);
      await expect(readFile(path.join(outside, "rooted", "status.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("a process killed after startRun leaves a status that reads interrupted", async () => {
    const script = `
      import { runScope } from ${JSON.stringify(new URL("../../src/run/run.ts", import.meta.url).href)};
      await runScope(async (scope) => {
        const started = await scope.startRun({ cwd: ${JSON.stringify(cwd)}, runId: "killed",
          mintRunId: () => "minted", mode: "live", renderReview: () => "" });
        if (!started.ok) throw new Error(started.message);
        process.stdout.write("STARTED\\n");
        await new Promise(() => {});
      });
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("the child never started its run")),
          15_000,
        );
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("STARTED")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("the child exited before starting its run"));
        });
      });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    const status = await readStatus("killed");
    expect(status.state).toBe("running");
    expect(classifyRunStatus(status, Date.parse(status.updatedAt) + RUN_STATUS_STALE_MS + 1)).toBe(
      "interrupted",
    );
  });

  it("a run directory replaced after finish is neither rendered nor analyzed", async () => {
    const finished = await publish("replaced");
    expect(FinishedRun.isIssued(finished)).toBe(true);
    await rename(runDir("replaced"), path.join(cwd, "moved"));
    await mkdir(runDir("replaced"));

    const observer = await finished!.renderObserver();
    expect(observer).toMatchObject({ ok: false, error: { code: "HUMANISH_RUN_NOT_FOUND" } });
    const analysis = resolveAutomaticAnalysis(undefined);
    if (!analysis.ok) throw new Error(analysis.message);
    const run = vi.fn();
    const result = await completeAutomaticAnalysis(
      { cwd, runId: "replaced", dryRun: false },
      finished,
      analysis.config,
      { deps: { analysis: { run } } },
    );
    expect(result.automaticAnalysis).toEqual({
      state: "failed",
      reason: "AUTOMATIC_ANALYSIS_SOURCE_CHANGED",
    });
    expect(run).not.toHaveBeenCalled();
  });
});

function failFirstBundleWrite(message: string): void {
  let failed = false;
  vi.mocked(writeContainedOutputFile).mockImplementation(async (root, file, data, encoding) => {
    if (file === "run.json" && !failed) {
      failed = true;
      throw new Error(message);
    }
    return actualWriters.writeContainedOutputFile(root, file, data, encoding);
  });
}

describe("Run.writeSnapshot publishes in-progress bundles through the same queue", () => {
  it("finish waits for a held snapshot write, and the final bundle wins", async () => {
    const atSnapshot = deferred();
    const releaseSnapshot = deferred();
    let held = false;
    vi.mocked(writeContainedOutputFile).mockImplementation(async (root, file, data, encoding) => {
      if (file === "run.json" && !held) {
        held = true;
        atSnapshot.resolve();
        await releaseSnapshot.promise;
      }
      return actualWriters.writeContainedOutputFile(root, file, data, encoding);
    });
    await runScope(async (scope) => {
      const run = await startOk(scope, "held");
      const snapshot = run.writeSnapshot(bundleFor("held", "in progress"));
      await atSnapshot.promise;
      let finishSettled = false;
      const finishing = run.finish(bundleFor("held", "final")).then(() => {
        finishSettled = true;
      });
      await expect(run.writeSnapshot(bundleFor("held", "late"))).rejects.toThrow(/no snapshot/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finishSettled).toBe(false);
      releaseSnapshot.resolve();
      await snapshot;
      await finishing;
    });
    const written = await readJson(path.join(runDir("held"), "run.json"));
    expect(written.review.gaps).toEqual(["final"]);
  });

  it("a snapshot and then an early return leave the in-progress run.json and no outcome", async () => {
    const { finished } = await runScope(async (scope) => {
      const run = await startOk(scope, "abandoned-live");
      await run.writeSnapshot(bundleFor("abandoned-live", "in progress"));
      return "refused";
    });
    expect(finished).toBeUndefined();
    const written = await readJson(path.join(runDir("abandoned-live"), "run.json"));
    expect(written.review.gaps).toEqual(["in progress"]);
    const status = await readStatus("abandoned-live");
    expect(status.state).toBe("finished");
    expect(status).not.toHaveProperty("outcome");
  });

  it("only the first successful snapshot writes the pointer, and finish writes it again", async () => {
    vi.mocked(writePreparedRunLatestPointer).mockRejectedValueOnce(new Error("pointer failed"));
    await runScope(async (scope) => {
      const run = await startOk(scope, "pointed");
      await expect(run.writeSnapshot(bundleFor("pointed"))).rejects.toThrow("pointer failed");
      await expect(readLatest()).rejects.toMatchObject({ code: "ENOENT" });
      await run.writeSnapshot(bundleFor("pointed"));
      expect((await readLatest()).runId).toBe("pointed");

      // A newer run took the pointer; a later flush of this run must not take it back.
      const latest = path.join(cwd, ".humanish", "runs", "latest.json");
      const newer = { schema: "humanish.latest-run.v1", runId: "newer", path: "x", updatedAt: "t" };
      await actualWriters.writePreparedRunLatestPointer(run.paths, JSON.stringify(newer), "utf8");
      await run.writeSnapshot(bundleFor("pointed"));
      expect(JSON.parse(await readFile(latest, "utf8")).runId).toBe("newer");

      await run.finish(bundleFor("pointed"));
    });
    expect((await readLatest()).runId).toBe("pointed");
  });

  it("a rejected snapshot does not block the final publication", async () => {
    failFirstBundleWrite("snapshot failed");
    const { finished } = await runScope(async (scope) => {
      const run = await startOk(scope, "recovered");
      await expect(run.writeSnapshot(bundleFor("recovered"))).rejects.toThrow("snapshot failed");
      return run.finish(bundleFor("recovered", "final"));
    });
    expect(finished?.runId).toBe("recovered");
    expect((await readStatus("recovered")).outcome).toEqual({ verdict: "contract_proof_only" });
  });

  it("a throw while a snapshot rejects surfaces the original error and stops the status cadence", async () => {
    // Only the interval is faked: the status record's 5 s cadence is the one interval a run owns.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      failFirstBundleWrite("snapshot failed");
      const failure = new Error("route failed");
      let timersWhileRunning = 0;
      await expect(
        runScope(async (scope) => {
          const run = await startOk(scope, "doubly-failed");
          timersWhileRunning = vi.getTimerCount();
          void run.writeSnapshot(bundleFor("doubly-failed")).catch(() => undefined);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(timersWhileRunning).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      const status = await readStatus("doubly-failed");
      expect(status.state).toBe("finished");
      expect(status).not.toHaveProperty("outcome");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a snapshot from a timer that fires after the scope closed writes nothing", async () => {
    let late: Promise<unknown> | undefined;
    await runScope(async (scope) => {
      const run = await startOk(scope, "timer");
      await run.writeSnapshot(bundleFor("timer", "before close"));
      setTimeout(() => {
        late = run.writeSnapshot(bundleFor("timer", "after close")).then(
          () => "written",
          (error: unknown) => error,
        );
      }, 10);
    });
    const before = await readFile(path.join(runDir("timer"), "run.json"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(String(await late)).toMatch(/closed/);
    expect(await readFile(path.join(runDir("timer"), "run.json"), "utf8")).toBe(before);
  });

  it("rejects a snapshot that names another run or mode before writing", async () => {
    await runScope(async (scope) => {
      const run = await startOk(scope, "identity");
      await expect(run.writeSnapshot(bundleFor("other"))).rejects.toThrow(/another run or mode/);
      await expect(run.writeSnapshot({ ...bundleFor("identity"), mode: "live" })).rejects.toThrow(
        /another run or mode/,
      );
      await expect(
        readFile(path.join(run.paths.physicalRunRoot, "run.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

// Run.finish moves .humanish/runs/latest.json after it publishes the bundle (architecture.md, step
// 6). That holds only while it is the one writer: writePreparedRunLatestPointer is the only write
// of the pointer, and only src/run/run.ts calls it.
describe("the latest-run pointer", () => {
  it("has one writer in src: Run.finish in src/run/run.ts", async () => {
    const files = (await readdir("src", { recursive: true })).filter((file) =>
      file.endsWith(".ts"),
    );
    const callers: string[] = [];
    const pointerUsers: string[] = [];
    for (const file of files) {
      const text = await readFile(path.join("src", file), "utf8");
      if (/\bwritePreparedRunLatestPointer\s*\(/.test(text)) callers.push(path.join("src", file));
      if (/\bphysicalLatestPointer\b/.test(text)) pointerUsers.push(path.join("src", file));
    }
    // contained-output.ts declares the writer; run.ts is the only call.
    expect(callers.sort()).toEqual(
      [path.join("src", "run", "contained-output.ts"), path.join("src", "run", "run.ts")].sort(),
    );
    // Only the writer and the path preparation see the pointer's physical path.
    expect(pointerUsers.sort()).toEqual(
      [path.join("src", "run", "contained-output.ts"), path.join("src", "run", "paths.ts")].sort(),
    );
  });
});
