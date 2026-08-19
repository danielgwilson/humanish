import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import React from "react";
import { describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import type { TuiOptions } from "../../src/tui-contract.js";
import { normalizeFrame, renderToText } from "../src/testing/render-to-text.js";
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

function options(overrides: Partial<TuiOptions> = {}): TuiOptions {
  return {
    cwd: "/projects/acme-app",
    version: { cli: "9.9.9" },
    capabilities: {
      readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs: RUNS, unreadable: [] }),
      listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: LABS, warnings: [] })
    },
    stdin: process.stdin,
    stdout: process.stdout,
    ...overrides
  } as TuiOptions;
}

async function frameAt(columns: number, rows = 24): Promise<string> {
  const rendered = await renderToText(<App options={options()} now={NOW} />, {
    columns,
    rows,
    // Wait for the DATA-BEARING frame, never a fixed sleep: the first frame says "reading project…"
    // and a timer captures whichever one the scheduler happened to reach. Defined by what the frame
    // is NOT, so it cannot silently stop matching when the copy on the screen changes.
    until: (frame) => frame.trim().length > 0 && !frame.includes("reading project")
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
    // And the live lab reports what is happening rather than history, because while something is
    // running that is the only fact worth the width.
    expect(lines[live]).toContain("1 running");
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
    const rowLines = lines.filter((line) => line.startsWith("\u203a ") || line.startsWith("  "));
    expect(new Set(rowLines).size).toBe(rowLines.length);
  });

  it("counts runs with no lab separately instead of inventing a lab for them", async () => {
    expect(await frameAt(80)).toContain("1 run with no lab");
  });

  it("says the project is empty in a way that tells you what to do next", async () => {
    const empty = options({
      capabilities: {
        readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs: [], unreadable: [] }),
        listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: [], warnings: [] })
      }
    } as Partial<TuiOptions>);
    const rendered = await renderToText(<App options={empty} now={NOW} />, {
      columns: 80,
      until: (frame) => frame.includes("no labs")
    });
    rendered.unmount();
    const frame = normalizeFrame(rendered.last);
    expect(frame).toContain("no labs in this project");
    expect(frame).toContain("humanish init");
  });

  it("reports a project it cannot read instead of rendering an empty one", async () => {
    const broken = options({
      capabilities: {
        readRunIndex: async () => {
          throw new Error("EACCES: permission denied");
        },
        listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: [], warnings: [] })
      }
    } as Partial<TuiOptions>);
    const rendered = await renderToText(<App options={broken} now={NOW} />, {
      columns: 80,
      until: (frame) => frame.includes("could not read")
    });
    rendered.unmount();
    // An unreadable project and an empty one look identical if you render zeroes for both.
    expect(rendered.last).toContain("could not read this project");
    expect(rendered.last).toContain("EACCES");
  });
});
