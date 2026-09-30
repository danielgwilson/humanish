import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { RunBundle } from "../../src/run/bundle.js";
import { verifyRun } from "../../src/verify/verify.js";
import {
  pinnedVerifyResult,
  verifyGolden,
  type PinnedVerifyResult,
} from "../helpers/verify-findings.js";

// Live run directories written by the sequential shared-world route in 0.105.0 on its fake E2B
// module, before that route was removed. No route writes `topologyMode: "sequential"` any more;
// `humanish.shared-world.v1` still documents it, so verify keeps reading these bundles.
// The Observer build and analysis job are left out: verify reads neither.
const FIXTURES = {
  passed: "shared-world-2026-09-30T08-01-53-267Z-899ab3c9",
  "skipped-tail": "shared-world-2026-09-30T08-01-52-597Z-a21004d9",
} as const;
type Fixture = keyof typeof FIXTURES;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function prepareFixture(
  fixture: Fixture,
  mutate?: (bundle: RunBundle) => void,
): Promise<{ cwd: string; runId: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-legacy-sequential-"));
  roots.push(cwd);
  const runId = FIXTURES[fixture];
  const runDir = path.join(cwd, ".humanish", "runs", runId);
  await cp(
    fileURLToPath(
      new URL(`../fixtures/legacy-sequential-shared-world/${fixture}`, import.meta.url),
    ),
    runDir,
    { recursive: true },
  );
  if (mutate) {
    const bundlePath = path.join(runDir, "run.json");
    const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as RunBundle;
    mutate(bundle);
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  }
  return { cwd, runId };
}

async function verifyFixture(
  fixture: Fixture,
  mutate?: (bundle: RunBundle) => void,
): Promise<boolean> {
  const { cwd, runId } = await prepareFixture(fixture, mutate);
  return (await verifyRun(cwd, runId)).ok;
}

type Entry = Record<string, unknown>;
const timeline = (bundle: RunBundle): Entry[] => bundle.sharedWorld!.timeline as unknown as Entry[];

const overclaims: Array<[string, (bundle: RunBundle) => void]> = [
  [
    "attributionLimits missing no-concurrent-races",
    (b) => {
      b.sharedWorld!.attributionLimits = b.sharedWorld!.attributionLimits.filter(
        (limit) => limit !== "no-concurrent-races",
      );
    },
  ],
  [
    "a value-shaped checkpoint field",
    (b) => {
      timeline(b).find((entry) => entry.kind === "checkpoint")!.rawValue = "notes=42";
    },
  ],
  [
    "divergent plane provenance across turns",
    (b) => {
      timeline(b).find((entry) => entry.kind === "turn")!.commit = "deadbeefdeadbeef0000";
    },
  ],
  [
    "a dropped role",
    (b) => {
      b.sharedWorld!.sequence = b.sharedWorld!.sequence!.slice(0, 1);
    },
  ],
  [
    "a passed run with no checkpoint delta",
    (b) => {
      for (const entry of timeline(b)) {
        if (entry.kind === "checkpoint") entry.deltaFromPrev = false;
      }
    },
  ],
  [
    "goal_satisfied with zero engagement",
    (b) => {
      const actor = b.streams.find((stream) => stream.actor)!.actor!;
      actor.completionReason = "goal_satisfied";
      actor.counts = { actions: 0, messages: 0, screenshots: 0 };
      actor.items = [];
    },
  ],
  [
    "concurrent laneWindows on a sequential bundle",
    (b) => {
      Object.assign(b.sharedWorld!, { laneWindows: [] });
    },
  ],
];

const tailTampers: Array<[string, (bundle: RunBundle) => void]> = [
  ["no explicit tail", (b) => delete b.sharedWorld!.skippedTail],
  ["empty tail", (b) => void (b.sharedWorld!.skippedTail!.roles = [])],
  ["wrong blocker", (b) => void (b.sharedWorld!.skippedTail!.afterRoleId = "role-author")],
  [
    "unknown cause",
    (b) => void Object.assign(b.sharedWorld!.skippedTail!, { cause: "because it stopped" }),
  ],
  ["unsupported usage cause", (b) => void (b.sharedWorld!.skippedTail!.cause = "usage_unreported")],
  ["invented threshold crossing", (b) => void (b.sharedWorld!.skippedTail!.maxTotalUsd = 100)],
  ["invented cost", (b) => void (b.sharedWorld!.skippedTail!.estimatedTotalUsd = 100)],
  ["dropped simulation", (b) => void b.simulations.splice(1, 1)],
  ["dropped stream", (b) => void b.streams.splice(1, 1)],
  ["duplicate role", (b) => void (b.sharedWorld!.skippedTail!.roles[0]!.roleId = "role-reviewer")],
  ["duplicate sim", (b) => void (b.sharedWorld!.skippedTail!.roles[0]!.simId = "sim-002")],
  ["duplicate stream", (b) => void (b.sharedWorld!.skippedTail!.roles[0]!.streamId = "stream-002")],
  ["wrong stream mapping", (b) => void (b.streams[1]!.simId = "sim-001")],
  ["wrong simulation mapping", (b) => void (b.simulations[1]!.streamIds = ["stream-001"])],
  ["missing executed actor", (b) => delete b.streams[1]!.actor],
  ["blocked middle", (b) => void ([b.streams[1], b.streams[2]] = [b.streams[2]!, b.streams[1]!])],
  ["fabricated blocked actor", (b) => void (b.streams[2]!.actor = b.streams[0]!.actor!)],
  ["fabricated live actor", (b) => void Object.assign(b.streams[2]!, { liveActor: { items: [] } })],
  [
    "fabricated blocked trace",
    (b) =>
      void b.streams[2]!.artifacts.push({
        kind: "trace",
        path: "actors/stream-001.json",
        label: "invented",
      }),
  ],
  [
    "fabricated blocked screenshot",
    (b) => void (b.streams[2]!.embed = { kind: "screenshot", url: "invented.png" }),
  ],
  [
    "fabricated skipped checkpoint",
    (b) => void Object.assign(timeline(b)[4]!, { name: "cp-after-role-later" }),
  ],
  [
    "missing blocked event",
    (b) =>
      void (b.events = b.events.filter((event) => event.type !== "shared-world.session.blocked")),
  ],
  ["passed review", (b) => void (b.review.verdict = "pass")],
  ["concurrent tail", (b) => void (b.sharedWorld!.topologyMode = "concurrent")],
  ["dry-run tail", (b) => void (b.mode = "dry-run")],
];

describe("sequential shared-world bundles from before 0.106.0", () => {
  it.each(Object.keys(FIXTURES) as Fixture[])("the %s fixture still verifies", async (fixture) => {
    expect(await verifyFixture(fixture)).toBe(true);
  });

  it.each(overclaims)("a passed bundle fails closed on %s", async (_name, mutate) => {
    expect(await verifyFixture("passed", mutate)).toBe(false);
  });

  it.each(tailTampers)("a budget-stopped bundle fails closed on %s", async (_name, mutate) => {
    expect(await verifyFixture("skipped-tail", mutate)).toBe(false);
  });
});

describe("sequential shared-world verify findings golden", () => {
  it("pins verify's failing checks for each fixture and each tamper in a golden", async () => {
    const entries: Array<readonly [string, PinnedVerifyResult]> = [];
    const pin = async (name: string, fixture: Fixture, mutate?: (bundle: RunBundle) => void) => {
      const { cwd, runId } = await prepareFixture(fixture, mutate);
      entries.push([name, await pinnedVerifyResult(cwd, runId)]);
    };
    for (const fixture of Object.keys(FIXTURES) as Fixture[]) await pin(fixture, fixture);
    for (const [name, mutate] of overclaims) await pin(`passed: ${name}`, "passed", mutate);
    for (const [name, mutate] of tailTampers)
      await pin(`skipped-tail: ${name}`, "skipped-tail", mutate);
    // Several invariants fail at once, so the golden also pins the order across them.
    await pin("passed: every overclaim at once", "passed", (b) => {
      for (const [, mutate] of overclaims) mutate(b);
    });
    // Tampers that keep the bundle shape valid, from the roster, role and cause checks.
    const combinedTail = new Set([
      "wrong blocker",
      "unknown cause",
      "invented cost",
      "duplicate role",
      "fabricated blocked actor",
      "fabricated skipped checkpoint",
      "missing blocked event",
    ]);
    await pin(`skipped-tail: ${[...combinedTail].join(", ")}`, "skipped-tail", (b) => {
      for (const [name, mutate] of tailTampers) if (combinedTail.has(name)) mutate(b);
    });
    await expect(verifyGolden(entries)).toMatchFileSnapshot(
      "../golden/verify/shared-world-sequential.json",
    );
  });
});
