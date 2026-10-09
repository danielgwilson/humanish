import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { formatCuaStudyHuman } from "../../src/cli/commands/study-format.js";
import { createProgram } from "../../src/cli/program.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import type { ActorCompletionReason, ActorStatus } from "../../src/actors/contract.js";
import type { CuaActorStudyResult } from "../../src/routes/computer-use/types.js";
import fanout from "../golden/routes/computer-use-fanout-live.json" with { type: "json" };

// What `watch` and `run` print for a computer-use run, built from the recorded four-participant
// fan-out result.
const recorded = fanout["<result>"] as unknown as CuaActorStudyResult;
const subject = { source: "app-url", appUrl: "http://127.0.0.1:3000/" } as const;
const SCREENSHOTS_WARNING = recorded.warnings[0]!;
const BLOCKED_REASON = "I could not find the save button.\n\nI tried the menu twice.";

/** How every ten participants end: six pass, then one each blocked, abandoned, incomplete, failed. */
const ENDINGS: { status: ActorStatus; completionReason: ActorCompletionReason }[] = [
  ...Array.from({ length: 6 }, () => ({
    status: "passed" as const,
    completionReason: "goal_satisfied" as const,
  })),
  { status: "blocked", completionReason: "blocked_approval" },
  { status: "abandoned", completionReason: "gave_up" },
  { status: "incomplete", completionReason: "budget_reached" },
  { status: "failed", completionReason: "harness_error" },
];

/** A run of `count` participants with the recorded first participant's fields and the endings above. */
function runOf(count: number): CuaActorStudyResult {
  const template = recorded.lanes![0]!;
  return {
    ...recorded,
    lanes: Array.from({ length: count }, (_, n) => {
      const ending = ENDINGS[n % ENDINGS.length]!;
      return {
        ...template,
        id: `lane-${String(n + 1).padStart(2, "0")}`,
        index: n + 1,
        status: ending.status,
        ok: ending.status === "passed",
        session: {
          ...template.session!,
          ...ending,
          reason: ending.status === "passed" ? "Done." : BLOCKED_REASON,
        },
      };
    }),
    // The route adds the screenshots warning once per participant.
    warnings: [
      ...Array.from({ length: count }, () => SCREENSHOTS_WARNING),
      ...recorded.warnings.slice(4, 6),
    ],
  };
}

function stdout(result: CuaActorStudyResult): string[] {
  const output = formatCuaStudyHuman(result, subject);
  return (typeof output === "string" ? output : (output.stdout ?? "")).trimEnd().split("\n");
}

const participantLines = (lines: string[]) =>
  lines.filter((line) => line.startsWith("participant") || line.startsWith("not listed"));

describe("the participants a computer-use run prints", () => {
  it("lists each participant of a run of up to 16 on its own line", () => {
    expect(participantLines(stdout(recorded))).toEqual([
      "participant mobile-newcomer: passed (goal_satisfied) · participant outcome · Done.",
      "participant small-skimmer: passed (goal_satisfied) · participant outcome · Done.",
      "participant desktop-power: passed (goal_satisfied) · participant outcome · Done.",
      "participant wide-researcher: passed (goal_satisfied) · participant outcome · Done.",
    ]);
  });

  it("puts a participant's closing message on one line of at most 160 characters", () => {
    const run = runOf(10);
    run.lanes![7]!.session!.reason = `${"The settings page kept moving. ".repeat(6)}\nI stopped.`;
    const lines = participantLines(stdout(run));
    expect(lines[6]).toBe(
      "participant lane-07: blocked (blocked_approval) · participant outcome · I could not find the save button. I tried the menu twice.",
    );
    expect(lines[7]).toBe(
      "participant lane-08: abandoned (gave_up) · participant outcome · The settings page kept moving. The settings page kept moving. The settings page kept moving. The settings page kept moving. The settings page kept moving. The…",
    );
  });

  it("counts a run of 40 by status and lists the 16 that did not pass", () => {
    const lines = participantLines(stdout(runOf(40)));
    expect(lines[0]).toBe(
      "participants: 40 · 24 passed · 4 blocked · 4 abandoned · 4 incomplete · 4 failed",
    );
    expect(lines.slice(1, -1).map((line) => line.split(":")[0])).toEqual(
      [
        "07",
        "08",
        "09",
        "10",
        "17",
        "18",
        "19",
        "20",
        "27",
        "28",
        "29",
        "30",
        "37",
        "38",
        "39",
        "40",
      ].map((n) => `participant lane-${n}`),
    );
    expect(lines.at(-1)).toBe("not listed: 24 participants. The Observer shows each one.");
  });

  it("prints a run of 100 in as many lines as a run of 40", () => {
    const lines = stdout(runOf(100));
    const listed = participantLines(lines);
    expect(listed[0]).toBe(
      "participants: 100 · 60 passed · 10 blocked · 10 abandoned · 10 incomplete · 10 failed",
    );
    expect(listed).toHaveLength(18);
    expect(listed.at(-1)).toBe(
      "not listed: 84 participants (24 did not pass). The Observer shows each one.",
    );
    expect(lines).toHaveLength(31);
    expect(stdout(runOf(40))).toHaveLength(31);
  });

  it("prints a warning the route repeats for every participant once", () => {
    const warnings = stdout(runOf(100)).filter((line) => line.startsWith("warning: "));
    expect(warnings).toEqual([
      `warning: ${SCREENSHOTS_WARNING}`,
      "warning: Observer renders verified local evidence artifacts; runtime stream auth URLs are not persisted.",
      "warning: Before filing public feedback, use `humanish feedback issue` so redaction and public-safety checks gate the payload.",
    ]);
  });

  it("is what `watch` prints for a dry run of 40 participants", async () => {
    const cwd = await makeTestTempDir("humanish-watch-40-");
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", "forty.yaml"),
      [
        "schema: humanish.study.v3",
        "id: forty",
        "title: Forty participants",
        "route: computer-use",
        "subject:",
        "  source: app-url",
        "  appUrl: http://127.0.0.1:3000/",
        "actor:",
        "  type: openai-computer-use",
        "  mission: Explore the app and stop when done.",
        "participants: 40",
        "execution:",
        "  target: e2b-desktop",
        "",
      ].join("\n"),
    );
    const out: string[] = [];
    const program = createProgram({
      writeOut: (text) => out.push(text),
      writeErr: () => {},
      setExitCode: () => {},
    });
    program.exitOverride();
    await program.parseAsync(
      ["node", "humanish", "watch", "forty", "--dry-run", "--no-open", "--cwd", cwd],
      {
        from: "node",
      },
    );
    expect(participantLines(out.join("").split("\n"))).toEqual([
      "participants: 40 · 40 dry run, nothing ran live",
      "not listed: 40 participants. The Observer shows each one.",
    ]);
  });
});
