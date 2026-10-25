// A provisioned shared world with a declared schedule, run on the N+1 fakes ($0, real
// orchestration and real time with sub-second offsets): the app's sandbox is asked to live until
// the last participant ends, each participant's desktop is created at its start, and run.json
// records each participant's scheduled and actual start.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CuaActorSessionOptions } from "../../../src/actors/computer-use/actor.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { parseStudy } from "../../../src/study/config.js";
import type { StudyConfig } from "../../../src/study/types.js";
import type { E2BDesktopModule } from "../../../src/substrates/e2b/sdk.js";
import { automaticAnalysisBoundary } from "../../helpers/automatic-analysis-boundary.js";
import { runSharedWorld } from "../../helpers/route-run.js";
import { baseSeams, concurrentStudy, makeRunSession } from "../../helpers/shared-world-fakes.js";

const MINUTES = 60_000;

function scheduled(offsets: (number | undefined)[], caps?: { maxTotalUsd: number }): StudyConfig {
  const study = concurrentStudy(offsets.length, offsets.length);
  const parsed = parseStudy({
    ...study,
    ...(caps === undefined ? {} : { caps }),
    participants: study.participants.map((entry, index) => ({
      ...entry,
      ...(offsets[index] === undefined ? {} : { startAfterMs: offsets[index] }),
    })),
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("a provisioned shared world with a declared schedule", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-shared-arrivals-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps the app up until the last participant ends and starts each participant at its time", async () => {
    const state = { worldVersion: 0 };
    const { env, deps, created } = baseSeams(state, async () => {});
    const createdAt: number[] = [];
    const fakes = await deps.desktopModule!();
    const timed: E2BDesktopModule = {
      Sandbox: {
        ...fakes.Sandbox,
        create: (async (...args: Parameters<E2BDesktopModule["Sandbox"]["create"]>) => {
          createdAt.push(Date.now());
          return fakes.Sandbox.create(...args);
        }) as E2BDesktopModule["Sandbox"]["create"],
      },
    };
    // Each session holds its participant long enough for the next one's start to overlap it.
    const session = makeRunSession(state, async () => {});
    const result = await runSharedWorld({
      cwd,
      config: scheduled([undefined, 300, 600]),
      dryRun: false,
      env,
      deps: {
        ...deps,
        desktopModule: async () => timed,
        runSession: async (options: CuaActorSessionOptions) => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return session(options);
        },
        analysis: { run: automaticAnalysisBoundary() },
      },
    });
    expect(result.ok).toBe(true);

    // The app's sandbox serves 600 ms past one 1-minute session, plus 45 minutes to provision,
    // seed (one 5-minute step) and tear down.
    expect(created[0]?.metadata?.kind).toBe("subject");
    expect(created[0]?.timeoutMs).toBe(MINUTES + 600 + 45 * MINUTES);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    const starts = bundle.simulations.map((record) => ({
      offset: record.arrival?.startAfterMs,
      scheduledAt: Date.parse(record.arrival?.scheduledAt ?? ""),
      startedAt: Date.parse(record.arrival?.startedAt ?? ""),
    }));
    expect(starts.map((start) => start.offset)).toEqual([0, 300, 600]);
    const anchor = starts[0]!.scheduledAt;
    expect(starts.map((start) => start.scheduledAt - anchor)).toEqual([0, 300, 600]);
    // createdAt[0] is the app's sandbox; each participant's desktop comes at or after its time.
    for (const [index, start] of starts.entries()) {
      expect(start.startedAt).toBeGreaterThanOrEqual(start.scheduledAt);
      expect(createdAt[index + 1]).toBeGreaterThanOrEqual(start.scheduledAt);
    }
  });

  it("skips a participant due after the study budget is spent, before its desktop exists", async () => {
    const state = { worldVersion: 0 };
    const { env, deps, created } = baseSeams(state, async () => {});
    const session = makeRunSession(state, async () => {});
    const result = await runSharedWorld({
      cwd,
      config: scheduled([undefined, 1_000], { maxTotalUsd: 0.01 }),
      dryRun: false,
      env,
      deps: {
        ...deps,
        // The first participant's session reports a million input tokens to the study ledger.
        runSession: async (options: CuaActorSessionOptions) => {
          options.overRunBudget?.({ input: 1_000_000, output: 0 });
          return session(options);
        },
        analysis: { run: automaticAnalysisBoundary() },
      },
    });

    // The app's sandbox and the first participant's desktop; none for the second.
    expect(created.map((options) => options.metadata?.kind)).toHaveLength(2);
    // As for a follower the handoff stopped: no session, blocked in the result and in run.json.
    expect(result.roles[1]?.status).toBe("blocked");
    expect(result.roles[1]?.error?.message).toContain("caps.maxTotalUsd");
    expect(result.ok).toBe(false);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.simulations[1]?.status).toBe("blocked");
    expect(bundle.simulations[1]?.arrival?.startedAt).toBeUndefined();
    // The participant's record says it was skipped, in the form a computer-use skip takes.
    expect(bundle.simulations[1]?.summary).toBe(
      "Persona 02 was skipped: study budget reached before this participant started: the run's estimated model spend $2 crossed caps.maxTotalUsd=$0.01; no desktop was created.",
    );
    expect(bundle.review.summary).toBe(
      "1 participant used one shared app. 1 of 1 reached the goal. 1 participant was skipped before its session started; the gaps say why. The app's shared state changed 1 time during the run.",
    );
  });

  it("does not count a participant skipped mid-session as overlap between two who ran in turn", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, async () => {});
    const session = makeRunSession(state, async () => {});
    let sessions = 0;
    // Each read of this clock is 1 ms after the last, so the skipped participant's window is at
    // least 1 ms wide.
    let reads = 0;
    const result = await runSharedWorld({
      cwd,
      // The first participant ends well before the second starts at 1 s. The second spends the
      // study budget as it starts and holds its session past 1.3 s, when the third is due.
      config: scheduled([undefined, 1_000, 1_300], { maxTotalUsd: 0.01 }),
      dryRun: false,
      env,
      deps: {
        ...deps,
        now: () => Date.now() + reads++,
        runSession: async (options: CuaActorSessionOptions) => {
          sessions += 1;
          if (sessions === 2) {
            options.overRunBudget?.({ input: 1_000_000, output: 0 });
            await new Promise((resolve) => setTimeout(resolve, 600));
          }
          return session(options);
        },
        analysis: { run: automaticAnalysisBoundary() },
      },
    });

    expect(result.roles.map((role) => role.status)).toEqual(["passed", "passed", "blocked"]);
    expect(result.overlapProven).toBe(false);
    expect(result.maxSimultaneousLanes).toBe(1);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.review.summary).toContain(
      "2 participants used one shared app, but never at the same time. 2 of 2 reached the goal. 1 participant was skipped before its session started; the gaps say why.",
    );
    const concurrency = bundle.events.find(
      (event) => event.type === "concurrent-shared-world.concurrency",
    );
    expect(concurrency?.message).toContain(
      "3 participants, up to 1 live at once (cap 3), overlap not observed",
    );
  });
});
