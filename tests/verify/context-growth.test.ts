import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../../src/actors/contract.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { contextGrowth, flatContextWarnings } from "../../src/verify/context-growth.js";
import { verifyRun } from "../../src/verify/verify.js";
import { runSyntheticLive } from "../helpers/synthetic-live-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

type Turn = { input: number; cachedInput?: number; cacheWriteInput?: number };

const turns = (inputs: readonly number[]): Turn[] => inputs.map((input) => ({ input }));

/** About 3,100 tokens from turn 2 to turn 527, as a zero-data-retention computer-use run sent. */
const flatTurns = (first: number, near: number, count: number): Turn[] =>
  turns([first, ...Array.from({ length: count - 1 }, (_, i) => near + ((i * 37) % 120) - 60)]);

function bundle(streamTurns: Record<string, Turn[]>, mode: RunBundle["mode"] = "live"): RunBundle {
  return {
    mode,
    streams: Object.entries(streamTurns).map(([id, list]) => ({
      id,
      actor: { schema: ACTOR_TRACE_SCHEMA, tokenUsage: { turns: list } },
    })),
  } as unknown as RunBundle;
}

describe("flat context", () => {
  it("names a participant whose prompt stayed flat, and only that one", () => {
    const warnings = flatContextWarnings(
      bundle({
        "participant-01": flatTurns(1400, 3100, 527),
        "participant-02": flatTurns(2600, 5300, 109),
        // The slowest growth among the live traces measured: a Codex participant's inferences.
        "participant-03": turns([8734, 10457, 11991, 12248, 13979, 14268, 14518, 16292]),
      }),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^participant-01: its context did not grow\. .* turn 527/);
    expect(warnings[1]).toMatch(/^participant-02: .* turn 109/);
  });

  it("counts the cached prompt of a Claude session trace that recorded uncached input alone", () => {
    const claude: Turn[] = [41852, 67514, 72115, 76873, 81590, 86120, 90700].map((cachedInput) => ({
      input: 34,
      cachedInput,
      cacheWriteInput: 2300,
    }));
    expect(contextGrowth(claude)).toBeGreaterThan(1.1);
    expect(flatContextWarnings(bundle({ "participant-01": claude }))).toEqual([]);
  });

  it("says nothing about fewer than six turns, a turn without usage, or a dry run", () => {
    expect(contextGrowth(turns([1400, 3100, 3100, 3100, 3100]))).toBeUndefined();
    expect(
      contextGrowth([...turns([1400, 3100, 3100]), {}, ...turns([3100, 3100])]),
    ).toBeUndefined();
    expect(
      flatContextWarnings(bundle({ "participant-01": flatTurns(1400, 3100, 40) }, "dry-run")),
    ).toEqual([]);
  });

  it("reaches `humanish verify` as a run warning", async () => {
    const cwd = await makeTestTempDir("humanish-flat-context-");
    const runId = "flat-context";
    await runSyntheticLive({ cwd, dryRun: true, runId });
    const file = path.join(cwd, ".humanish", "runs", runId, "run.json");
    const run = JSON.parse(await readFile(file, "utf8")) as {
      streams: Array<Record<string, unknown>>;
    };
    const stream = run.streams[0]!;
    stream.actor = { schema: ACTOR_TRACE_SCHEMA, tokenUsage: { turns: flatTurns(1400, 3100, 30) } };
    await writeFile(file, `${JSON.stringify(run, null, 2)}\n`);

    const result = await verifyRun(cwd, runId);
    expect(result.warnings).toContainEqual(
      expect.stringMatching(new RegExp(`^${String(stream.id)}: its context did not grow`)),
    );
  });
});
