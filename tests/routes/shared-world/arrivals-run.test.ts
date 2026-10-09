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

function scheduled(offsets: (number | undefined)[]): StudyConfig {
  const study = concurrentStudy(offsets.length, offsets.length);
  const parsed = parseStudy({
    ...study,
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
});
