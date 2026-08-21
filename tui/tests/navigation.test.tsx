import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import React from "react";
import { describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import type { TuiOptions } from "../../src/tui-contract.js";
import { KEY, normalizeFrame, renderToText } from "../src/testing/render-to-text.js";
import { initialNav, navigate, currentScreen, selectedIndex } from "../src/navigation.js";
import { LABS, NOW, RUNS } from "./fixtures.js";

// Driving the surface the way a person does: arrow keys and Enter, through Ink's real input
// handling. Asserting on the reducer alone would prove the model and none of the wiring — and the
// wiring is where "Enter opened the wrong run" lives.

const GOLDEN_DIR = path.join(import.meta.dirname, "golden");

async function expectGolden(name: string, actual: string): Promise<void> {
  const file = path.join(GOLDEN_DIR, `${name}.txt`);
  if (process.env.UPDATE_TUI_GOLDENS === "1") {
    await writeFile(file, `${actual}\n`, "utf8");
    return;
  }
  const expected = await readFile(file, "utf8").catch(() => {
    throw new Error(`missing golden ${file}. Create it with UPDATE_TUI_GOLDENS=1 and read the diff.`);
  });
  expect(actual).toBe(expected.replace(/\n$/, ""));
}

const options = (): TuiOptions =>
  ({
    cwd: "/projects/acme-app",
    version: { cli: "9.9.9" },
    capabilities: {
      readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs: RUNS, unreadable: [] }),
      listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: LABS, warnings: [] }),
      startRun: async () => ({ ok: true, run: { pid: 4242, logPath: "/tmp/x.log", command: [] } }),
      readLaunchLog: async () => "",
      readRunDetail: async () => null,
      readLabSummary: async () => null,
      readProjectState: () => ({ schema: "humanish.tui-project.v1" as const, initialized: true, hasRuntime: true }),
      openObserver: async () => ({ schema: "humanish.tui-action.v1" as const, ok: true, message: "opened" }),
      reclaimRun: async () => ({ schema: "humanish.reclaim-result.v1" as const, ok: true, cwd: "/x", runId: "r", receiptCount: 0, outcomes: [], warnings: [] }),
      stopRun: async () => ({ schema: "humanish.tui-action.v1" as const, ok: true, message: "asked the run to stop" })
    },
    stdin: process.stdin,
    stdout: process.stdout
  });

/**
 * Press a key until the screen shows what the test is after.
 *
 * Tests navigate by INTENT, not by counting keystrokes: encoding "Down twice" bakes the current row
 * layout into every test, so adding a row to a screen breaks tests that have nothing to do with it.
 */
async function pressUntil(
  surface: Awaited<ReturnType<typeof openSurface>>,
  key: string,
  predicate: (frame: string) => boolean,
  limit = 8
): Promise<string> {
  // Waits for the frame the predicate wants BEFORE deciding to press again. Pressing and then
  // testing whatever frame came back overshoots, because Ink's first frame after a key can predate
  // the state change the key caused.
  let last = "";
  for (let index = 0; index < limit; index += 1) {
    try {
      return await surface.press(key, predicate, 400);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`pressUntil: never reached the wanted row after ${limit} presses. Last: ${last.slice(0, 400)}`);
}

async function openSurface(columns = 80) {
  return renderToText(<App options={options()} now={NOW} tick={0} />, {
    columns,
    until: (frame) => frame.trim().length > 0 && !frame.includes("reading project")
  });
}

describe("moving through the surface", () => {
  it("Enter opens the selected lab, and its runs are that lab's runs only", async () => {
    const surface = await openSurface();
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("❯ Start a dry run"));
    surface.unmount();

    // The first lab is selected by default and is the live one, so Enter lands on Signup flow.
    expect(lab).toContain("‹ labs / signup-flow");
    // Both of signup-flow's runs, and neither of diagram-editor's. Rows are identified by when they
    // ran and what happened, not by their id — the id is on the run screen, one level in.
    expect(lab).toContain("2/2 reached the goal");
    expect(lab).toContain("~$1.20");
    expect(lab).not.toContain("0/1 reached the goal");
  });

  it("Escape returns to the labs list, with the selection where it was left", async () => {
    const surface = await openSurface();
    await surface.press(KEY.down, (frame) => /❯[^\n]*diagram-editor/.test(frame));
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("❯ Start a dry run") || frame.includes("no manifest"));
    expect(lab).toContain("0/1 reached the goal");

    const back = await surface.press(KEY.escape, (frame) => frame.includes("never-run-lab"));
    surface.unmount();
    // Back where we were, still on the second row rather than reset to the top — a list that
    // forgets its position makes every "just check that one" cost the scroll again.
    expect(back).toMatch(/❯[^\n]*diagram-editor/);
  });

  it("renders the lab screen", async () => {
    const surface = await openSurface();
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("❯ Start a dry run"));
    surface.unmount();
    await expectGolden("lab-80", normalizeFrame(lab));
  });

  it("renders the lab screen on a phone-width terminal", async () => {
    const surface = await openSurface(45);
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("❯ Start a dry run"));
    surface.unmount();
    await expectGolden("lab-45", normalizeFrame(lab));
  });

  it("renders one run on a phone-width terminal, wrapping rather than overflowing", async () => {
    const surface = await openSurface(45);
    await surface.press(KEY.enter, (frame) => frame.includes("❯ Start a dry run"));
    // The FINISHED run, deliberately: it is the one carrying a participants line long enough to
    // run off a phone-width screen.
    await pressUntil(surface, KEY.down, (frame) => /❯[^\n]*2\/2 reached the goal/.test(frame));
    const run = await surface.press(KEY.enter, (frame) => frame.includes("reached the goal"));
    surface.unmount();
    const frame = normalizeFrame(run);
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(45);
    }
    await expectGolden("run-45", normalizeFrame(run));
  });

  it("renders one run, in place, with only the facts that were recorded", async () => {
    const surface = await openSurface();
    await surface.press(KEY.enter, (frame) => frame.includes("❯ Start a dry run"));
    await pressUntil(surface, KEY.down, (frame) => /❯[^\n]*2\/2 reached the goal/.test(frame));
    const run = await surface.press(KEY.enter, (frame) => frame.includes("reached the goal"));
    surface.unmount();
    await expectGolden("run-80", normalizeFrame(run));
  });

  it("warns that two manifests share one id, because the runs below cannot be told apart", async () => {
    const surface = await openSurface();
    await surface.press(KEY.down, (frame) => /❯[^\n]*diagram-editor/.test(frame));
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("manifests declare"));
    surface.unmount();

    expect(lab).toContain("2 manifests declare");
    expect(lab).toContain("these runs are shared between them");
  });

  it("a run with no recorded cost says so rather than showing $0.00", async () => {
    const surface = await openSurface();
    await surface.press(KEY.down, (frame) => /❯[^\n]*diagram-editor/.test(frame));
    await surface.press(KEY.enter, (frame) => frame.includes("❯ Start a dry run"));
    await pressUntil(surface, KEY.down, (frame) => /❯[^\n]*0\/1 reached the goal/.test(frame));
    const run = await surface.press(KEY.enter, (frame) => frame.includes("cost declared absent") || frame.includes("Run again"));
    surface.unmount();

    // `null` is a DECLARED absent cost. Rendering it as $0.00 would claim the run was free.
    expect(run).toContain("cost declared absent");
    expect(run).not.toContain("$0.00");
    // The card leads with the DENOMINATOR, not the label: "fail" says a run failed without saying
    // at what, and the count is the finding.
    expect(run).toContain("0/1 reached the goal");
  });

  it("an interrupted run explains itself instead of looking like a bug", async () => {
    const surface = await openSurface();
    await surface.press(KEY.down, (frame) => /❯[^\n]*diagram-editor/.test(frame));
    await surface.press(KEY.enter, (frame) => frame.includes("❯ Start a dry run"));
    await pressUntil(surface, KEY.down, (frame) => /❯[^\n]*no verdict/.test(frame));
    const run = await surface.press(KEY.enter, (frame) => frame.includes("interrupted"));
    surface.unmount();

    // The interrupted card sits at the same level as a finished one: what it managed, what it
    // spent, and whether anything is still running — which is the part that keeps costing money.
    expect(run).toContain("interrupted — no outcome recorded");
    expect(run).toContain("sandboxes");
    expect(run).toContain("Reclaim");
  });
});

describe("the navigation model itself", () => {
  it("Escape at the top level means leave, not nothing", async () => {
    // One key always means "out of here" — which is what a person reaches for when a surface has
    // taken their screen.
    const state = navigate(initialNav(), { type: "back" });
    expect(state.quit).toBe(true);
  });

  it("selection clamps at the ends instead of wrapping", () => {
    let state = initialNav();
    state = navigate(state, { type: "move", delta: -1, total: 3 });
    expect(selectedIndex(state)).toBe(0);
    for (let index = 0; index < 10; index += 1) {
      state = navigate(state, { type: "move", delta: 1, total: 3 });
    }
    // Holding Down past the end must not teleport to the top: in a list of runs that is how
    // someone opens the wrong one.
    expect(selectedIndex(state)).toBe(2);
  });

  it("remembers a selection per screen, so going back restores where you were", () => {
    let state = initialNav();
    state = navigate(state, { type: "move", delta: 1, total: 5 });
    state = navigate(state, { type: "enter", screen: { name: "lab", labId: "alpha" } });
    state = navigate(state, { type: "move", delta: 2, total: 5 });
    expect(selectedIndex(state)).toBe(2);
    state = navigate(state, { type: "back" });
    expect(currentScreen(state).name).toBe("labs");
    expect(selectedIndex(state)).toBe(1);
  });
});
