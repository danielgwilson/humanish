import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorTrace } from "../../src/actors/contract.js";
import type { CuaLoopResult } from "../../src/actors/computer-use/loop.js";
import { captureGitState } from "../../src/run/git-state.js";
import { buildCuaBundle } from "../../src/routes/computer-use/single-bundle.js";
import { verdictForStatus } from "../../src/run/judge.js";
import { renderObserver } from "../../src/observer/render.js";
import { createProgram } from "../../src/cli/program.js";
import { startCodexAppServerUi } from "../../src/actors/codex/app-server-ui.js";
import {
  PUBLIC_TARGET_CWD,
  RUN_BUNDLE_SCHEMA,
  buildRunSource,
  type RunCostSummary,
  type RunBundle,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
} from "../../src/run/bundle.js";
import { CLEANUP_SCHEMA } from "../../src/run/results.js";
import { cleanupRun, listRuns, readReview } from "../../src/run/stored-runs.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";
import { syntheticPng1x1 } from "../image-fixtures.js";

const execFileAsync = promisify(execFile);
const PNG_1X1 = syntheticPng1x1();

function isNodeErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

async function withFixtureCopy<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-run-fixture-"));
  const tempApp = path.join(tempRoot, "minimal-app");

  try {
    await cp(path.resolve("fixtures/minimal-app"), tempApp, { recursive: true });
    return await callback(tempApp);
  } finally {
    // CI hit "ENOTEMPTY: rmdir .../.humanish/runs/codex-unsafe-admin-gitdir-*" here. It was read
    // as a write landing AFTER runDryRun resolved (#553). It was not: the trust-preflight test
    // raced runDryRun against a timer, and when the timer won on a loaded runner, this rm ran
    // while the run was still writing its bundle. The ENOTEMPTY, thrown from a finally, replaced
    // the "preflight hung" error that was the actual failure. That test now awaits the run before
    // returning here. The retries stay as belt-and-braces; they are no longer load-bearing.
    await rm(tempRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });

  await program.parseAsync(["node", "humanish", ...args], { from: "node" });

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

describe("dry-run bundles", () => {
  it("verifies new physical geometry and legacy saved geometry sources", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({ cwd, dryRun: true, runId: "geometry-source-compatibility" });
      expect(run.ok).toBe(true);
      if (!run.bundlePath || !run.runId) throw new Error("Expected a successful dry run");
      const file = path.join(cwd, run.bundlePath);
      const bundle = JSON.parse(await readFile(file, "utf8"));
      expect(bundle.streams.length).toBeGreaterThan(0);
      delete bundle.streams[0].viewport;
      for (const source of ["xwininfo", "xdotool", "cdp", "untrusted"]) {
        bundle.streams[0].desktopGeometry = {
          screen: { requested: { width: 1440, height: 950 } },
          browserWindow: { x: 0, y: 51, width: 1440, height: 899, source },
        };
        await writeFile(file, JSON.stringify(bundle));
        const verified = await verifyRun(cwd, run.runId);
        expect(verified.ok, JSON.stringify(verified)).toBe(source !== "untrusted");
      }
    });
  });

  it("writes and verifies a synthetic run bundle", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "dryrun-test",
      });

      expect(run.ok).toBe(true);
      expect(run.runId).toBe("dryrun-test");
      expect(run.bundlePath).toBe(".humanish/runs/dryrun-test/run.json");

      const bundleText = await readFile(
        path.join(cwd, ".humanish/runs/dryrun-test/run.json"),
        "utf8",
      );
      const bundle = JSON.parse(bundleText) as {
        cwd: string;
        schema: string;
        review: { verdict: string };
        simCount: number;
        simulations: unknown[];
        source: { git: { schema: string; status: string } };
      };
      expect(bundle.schema).toBe(RUN_BUNDLE_SCHEMA);
      expect(bundle.cwd).toBe(PUBLIC_TARGET_CWD);
      expect(bundleText).not.toContain(cwd);
      expect(bundle.simCount).toBe(1);
      expect(bundle.simulations).toHaveLength(1);
      expect(bundle.source.git.schema).toBe("humanish.git-state.v1");
      expect(bundle.source.git.status).toBe("missing");
      expect(bundle.review.verdict).toBe("contract_proof_only");

      await expect(stat(path.join(cwd, ".humanish/runs/latest.json"))).resolves.toBeTruthy();

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
      expect(verify.checks.every((check) => check.ok)).toBe(true);
      expect(verify.shareSafety).toEqual({ status: "share_ready", reasons: [] });

      const observer = await renderObserver(cwd, "latest");
      expect(observer.ok).toBe(true);
      expect(observer.warnings.join("\n")).toContain(
        "dry-run lanes do not claim product behavior proof",
      );
      expect(observer.warnings.join("\n")).not.toContain("verified local evidence artifacts");

      const review = await readReview(cwd, "latest");
      expect("verdict" in review ? review.verdict : null).toBe("contract_proof_only");

      const runs = await listRuns(cwd);
      expect(runs.latest).toBe("dryrun-test");
      expect(runs.runs).toHaveLength(1);
    });
  });

  it("does not hang a generic dry-run on special .git metadata", async () => {
    await withFixtureCopy(async (cwd) => {
      await execFileAsync("mkfifo", [path.join(cwd, ".git")]);

      // The hang under test is INDEFINITE (a FIFO read blocks forever), so the bound only needs
      // to be an order of magnitude above a slow legitimate dry-run, not a stopwatch. This raced
      // at a fixed 1s and flaked in the PUBLISH gate on a busy runner (#416): the tag was live
      // while npm served the old version, and the failure signal meant "the runner was busy",
      // not "the behavior regressed". 10s cannot be reached by a working dry-run and is still
      // reached instantly-in-CI-terms by the actual regression.
      const run = await Promise.race([
        runDryRun({
          cwd,
          dryRun: true,
          runId: "dryrun-special-git",
        }),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("generic dry-run hung on special .git metadata")),
            10_000,
          );
          timer.unref?.();
        }),
      ]);

      expect(run.ok).toBe(true);
      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".humanish/runs/dryrun-special-git/run.json"), "utf8"),
      ) as { source: { git: { note: string; status: string } } };
      expect(bundle.source.git.status).toBe("unavailable");
      expect(bundle.source.git.note).toBe("Git metadata failed containment validation.");
    });
  });

  it("verifies a built run whose bounded Git capture timed out", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({ cwd, dryRun: true, runId: "dryrun-git-timeout" });
      expect(run.ok).toBe(true);
      const bundlePath = path.join(cwd, ".humanish/runs/dryrun-git-timeout/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        source: { git: unknown };
      };
      bundle.source.git = await captureGitState(cwd, {
        commandTimeoutMs: 10,
        runner: async () => await new Promise(() => {}),
      });
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "dryrun-git-timeout");
      expect(verify.ok).toBe(true);
    });
  });

  it("refuses to trust a stored provider id without a verified resource lease", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({
        cwd,
        dryRun: true,
        runId: "cleanup-owned",
      });

      const bundlePath = path.join(cwd, ".humanish/runs/cleanup-owned/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<string, unknown>;
      bundle.providerResources = [
        {
          schema: "humanish.provider-resource.v1",
          provider: "e2b-desktop",
          kind: "sandbox",
          id: "sbx-owned-1",
          owner: "humanish",
          status: "running",
          simId: "sim-001",
          streamId: "stream-001",
          laneId: "lane-01",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          schema: "humanish.provider-resource.v1",
          provider: "e2b-desktop",
          kind: "sandbox",
          id: "sbx-forged-unknown",
          owner: "humanish",
          status: "unknown",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      let providerLoads = 0;
      const cleanup = await cleanupRun(cwd, "cleanup-owned", {
        now: () => new Date("2026-01-01T00:01:00.000Z"),
        loadDesktopModule: async () => {
          providerLoads += 1;
          throw new Error("provider module must not be loaded from stored resource metadata");
        },
      });

      expect(cleanup.schema).toBe(CLEANUP_SCHEMA);
      expect(cleanup.ok).toBe(false);
      expect(providerLoads).toBe(0);
      expect(cleanup.resources).toEqual([
        expect.objectContaining({
          id: "sbx-owned-1",
          status: "failed",
          message: "automatic provider cleanup requires a verified resource lease",
        }),
        expect.objectContaining({
          id: "sbx-forged-unknown",
          status: "failed",
          message: "automatic provider cleanup requires a verified resource lease",
        }),
      ]);
      expect(cleanup.summary).toMatchObject({
        resources: 2,
        killed: 0,
        alreadyClean: 0,
        failed: 2,
        skipped: 0,
      });

      const cleanupText = await readFile(
        path.join(cwd, ".humanish/runs/cleanup-owned/cleanup.json"),
        "utf8",
      );
      expect(cleanupText).toContain("humanish.cleanup-result.v1");

      const verify = await verifyRun(cwd, "cleanup-owned");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((check) => check.name === "cleanup receipt")?.ok).toBe(false);
    });
  });

  it("keeps cleanup bound to the original physical run across a cwd alias retarget", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-cleanup-alias-"));
    const physicalA = path.join(tempRoot, "physical-a");
    const physicalB = path.join(tempRoot, "physical-b");
    const cwdAlias = path.join(tempRoot, "selected-cwd");
    try {
      await cp(path.resolve("fixtures/minimal-app"), physicalA, { recursive: true });
      await cp(path.resolve("fixtures/minimal-app"), physicalB, { recursive: true });
      await symlink(physicalA, cwdAlias, "dir");
      await runDryRun({ cwd: cwdAlias, dryRun: true, runId: "cleanup-retarget" });
      await cp(path.join(physicalA, ".humanish"), path.join(physicalB, ".humanish"), {
        recursive: true,
      });
      const bCleanup = path.join(physicalB, ".humanish/runs/cleanup-retarget/cleanup.json");
      await writeFile(bCleanup, "physical-b-sentinel\n", "utf8");

      await expect(
        cleanupRun(cwdAlias, "cleanup-retarget", {
          cleanupAdapterResources: async ({ runDir }) => {
            expect(runDir).toBe(
              path.join(await realpath(physicalA), ".humanish/runs/cleanup-retarget"),
            );
            await rm(cwdAlias);
            await symlink(physicalB, cwdAlias, "dir");
            return [];
          },
        }),
      ).rejects.toThrow(/changed physical destination|identity/i);

      await expect(readFile(bCleanup, "utf8")).resolves.toBe("physical-b-sentinel\n");
      await expect(
        stat(path.join(physicalA, ".humanish/runs/cleanup-retarget/cleanup.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects a symlinked cleanup receipt without mutating its target", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({ cwd, dryRun: true, runId: "cleanup-symlink" });
      const sentinel = path.join(path.dirname(cwd), "cleanup-symlink-sentinel.txt");
      const cleanupPath = path.join(cwd, ".humanish/runs/cleanup-symlink/cleanup.json");
      await writeFile(sentinel, "outside-sentinel\n", "utf8");
      await symlink(sentinel, cleanupPath);

      await expect(cleanupRun(cwd, "cleanup-symlink")).resolves.toMatchObject({
        ok: false,
        error: { code: "HUMANISH_INVALID_RUN_BUNDLE" },
      });
      await expect(readFile(sentinel, "utf8")).resolves.toBe("outside-sentinel\n");
    });
  });

  it("rejects a hardlinked cleanup receipt without mutating its target", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({ cwd, dryRun: true, runId: "cleanup-hardlink" });
      const sentinel = path.join(path.dirname(cwd), "cleanup-hardlink-sentinel.txt");
      const cleanupPath = path.join(cwd, ".humanish/runs/cleanup-hardlink/cleanup.json");
      await writeFile(sentinel, "outside-sentinel\n", "utf8");
      try {
        await link(sentinel, cleanupPath);
      } catch (error) {
        if (isNodeErrorCode(error, "EPERM", "ENOTSUP", "EOPNOTSUPP")) {
          return;
        }
        throw error;
      }

      await expect(cleanupRun(cwd, "cleanup-hardlink")).resolves.toMatchObject({
        ok: false,
        error: { code: "HUMANISH_INVALID_RUN_BUNDLE" },
      });
      await expect(readFile(sentinel, "utf8")).resolves.toBe("outside-sentinel\n");
    });
  });

  it("supports cleanup CLI for already-clean resources without loading a provider dependency", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({
        cwd,
        dryRun: true,
        runId: "cleanup-already-clean",
      });

      const bundlePath = path.join(cwd, ".humanish/runs/cleanup-already-clean/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<string, unknown>;
      bundle.providerResources = [
        {
          schema: "humanish.provider-resource.v1",
          provider: "e2b-desktop",
          kind: "sandbox",
          id: "sbx-already-clean",
          owner: "humanish",
          status: "killed",
          cleanup: {
            killed: true,
            reason: "killed during normal lane teardown",
          },
        },
      ];
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const cli = await runCli(["cleanup", "--cwd", cwd, "--run", "latest", "--json"]);
      expect(cli.exitCode).toBe(0);
      const result = JSON.parse(cli.stdout) as {
        ok: boolean;
        summary: { alreadyClean: number; killed: number };
      };
      expect(result.ok).toBe(true);
      expect(result.summary.alreadyClean).toBe(1);
      expect(result.summary.killed).toBe(0);
    });
  });

  it("fails verify when a cleanup receipt says cleanup failed", async () => {
    await withFixtureCopy(async (cwd) => {
      await runDryRun({
        cwd,
        dryRun: true,
        runId: "cleanup-failed-receipt",
      });

      await writeFile(
        path.join(cwd, ".humanish/runs/cleanup-failed-receipt/cleanup.json"),
        `${JSON.stringify(
          {
            schema: CLEANUP_SCHEMA,
            ok: false,
            cwd: PUBLIC_TARGET_CWD,
            run: "cleanup-failed-receipt",
            runId: "cleanup-failed-receipt",
            checkedAt: "2026-01-01T00:02:00.000Z",
            summary: { resources: 1, killed: 0, alreadyClean: 0, failed: 1, skipped: 0 },
            resources: [
              {
                provider: "e2b-desktop",
                kind: "sandbox",
                id: "sbx-failed",
                status: "failed",
                message: "synthetic failure",
              },
            ],
            adapterResults: [],
            warnings: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const verify = await verifyRun(cwd, "cleanup-failed-receipt");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((check) => check.name === "cleanup receipt")?.ok).toBe(false);
    });
  });

  it("allows dry-run simulation counts above old magic caps", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "dryrun-sims-65",
        simCount: 65,
      });

      expect(run.ok).toBe(true);
      expect(run.simCount).toBe(65);

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".humanish/runs/dryrun-sims-65/run.json"), "utf8"),
      ) as { simCount: number; simulations: unknown[] };
      expect(bundle.simCount).toBe(65);
      expect(bundle.simulations).toHaveLength(65);
    });
  });

  it("fails closed on malformed run bundle shapes", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "malformed-run-shape",
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".humanish/runs/malformed-run-shape/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        streams?: unknown;
      };
      delete bundle.streams;
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "malformed-run-shape");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("fails closed on malformed source git provenance", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "malformed-run-source-git",
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".humanish/runs/malformed-run-source-git/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        source: { git: { schema?: string } };
      };
      bundle.source.git.schema = "humanish.legacy-not-captured";
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "malformed-run-source-git");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("fails closed on unsafe git provenance values", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "malformed-run-git-values",
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".humanish/runs/malformed-run-git-values/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        source: { git: { head: { shortSha: unknown }; note: string } };
      };
      bundle.source.git.head.shortSha = "private/repo-name";
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      let verify = await verifyRun(cwd, "malformed-run-git-values");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);

      bundle.source.git.head.shortSha = null;
      bundle.source.git.note = "private branch and remote details";
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      verify = await verifyRun(cwd, "malformed-run-git-values");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("fails closed on malformed feedback candidates", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "malformed-feedback-candidate",
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".humanish/runs/malformed-feedback-candidate/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        feedbackCandidates: unknown[];
      };
      bundle.feedbackCandidates = [42];
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "malformed-feedback-candidate");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("fails closed on simulation and stream consistency mismatches", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "malformed-sim-streams",
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".humanish/runs/malformed-sim-streams/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        simCount: number;
        simulations: Array<{ id: string; streamIds: string[] }>;
        streams: Array<{ id: string; simId: string }>;
      };
      bundle.simCount = bundle.simulations.length + 1;
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      let verify = await verifyRun(cwd, "malformed-sim-streams");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);

      bundle.simCount = bundle.simulations.length;
      const firstStream = bundle.streams[0];
      expect(firstStream).toBeDefined();
      bundle.streams[0] = {
        ...firstStream!,
        simId: "missing-simulation",
      };
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      verify = await verifyRun(cwd, "malformed-sim-streams");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("keeps live runs fail-closed", async () => {
    await withFixtureCopy(async (cwd) => {
      const result = await runDryRun({ cwd });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HUMANISH_LIVE_RUN_UNIMPLEMENTED");
      await expect(stat(path.join(cwd, ".humanish"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not treat Codex flag names as OpenAI keys", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "flag-redaction-regression",
      });
      expect(run.ok).toBe(true);

      await writeFile(
        path.join(cwd, ".humanish/runs/flag-redaction-regression/review.md"),
        "actor command: codex exec --ask-for-approval never\n",
        "utf8",
      );

      const verify = await verifyRun(cwd, "flag-redaction-regression");
      expect(verify.ok).toBe(true);
      expect(verify.checks.find((check) => check.name === "public-safety scan")?.ok).toBe(true);
    });
  });

  it("rejects browser profile artifacts in public proof runs", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "profile-artifact-regression",
      });
      expect(run.ok).toBe(true);

      const profileDir = path.join(
        cwd,
        ".humanish/runs/profile-artifact-regression/profiles/desktop/Default",
      );
      await mkdir(profileDir, { recursive: true });
      await writeFile(
        path.join(profileDir, "Preferences"),
        '{"metadata_secret":"synthetic"}\n',
        "utf8",
      );

      const verify = await verifyRun(cwd, "profile-artifact-regression");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((check) => check.name === "public-safety scan")?.message).toContain(
        "profiles",
      );
    });
  });

  it("scans non-bundle text artifacts for public-safety leaks", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "events-secret-regression",
      });
      expect(run.ok).toBe(true);

      await writeFile(
        path.join(cwd, ".humanish/runs/events-secret-regression/events.ndjson"),
        `{"message":"synthetic ${"sk-" + "testsecretvalue1234567890abcd"}"}\n`,
        "utf8",
      );

      const verify = await verifyRun(cwd, "events-secret-regression");
      expect(verify.ok).toBe(false);
      expect(verify.shareSafety.status).toBe("blocked");
      expect(verify.shareSafety.reasons.map((reason) => reason.code)).toContain(
        "PUBLIC_SAFETY_FINDINGS",
      );
      expect(verify.checks.find((check) => check.name === "public-safety scan")?.message).toContain(
        "events.ndjson",
      );
    });
  });

  it("rejects run bundles that persist raw local cwd paths", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "raw-cwd-regression",
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".humanish/runs/raw-cwd-regression/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as { cwd: string };
      bundle.cwd = cwd;
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "raw-cwd-regression");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("rejects nonlocal stream artifact references in run bundles", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "nonlocal-artifact-regression",
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".humanish/runs/nonlocal-artifact-regression/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        streams: Array<{ artifacts: Array<{ label: string; path: string; kind: string }> }>;
      };
      bundle.streams[0]?.artifacts.push({
        label: "remote actor log",
        path: "/home/user/private-repo/actor.log",
        kind: "log",
      });
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "nonlocal-artifact-regression");
      expect(verify.ok).toBe(false);
      expect(
        verify.checks.find((check) => check.name === "local evidence artifacts exist")?.message,
      ).toContain("nonlocal artifact");
    });
  });

  it("rejects referenced screenshot files that have a valid PNG signature but cannot be decoded", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "invalid-screenshot-regression",
      });
      expect(run.ok).toBe(true);

      const runRoot = path.join(cwd, ".humanish/runs/invalid-screenshot-regression");
      const screenshotPath = "screenshots/truncated.png";
      await mkdir(path.join(runRoot, "screenshots"), { recursive: true });
      await writeFile(path.join(runRoot, screenshotPath), PNG_1X1.subarray(0, 24));

      const bundlePath = path.join(runRoot, "run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        streams: Array<{
          artifacts: Array<{ label: string; path: string; kind: string }>;
          embed?: { kind: string; url?: string; title?: string };
          ui?: { screenshotUrl?: string };
        }>;
      };
      const stream = bundle.streams[0];
      expect(stream).toBeTruthy();
      stream!.embed = {
        kind: "screenshot",
        url: screenshotPath,
        title: "Invalid screenshot evidence",
      };
      stream!.ui = { ...stream!.ui, screenshotUrl: screenshotPath };
      stream!.artifacts.push({
        label: "invalid screenshot evidence",
        path: screenshotPath,
        kind: "screenshot",
      });
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "invalid-screenshot-regression");
      expect(verify.ok).toBe(false);
      expect(
        verify.checks.find((check) => check.name === "local evidence artifacts exist")?.message,
      ).toContain("screenshots/truncated.png (could not decode PNG evidence)");
    });
  });

  it("rejects local nested humanish proof references when the artifact is missing", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "missing-nested-proof-regression",
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(cwd, ".humanish/runs/missing-nested-proof-regression/run.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        streams: Array<{ ui?: { nestedObserverPath?: string } }>;
      };
      bundle.streams[0]!.ui = {
        ...bundle.streams[0]?.ui,
        nestedObserverPath: "nested-evidence/missing-nested-proof.json",
      };
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "missing-nested-proof-regression");
      expect(verify.ok).toBe(false);
      expect(
        verify.checks.find((check) => check.name === "local evidence artifacts exist")?.message,
      ).toContain("nested-evidence/missing-nested-proof.json");
    });
  });

  it("rejects placeholder nested proof references as nonlocal evidence", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "placeholder-nested-proof-regression",
      });
      expect(run.ok).toBe(true);

      const bundlePath = path.join(
        cwd,
        ".humanish/runs/placeholder-nested-proof-regression/run.json",
      );
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
        streams: Array<{ ui?: { nestedObserverPath?: string } }>;
      };
      bundle.streams[0]!.ui = {
        ...bundle.streams[0]?.ui,
        nestedObserverPath: "[remote-nested-observer]",
      };
      await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      const verify = await verifyRun(cwd, "placeholder-nested-proof-regression");
      expect(verify.ok).toBe(false);
      expect(
        verify.checks.find((check) => check.name === "local evidence artifacts exist")?.message,
      ).toContain("nonlocal nested observer reference");
    });
  });

  it("persists Codex app-server UI state without raw prompt, key, or local paths", async () => {
    await withFixtureCopy(async (cwd) => {
      const fakeAppServer = path.join(cwd, "fake-codex-app-server-ui.mjs");
      const fakeApiKey = `sk-${"ui-state-testsecretvalue1234567890"}`;
      const previousOpenai = process.env.OPENAI_API_KEY;
      await writeFile(
        fakeAppServer,
        [
          "import readline from 'node:readline';",
          "const rl = readline.createInterface({ input: process.stdin });",
          "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
          "const thread = { id: 'thread-ui-public-safe-01', sessionId: 'session-ui-public-safe-01', model: 'test-model', cwd: process.cwd(), cliVersion: 'codex-cli-test' };",
          "const turn = { id: 'turn-ui-public-safe-01', status: 'inProgress' };",
          "rl.on('line', (line) => {",
          "  const msg = JSON.parse(line);",
          "  if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake-codex-app-server-ui' } });",
          "  if (msg.method === 'account/login/start') send({ id: msg.id, result: { type: 'apiKey' } });",
          "  if (msg.method === 'thread/start') { send({ id: msg.id, result: { thread } }); send({ method: 'thread/started', params: { thread } }); }",
          "  if (msg.method === 'turn/start') {",
          "    send({ id: msg.id, result: { turn } });",
          "    send({ method: 'turn/started', params: { threadId: thread.id, turn } });",
          "    send({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId: 'msg-ui-01', delta: 'UI state path check complete.' } });",
          "    send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });",
          "    setTimeout(() => process.exit(0), 50);",
          "  }",
          "});",
        ].join("\n"),
        "utf8",
      );

      process.env.OPENAI_API_KEY = fakeApiKey;
      try {
        const controller = await startCodexAppServerUi({
          actorCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAppServer)}`,
          cwd,
          prompt: `Private UI prompt marker at ${cwd} with ${fakeApiKey}`,
          runRoot: ".humanish/codex-app-server-ui-test",
          stateFile: ".humanish/codex-app-server-ui-test/state.json",
          timeoutMs: 5_000,
        });
        await controller.completion;
        const stateText = await readFile(
          path.join(cwd, ".humanish/codex-app-server-ui-test/state.json"),
          "utf8",
        );
        expect(stateText).toContain("[target-cwd]");
        expect(stateText).not.toContain(cwd);
        expect(stateText).not.toContain("Private UI prompt marker");
        expect(stateText).not.toContain(fakeApiKey);
        expect(stateText).toContain("promptDigest");
      } finally {
        if (previousOpenai === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = previousOpenai;
        }
      }
    });
  });

  it("exposes run and verify through the Commander CLI", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runCli([
        "run",
        "--dry-run",
        "--run-id",
        "dryrun-cli",
        "--cwd",
        cwd,
        "--json",
      ]);
      expect(run.exitCode).toBe(0);
      const runResult = JSON.parse(run.stdout) as { ok: boolean; runId: string };
      expect(runResult.ok).toBe(true);
      expect(runResult.runId).toBe("dryrun-cli");

      const verify = await runCli(["verify", "--run", "latest", "--cwd", cwd, "--json"]);
      expect(verify.exitCode).toBe(0);
      const verifyResult = JSON.parse(verify.stdout) as { ok: boolean };
      expect(verifyResult.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Verify hardening: the independent verifier upholds invariant 4 on its own.
// It re-derives the producer-side no-engagement judgment from bundle data
// alone (bundle.mode + the provider-neutral actor trace) instead of trusting
// the producer's self-attested verdict, and it surfaces the raw-screenshot
// posture so ok: true never reads as "share-ready". Fixtures are built with
// the real producer's bundle builder so the shape tracks the producer.
// ---------------------------------------------------------------------------

function cuaActorTrace(args: {
  screenshots?: ActorTrace["redaction"]["screenshots"];
  status?: ActorTrace["status"];
  completionReason?: ActorTrace["completionReason"];
  reason?: string;
  counts?: Record<string, number>;
  items?: ActorTrace["items"];
}): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "openai-responses-cu",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    redaction: {
      status: "passed",
      screenshots: args.screenshots ?? "blurred",
      notes: "synthetic public-safe test trace",
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5_000,
    status: args.status ?? "passed",
    completionReason: args.completionReason ?? "goal_satisfied",
    reason: args.reason ?? "model reported a natural endpoint with no further action",
    ids: { model: "computer-use-preview" },
    counts: args.counts ?? {
      turns: 1,
      actions: 0,
      screenshots: 0,
      reasonings: 0,
      messages: 0,
      idleTurns: 0,
      noProgressTurns: 0,
    },
    items: args.items ?? [],
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: false,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "proprietary",
    },
  };
}

async function writeCuaRunFixture(
  cwd: string,
  runId: string,
  args: {
    dryRun: boolean;
    trace?: ActorTrace;
    subject?: RunSubjectProvenance;
    cost?: RunCostSummary;
    forceReviewVerdict?: "pass" | "fail" | "blocked" | "timed_out" | "contract_proof_only";
  },
): Promise<void> {
  const session: CuaLoopResult | undefined = args.trace
    ? {
        status: args.trace.status,
        completionReason: args.trace.completionReason,
        reason: args.trace.reason,
        trace: args.trace,
      }
    : undefined;
  const bundle = buildCuaBundle({
    verdict: session ? verdictForStatus(session.status) : "contract_proof_only",
    actorId: "openai-computer-use",
    appUrl: "http://127.0.0.1:3000/",
    createdAt: "2026-01-01T00:00:00.000Z",
    dryRun: args.dryRun,
    labId: "verify-hardening-proof",
    mission: "Explore the app and stop.",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    resolution: [1440, 960],
    runId,
    screenshots: [],
    ...(session ? { session, traceArtifactPath: "actor.json" } : {}),
    source: await buildRunSource({ cwd, humanishSource: "present", packageName: "humanish" }),
  });
  // The verify matrix forges subject blocks the producer would never emit (e.g. a "seeded"
  // claim over a failed step) — verify must reject them from the persisted evidence alone.
  if (args.subject) {
    bundle.subject = args.subject;
  }
  if (args.cost) {
    bundle.cost = args.cost;
  }
  if (args.forceReviewVerdict) {
    bundle.review.verdict = args.forceReviewVerdict;
  }
  const runDir = path.join(cwd, ".humanish", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(runDir, "review.json"),
    `${JSON.stringify(bundle.review, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "review.md"),
    `# ${bundle.scenario.title}\n\n- verdict: ${bundle.review.verdict}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "events.ndjson"),
    `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  if (session) {
    await writeFile(
      path.join(runDir, "actor.json"),
      `${JSON.stringify(session.trace, null, 2)}\n`,
      "utf8",
    );
  }
}

describe("verify hardening (no-engagement + screenshot posture)", () => {
  it("accepts a retained zero-action adapter-limit interruption without inventing a participant success", async () => {
    await withFixtureCopy(async (cwd) => {
      const trace = cuaActorTrace({
        status: "incomplete",
        completionReason: "budget_reached",
        reason: "The adapter reported a local admission limit before provider dispatch.",
        counts: { turns: 0, actions: 0, screenshots: 0, messages: 0 },
        items: [
          {
            id: "notice-001",
            kind: "notice",
            lifecycle: "completed",
            status: "warn",
            title: "adapter admission limit reached",
          },
        ],
      });
      trace.stopCause = "adapter_limit";
      await writeCuaRunFixture(cwd, "adapter-limit", { dryRun: false, trace });
      const result = await verifyRun(cwd, "adapter-limit");
      expect(result.ok).toBe(true);
      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".humanish/runs/adapter-limit/run.json"), "utf8"),
      ) as RunBundle;
      expect(bundle.streams[0]?.actor?.stopCause).toBe("adapter_limit");
      expect(bundle.review.participants).toMatchObject({
        total: 1,
        reachedGoal: 0,
        ranOut: 1,
        harnessFailed: 0,
      });
    });
  });

  it("FAILS a live goal_satisfied bundle whose actor trace has zero actions and zero messages (hollow run)", async () => {
    await withFixtureCopy(async (cwd) => {
      // Shape mirrors the preserved pre-0.6.1 hollow-run bundles: mode live, status passed,
      // completionReason goal_satisfied, counts and items empty of actions and messages.
      await writeCuaRunFixture(cwd, "hollow-live-regression", {
        dryRun: false,
        trace: cuaActorTrace({}),
      });

      const verify = await verifyRun(cwd, "hollow-live-regression");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
      const check = verify.checks.find((entry) => entry.name === "actor engagement");
      expect(check?.ok).toBe(false);
      expect(check?.message).toContain("zero actions and zero messages");
      // Blurred screenshots carry no raw-posture warning; the failure stands on its own.
      expect(verify.warnings).toEqual([]);
    });
  });

  it("passes a deterministic stopWhen observation with a screenshot even when no model action was needed", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "stopwhen-observed-live", {
        dryRun: false,
        trace: cuaActorTrace({
          reason: "stopWhen matched dashboard-visible (textIncludes)",
          counts: {
            turns: 0,
            actions: 0,
            screenshots: 1,
            reasonings: 0,
            messages: 0,
            idleTurns: 0,
            noProgressTurns: 0,
          },
          items: [
            {
              id: "screenshot-001",
              kind: "screenshot",
              lifecycle: "completed",
              title: "turn-00-start",
              screenshotRef: {
                path: "screenshots/turn-00-start.png",
                redaction: "blurred",
              },
            },
            {
              id: "notice-002",
              kind: "notice",
              lifecycle: "completed",
              status: "matched",
              title: "stopWhen matched: dashboard-visible",
              text: "Harness stop condition matched rule dashboard-visible using textIncludes.",
            },
          ],
        }),
      });
      await mkdir(path.join(cwd, ".humanish/runs/stopwhen-observed-live/screenshots"), {
        recursive: true,
      });
      await writeFile(
        path.join(cwd, ".humanish/runs/stopwhen-observed-live/screenshots/turn-00-start.png"),
        PNG_1X1,
      );

      const verify = await verifyRun(cwd, "stopwhen-observed-live");
      expect(verify.ok).toBe(true);
      expect(verify.checks.find((entry) => entry.name === "actor engagement")?.ok).toBe(true);
    });
  });

  it("FAILS a live pass review whose actor trace status is failed", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "failed-actor-pass-review-regression", {
        dryRun: false,
        forceReviewVerdict: "pass",
        trace: cuaActorTrace({
          status: "failed",
          completionReason: "gave_up",
          reason: "gave up: 6 consecutive turns with no material UI action",
          counts: {
            turns: 6,
            actions: 1,
            screenshots: 6,
            reasonings: 0,
            messages: 1,
            idleTurns: 6,
            noProgressTurns: 0,
          },
          items: [
            { id: "action-001", kind: "ui_action", lifecycle: "completed", title: "wait" },
            {
              id: "message-001",
              kind: "message",
              lifecycle: "completed",
              title: "message",
              text: "Still waiting.",
            },
          ],
        }),
      });

      const verify = await verifyRun(cwd, "failed-actor-pass-review-regression");
      expect(verify.ok).toBe(false);
      const check = verify.checks.find((entry) => entry.name === "actor verdict consistency");
      expect(check?.ok).toBe(false);
      expect(check?.message).toContain("status failed");
    });
  });

  it("passes an engaged live bundle and surfaces raw screenshots as a warning, not a failure", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "raw-posture-live", {
        dryRun: false,
        trace: cuaActorTrace({
          screenshots: "raw",
          counts: {
            turns: 2,
            actions: 1,
            screenshots: 0,
            reasonings: 0,
            messages: 1,
            idleTurns: 0,
            noProgressTurns: 0,
          },
          items: [
            {
              id: "action-001",
              kind: "ui_action",
              lifecycle: "completed",
              title: "click (11, 22)",
            },
            {
              id: "message-001",
              kind: "message",
              lifecycle: "completed",
              title: "message",
              text: "Done.",
            },
          ],
        }),
      });

      const verify = await verifyRun(cwd, "raw-posture-live");
      expect(verify.ok).toBe(true);
      expect(verify.checks.find((entry) => entry.name === "actor engagement")?.ok).toBe(true);
      expect(verify.warnings).toHaveLength(1);
      expect(verify.warnings[0]).toContain("FULL-FIDELITY (raw)");
      expect(verify.warnings[0]).toContain("NOT publish-safe");
      expect(verify.shareSafety.status).toBe("local_only");
      expect(verify.shareSafety.reasons.map((reason) => reason.code)).toContain("RAW_SCREENSHOTS");
      expect(
        verify.shareSafety.reasons.find((reason) => reason.code === "RAW_SCREENSHOTS")?.message,
      ).toContain("Full-fidelity screenshots are present");

      // The CLI must show the posture in BOTH output modes.
      const json = await runCli(["verify", "--run", "raw-posture-live", "--cwd", cwd, "--json"]);
      expect(json.exitCode).toBe(0);
      const jsonBody = JSON.parse(json.stdout) as {
        shareSafety: { status: string; reasons: Array<{ code: string }> };
        warnings: string[];
      };
      expect(jsonBody.shareSafety.status).toBe("local_only");
      expect(jsonBody.shareSafety.reasons.map((reason) => reason.code)).toContain(
        "RAW_SCREENSHOTS",
      );
      expect(jsonBody.warnings[0]).toContain("FULL-FIDELITY (raw)");
      const human = await runCli(["verify", "--run", "raw-posture-live", "--cwd", cwd]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("share-safety: local_only");
      expect(human.stdout).toContain("warning: Screenshots are FULL-FIDELITY (raw)");
    });
  });

  it("a single message with zero actions is engagement (look-and-report missions stay valid)", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "message-only-live", {
        dryRun: false,
        trace: cuaActorTrace({
          counts: {
            turns: 1,
            actions: 0,
            screenshots: 0,
            reasonings: 0,
            messages: 1,
            idleTurns: 0,
            noProgressTurns: 0,
          },
          items: [
            {
              id: "message-001",
              kind: "message",
              lifecycle: "completed",
              title: "message",
              text: "The heading reads: Example.",
            },
          ],
        }),
      });

      const verify = await verifyRun(cwd, "message-only-live");
      expect(verify.ok).toBe(true);
      expect(verify.checks.find((entry) => entry.name === "actor engagement")?.ok).toBe(true);
    });
  });

  it("keeps passing dry-run/contract bundles that carry zero actions by design", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "dryrun-contract-cua", { dryRun: true });

      const verify = await verifyRun(cwd, "dryrun-contract-cua");
      expect(verify.ok).toBe(true);
      expect(verify.checks.every((entry) => entry.ok)).toBe(true);
      expect(verify.warnings).toEqual([]);
    });
  });
});

describe("verify: subject state provenance", () => {
  // An ENGAGED live trace (status passed → review verdict pass) so the matrix isolates the
  // state check: the actor-engagement check must not be the thing failing these bundles.
  const engagedTrace = (): ActorTrace =>
    cuaActorTrace({
      counts: {
        turns: 2,
        actions: 1,
        screenshots: 0,
        reasonings: 0,
        messages: 1,
        idleTurns: 0,
        noProgressTurns: 0,
      },
      items: [
        { id: "action-001", kind: "ui_action", lifecycle: "completed", title: "click (11, 22)" },
        {
          id: "message-001",
          kind: "message",
          lifecycle: "completed",
          title: "message",
          text: "Done.",
        },
      ],
    });
  const seedRecord = (
    overrides: Partial<RunSubjectStateStepRecord>,
  ): RunSubjectStateStepRecord => ({
    name: "db-migrate",
    when: "before-start",
    commandDigest: "a1b2c3d4e5f60718",
    ...overrides,
  });
  const cloneSubject = (
    state: RunSubjectProvenance["state"],
    envNames: string[] = [],
  ): RunSubjectProvenance => ({
    source: "clone",
    repo: "example-org/example-app",
    commit: "abc123def4567890abc1",
    envNames,
    state,
  });
  const stateCheck = (verify: Awaited<ReturnType<typeof verifyRun>>) =>
    verify.checks.find((entry) => entry.name === "subject state provenance");

  it("passes a live seeded bundle whose every record ran ok with a sha256-16 digest", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "state-seeded-ok", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject({
          provenance: "seeded",
          seed: [seedRecord({ ok: true, exitCode: 0, durationMs: 1200 })],
        }),
      });
      const verify = await verifyRun(cwd, "state-seeded-ok");
      expect(verify.ok).toBe(true);
      expect(stateCheck(verify)?.ok).toBe(true);
      expect(verify.warnings).toEqual([]);
    });
  });

  it("FAILS a hollow seeded claim: live pass verdict over a seed step that did not run ok", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "state-seeded-hollow", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject({
          provenance: "seeded",
          seed: [seedRecord({ ok: false, exitCode: 1 })],
        }),
      });
      const verify = await verifyRun(cwd, "state-seeded-hollow");
      expect(verify.ok).toBe(false);
      expect(verify.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
      expect(stateCheck(verify)?.ok).toBe(false);
      expect(stateCheck(verify)?.message).toContain("did not complete ok");
    });
  });

  it("FAILS seeded with zero records, and seeded records without a real digest", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "state-seeded-empty", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject({ provenance: "seeded", seed: [] }),
      });
      const empty = await verifyRun(cwd, "state-seeded-empty");
      expect(stateCheck(empty)?.ok).toBe(false);
      expect(stateCheck(empty)?.message).toContain("hollow");

      await writeCuaRunFixture(cwd, "state-seeded-bad-digest", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject({
          provenance: "seeded",
          seed: [seedRecord({ ok: true, commandDigest: "not-a-digest" })],
        }),
      });
      const badDigest = await verifyRun(cwd, "state-seeded-bad-digest");
      expect(stateCheck(badDigest)?.ok).toBe(false);
      expect(stateCheck(badDigest)?.message).toContain("commandDigest");
    });
  });

  it("REJECTS marker seeded on a dry-run bundle — a contract bundle cannot claim executed state", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "state-seeded-dryrun", {
        dryRun: true,
        subject: cloneSubject({ provenance: "seeded", seed: [seedRecord({ ok: true })] }),
      });
      const verify = await verifyRun(cwd, "state-seeded-dryrun");
      expect(verify.ok).toBe(false);
      expect(stateCheck(verify)?.ok).toBe(false);
      expect(stateCheck(verify)?.message).toContain("dry-run");
    });
  });

  it("FAILS unpinned without externalEnvNames, and value-shaped entries without echoing them", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "state-unpinned-empty", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject({ provenance: "unpinned" }),
      });
      const empty = await verifyRun(cwd, "state-unpinned-empty");
      expect(stateCheck(empty)?.ok).toBe(false);
      expect(stateCheck(empty)?.message).toContain("externalEnvNames");

      // A VALUE smuggled into the names list trips the shape check (a free secret tripwire) —
      // and the finding must not echo the entry, which may itself be the secret.
      const leakedValue = "db-pass-" + "value-123456";
      await writeCuaRunFixture(cwd, "state-unpinned-value", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject({ provenance: "unpinned", externalEnvNames: [leakedValue] }),
      });
      const value = await verifyRun(cwd, "state-unpinned-value");
      expect(stateCheck(value)?.ok).toBe(false);
      expect(stateCheck(value)?.message).toContain("not an env var NAME shape");
      expect(stateCheck(value)?.message).not.toContain(leakedValue);
    });
  });

  it("FAILS a live PASS verdict claiming declared-not-run", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "state-dnr-live-pass", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject({ provenance: "declared-not-run", seed: [seedRecord({})] }),
      });
      const verify = await verifyRun(cwd, "state-dnr-live-pass");
      expect(verify.ok).toBe(false);
      expect(stateCheck(verify)?.ok).toBe(false);
      expect(stateCheck(verify)?.message).toContain(
        "cannot claim its declared seed steps did not run",
      );
    });
  });

  it("FAILS a live PASS verdict carrying a failed seed record even under the unpinned marker (the hollow-seeded × unpinned hole)", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "state-unpinned-failed-seed", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject(
          {
            provenance: "unpinned",
            seed: [seedRecord({ ok: false, exitCode: 1 })],
            externalEnvNames: ["DATABASE_URL"],
          },
          ["DATABASE_URL"],
        ),
      });
      const verify = await verifyRun(cwd, "state-unpinned-failed-seed");
      expect(verify.ok).toBe(false);
      expect(stateCheck(verify)?.ok).toBe(false);
      expect(stateCheck(verify)?.message).toContain("passed live run cannot carry failed");
    });
  });

  it("warns ONCE (never fails) on a live clone bundle with provisioned env but an undeclared state story — GITHUB_TOKEN excluded", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "state-undeclared-env", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject({ provenance: "undeclared" }, ["DATABASE_URL", "GITHUB_TOKEN"]),
      });
      const verify = await verifyRun(cwd, "state-undeclared-env");
      expect(verify.ok).toBe(true);
      expect(stateCheck(verify)?.ok).toBe(true);
      const stateWarnings = verify.warnings.filter((warning) => warning.includes("no state story"));
      expect(stateWarnings).toHaveLength(1);
      expect(stateWarnings[0]).toContain("DATABASE_URL");
      expect(stateWarnings[0]).not.toContain("GITHUB_TOKEN");

      // GITHUB_TOKEN alone is the harness's clone-auth channel — no state implication, no nudge.
      await writeCuaRunFixture(cwd, "state-undeclared-token-only", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject({ provenance: "undeclared" }, ["GITHUB_TOKEN"]),
      });
      const tokenOnly = await verifyRun(cwd, "state-undeclared-token-only");
      expect(tokenOnly.ok).toBe(true);
      expect(tokenOnly.warnings).toEqual([]);
    });
  });

  it("rejects a malformed subject block at the bundle-shape gate (unknown marker)", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "state-bad-marker", {
        dryRun: false,
        trace: engagedTrace(),
        subject: cloneSubject({ provenance: "pinned" as never }),
      });
      const verify = await verifyRun(cwd, "state-bad-marker");
      expect(verify.ok).toBe(false);
      expect(verify.checks.find((entry) => entry.name === "run bundle shape")?.ok).toBe(false);
    });
  });

  it("keeps verifying pre-existing bundles that carry no subject block at all", async () => {
    await withFixtureCopy(async (cwd) => {
      const result = await runDryRun({ cwd, dryRun: true, simCount: 1 });
      expect(result.ok).toBe(true);
      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
      expect(stateCheck(verify)?.ok).toBe(true);
    });
  });
});

describe("verify: subject provenance (local-tree)", () => {
  const engagedTrace = (): ActorTrace =>
    cuaActorTrace({
      counts: {
        turns: 2,
        actions: 1,
        screenshots: 0,
        reasonings: 0,
        messages: 1,
        idleTurns: 0,
        noProgressTurns: 0,
      },
      items: [
        { id: "action-001", kind: "ui_action", lifecycle: "completed", title: "click (11, 22)" },
        {
          id: "message-001",
          kind: "message",
          lifecycle: "completed",
          title: "message",
          text: "Done.",
        },
      ],
    });
  // Shape-valid fixtures (64-hex / 40-hex), not real digests.
  const ARCHIVE_SHA = "a1".repeat(32);
  const HOST_COMMIT = "b2".repeat(20);
  const stateCheck = (verify: Awaited<ReturnType<typeof verifyRun>>) =>
    verify.checks.find((entry) => entry.name === "subject state provenance");
  const shapeCheck = (verify: Awaited<ReturnType<typeof verifyRun>>) =>
    verify.checks.find((entry) => entry.name === "run bundle shape");

  it("accepts a well-formed live local-tree subject at both the bundle-shape gate and the subject state check", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "local-tree-well-formed", {
        dryRun: false,
        trace: engagedTrace(),
        subject: {
          source: "local-tree",
          archiveSha256: ARCHIVE_SHA,
          commit: HOST_COMMIT,
          dirty: true,
          envNames: [],
          state: { provenance: "undeclared" },
        },
      });
      const verify = await verifyRun(cwd, "local-tree-well-formed");
      expect(verify.ok).toBe(true);
      expect(shapeCheck(verify)?.ok).toBe(true);
      expect(stateCheck(verify)?.ok).toBe(true);
    });
  });

  it("rejects a malformed archiveSha256 at the bundle-shape gate (not 64-hex)", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "local-tree-bad-digest", {
        dryRun: false,
        trace: engagedTrace(),
        subject: {
          source: "local-tree",
          archiveSha256: "not-a-hex-digest",
          envNames: [],
          state: { provenance: "undeclared" },
        },
      });
      const verify = await verifyRun(cwd, "local-tree-bad-digest");
      expect(verify.ok).toBe(false);
      expect(shapeCheck(verify)?.ok).toBe(false);
    });
  });

  it("FAILS a live local-tree bundle missing archiveSha256, and PASSES once it carries a well-formed one", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "local-tree-missing-pin", {
        dryRun: false,
        trace: engagedTrace(),
        subject: {
          source: "local-tree",
          envNames: [],
          state: { provenance: "undeclared" },
        },
      });
      const missing = await verifyRun(cwd, "local-tree-missing-pin");
      expect(missing.ok).toBe(false);
      expect(stateCheck(missing)?.ok).toBe(false);
      expect(stateCheck(missing)?.message).toContain("archiveSha256 is missing or malformed");
      // Fail-closed discipline: the finding never echoes anything sensitive because there is
      // nothing to echo here (the value is simply absent), matching the malformed-shape gate's
      // never-echo rule for values that could themselves be leaked secrets.

      await writeCuaRunFixture(cwd, "local-tree-with-pin", {
        dryRun: false,
        trace: engagedTrace(),
        subject: {
          source: "local-tree",
          archiveSha256: ARCHIVE_SHA,
          envNames: [],
          state: { provenance: "undeclared" },
        },
      });
      const withPin = await verifyRun(cwd, "local-tree-with-pin");
      expect(withPin.ok).toBe(true);
      expect(stateCheck(withPin)?.ok).toBe(true);
    });
  });

  it("a dry-run local-tree bundle with NO archiveSha256 passes (nothing was packed, so nothing to pin)", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "local-tree-dryrun", {
        dryRun: true,
        subject: {
          source: "local-tree",
          envNames: [],
          state: { provenance: "undeclared" },
        },
      });
      const verify = await verifyRun(cwd, "local-tree-dryrun");
      expect(verify.ok).toBe(true);
      expect(stateCheck(verify)?.ok).toBe(true);
    });
  });
});

describe("verify: cost estimate labeling", () => {
  // An ENGAGED live trace so the review verdict is a genuine pass; that isolates the cost check
  // from the actor-engagement gate. Cost is ADVISORY on magnitude, FAIL-CLOSED on provenance.
  const engagedTrace = (estimatedCost?: ActorTrace["estimatedCost"]): ActorTrace => {
    const trace = cuaActorTrace({
      counts: {
        turns: 2,
        actions: 1,
        screenshots: 0,
        reasonings: 0,
        messages: 1,
        idleTurns: 0,
        noProgressTurns: 0,
      },
      items: [
        { id: "action-001", kind: "ui_action", lifecycle: "completed", title: "click (11, 22)" },
        {
          id: "message-001",
          kind: "message",
          lifecycle: "completed",
          title: "message",
          text: "Done.",
        },
      ],
    });
    if (estimatedCost) trace.estimatedCost = estimatedCost;
    return trace;
  };
  const costCheck = (verify: Awaited<ReturnType<typeof verifyRun>>) =>
    verify.checks.find((entry) => entry.name === "cost estimate labeling");
  const labeledSummary = (overrides: Partial<RunCostSummary> = {}): RunCostSummary => ({
    schema: "humanish.run-cost-summary.v1",
    currency: "usd",
    estimatedTotalUsd: 11.6,
    ratesAsOf: "2026-08-01",
    fullyEstimated: false,
    placeholder: false,
    breakdown: [
      {
        kind: "model-tokens",
        laneId: "lane-01",
        modelId: "computer-use-preview",
        estimatedCostUsd: 11.6,
        ratesAsOf: "2026-08-01",
        source: "openai.com/api/pricing (computer-use-preview)",
      },
      { kind: "desktop-minutes", estimatedCostUsd: null, reason: "no_duration", ratesAsOf: null },
    ],
    tokenUsage: { input: 3843523, output: 5869, total: 3849392 },
    desktopMinutes: null,
    note: "Estimated model-token cost; desktop minutes unmeasured.",
    ...overrides,
  });

  it("passes when the bundle carries NO cost at all (fail-open on absence)", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "cost-absent", { dryRun: false, trace: engagedTrace() });
      const verify = await verifyRun(cwd, "cost-absent");
      expect(costCheck(verify)?.ok).toBe(true);
      expect(verify.ok).toBe(true);
    });
  });

  it("passes a properly-labeled estimate and a HUGE but correctly-labeled estimate (magnitude never fails)", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "cost-labeled", {
        dryRun: false,
        trace: engagedTrace(),
        cost: labeledSummary(),
      });
      const labeled = await verifyRun(cwd, "cost-labeled");
      expect(costCheck(labeled)?.ok).toBe(true);
      expect(labeled.ok).toBe(true);

      await writeCuaRunFixture(cwd, "cost-huge", {
        dryRun: false,
        trace: engagedTrace(),
        cost: labeledSummary({
          estimatedTotalUsd: 1_000_000,
          breakdown: [
            {
              kind: "model-tokens",
              laneId: "lane-01",
              modelId: "computer-use-preview",
              estimatedCostUsd: 1_000_000,
              ratesAsOf: "2026-08-01",
              source: "openai.com/api/pricing",
            },
          ],
        }),
      });
      const huge = await verifyRun(cwd, "cost-huge");
      expect(costCheck(huge)?.ok).toBe(true);
      expect(huge.ok).toBe(true);
    });
  });

  it("FAILS a number total that lacks its ratesAsOf date (a token-derived charge without provenance)", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "cost-no-rates", {
        dryRun: false,
        trace: engagedTrace(),
        cost: labeledSummary({ ratesAsOf: null }),
      });
      const verify = await verifyRun(cwd, "cost-no-rates");
      expect(costCheck(verify)?.ok).toBe(false);
      expect(verify.ok).toBe(false);
    });
  });

  it("FAILS a total that does not equal the sum of its known breakdown lines", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "cost-mismatch", {
        dryRun: false,
        trace: engagedTrace(),
        cost: labeledSummary({ estimatedTotalUsd: 99.99 }),
      });
      const verify = await verifyRun(cwd, "cost-mismatch");
      expect(costCheck(verify)?.ok).toBe(false);
    });
  });

  it("FAILS a null total sitting beside a known (non-null) breakdown line", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "cost-null-hides", {
        dryRun: false,
        trace: engagedTrace(),
        cost: labeledSummary({ estimatedTotalUsd: null }),
      });
      const verify = await verifyRun(cwd, "cost-null-hides");
      expect(costCheck(verify)?.ok).toBe(false);
    });
  });

  it("asserts per-actor estimate labeling: a number estimate without ratesAsOf fails; a declared-absent null passes", async () => {
    await withFixtureCopy(async (cwd) => {
      await writeCuaRunFixture(cwd, "actor-cost-bad", {
        dryRun: false,
        trace: engagedTrace({
          schema: "humanish.actor-estimated-cost.v1",
          estimatedCostUsd: 4.86,
          ratesAsOf: null,
          source: "openai.com/api/pricing",
        }),
      });
      expect(costCheck(await verifyRun(cwd, "actor-cost-bad"))?.ok).toBe(false);

      await writeCuaRunFixture(cwd, "actor-cost-null", {
        dryRun: false,
        trace: engagedTrace({
          schema: "humanish.actor-estimated-cost.v1",
          estimatedCostUsd: null,
          reason: "no_rate_for_model",
          ratesAsOf: null,
          modelId: "mystery-model",
        }),
      });
      const nullVerify = await verifyRun(cwd, "actor-cost-null");
      expect(costCheck(nullVerify)?.ok).toBe(true);
      expect(nullVerify.ok).toBe(true);
    });
  });
});
