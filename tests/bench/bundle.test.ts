import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { participantsOf, readRunBundle } from "../../bench/lib/bundle.js";
import { scoreReport } from "../../bench/lib/score.js";
import { MISSIONS } from "../../bench/taskly/missions.js";

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

/**
 * A run bundle v4 as `pnpm bench` saved it on 2026-10-25: run.json keeps the actor without its
 * items and indexes actor.json, which holds them. The item titles are copied from that run.
 */
function writeV4Run(runId: string): string {
  const project = mkdtempSync(path.join(os.tmpdir(), "humanish-bench-bundle-"));
  projects.push(project);
  const runDir = path.join(project, ".humanish", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const items = [
    { id: "ui_action-004", kind: "ui_action", lifecycle: "completed", title: "click (612, 300)" },
    { id: "ui_action-005", kind: "ui_action", lifecycle: "completed", title: "type [24 chars]" },
    { id: "ui_action-012", kind: "ui_action", lifecycle: "completed", title: "type [32 chars]" },
    { id: "ui_action-013", kind: "ui_action", lifecycle: "completed", title: "keypress ENTER" },
    { id: "message-020", kind: "message", text: "I will try Clear completed next." },
  ];
  const actor = {
    schema: "humanish.actor-trace.v1",
    status: "passed",
    reason: "Adding tasks was easy.",
    persona: { id: "synthetic-new-user", traitsApplied: [] },
  };
  writeFileSync(
    path.join(runDir, "actor.json"),
    JSON.stringify({ ...actor, items, artifacts: [] }),
  );
  writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({
      schema: "humanish.run-bundle.v4",
      runId,
      streams: [
        {
          id: "stream-001",
          actor,
          artifacts: [],
          trace: { path: "actor.json", items: items.length, screenshots: 0 },
        },
      ],
    }),
  );
  return project;
}

it("reads a v4 bundle's typing and narration from the trace file run.json indexes", () => {
  const runId = "cua-2026-10-25T22-26-37-054Z-08f30fa6";
  const project = writeV4Run(runId);
  const [participant] = participantsOf(
    readRunBundle(project, runId),
    MISSIONS.neutral.text,
    "local",
  );
  expect(participant?.facts.maxTypedChars).toBe(32);
  expect(participant?.narration).toEqual(["I will try Clear completed next."]);
  const score = scoreReport(participant!, "planted");
  expect(score.engaged.D2).toBe(true);
  expect(score.engaged.D1).toBe(true);
});
