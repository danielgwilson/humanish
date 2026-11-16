// `humanish personas build` writes persona files from a sessions export and prints the roster that
// assigns them, which a study can paste.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

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

// A fictional photo quiz's export: one row per session, with an id and free text the build skips.
const SESSIONS = [
  { session_id: 101, rounds_played: 3, photos_per_round: 2.1, used_a_hint: false, note: "fun" },
  { session_id: 102, rounds_played: 1, photos_per_round: 4.6, used_a_hint: true, note: null },
  { session_id: 103, rounds_played: 6, photos_per_round: 1, used_a_hint: false, note: "slow" },
  { session_id: 104, rounds_played: 2, photos_per_round: null, used_a_hint: true, note: null },
]
  .map((record) => JSON.stringify(record))
  .join("\n");

const PERSONAS_DIR = path.join(".humanish", "local", "personas");

async function project(): Promise<string> {
  const cwd = await makeTestTempDir("humanish-personas-build-");
  await writeFile(path.join(cwd, "sessions.jsonl"), `${SESSIONS}\n`);
  return cwd;
}

async function builtFiles(cwd: string): Promise<Map<string, string>> {
  const directory = path.join(cwd, PERSONAS_DIR);
  const names = (await readdir(directory)).sort();
  return new Map(
    await Promise.all(
      names.map(
        async (name) => [name, await readFile(path.join(directory, name), "utf8")] as const,
      ),
    ),
  );
}

/** The `participants:` block the human output prints, from its first line to the end. */
function printedRoster(output: string): string {
  return output.slice(output.indexOf("participants:\n"));
}

describe("humanish personas build", () => {
  it("writes the personas and prints a roster that passes study check", async () => {
    const cwd = await project();

    const result = await runCli(["personas", "build", "sessions.jsonl", "--cwd", cwd]);

    expect(result.exitCode).toBe(0);
    expect([...(await builtFiles(cwd)).keys()]).toEqual([
      "visitor-001.yaml",
      "visitor-002.yaml",
      "visitor-003.yaml",
      "visitor-004.yaml",
    ]);
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", "photo-quiz.yaml"),
      [
        "schema: humanish.study.v3",
        "id: photo-quiz",
        "route: computer-use",
        "mode: dry-run",
        "subject:",
        "  source: app-url",
        "  appUrl: http://127.0.0.1:3000/",
        "actor:",
        "  type: openai-computer-use",
        "  mission: Play the photo quiz the way you usually would.",
        "execution:",
        "  target: e2b-desktop",
        "  timeoutMs: 60000",
        printedRoster(result.output),
      ].join("\n"),
    );
    const check = await runCli(["study", "check", "photo-quiz", "--cwd", cwd, "--json"]);
    expect(check.exitCode).toBe(0);
    expect(JSON.parse(check.output)).toMatchObject({ ok: true });
    const show = await runCli(["study", "show", "photo-quiz", "--cwd", cwd, "--json"]);
    const personas = (
      JSON.parse(show.output) as { personas: Array<{ id: string; resolved: boolean }> }
    ).personas;
    expect(personas.map(({ id, resolved }) => ({ id, resolved }))).toEqual(
      ["visitor-001", "visitor-002", "visitor-003", "visitor-004"].map((id) => ({
        id,
        resolved: true,
      })),
    );
  });

  it("gives byte-identical files for the same export and seed", async () => {
    const first = await project();
    const second = await project();
    for (const cwd of [first, second])
      expect(
        (
          await runCli([
            "personas",
            "build",
            "sessions.jsonl",
            "--count",
            "6",
            "--seed",
            "4",
            "--cwd",
            cwd,
          ])
        ).exitCode,
      ).toBe(0);
    const files = await builtFiles(first);
    expect(files.size).toBe(6);
    expect(await builtFiles(second)).toEqual(files);
  });

  it("refuses to replace an existing persona file unless --force", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, PERSONAS_DIR), { recursive: true });
    await writeFile(path.join(cwd, PERSONAS_DIR, "visitor-002.yaml"), "kept\n");

    const refused = await runCli(["personas", "build", "sessions.jsonl", "--cwd", cwd, "--json"]);

    expect(refused.exitCode).toBe(2);
    expect(JSON.parse(refused.output)).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_PERSONAS_FILE_EXISTS" },
    });
    expect([...(await builtFiles(cwd)).entries()]).toEqual([["visitor-002.yaml", "kept\n"]]);

    const forced = await runCli(["personas", "build", "sessions.jsonl", "--force", "--cwd", cwd]);
    expect(forced.exitCode).toBe(0);
    expect((await builtFiles(cwd)).size).toBe(4);
    expect((await builtFiles(cwd)).get("visitor-002.yaml")).not.toBe("kept\n");
  });
});

describe("humanish personas build options", () => {
  it("lists the fields it used and skipped, with the reason, in its JSON result", async () => {
    const cwd = await project();

    const result = await runCli([
      "personas",
      "build",
      "sessions.jsonl",
      "--out",
      "built",
      "--prefix",
      "quiz-player",
      "--cwd",
      cwd,
      "--json",
    ]);

    expect(JSON.parse(result.output)).toMatchObject({
      schema: "humanish.personas-build-result.v1",
      ok: true,
      fields: [
        { name: "session_id", used: false, reason: "identifier or time" },
        { name: "rounds_played", used: true, kind: "number" },
        { name: "photos_per_round", used: true, kind: "number" },
        { name: "used_a_hint", used: true, kind: "yes/no" },
        { name: "note", used: false, reason: "text" },
      ],
      written: [
        "quiz-player-001.yaml",
        "quiz-player-002.yaml",
        "quiz-player-003.yaml",
        "quiz-player-004.yaml",
      ],
    });
    expect((await readdir(path.join(cwd, "built"))).sort()).toHaveLength(4);
  });

  it("reads --habits and --measures", async () => {
    const cwd = await project();
    await writeFile(
      path.join(cwd, "habits.yaml"),
      [
        "schema: humanish.habits.v1",
        "measures:",
        '  rounds_played: { other: "they play about {value} rounds", one: "they play one round" }',
      ].join("\n"),
    );

    const result = await runCli([
      "personas",
      "build",
      "sessions.jsonl",
      "--habits",
      "habits.yaml",
      "--measures",
      "rounds_played",
      "--count",
      "1",
      "--cwd",
      cwd,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const [contents] = [...(await builtFiles(cwd)).values()];
    expect(contents?.split("\n").filter((line) => line.trim().startsWith("- "))).toHaveLength(1);
  });

  it("refuses an unreadable sessions file before writing anything", async () => {
    const cwd = await project();
    const result = await runCli(["personas", "build", "missing.jsonl", "--cwd", cwd, "--json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_PERSONAS_UNREADABLE_FILE" },
    });
  });
});
