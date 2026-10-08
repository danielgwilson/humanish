// Bare `humanish` orients instead of printing a menu.
//
// Commander's help prints sixteen subcommands, identical whether you had never run the
// tool or had a finished study on disk. A human cannot tell where to start from that, and a coding
// agent cannot tell where it is, which is the question it has to answer before choosing a command.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatOrientationHuman,
  readOrientation,
  ORIENTATION_SCHEMA,
} from "../../src/cli/orientation.js";
import { runDryRun } from "../../src/run/dry-run.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function emptyProject(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "humanish-orient-"));
  await writeFile(
    path.join(created, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
    "utf8",
  );
  return created;
}

describe("readOrientation", () => {
  it("tells a brand-new project it is not set up, and names the two commands that get it going", async () => {
    dir = await emptyProject();
    const state = await readOrientation(dir);

    expect(state.schema).toBe(ORIENTATION_SCHEMA);
    expect(state.initialized).toBe(false);
    expect(state.studyCount).toBe(0);
    expect(state.runCount).toBe(0);

    const commands = state.nextCommands.map((next) => next.command);
    expect(commands[0]).toContain("init");
    // The second step must cost nothing: first contact cannot require keys or spend.
    expect(commands.join(" ")).toContain("first-run");
    expect(commands.join(" ")).not.toContain("--live");
  });

  it("points a project of v2 study files at humanish migrate before anything else", async () => {
    dir = await emptyProject();
    await mkdir(path.join(dir, "humanish", "labs"), { recursive: true });
    await writeFile(
      path.join(dir, "humanish", "labs", "old.yaml"),
      ["schema: humanish.lab.v2", "id: old", "subject:", "  source: this-repo", "actors:"]
        .concat(["  - type: synthetic-persona"])
        .join("\n"),
      "utf8",
    );
    const state = await readOrientation(dir);

    expect(state.initialized).toBe(true);
    expect(state.studyCount).toBe(0);
    expect(state.nextCommands[0]).toEqual({
      command: "humanish migrate --dry-run",
      why: "1 study file uses humanish.lab.v2, which humanish no longer reads; this lists the conversion, and humanish migrate writes it",
    });
    expect(state.nextCommands.map((next) => next.command)).not.toContain("humanish init --yes");
  });

  it("points v3 files in a labs/ directory at study list, since migrate skips them", async () => {
    dir = await emptyProject();
    await mkdir(path.join(dir, ".humanish", "labs"), { recursive: true });
    for (const id of ["one", "two"])
      await writeFile(
        path.join(dir, ".humanish", "labs", `${id}.yaml`),
        ["schema: humanish.study.v3", `id: ${id}`, "route: preview", "mode: dry-run"]
          .concat(["subject:", "  source: this-repo", "actor:", "  type: synthetic-persona"])
          .join("\n"),
        "utf8",
      );
    const state = await readOrientation(dir);

    expect(state.initialized).toBe(true);
    expect(state.nextCommands.map((next) => next.command)).not.toContain(
      "humanish migrate --dry-run",
    );
    expect(state.nextCommands[0]).toEqual({
      command: "humanish study list",
      why: "2 study files are in a labs/ directory, which humanish no longer reads; this names each one and the studies/ directory to move it to",
    });
    // Named once, with the reason that matters here.
    expect(
      state.nextCommands.filter((next) => next.command === "humanish study list"),
    ).toHaveLength(1);
  });

  async function projectWithLabs(ids: string[]): Promise<string> {
    const created = await emptyProject();
    await mkdir(path.join(created, "humanish", "studies"), { recursive: true });
    for (const id of ids)
      await writeFile(
        path.join(created, "humanish", "studies", `${id}.yaml`),
        [
          "schema: humanish.study.v3",
          `id: ${id}`,
          "route: preview",
          "subject:",
          "  source: this-repo",
          "actor:",
          "  type: synthetic-persona",
        ].join("\n"),
        "utf8",
      );
    return created;
  }
  const linux = { platform: "linux" as const, arch: "x64" };
  const intelMac = { platform: "darwin" as const, arch: "x64" };
  const starterLabs = ["cua-browser", "first-run", "local-browser", "terminal-cli", "try-live"];

  it("starts an initialized project with the preview, then the hosted live starter study", async () => {
    dir = await projectWithLabs(starterLabs);
    const onLinux = (await readOrientation(dir, linux)).nextCommands.map((next) => next.command);
    expect(onLinux).toEqual(["humanish run first-run", "humanish doctor --study try-live"]);
    const onIntelMac = (await readOrientation(dir, intelMac)).nextCommands.map((n) => n.command);
    expect(onIntelMac).toEqual(["humanish run first-run", "humanish doctor --study try-live"]);
  });

  it("falls back to the local starter study only on a host shape that runs it", async () => {
    dir = await projectWithLabs(["first-run", "local-browser"]);
    const onLinux = (await readOrientation(dir, linux)).nextCommands.map((next) => next.command);
    expect(onLinux).toEqual(["humanish run first-run", "humanish doctor --study local-browser"]);
    const onIntelMac = (await readOrientation(dir, intelMac)).nextCommands.map((n) => n.command);
    expect(onIntelMac).toEqual(["humanish run first-run", "humanish study list"]);
  });

  it("never suggests a template lab whose subject is a placeholder", async () => {
    dir = await projectWithLabs(["cua-browser", "terminal-cli", "demo-lab"]);
    const commands = (await readOrientation(dir, linux)).nextCommands.map((n) => n.command);
    expect(commands).toEqual(["humanish run first-run", "humanish study list"]);
  });

  it("after a run, offers the live lab, then the last run's verify and Observer", async () => {
    dir = await projectWithLabs(starterLabs);
    const preview = await runDryRun({ cwd: dir, dryRun: true });
    expect(preview.ok).toBe(true);
    const state = await readOrientation(dir, linux);
    expect(state.runCount).toBe(1);
    expect(state.nextCommands.map((next) => next.command)).toEqual([
      "humanish run try-live",
      "humanish verify --run latest",
      "humanish observe --run latest",
    ]);
  });

  it("never suggests a command that would spend money on first contact", async () => {
    dir = await emptyProject();
    const state = await readOrientation(dir);
    for (const next of state.nextCommands) {
      expect(next.command).not.toMatch(/\brun\b.*\blive\b/);
    }
  });

  it("survives a directory it cannot read, because orientation must never be the thing that fails", async () => {
    const state = await readOrientation(
      path.join(tmpdir(), "humanish-does-not-exist-", String(Date.now())),
    );
    expect(state.schema).toBe(ORIENTATION_SCHEMA);
    expect(state.initialized).toBe(false);
    expect(state.nextCommands.length).toBeGreaterThan(0);
  });
});

describe("formatOrientationHuman", () => {
  it("says where you are before it says what to do", async () => {
    dir = await emptyProject();
    const text = formatOrientationHuman(await readOrientation(dir), "person");

    expect(text).toContain("not set up yet");
    // Every suggestion carries its reason: a command with no "why" is just a shorter menu.
    expect(text).toContain("humanish init");
    expect(text).toContain("humanish --help");
  });

  it("counts labs and runs in prose a person can read", async () => {
    const text = formatOrientationHuman(
      {
        schema: ORIENTATION_SCHEMA,
        initialized: true,
        studyCount: 1,
        studyIds: ["only-lab"],
        runCount: 1,
        latestRunId: "cua-123",
        nextCommands: [{ command: "humanish watch only-lab", why: "run it" }],
      },
      "person",
    );
    expect(text).toContain("1 study and 1 run");
    expect(text).toContain("cua-123");
  });

  // A person at a terminal types bare `humanish` first; without this line they find the TUI only
  // through --help.
  const initialized = {
    schema: ORIENTATION_SCHEMA,
    initialized: true,
    studyCount: 5,
    studyIds: ["first-run", "try-live", "local-browser"],
    runCount: 0,
    nextCommands: [
      {
        command: "humanish run first-run",
        why: "a dry run: no browser or model runs, no keys, no spend",
      },
    ],
  };

  it("names the terminal UI to a person at a terminal", () => {
    expect(formatOrientationHuman(initialized, "person")).toBe(
      [
        "humanish: Synthetic user research for apps, CLIs, and agent-facing product flows.",
        "",
        "This project has 5 studies and no runs yet.",
        "",
        "  humanish run first-run",
        "      a dry run: no browser or model runs, no keys, no spend",
        "",
        "`humanish tui` lists this project's studies and runs, starts a dry or live run, and shows what each participant is doing during a run.",
        "`humanish --help` lists every command.",
        "",
      ].join("\n"),
    );
  });

  it("addresses an agent's reader to the person it works for", () => {
    expect(formatOrientationHuman(initialized, "agent")).toContain(
      "\nTell the person you are working for: `humanish tui`, typed in your own terminal, lists this project's studies and runs, starts a dry or live run, and shows what each participant is doing during a run.\n`humanish --help` lists every command.\n",
    );
  });

  it("leaves the TUI out of a project that has no studies for it to list", async () => {
    dir = await emptyProject();
    const state = await readOrientation(dir);
    expect(formatOrientationHuman(state, "person")).not.toContain("tui");
    expect(formatOrientationHuman(state, "agent")).not.toContain("tui");
  });
});
