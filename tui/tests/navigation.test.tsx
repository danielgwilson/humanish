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
      readLaunchLog: async () => ""
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
  let frame = "";
  for (let index = 0; index < limit; index += 1) {
    frame = await surface.press(key);
    if (predicate(frame)) return frame;
  }
  throw new Error(`pressUntil: never reached the wanted row after ${limit} presses. Last frame:\n${frame}`);
}

async function openSurface(columns = 80) {
  return renderToText(<App options={options()} now={NOW} />, {
    columns,
    until: (frame) => frame.trim().length > 0 && !frame.includes("reading project")
  });
}

describe("moving through the surface", () => {
  it("Enter opens the selected lab, and its runs are that lab's runs only", async () => {
    const surface = await openSurface();
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("Signup flow") && frame.includes("cua-"));
    surface.unmount();

    // The first lab is selected by default and is the live one, so Enter lands on Signup flow.
    expect(lab).toContain("Signup flow");
    // Both of signup-flow's runs, and neither of diagram-editor's.
    expect(lab).toContain("aa11bb22");
    expect(lab).toContain("cc33dd44");
    expect(lab).not.toContain("ee55ff66");
  });

  it("Escape returns to the labs list, with the selection where it was left", async () => {
    const surface = await openSurface();
    await surface.press(KEY.down, (frame) => frame.includes("› diagram-editor"));
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("no manifest") || frame.includes("ee55ff66"));
    expect(lab).toContain("ee55ff66");

    const back = await surface.press(KEY.escape, (frame) => frame.includes("never-run-lab"));
    surface.unmount();
    // Back where we were, still on the second row rather than reset to the top — a list that
    // forgets its position makes every "just check that one" cost the scroll again.
    expect(back).toContain("› diagram-editor");
  });

  it("renders the lab screen", async () => {
    const surface = await openSurface();
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("Signup flow") && frame.includes("cua-"));
    surface.unmount();
    await expectGolden("lab-80", normalizeFrame(lab));
  });

  it("renders the lab screen on a phone-width terminal", async () => {
    const surface = await openSurface(45);
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("cua-"));
    surface.unmount();
    await expectGolden("lab-45", normalizeFrame(lab));
  });

  it("renders one run on a phone-width terminal, wrapping rather than overflowing", async () => {
    const surface = await openSurface(45);
    await surface.press(KEY.enter, (frame) => frame.includes("cua-"));
    // The FINISHED run, deliberately: it is the one carrying a participants line long enough to
    // run off a phone-width screen.
    await pressUntil(surface, KEY.down, (frame) => /\u203a[^\n]*cc33dd44/.test(frame));
    const run = await surface.press(KEY.enter, (frame) => frame.includes("participants"));
    surface.unmount();
    const frame = normalizeFrame(run);
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(45);
    }
    await expectGolden("run-45", normalizeFrame(run));
  });

  it("renders one run, in place, with only the facts that were recorded", async () => {
    const surface = await openSurface();
    await surface.press(KEY.enter, (frame) => frame.includes("cua-"));
    await pressUntil(surface, KEY.down, (frame) => /›[^\n]*cc33dd44/.test(frame));
    const run = await surface.press(KEY.enter, (frame) => frame.includes("participants"));
    surface.unmount();
    await expectGolden("run-80", normalizeFrame(run));
  });

  it("warns that two manifests share one id, because the runs below cannot be told apart", async () => {
    const surface = await openSurface();
    await surface.press(KEY.down, (frame) => /\u203a[^\n]*diagram-editor/.test(frame));
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("manifests declare"));
    surface.unmount();

    expect(lab).toContain("2 manifests declare id");
    expect(lab).toContain("the runs below are shared between them");
  });

  it("a run with no recorded cost says so rather than showing $0.00", async () => {
    const surface = await openSurface();
    await surface.press(KEY.down, (frame) => frame.includes("› diagram-editor"));
    await surface.press(KEY.enter, (frame) => frame.includes("ee55ff66"));
    await pressUntil(surface, KEY.down, (frame) => /›[^\n]*ee55ff66/.test(frame));
    const run = await surface.press(KEY.enter, (frame) => frame.includes("cost"));
    surface.unmount();

    // `null` is a DECLARED absent cost. Rendering it as $0.00 would claim the run was free.
    expect(run).toContain("not recorded");
    expect(run).not.toContain("$0.00");
    expect(run).toContain("fail");
  });

  it("an interrupted run explains itself instead of looking like a bug", async () => {
    const surface = await openSurface();
    await surface.press(KEY.down, (frame) => frame.includes("› diagram-editor"));
    await surface.press(KEY.enter, (frame) => frame.includes("99887766"));
    await pressUntil(surface, KEY.down, (frame) => /›[^\n]*99887766/.test(frame));
    const run = await surface.press(KEY.enter, (frame) => frame.includes("interrupted"));
    surface.unmount();

    expect(run).toContain("interrupted");
    expect(run).toContain("the process ended before it finished writing");
    // And it names where the listing's facts came from, so a surprising row can be traced.
    expect(run).toContain("the run directory alone");
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
