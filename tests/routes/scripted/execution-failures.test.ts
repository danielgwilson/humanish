import { describe, expect, it } from "vitest";

import { scriptedExecutionFailures } from "../../../src/routes/scripted/result.js";

// A scripted surface that failed a step or timed out is captured evidence; these are the facts that
// fail the run as an execution instead.
describe("scriptedExecutionFailures", () => {
  const observer = { ok: true as const };
  const passed = { completionReason: "goal_satisfied" as const, reason: "satisfied" };
  const base = {
    dryRun: false,
    runId: "scripted-run",
    sessionError: undefined,
    expected: 2,
    subject: undefined,
    observer,
  };

  it("records nothing when every surface returned and the Observer rendered", () => {
    expect(scriptedExecutionFailures({ ...base, sessionResults: [passed, passed] })).toEqual([]);
    expect(
      scriptedExecutionFailures({
        ...base,
        sessionResults: [passed, { ...passed, completionReason: "step_failed" }],
      }),
    ).toEqual([]);
  });

  it("records a live surface that never returned", () => {
    expect(scriptedExecutionFailures({ ...base, sessionResults: [passed] })).toEqual([
      {
        kind: "harness",
        message: "Scripted lab did not produce terminal sessions for every surface.",
      },
    ]);
    // A dry run returns no surfaces by design.
    expect(scriptedExecutionFailures({ ...base, dryRun: true, sessionResults: [] })).toEqual([]);
  });

  it("records a subject sandbox whose release is unconfirmed, and nothing for a released one", () => {
    const subject = {
      sandboxId: "sb-subject",
      killed: false,
      releaseWarning: "Subject sandbox teardown failed.",
    };
    expect(
      scriptedExecutionFailures({ ...base, sessionResults: [passed, passed], subject }),
    ).toEqual([
      {
        kind: "sandbox-cleanup",
        message:
          "subject: Subject sandbox teardown failed. Reclaim it by recorded id with `humanish reclaim --run scripted-run`.",
      },
    ]);
    expect(
      scriptedExecutionFailures({
        ...base,
        sessionResults: [passed, passed],
        subject: { ...subject, killed: true },
      }),
    ).toEqual([]);
  });

  it("records the session's error, an empty message included, without also counting the missing surfaces", () => {
    expect(scriptedExecutionFailures({ ...base, sessionError: "", sessionResults: [] })).toEqual([
      { kind: "harness", message: "" },
    ]);
  });

  it("records a surface's harness error and an Observer that failed", () => {
    expect(
      scriptedExecutionFailures({
        ...base,
        sessionResults: [passed, { completionReason: "harness_error", reason: "browser missing" }],
        observer: {
          ok: false,
          error: {
            code: "HUMANISH_INVALID_RUN_BUNDLE",
            message: "Run bundle failed verification.",
          },
        },
      }),
    ).toEqual([
      { kind: "harness", message: "Scripted session ended with a harness error: browser missing" },
      { kind: "evidence", message: "Run bundle failed verification." },
    ]);
  });
});
