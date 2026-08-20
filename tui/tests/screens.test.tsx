import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import React from "react";
import { describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import type { TuiCapabilities, TuiOptions } from "../../src/tui-contract.js";
import { KEY, normalizeFrame, renderToText } from "../src/testing/render-to-text.js";
import { LABS, NOW, RUNS } from "./fixtures.js";

// Text goldens at two widths (#455).
//
// 80 is a desktop terminal; 45 is a phone in landscape, which is a width Daniel actually uses. Every
// layout bug this surface can have — a status column that collides with a name, a path that wraps to
// two lines, a run id that eats the whole row — is invisible until something measures characters at
// a fixed width, so these render through real yoga layout rather than asserting on props.
//
// Regenerate deliberately with UPDATE_TUI_GOLDENS=1; a golden that changes by accident is the
// failure this is for.

const GOLDEN_DIR = path.join(import.meta.dirname, "golden");

async function expectGolden(name: string, actual: string): Promise<void> {
  const file = path.join(GOLDEN_DIR, `${name}.txt`);
  if (process.env.UPDATE_TUI_GOLDENS === "1") {
    await writeFile(file, `${actual}\n`, "utf8");
    return;
  }
  const expected = await readFile(file, "utf8").catch(() => {
    throw new Error(`missing golden ${file}. Create it with UPDATE_TUI_GOLDENS=1 and read the diff before committing.`);
  });
  expect(actual).toBe(expected.replace(/\n$/, ""));
}

/**
 * A COMPLETE set of capabilities, merged with whatever a test wants to change. No cast: the
 * compiler is the thing that catches a capability nobody remembered to fake, and a cast here would
 * turn that into an unhandled rejection mid-render instead.
 */
function options(overrides: Partial<TuiCapabilities> = {}): TuiOptions {
  const capabilities: TuiCapabilities = {
    readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs: RUNS, unreadable: [] }),
    listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: LABS, warnings: [] }),
    startRun: async () => ({ ok: true, run: { pid: 4242, logPath: "/tmp/x.log", command: [] } }),
    readLaunchLog: async () => "",
    readRunDetail: async () => null,
      readLabSummary: async () => null,
      readProjectState: () => ({ schema: "humanish.tui-project.v1" as const, initialized: true, hasRuntime: true }),
      openObserver: async () => ({ schema: "humanish.tui-action.v1" as const, ok: true, message: "opened" }),
      reclaimRun: async () => ({ schema: "humanish.reclaim-result.v1" as const, ok: true, cwd: "/x", runId: "r", receiptCount: 0, outcomes: [], warnings: [] }),
      stopRun: async () => ({ schema: "humanish.tui-action.v1" as const, ok: true, message: "asked the run to stop" }),
    ...overrides
  };
  return {
    cwd: "/projects/acme-app",
    version: { cli: "9.9.9" },
    capabilities,
    stdin: process.stdin,
    stdout: process.stdout
  };
}

async function frameAt(
  columns: number,
  rows = 24,
  overrides: Partial<TuiCapabilities> = {},
  until?: (frame: string) => boolean
): Promise<string> {
  const rendered = await renderToText(<App options={options(overrides)} now={NOW} tick={0} />, {
    columns,
    rows,
    // Wait for the DATA-BEARING frame, never a fixed sleep: the first frame says "reading project…"
    // and a timer captures whichever one the scheduler happened to reach. Defined by what the frame
    // is NOT, so it cannot silently stop matching when the copy on the screen changes.
    // Live participant names arrive from a SECOND async read, so a caller that asserts on them has
    // to wait for that frame rather than the first data-bearing one.
    until: until ?? ((frame) => frame.trim().length > 0 && !frame.includes("reading project"))
  });
  rendered.unmount();
  return normalizeFrame(rendered.last);
}

describe("the labs screen, rendered", () => {
  it("at 80 columns", async () => {
    await expectGolden("labs-80", await frameAt(80));
  });

  it("at 45 columns — a phone in landscape", async () => {
    await expectGolden("labs-45", await frameAt(45));
  });

  it("puts a live lab first, and never invents numbers for a lab that has not run", async () => {
    const frame = await frameAt(80);
    const lines = frame.split("\n").filter((line) => line.trim().length > 0);
    const live = lines.findIndex((line) => line.includes("Signup flow"));
    const never = lines.findIndex((line) => line.includes("never-run-lab"));
    expect(live).toBeGreaterThan(-1);
    expect(never).toBeGreaterThan(live);
    // The lab that has never run says exactly that — it does not borrow a median from its
    // neighbours to look populated.
    expect(lines[never]).toContain("never run");
    expect(lines[never]).not.toContain("$");
    // A live lab reports WHO is in it and for how long — not a count. "1 running" answers the less
    // interesting half of the question; the participant and the elapsed clock answer the rest.
    expect(lines[live]).toMatch(/\d+:\d\d/);
    expect(lines[live]).not.toContain("1 running");
  });

  it("shows one row per MANIFEST, and never two rows a reader cannot tell apart", async () => {
    const frame = await frameAt(80);
    const lines = frame.split("\n").filter((line) => line.trim().length > 0);
    // Two manifests declare `diagram-editor` AND carry the same title. Both are real files and both
    // are listed — but labelled by the handle that actually addresses them, so a reader can tell
    // them apart and knows what to type. Found on the real project, where a title-less fixture had
    // happily passed.
    expect(lines.filter((line) => line.includes("diagram-editor")).length).toBe(2);
    expect(frame).toContain("diagram-editor-live");
    // The shared title is dropped precisely because it is shared — it identifies neither row.
    expect(lines.filter((line) => line.includes("Is the diagram axis load-bearing?")).length).toBe(0);
    // And no two rows are byte-identical, which is the failure the real project surfaced.
    const rowLines = lines.filter((line) => line.startsWith("❯ ") || line.startsWith("  "));
    expect(new Set(rowLines).size).toBe(rowLines.length);
  });

  it("a live lab names the participant, not the lane the harness ran them in", async () => {
    // "CUA browser — observer-live-check" is the harness describing itself. The row is about who is
    // in there, so the persona wins whenever the live flush carries one.
    const frame = await frameAt(
      80,
      24,
      {
      readRunDetail: async () => ({
        schema: "humanish.run-detail.v1" as const,
        runId: "cua-2026-08-19T11-30-00-000Z-aa11bb22",
        participants: [
          { id: "s1", label: "CUA browser — signup flow", personaId: "skeptical-power-user", traits: [], status: "running" }
        ]
      })
      },
      (candidate) => candidate.includes("skeptical-power-user")
    );
    const liveRow = frame.split("\n").find((line) => line.includes("Signup flow")) ?? "";
    expect(liveRow).toContain("skeptical-power-user");
    expect(liveRow).not.toContain("CUA browser");
  });

  it("counts runs with no lab separately instead of inventing a lab for them", async () => {
    expect(await frameAt(80)).toContain("1 run with no lab");
  });

  it("says the project is empty in a way that tells you what to do next", async () => {
    const empty = options({
      readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs: [], unreadable: [] }),
      listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: [], warnings: [] })
    });
    const rendered = await renderToText(<App options={empty} now={NOW} tick={0} />, {
      columns: 80,
      until: (frame) => frame.includes("no labs")
    });
    rendered.unmount();
    const frame = normalizeFrame(rendered.last);
    expect(frame).toContain("no labs here yet");
    // The empty state says what a lab IS before telling you to run a command — someone seeing this
    // screen in their home directory has no idea what they are being asked to make.
    expect(frame).toContain("a lab is a study");
    expect(frame).toContain("humanish init");
  });

  it("reports a project it cannot read instead of rendering an empty one", async () => {
    const broken = options({
      readRunIndex: async () => {
        throw new Error("EACCES: permission denied");
      },
      listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: [], warnings: [] })
    });
    const rendered = await renderToText(<App options={broken} now={NOW} tick={0} />, {
      columns: 80,
      until: (frame) => frame.includes("could not read")
    });
    rendered.unmount();
    // An unreadable project and an empty one look identical if you render zeroes for both.
    expect(rendered.last).toContain("could not read this project");
    expect(rendered.last).toContain("EACCES");
  });
});

describe("the harness renders the way a terminal does, not the way a build log does", () => {
  it("still produces frames while CI is set", async () => {
    // Ink consults `is-in-ci` and, when it decides non-interactive, writes only the final frame at
    // unmount — no intermediate renders at all. Every render test above then waits forever for a
    // frame that never arrives, which is exactly how this suite failed in CI while passing locally.
    // Pinned here so the guard cannot be removed without a local failure.
    const previous = process.env.CI;
    process.env.CI = "true";
    try {
      const rendered = await renderToText(<App options={options()} now={NOW} tick={0} />, {
        columns: 80,
        until: (frame) => frame.includes("Signup flow")
      });
      rendered.unmount();
      // A frame arrived BEFORE unmount, which is the whole property.
      expect(rendered.last).toContain("Signup flow");
    } finally {
      if (previous === undefined) delete process.env.CI;
      else process.env.CI = previous;
    }
  });
});

describe("the two empty states are different problems", () => {
  const empty = { schema: "humanish.run-index.v1" as const, cwd: "/x", runs: [], unreadable: [] };
  const noLabs = { schema: "humanish.lab-list.v1" as const, ok: true as const, cwd: "/x", labs: [], warnings: [] };

  it("a project with no labs is told to write one", async () => {
    const frame = await frameAt(80, 24, {
      readRunIndex: async () => empty,
      listLabs: async () => noLabs,
      readProjectState: () => ({ schema: "humanish.tui-project.v1" as const, initialized: true, hasRuntime: true }),
      openObserver: async () => ({ schema: "humanish.tui-action.v1" as const, ok: true, message: "opened" }),
      reclaimRun: async () => ({ schema: "humanish.reclaim-result.v1" as const, ok: true, cwd: "/x", runId: "r", receiptCount: 0, outcomes: [], warnings: [] }),
      stopRun: async () => ({ schema: "humanish.tui-action.v1" as const, ok: true, message: "asked the run to stop" })
    }, (candidate) => candidate.includes("no labs here yet"));
    expect(frame).toContain("no labs here yet");
    expect(frame).toContain("a lab is a study");
  });

  it("a directory that is not a project is told THAT first", async () => {
    // `npx humanish tui` is easy to type anywhere, and someone in their home directory reading
    // "write a lab" cannot act on it — they do not know they are in the wrong place.
    const frame = await frameAt(80, 24, {
      readRunIndex: async () => empty,
      listLabs: async () => noLabs,
      readProjectState: () => ({ schema: "humanish.tui-project.v1" as const, initialized: false, hasRuntime: false })
    }, (candidate) => candidate.includes("not a humanish project"));
    expect(frame).toContain("this directory is not a humanish project");
    expect(frame).toContain("cd to your project");
    expect(frame).not.toContain("no labs here yet");
    // And it does not offer keys that do nothing here.
    expect(frame).not.toContain("⏎ open");
  });
});

describe("all runs — everyone working, across every lab", () => {
  const live = (runId: string, labId: string, minutesAgo: number) => ({
    runId,
    derivedFrom: "status" as const,
    liveness: "running" as const,
    mode: "live" as const,
    lab: { id: labId },
    startedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString()
  });

  const detailFor = (runId: string, persona: string, thought?: string) => ({
    schema: "humanish.run-detail.v1" as const,
    runId,
    participants: [
      {
        id: "s1",
        label: "lane",
        personaId: persona,
        traits: [],
        status: "running",
        ...(thought === undefined ? {} : { thought: { text: thought } })
      }
    ]
  });

  async function openAllRuns(columns = 80) {
    const runs = [
      live("r-1", "signup-flow", 3),
      live("r-2", "diagram-editor", 1)
    ];
    const details: Record<string, ReturnType<typeof detailFor>> = {
      "r-1": detailFor("r-1", "synthetic-new-user", "**Figuring out table creation** I am thinking about possible names."),
      "r-2": detailFor("r-2", "skeptical-power-user")
    };
    const rendered = await renderToText(
      <App
        options={options({
          readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs, unreadable: [] }),
          readRunDetail: async (_cwd, runId) => details[runId] ?? null
        })}
        now={NOW}
      />,
      { columns, rows: 28, until: (frame) => frame.includes("All runs") }
    );
    // Down past the labs to the peer, then open it.
    for (let index = 0; index < 8; index += 1) {
      const frame = await rendered.press(KEY.down);
      if (/❯\s+All runs/.test(frame)) break;
    }
    await rendered.press(KEY.enter, (candidate) => candidate.includes("synthetic-new-user"));
    // Move to the participant who HAS recorded thinking: the quoted line follows the cursor, which
    // is the whole reason only one is quoted.
    let frame = "";
    for (let index = 0; index < 4; index += 1) {
      frame = await rendered.press(KEY.down);
      if (/❯[^\n]*synthetic-new-user/.test(frame)) break;
    }
    rendered.unmount();
    return frame;
  }

  it("leads with participants and follows with the lab they are in", async () => {
    const frame = await openAllRuns();
    const row = frame.split("\n").find((line) => line.includes("synthetic-new-user")) ?? "";
    // And each run appears exactly once, even though two manifests declare the same lab id.
    expect(frame.split("\n").filter((line) => line.includes("skeptical-power-user")).length).toBe(1);
    // Who first, where second: when three studies run at once the question is who is doing what.
    expect(row.indexOf("synthetic-new-user")).toBeLessThan(row.indexOf("Signup flow"));
    expect(row).toMatch(/\d+:\d\d/);
  });

  it("quotes ONE thought — the selected row's — not every participant at once", async () => {
    // Three participants each streaming their thinking turns this into a log tail nobody can read.
    const frame = await openAllRuns();
    expect(frame).toContain("Figuring out table creation");
    expect(frame.match(/▌/g)?.length ?? 0).toBeGreaterThan(0);
    // The second participant has no recorded thought, and none is invented for them.
    expect(frame).not.toContain("skeptical-power-user is thinking");
  });

  it("reports spend as one line that says how much of it is actually known", async () => {
    // Neither run has priced itself yet, and a total that quietly omitted them would read as a
    // smaller number than the truth.
    const frame = await openAllRuns();
    expect(frame).toContain("no spend recorded yet");
  });
});
