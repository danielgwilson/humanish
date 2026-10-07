// `humanish notes` lists a run's reviewer notes and adds one at a moment of the run clock.
import { Command, CommanderError } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { FIRST_PARTICIPANT, writeTimedRun } from "../helpers/timed-run.js";

const RUN = "noted-run";

async function runCli(args: string[]) {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { exitCode, output: stdout.join(""), errors: stderr.join("") };
}

async function timedProject(): Promise<string> {
  const cwd = await makeTestTempDir("humanish-notes-cli-");
  await writeTimedRun(cwd, RUN);
  return cwd;
}

describe("humanish notes", () => {
  it("adds a note at mm:ss for a participant and lists it", async () => {
    const cwd = await timedProject();

    const added = await runCli([
      "notes",
      RUN,
      "--add",
      "--at",
      "02:31",
      "--participant",
      FIRST_PARTICIPANT,
      "They looked for the save button here.",
      "--cwd",
      cwd,
      "--json",
    ]);

    expect(added.exitCode).toBe(0);
    expect(JSON.parse(added.output)).toMatchObject({
      schema: "humanish.notes-result.v1",
      ok: true,
      run: RUN,
      added: { atMs: 151_000, participant: FIRST_PARTICIPANT, author: "you" },
    });
    const listed = await runCli(["notes", RUN, "--cwd", cwd, "--json"]);
    expect(JSON.parse(listed.output)).toMatchObject({
      ok: true,
      notes: [{ atMs: 151_000, text: "They looked for the save button here." }],
    });
  });

  it("lists notes in run clock order with time, participant and author", async () => {
    const cwd = await timedProject();
    await runCli(["notes", RUN, "--add", "--at", "02:31", "Late note.", "--cwd", cwd]);
    await runCli([
      "notes",
      "latest",
      "--add",
      "--at",
      "00:12",
      "--participant",
      FIRST_PARTICIPANT,
      "Early note.\nSecond line.",
      "--cwd",
      cwd,
    ]);

    const listed = await runCli(["notes", "latest", "--cwd", cwd]);

    expect(listed.exitCode).toBe(0);
    expect(listed.output).toBe(
      [
        `Reviewer notes on run ${RUN}: 2`,
        `  00:12  ${FIRST_PARTICIPANT}  you: Early note.`,
        "         Second line.",
        "  02:31  whole run   you: Late note.",
        "",
      ].join("\n"),
    );
  });

  it("takes the words after the run as the text when they are not quoted", async () => {
    const cwd = await timedProject();

    const added = await runCli(
      ["notes", RUN, "--add", "--at", "00:05", "Two", "words."].concat(["--cwd", cwd, "--json"]),
    );

    expect(JSON.parse(added.output)).toMatchObject({ ok: true, added: { text: "Two words." } });
  });

  it("says how to add a note when a run has none", async () => {
    const cwd = await timedProject();

    const listed = await runCli(["notes", RUN, "--cwd", cwd]);

    expect(listed.exitCode).toBe(0);
    expect(listed.output).toContain(`humanish notes ${RUN} --add --at`);
  });

  it("refuses a time that is not minutes and seconds", async () => {
    const cwd = await timedProject();

    for (const at of ["2:31pm", "151", "02:61"]) {
      const result = await runCli(["notes", RUN, "--add", "--at", at, "Text.", "--cwd", cwd]);
      expect(result.exitCode).toBe(2);
      expect(result.errors).toContain("code: HUMANISH_NOTE_INVALID_TIME");
    }
  });

  it("refuses --add without --at or text, and text without --add", async () => {
    const cwd = await timedProject();

    const noTime = await runCli(["notes", RUN, "--add", "Text.", "--cwd", cwd, "--json"]);
    const noText = await runCli(["notes", RUN, "--add", "--at", "00:01", "--cwd", cwd, "--json"]);
    const noAdd = await runCli(["notes", RUN, "Text.", "--cwd", cwd, "--json"]);

    for (const result of [noTime, noText, noAdd]) {
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_NOTES_OPTION_CONFLICT" },
      });
    }
  });

  it("passes a refusal from the run through with its code", async () => {
    const cwd = await timedProject();

    const result = await runCli([
      "notes",
      RUN,
      "--add",
      "--at",
      "09:00",
      "Too late.",
      "--cwd",
      cwd,
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_NOTE_OUTSIDE_RUN" },
    });
  });

  it("reports a run that does not exist", async () => {
    const cwd = await timedProject();

    const result = await runCli(["notes", "no-such-run", "--cwd", cwd, "--json"]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_RUN_NOT_FOUND" },
    });
  });
});
