import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorTrace } from "../../../src/actors/contract.js";
import type { CuaLoopResult } from "../../../src/actors/computer-use/loop.js";
import { buildRunSource, type RunBundle } from "../../../src/run/bundle.js";
import { buildSingleParticipantBundle } from "../../../src/routes/computer-use/single-bundle.js";
import { verdictForStatus } from "../../../src/run/judge.js";

// The single-participant bundle says where the participant's browser ran. That place comes from the
// participant's runner (its substrate), so a local VM run is not described as a hosted desktop.

const trace: ActorTrace = {
  schema: ACTOR_TRACE_SCHEMA,
  provider: "openai-responses-cu",
  protocol: "cua-loop",
  lane: "computer-use",
  persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
  redaction: { status: "passed", screenshots: "raw", notes: "synthetic test trace" },
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:05.000Z",
  durationMs: 5_000,
  status: "passed",
  completionReason: "goal_satisfied",
  reason: "model reported a natural endpoint with no further action",
  ids: {},
  counts: { turns: 1, actions: 0, screenshots: 0, reasonings: 0, messages: 0 },
  items: [],
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
const session: CuaLoopResult = {
  status: trace.status,
  completionReason: trace.completionReason,
  reason: trace.reason,
  trace,
};

type Runner = "e2b-desktop" | "local-desktop" | "local-filesystem";

async function bundle(runner: Runner, state: "finished" | "running"): Promise<RunBundle> {
  return buildSingleParticipantBundle({
    verdict: state === "finished" ? verdictForStatus(session.status) : "contract_proof_only",
    actorId: "openai-computer-use",
    appUrl: "http://127.0.0.1:3000/",
    subject: { source: "app-url", state: { provenance: "undeclared" } },
    run: {
      runId: "cua-2026-01-01T00-00-00-000Z-00000000",
      mode: "live",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    dryRun: false,
    studyId: "substrate-wording",
    mission: "Add a note, then stop.",
    persona: trace.persona,
    resolution: [1440, 960],
    screenshots: [],
    substrate: runner,
    ...(runner === "local-filesystem" ? { desktopRoute: false } : {}),
    ...(state === "finished" ? { session, traceArtifactPath: "actor.json" } : { inProgress: true }),
    source: await buildRunSource({
      cwd: process.cwd(),
      humanishSource: "present",
      packageName: "humanish",
    }),
  });
}

const place: Record<Runner, string> = {
  "e2b-desktop": "in a hosted desktop browser",
  "local-desktop": "in a browser on a local VM",
  "local-filesystem": "in process, with no desktop",
};

describe.each(["e2b-desktop", "local-desktop", "local-filesystem"] as const)(
  "a single-participant bundle from the %s runner",
  (runner) => {
    it("names the runner in the finished summary and the stream intent", async () => {
      const run = await bundle(runner, "finished");
      expect(run.simulations[0]?.summary).toBe(
        `First time visitor used the app ${place[runner]}, and reached the goal.`,
      );
      expect(run.streams[0]?.ui?.intent).toBe(
        `Watch the computer-use actor drive the subject app ${place[runner]}.`,
      );
    });

    it("names the runner while the session is running", async () => {
      const run = await bundle(runner, "running");
      expect(run.simulations[0]?.summary).toBe(
        `First time visitor is using the app ${place[runner]}.`,
      );
    });
  },
);

describe("the subject-declared event", () => {
  it("says a local VM reaches the host's loopback, and a hosted desktop its own", async () => {
    const declared = (run: RunBundle) =>
      run.events.find((event) => event.type === "cua-lab.subject.declared")?.message;
    expect(declared(await bundle("local-desktop", "finished"))).toBe(
      "Subject app declared at http://127.0.0.1:3000/ (the host's loopback, opened from a browser on a local VM).",
    );
    expect(declared(await bundle("e2b-desktop", "finished"))).toBe(
      "Subject app declared at http://127.0.0.1:3000/ (loopback inside the desktop sandbox).",
    );
  });
});
