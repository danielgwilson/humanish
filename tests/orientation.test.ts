// Bare `humanish` orients instead of printing a menu (#367).
//
// It used to print commander's help — sixteen subcommands, identical whether you had never run the
// tool or had a finished study on disk. A human cannot tell where to start from that, and a coding
// agent cannot tell where it IS, which is the question it has to answer before choosing a command.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatOrientationHuman, readOrientation, ORIENTATION_SCHEMA } from "../src/orientation.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function emptyProject(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "humanish-orient-"));
  await writeFile(path.join(created, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");
  return created;
}

describe("readOrientation", () => {
  it("tells a brand-new project it is not set up, and names the two commands that get it going", async () => {
    dir = await emptyProject();
    const state = await readOrientation(dir);

    expect(state.schema).toBe(ORIENTATION_SCHEMA);
    expect(state.initialized).toBe(false);
    expect(state.labCount).toBe(0);
    expect(state.runCount).toBe(0);

    const commands = state.nextCommands.map((next) => next.command);
    expect(commands[0]).toContain("init");
    // The second step must cost nothing: first contact cannot require keys or spend.
    expect(commands.join(" ")).toContain("first-run");
    expect(commands.join(" ")).not.toContain("--live");
  });

  it("reports what an initialized project actually has, rather than a fixed menu", async () => {
    dir = await emptyProject();
    await mkdir(path.join(dir, "humanish", "labs"), { recursive: true });
    await writeFile(
      path.join(dir, "humanish", "labs", "demo.yaml"),
      [
        "schema: humanish.lab.v2",
        "id: demo-lab",
        "subject:",
        "  source: this-repo",
        "actors:",
        "  - type: synthetic-persona"
      ].join("\n"),
      "utf8"
    );

    const state = await readOrientation(dir);
    expect(state.initialized).toBe(true);
    expect(state.labIds).toContain("demo-lab");
    // With a lab present the suggestion names THAT lab, not a placeholder.
    expect(state.nextCommands[0]?.command).toContain("demo-lab");
  });

  it("never suggests a command that would spend money on first contact", async () => {
    dir = await emptyProject();
    const state = await readOrientation(dir);
    for (const next of state.nextCommands) {
      expect(next.command).not.toContain("--app-url");
      expect(next.command).not.toMatch(/\brun\b.*\blive\b/);
    }
  });

  it("survives a directory it cannot read, because orientation must never be the thing that fails", async () => {
    const state = await readOrientation(path.join(tmpdir(), "humanish-does-not-exist-", String(Date.now())));
    expect(state.schema).toBe(ORIENTATION_SCHEMA);
    expect(state.initialized).toBe(false);
    expect(state.nextCommands.length).toBeGreaterThan(0);
  });
});

describe("formatOrientationHuman", () => {
  it("says where you are before it says what to do", async () => {
    dir = await emptyProject();
    const text = formatOrientationHuman(await readOrientation(dir));

    expect(text).toContain("not set up yet");
    // Every suggestion carries its reason: a command with no "why" is just a shorter menu.
    expect(text).toContain("humanish init");
    expect(text).toContain("humanish --help");
  });

  it("counts labs and runs in prose a person can read", async () => {
    const text = formatOrientationHuman({
      schema: ORIENTATION_SCHEMA,
      initialized: true,
      labCount: 1,
      labIds: ["only-lab"],
      runCount: 1,
      latestRunId: "cua-123",
      nextCommands: [{ command: "humanish watch only-lab", why: "run it" }]
    });
    expect(text).toContain("1 lab and 1 run");
    expect(text).toContain("cua-123");
  });
});
