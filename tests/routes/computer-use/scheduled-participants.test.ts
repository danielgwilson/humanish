// The in-progress bundle of a roster whose participants start over time: a participant with a start
// offset is queued, says when it starts and has no session.running event until its session
// starts. The live flush rebuilds the bundle when it sees a participant's first items, so the
// participant reads as running from then on, also when its start comes during another write.

import { describe, expect, it } from "vitest";

import type { ActorTraceItem } from "../../../src/actors/contract.js";
import { getActor } from "../../../src/actors/registry.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { buildCuaFanoutBundle } from "../../../src/routes/computer-use/fanout-bundle.js";
import { startLiveTraceFlush } from "../../../src/routes/computer-use/live-flush.js";
import type { ParticipantRunOutcome } from "../../../src/routes/computer-use/types.js";
import { participantRunsAndPlan } from "../../../src/routes/computer-use/participant-runs.js";
import { planComputerUseStudy } from "../../../src/routes/computer-use/plan.js";
import { judgeParticipants } from "../../../src/run/judge.js";
import { parseStudy } from "../../../src/study/config.js";
import { concurrentSandboxes, sandboxCeiling } from "../../../src/substrates/e2b/lifetime.js";
import { lab } from "../../admission/fixtures.js";

const CREATED_AT = "2026-10-28T08:00:00.000Z";
const LOOPBACK = "http://127.0.0.1:3000/";

/** A support agent who starts with the run and two customers at +2h 35m and +5h 10m. */
function scheduledRoster() {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      participants: [
        { id: "support-agent" },
        { id: "customer", count: 2, startAfterMs: 9_300_000, startEveryMs: 9_300_000 },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const planned = planComputerUseStudy(parsed.config, {
    dryRun: false,
    sandboxCeiling: sandboxCeiling({}),
    concurrentSandboxes: concurrentSandboxes({}),
  });
  if (!planned.ok) throw new Error(planned.refusal.message);
  const { runs, participantPlan } = participantRunsAndPlan(planned.plan);
  return { plan: planned.plan, runs, participantPlan };
}

function inProgressBundle(
  options: {
    liveStarts?: ReadonlyMap<string, string>;
    appUrl?: string;
    outcomes?: readonly (ParticipantRunOutcome | undefined)[];
  } = {},
): RunBundle {
  const { plan, runs, participantPlan } = scheduledRoster();
  const subject = { source: "app-url" as const, state: { provenance: "undeclared" as const } };
  return buildCuaFanoutBundle({
    verdict: judgeParticipants({
      dryRun: false,
      inProgress: true,
      expected: runs.length,
      participants: [],
    }).verdict,
    run: { runId: "scheduled-roster", mode: "live", createdAt: CREATED_AT },
    specs: runs,
    subjects: runs.map(() => subject),
    aggregateSubject: subject,
    descriptor: getActor("openai-computer-use"),
    appUrl: options.appUrl ?? LOOPBACK,
    dryRun: false,
    plan,
    source: {
      packageName: "humanish",
      humanishSource: "present",
      git: {
        schema: "humanish.git-state.v1",
        status: "clean",
        capturedAt: CREATED_AT,
        head: { shortSha: "abc1234", refState: "attached" },
        changes: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
        note: "test fixture",
      },
    },
    participantPlan,
    inProgress: true,
    ...(options.liveStarts === undefined ? {} : { liveStarts: options.liveStarts }),
    ...(options.outcomes === undefined ? {} : { outcomes: options.outcomes }),
  });
}

/** Each participant's simulation status, stream status, current step and start. */
function participants(bundle: RunBundle) {
  return bundle.simulations.map((record, index) => ({
    status: record.status,
    stream: bundle.streams[index]!.status,
    currentStep: record.currentStep,
    startedAt: record.startedAt,
  }));
}

function runningEvents(bundle: RunBundle) {
  return bundle.events
    .filter((event) => event.type === "cua-lab.session.running")
    .map((event) => ({ simId: event.simId, at: event.at }));
}

const screenshot = (): ActorTraceItem => ({
  id: "screenshot-001",
  kind: "screenshot",
  lifecycle: "completed",
  title: "turn-01",
  screenshotRef: { path: "screenshots/customer/turn-01.png", redaction: "none" },
  at: CREATED_AT,
});

describe("the in-progress bundle of a scheduled roster", () => {
  it("queues each participant with a start offset and says when it starts", () => {
    const bundle = inProgressBundle();
    const [agent, first, second] = participants(bundle);
    expect(agent).toMatchObject({ status: "running", stream: "running", startedAt: CREATED_AT });
    expect(first).toMatchObject({
      status: "queued",
      stream: "queued",
      currentStep: "Starts at +2h 35m.",
    });
    expect(second).toMatchObject({ status: "queued", currentStep: "Starts at +5h 10m." });
    expect(bundle.simulations[1]!.summary).toContain("Starts at +2h 35m.");
    expect(bundle.simulations[1]!.arrival?.startAfterMs).toBe(9_300_000);
    expect(runningEvents(bundle)).toEqual([{ simId: bundle.simulations[0]!.id, at: CREATED_AT }]);
  });

  it("records a queued participant as running from when its session started", () => {
    const startedAt = "2026-10-28T10:35:04.000Z";
    const firstCustomer = scheduledRoster().runs[1]!.planned.id;
    const bundle = inProgressBundle({ liveStarts: new Map([[firstCustomer, startedAt]]) });
    const [, first, second] = participants(bundle);
    expect(first).toMatchObject({ status: "running", stream: "running", startedAt });
    expect(bundle.simulations[1]!.summary).toContain("is using");
    expect(second?.status).toBe("queued");
    expect(runningEvents(bundle)).toEqual([
      { simId: bundle.simulations[0]!.id, at: CREATED_AT },
      { simId: bundle.simulations[1]!.id, at: startedAt },
    ]);
  });
});

describe("the live flush of a scheduled roster", () => {
  it("rewrites a queued participant as running once its first items arrive", async () => {
    const { runs } = scheduledRoster();
    const writes: RunBundle[] = [];
    const flush = startLiveTraceFlush({
      bundle: inProgressBundle(),
      participantRuns: runs,
      model: "gpt-5.5",
      write: async (bundle) => {
        writes.push(bundle);
      },
      restate: (liveStarts) => inProgressBundle({ liveStarts }),
    });
    flush.flush(runs[1]!.planned.id, [screenshot()]);
    await flush.stop();
    const written = writes.at(-1)!;
    expect(participants(written).map((participant) => participant.status)).toEqual([
      "running",
      "running",
      "queued",
    ]);
    expect(Date.parse(written.simulations[1]!.startedAt)).toBeGreaterThan(Date.parse(CREATED_AT));
    expect(written.streams[1]!.liveActor?.items).toHaveLength(1);
  });

  it("writes a start that comes while another write is in flight", async () => {
    const { runs } = scheduledRoster();
    const writes: RunBundle[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flush = startLiveTraceFlush({
      bundle: inProgressBundle(),
      participantRuns: runs,
      model: "gpt-5.5",
      write: async (bundle) => {
        writes.push(bundle);
        if (writes.length === 1) await held;
      },
      restate: (liveStarts) => inProgressBundle({ liveStarts }),
    });
    flush.flush(runs[1]!.planned.id, [screenshot()]);
    expect(writes).toHaveLength(1);
    flush.flush(runs[2]!.planned.id, [screenshot()]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush.stop();
    expect(writes).toHaveLength(2);
    expect(participants(writes[1]!).map((participant) => participant.status)).toEqual([
      "running",
      "running",
      "running",
    ]);
  });
});

/** The first customer's outcome: its session failed in the harness after it started. */
function failedCustomer(): ParticipantRunOutcome {
  return {
    spec: scheduledRoster().runs[1]!,
    killed: true,
    streamUrlPresent: false,
    screenshots: [],
    stateStepRecords: [],
    phaseRecords: [],
    warnings: [],
    noEngagement: false,
    selfReportedBlocker: false,
    reportedFriction: false,
    harnessError: true,
    sessionError: "the desktop stopped answering",
  };
}

describe("an ended participant in the in-progress bundle", () => {
  it("records its outcome while the others run or wait", () => {
    const bundle = inProgressBundle({ outcomes: [undefined, failedCustomer(), undefined] });
    expect(participants(bundle).map((participant) => participant.status)).toEqual([
      "running",
      "failed",
      "queued",
    ]);
    expect(bundle.simulations[1]!.summary).toContain("did not finish a session");
    expect(bundle.events.filter((event) => event.type === "cua-lab.session.error")).toEqual([
      expect.objectContaining({ simId: bundle.simulations[1]!.id }),
    ]);
    expect(runningEvents(bundle)).toEqual([{ simId: bundle.simulations[0]!.id, at: CREATED_AT }]);
    // Neither counts only the participants that ended so far.
    expect(bundle.review.participants).toBeUndefined();
    expect(bundle.cost).toBeUndefined();
  });

  it("is written when the route refreshes the flush, with its live items kept", async () => {
    const { runs } = scheduledRoster();
    const writes: RunBundle[] = [];
    const ended: (ParticipantRunOutcome | undefined)[] = [undefined, undefined, undefined];
    const flush = startLiveTraceFlush({
      bundle: inProgressBundle(),
      participantRuns: runs,
      model: "gpt-5.5",
      write: async (bundle) => {
        writes.push(bundle);
      },
      restate: (liveStarts) => inProgressBundle({ liveStarts, outcomes: [...ended] }),
    });
    flush.flush(runs[1]!.planned.id, [screenshot()]);
    ended[1] = failedCustomer();
    flush.refresh();
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await flush.stop();
    const written = writes.at(-1)!;
    expect(written.streams[1]!.status).toBe("failed");
    expect(written.streams[1]!.liveActor?.items).toHaveLength(1);
  });
});

describe("the subject an app-url participant opens", () => {
  const declared = (bundle: RunBundle) =>
    bundle.events.find((event) => event.type === "cua-lab.subject.declared")!.message;

  it("calls a loopback app loopback and a public app a page the participant opens", () => {
    expect(declared(inProgressBundle())).toContain("loopback inside");
    const publicApp = declared(inProgressBundle({ appUrl: "https://app.example.com/" }));
    expect(publicApp).toContain("https://app.example.com/");
    expect(publicApp).not.toContain("loopback");
  });
});
