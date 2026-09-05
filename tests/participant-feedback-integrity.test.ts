import { describe, expect, it } from "vitest";

import { runComputerUseLoop, type CuaLoopOptions, type CuaLoopResult, type CuaTurn } from "../src/computer-use.js";
import { participantFeedbackCandidates, resolveSelfReportedBlocker, resolveSelfReportedFriction } from "../src/cua-actor-lab.js";
import { containsSensitive, defaultRedactionHooks } from "../src/redaction.js";

const REPORT = "The Save button did nothing. I used Enter and finished the task.";
const CLEAN = "REACHED THE GOAL. Saved the item; nothing was confusing and no defects were observed.";
const ENDINGS = ["participant", "stopWhen", "dwell"] as const;
type Ending = (typeof ENDINGS)[number];

// Internal provider/executor ports, not vendor API wire fixtures. The real loop decides when
// to stop, writes redacted trace messages, and feeds the same candidate builder as live lanes.
async function runSession(ending: Ending, options: {
  messages?: Array<string | undefined>;
  closing?: string;
  reasoning?: string;
  initialMatch?: boolean;
  conditionId?: string;
  scrubText?: CuaLoopOptions["scrubText"];
} = {}): Promise<CuaLoopResult> {
  const messages = options.messages ?? [REPORT];
  let turnIndex = 0;
  let actions = 0;
  let clockMs = 0;
  const matched = { any: [{ id: options.conditionId ?? "saved", textIncludes: "Saved successfully" }] };
  return runComputerUseLoop({
    instructions: "Save an item.",
    persona: { id: "synthetic-reviewer", traitsApplied: [], promptDigest: "fixture" },
    provider: {
      id: "internal-fixture",
      capabilities: {
        headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: false,
        byoModel: true, preGrantableApprovals: false, inProcessTools: false, license: "open"
      },
      async nextTurn(): Promise<CuaTurn> {
        if (turnIndex >= messages.length) {
          return { actions: [], pendingSafetyChecks: [], done: true, message: options.closing ?? CLEAN };
        }
        const message = messages[turnIndex++];
        return {
          actions: [{ kind: "keypress", keys: ["ENTER"] }], pendingSafetyChecks: [], done: false,
          ...(message === undefined ? {} : { message }),
          ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning })
        };
      }
    },
    executor: {
      async observe() {
        return {
          stateSignature: `state-${actions}`,
          // Deliberately defect-shaped app content. Observation text is never a participant report.
          text: options.initialMatch || actions >= messages.length
            ? "Saved successfully. The Save button did nothing."
            : "Editing. The Save button did nothing."
        };
      },
      async execute() { actions++; }
    },
    redaction: defaultRedactionHooks,
    timeoutMs: 10_000,
    now: () => clockMs,
    sleep: async (ms) => { clockMs += ms; },
    ...(options.scrubText === undefined ? {} : { scrubText: options.scrubText }),
    ...(ending === "stopWhen" ? { stopWhen: matched } : {}),
    ...(ending === "dwell" ? { dwell: { when: matched, ms: 1_000, everyMs: 500, then: "stop" as const } } : {})
  });
}

function candidates(session: CuaLoopResult) {
  return participantFeedbackCandidates({
    runId: "synthetic-feedback-integrity",
    scenarioId: "save-item",
    adapterId: "internal-fixture",
    goal: "Save an item.",
    substrate: "e2b-desktop",
    lanes: [{ laneId: "lane-1", streamId: "stream-1", personaId: "synthetic-reviewer", session,
      traceArtifactPath: "actors/stream-1.json", screenshots: [] }]
  });
}

describe("participant feedback survives completion mechanisms (#657)", () => {
  it.each(ENDINGS)("preserves the Save report when %s ends the actual loop", async (ending) => {
    const session = await runSession(ending, { closing: REPORT });
    expect(session.status).toBe("passed");
    expect(session.completionReason).toBe("goal_satisfied");
    expect(session.reason).toBe(ending === "participant" ? REPORT : ending === "stopWhen"
      ? "stopWhen matched saved (textIncludes)"
      : "dwell window complete (1000ms held after turn 1)");
    expect(session.trace.items.some((item) => item.kind === "message" && item.text === REPORT)).toBe(true);
    expect(resolveSelfReportedBlocker(session)).toBeUndefined();
    expect(resolveSelfReportedFriction(session)).toBe(REPORT);
    expect(candidates(session)).toMatchObject([{
      actual: REPORT,
      failure_owner: "target-app",
      evidence: [{ path: "actors/stream-1.json", kind: "trace" }]
    }]);
  });

  it.each(ENDINGS)("keeps earlier friction through later clean messages with %s completion", async (ending) => {
    const session = await runSession(ending, { messages: [REPORT, REPORT, CLEAN] });
    expect(resolveSelfReportedFriction(session)).toBe(REPORT);
    const findings = candidates(session);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.actual).toBe(REPORT);
    expect(resolveSelfReportedBlocker(session)).toBeUndefined();
  });

  it("keeps distinct participant reports in order within one candidate", async () => {
    const second = "The confirmation label was confusing.";
    const session = await runSession("stopWhen", { messages: [REPORT, second, REPORT, CLEAN] });
    const findings = candidates(session);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.actual).toBe(`${REPORT}\n\n${second}`);
  });

  it.each(ENDINGS)("ignores quoted copy, negations, reasoning, and app observations for %s", async (ending) => {
    const session = await runSession(ending, {
      messages: ['The banner reads "The Save button did nothing."', CLEAN],
      reasoning: "If the Save button did nothing, I could try Enter."
    });
    expect(session.trace.items.some((item) => item.kind === "reasoning")).toBe(true);
    expect(resolveSelfReportedFriction(session)).toBeUndefined();
    expect(candidates(session)).toHaveLength(0);
  });

  it.each(["stopWhen", "dwell"] as const)("does not turn a %s completion without participant messages into a finding", async (ending) => {
    for (const initialMatch of [false, true]) {
      const session = await runSession(ending, {
        messages: [undefined], initialMatch,
        // The controller's own reason contains a report word. It still is not participant text.
        conditionId: "confusing-complete"
      });
      expect(session.status).toBe("passed");
      expect(session.trace.items.filter((item) => item.kind === "message")).toHaveLength(0);
      expect(resolveSelfReportedFriction(session)).toBeUndefined();
      expect(candidates(session)).toHaveLength(0);
    }
  });

  it.each(ENDINGS)("uses only scrubbed and redacted report text with %s completion", async (ending) => {
    const knownValue = "synthetic-provisioned-value";
    const shapedToken = `sk-${"x".repeat(24)}`;
    const session = await runSession(ending, {
      messages: [`${REPORT} Screen values: ${knownValue} ${shapedToken}`],
      scrubText: (text) => text.replaceAll(knownValue, "[SCRUBBED]")
    });
    const findings = candidates(session);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.actual).toBe(`${REPORT} Screen values: [SCRUBBED] [REDACTED_SECRET]`);
    expect(JSON.stringify(session.trace)).not.toContain(knownValue);
    expect(containsSensitive(JSON.stringify(findings))).toBe(false);
  });
});
