import { describe, expect, it } from "vitest";

import { bundleDisplayFacts, reviewOutcome, runDisplay } from "../../src/run/display.js";

// runDisplay is the one rule every surface that says whether a run passed reads. These pin the
// states the failure goldens in tests/run/outcome-surfaces.test.ts do not reach.

const failure = { kind: "cap" as const, message: "Known spend $0.40 exceeds caps.maxUsd $0." };

describe("runDisplay", () => {
  it("shows a pass only for a pass verdict on a run whose ok is not false", () => {
    expect(runDisplay({ liveness: "finished", verdict: "pass", ok: true }).state).toBe("passed");
    // A run recorded before ok existed anywhere reads by its verdict.
    expect(runDisplay({ liveness: "finished", verdict: "pass" }).state).toBe("passed");
    expect(runDisplay({ liveness: "finished", verdict: "pass", ok: false, failure })).toEqual({
      state: "failed",
      label: "failed",
      tone: "fail",
      reason: "cap: Known spend $0.40 exceeds caps.maxUsd $0.",
    });
  });

  it("keeps a blocked or timed-out verdict, with the execution failure as the reason", () => {
    expect(runDisplay({ liveness: "finished", verdict: "blocked", ok: false, failure })).toEqual({
      state: "blocked",
      label: "blocked",
      tone: "warn",
      reason: "cap: Known spend $0.40 exceeds caps.maxUsd $0.",
    });
    expect(runDisplay({ liveness: "finished", verdict: "timed_out", ok: true }).label).toBe(
      "timed out",
    );
  });

  it("says a live, interrupted, verdictless, dry or unread run is that", () => {
    const states = [
      runDisplay({ liveness: "running", verdict: "contract_proof_only" }),
      runDisplay({ liveness: "interrupted", verdict: "pass", ok: true }),
      runDisplay({ liveness: "finished", verdict: "contract_proof_only", mode: "live" }),
      runDisplay({ liveness: "finished", verdict: "contract_proof_only", mode: "dry-run" }),
      runDisplay({ liveness: "finished" }),
    ].map((display) => [display.state, display.tone]);
    expect(states).toEqual([
      ["running", "live"],
      ["interrupted", "warn"],
      ["no_verdict", "warn"],
      ["dry_run", "neutral"],
      ["unknown", "neutral"],
    ]);
    // A dry run whose own ok is false failed.
    expect(
      runDisplay({
        liveness: "finished",
        verdict: "contract_proof_only",
        mode: "dry-run",
        ok: false,
      }).state,
    ).toBe("failed");
  });
});

describe("bundleDisplayFacts", () => {
  const bundle = {
    runId: "run-a",
    mode: "live",
    review: { verdict: "pass" },
    simulations: [{ status: "passed" }],
  };
  const record = (overrides: Record<string, unknown>) => ({
    schema: "humanish.run-status.v1",
    runId: "run-a",
    state: "finished",
    mode: "live",
    pid: 1,
    startedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:01:00.000Z",
    ...overrides,
  });

  it("reads run.json's outcome before anything in status.json", () => {
    const facts = bundleDisplayFacts(
      {
        ...bundle,
        outcome: {
          state: "finished",
          ok: false,
          execution: { succeeded: false, failures: [failure] },
        },
      },
      record({ outcome: { verdict: "pass", ok: true } }),
    );
    expect(runDisplay(facts).state).toBe("failed");
    expect(
      runDisplay(
        bundleDisplayFacts({
          ...bundle,
          outcome: {
            state: "interrupted",
            ok: false,
            signal: "SIGINT",
            at: "2026-10-01T00:00:30Z",
          },
        }),
      ).state,
    ).toBe("interrupted");
  });

  it("takes an older run's ok and liveness from its status record, and only the one naming it", () => {
    const failed = record({
      outcome: { verdict: "pass", ok: false, execution: { succeeded: false, failures: [failure] } },
    });
    expect(runDisplay(bundleDisplayFacts(bundle, failed)).state).toBe("failed");
    expect(runDisplay(bundleDisplayFacts(bundle, { ...failed, runId: "run-b" })).state).toBe(
      "passed",
    );
    expect(
      runDisplay(bundleDisplayFacts(bundle, record({ state: "interrupted", signal: "SIGTERM" })))
        .state,
    ).toBe("interrupted");
  });

  it("reads a bundle with no outcome and no record as live while a simulation runs", () => {
    const live = { ...bundle, simulations: [{ status: "running" }] };
    expect(runDisplay(bundleDisplayFacts(live)).state).toBe("running");
    expect(reviewOutcome(live)).toBe("running");
  });
});
