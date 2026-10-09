import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readRunIndex } from "../../src/run/run-index.js";
import { listStudyManifests } from "../../src/study/discover.js";
import { readStudySummary } from "../../src/study/summary.js";
import type { TuiOptions } from "../../src/tui/contract.js";
import { readProjectState } from "../../src/tui/project.js";
import { STARTER_VARIANTS, writeStarterProject } from "../../tests/helpers/study-corpus.js";
import { App } from "../src/app.js";
import { KEY, normalizeFrame, renderToText } from "../src/testing/render-to-text.js";

// The study screen's analysis line is the line `humanish run` and `study check` print, read
// through the host's own readStudySummary on the project `humanish init` writes.

let root: string;
let cwd: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "humanish-tui-analysis-line-"));
  cwd = path.join(root, "project");
  await writeStarterProject(cwd, STARTER_VARIANTS[0]!.files);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const options = (): TuiOptions => ({
  cwd,
  version: { cli: "9.9.9" },
  capabilities: {
    readRunIndex: async () => readRunIndex(cwd),
    listStudies: listStudyManifests,
    // As `study check` reads it: no key probe, so the result does not depend on this machine.
    readStudySummary: (target, study) => readStudySummary(target, study),
    readProjectState,
    readRunDetail: async () => null,
    readLaunchLog: async () => "",
    startRun: async () => ({ ok: true, run: { pid: 4242, logPath: "/tmp/x.log", command: [] } }),
    openObserver: async () => ({
      schema: "humanish.tui-action.v1" as const,
      ok: true,
      message: "opened",
    }),
    reclaimRun: async () => ({
      schema: "humanish.reclaim-result.v1" as const,
      ok: true,
      state: "clean" as const,
      mode: "kill" as const,
      tagSearch: { status: "done" as const, found: 0 },
      createsInFlight: 0,
      cwd,
      runId: "r",
      receiptCount: 0,
      outcomes: [],
      warnings: [],
    }),
    stopRun: async () => ({
      schema: "humanish.tui-action.v1" as const,
      ok: true,
      message: "asked the run to stop",
    }),
  },
  stdin: process.stdin,
  stdout: process.stdout,
});

describe("the study screen's analysis line", () => {
  it("expects no more than admission admits under the default $3 cap", async () => {
    const surface = await renderToText(<App options={options()} now={0} tick={0} />, {
      // The starter's cua-browser study, first on the list.
      until: (frame) => /❯ +Computer-use browser study/.test(frame),
    });
    try {
      const study = await surface.press(KEY.enter, (candidate) =>
        candidate.includes("After live runs"),
      );
      const text = normalizeFrame(study).replace(/\s+/g, " ");
      // One participant, gpt-6-astra at $12.50 per million input tokens (the cache-write rate) and
      // $50 per million output tokens. With no evidence: 6,208 tokens of instructions and schema
      // plus 2,048 of framing, and 13,000 expected output tokens, so $0.1032 + $0.65 = $0.7532.
      // Past the 32,768-token allowance's limit, dispatch takes the 16,384-token one, whose worst
      // case is the expected cost plus 3,384 more output tokens, $0.1692. Admission admits it while
      // that worst case is at most $3, so up to an expected $2.8308.
      expect(text).toContain(
        "expected $0.75 to $2.83 for 1 participant, depending on how much evidence the run keeps · refused before it starts if both its worst case and its expected cost plus a 10% margin are over $3; this is not a billing cap.",
      );
    } finally {
      surface.unmount();
    }
  });
});
