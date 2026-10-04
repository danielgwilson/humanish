import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { glyphColor, verdictGlyph } from "../src/frame.js";
import { PALETTE } from "../src/palette.js";
import { readRunIndex, type RunIndexEntry } from "../../src/run/run-index.js";
import {
  outcomeCases,
  outcomeRoot,
  writeOutcomeCase,
} from "../../tests/helpers/outcome-fixtures.js";

// The TUI's run glyph on the table every outcome surface is checked on
// (tests/run/outcome-surfaces.test.ts), read through the real run index. A check mark is a pass;
// every other finished run carries a flag, red for a failure and amber for a blocked, timed-out
// or interrupted run.

const PASS_GLYPHS = new Set(["✓", "+"]);

let root: string;
const cases = await outcomeCases();
const entries = new Map<string, RunIndexEntry>();

beforeAll(async () => {
  root = await outcomeRoot();
  for (const outcome of cases) {
    const { cwd } = await writeOutcomeCase(root, outcome);
    const [entry] = (await readRunIndex(cwd)).runs;
    if (entry === undefined) throw new Error(`no run index entry for ${outcome.name}`);
    entries.set(outcome.name, entry);
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.each(cases.map((outcome) => [outcome.name, outcome] as const))("%s", (_name, outcome) => {
  it("shows a check mark only for a run that passed", () => {
    const glyph = verdictGlyph(entries.get(outcome.name)!);
    expect(PASS_GLYPHS.has(glyph)).toBe(outcome.expected === "passed");
  });

  it("colors the glyph by how the run ended", () => {
    const expected =
      outcome.expected === "passed"
        ? undefined
        : outcome.expected === "failed"
          ? PALETTE.bad
          : PALETTE.warn;
    expect(glyphColor(entries.get(outcome.name)!).color).toBe(expected);
  });
});
