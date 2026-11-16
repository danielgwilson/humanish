// `humanish personas build` writes persona files from a sessions export and prints the roster that
// assigns them, which a study can paste. The examples are a fictional trip planner and recipe site.
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

async function runCli(args: string[], onOut?: (text: string) => void) {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => {
      onOut?.(text);
      stdout.push(text);
    },
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

// A trip planner's export: one row per session, with an id and free text the build skips.
const SESSIONS = [
  { trip_id: 101, stops_added: 3, routes_compared: 2.1, shared_the_plan: false, note: "fun" },
  { trip_id: 102, stops_added: 1, routes_compared: 4.6, shared_the_plan: true, note: null },
  { trip_id: 103, stops_added: 6, routes_compared: 1, shared_the_plan: false, note: "slow" },
  { trip_id: 104, stops_added: 2, routes_compared: null, shared_the_plan: true, note: null },
]
  .map((record) => JSON.stringify(record))
  .join("\n");

const PERSONAS_DIR = path.join(".humanish", "local", "personas");
const FIRST = path.join(PERSONAS_DIR, "visitor-001.yaml");

/** A project whose .gitignore lists .humanish/, as `humanish init` leaves it, unless `ignored` is false. */
async function project(ignored = true): Promise<string> {
  const cwd = await makeTestTempDir("humanish-personas-build-");
  await writeFile(path.join(cwd, "sessions.jsonl"), `${SESSIONS}\n`);
  if (ignored) await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n.humanish/\n");
  return cwd;
}

async function builtFiles(cwd: string): Promise<Map<string, string>> {
  const directory = path.join(cwd, PERSONAS_DIR);
  if (!existsSync(directory)) return new Map();
  const names = (await readdir(directory)).sort();
  return new Map(
    await Promise.all(
      names.map(
        async (name) => [name, await readFile(path.join(directory, name), "utf8")] as const,
      ),
    ),
  );
}

const build = (cwd: string, ...args: string[]) =>
  runCli(["personas", "build", "sessions.jsonl", ...args, "--cwd", cwd]);
const buildJson = async (cwd: string, ...args: string[]) => {
  const result = await build(cwd, ...args, "--json");
  return { exitCode: result.exitCode, json: JSON.parse(result.output) as Record<string, unknown> };
};

/** The `participants:` block the human output prints, from its first line to the end. */
function printedRoster(output: string): string {
  return output.slice(output.indexOf("participants:\n"));
}

describe("humanish personas build", () => {
  it("writes the personas and prints a roster that passes study check", async () => {
    const cwd = await project();

    const result = await build(cwd);

    expect(result.exitCode).toBe(0);
    expect([...(await builtFiles(cwd)).keys()]).toEqual([
      "visitor-001.yaml",
      "visitor-002.yaml",
      "visitor-003.yaml",
      "visitor-004.yaml",
    ]);
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", "trip-planner.yaml"),
      [
        "schema: humanish.study.v3",
        "id: trip-planner",
        "route: computer-use",
        "mode: dry-run",
        "subject:",
        "  source: app-url",
        "  appUrl: http://127.0.0.1:3000/",
        "actor:",
        "  type: openai-computer-use",
        "  mission: Plan a weekend trip the way you usually would.",
        "execution:",
        "  target: e2b-desktop",
        "  timeoutMs: 60000",
        printedRoster(result.output),
      ].join("\n"),
    );
    const check = await runCli(["study", "check", "trip-planner", "--cwd", cwd, "--json"]);
    expect(check.exitCode).toBe(0);
    expect(JSON.parse(check.output)).toMatchObject({ ok: true });
    const show = await runCli(["study", "show", "trip-planner", "--cwd", cwd, "--json"]);
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
      expect((await build(cwd, "--count", "6", "--seed", "4")).exitCode).toBe(0);
    const files = await builtFiles(first);
    expect(files.size).toBe(6);
    expect(await builtFiles(second)).toEqual(files);
  });

  it("prints the fields it used and skipped before it writes a file", async () => {
    const cwd = await project();
    const existedAtFirstOutput: boolean[] = [];

    await runCli(["personas", "build", "sessions.jsonl", "--cwd", cwd], () => {
      existedAtFirstOutput.push(existsSync(path.join(cwd, FIRST)));
    });

    expect(existedAtFirstOutput[0]).toBe(false);
    expect(existsSync(path.join(cwd, FIRST))).toBe(true);
  });

  it("lists the fields it used and skipped, with the reason, in its JSON result", async () => {
    const cwd = await project();

    const { json } = await buildJson(cwd, "--prefix", "trip-planner");

    expect(json).toMatchObject({
      schema: "humanish.personas-build-result.v1",
      ok: true,
      fields: [
        { name: "trip_id", used: false, reason: "identifier or time" },
        { name: "stops_added", used: true, kind: "number" },
        { name: "routes_compared", used: true, kind: "number" },
        { name: "shared_the_plan", used: true, kind: "yes/no" },
        { name: "note", used: false, reason: "text" },
      ],
      written: [
        "trip-planner-001.yaml",
        "trip-planner-002.yaml",
        "trip-planner-003.yaml",
        "trip-planner-004.yaml",
      ],
      warnings: [],
    });
  });

  it("reports the sessions it read when the build fails", async () => {
    const cwd = await project();
    await writeFile(path.join(cwd, "sessions.jsonl"), '{"note": "a"}\n{"note": "b"}\n{"id": 3}\n');

    const { exitCode, json } = await buildJson(cwd);

    expect(exitCode).toBe(2);
    expect(json).toMatchObject({
      ok: false,
      sessions: { read: 3, usable: 0 },
      error: { code: "HUMANISH_PERSONAS_NO_MEASURES" },
    });
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

  it("has no --out: personas resolve only from the persona folders", async () => {
    const cwd = await project();
    expect((await build(cwd, "--out", "elsewhere")).exitCode).not.toBe(0);
    expect(existsSync(path.join(cwd, "elsewhere"))).toBe(false);
  });
});

describe("humanish personas build --habits and --measures", () => {
  it("phrases each measure with the habits file's sentence", async () => {
    const cwd = await project();
    await writeFile(
      path.join(cwd, "sessions.jsonl"),
      '{"recipes_opened": 1, "searches_per_visit": 4, "saved_a_recipe": true}\n',
    );
    await writeFile(
      path.join(cwd, "habits.yaml"),
      [
        "schema: humanish.habits.v1",
        'intro: "On the recipe site:"',
        "measures:",
        '  recipes_opened: { other: "they open about {value} recipes", one: "they open a single recipe" }',
        '  saved_a_recipe: { "true": "they save what they cook" }',
      ].join("\n"),
    );

    const { exitCode } = await buildJson(
      cwd,
      "--habits",
      "habits.yaml",
      "--measures",
      "recipes_opened,saved_a_recipe",
    );

    expect(exitCode).toBe(0);
    const [contents] = [...(await builtFiles(cwd)).values()];
    expect((parse(contents!) as { background: string }).background.split("\n")).toEqual([
      "On the recipe site:",
      "- they open a single recipe",
      "- they save what they cook",
    ]);
  });
});

describe("humanish personas build --dry-run", () => {
  it("prints the field report and the first persona, and writes nothing", async () => {
    const cwd = await project();

    const { exitCode, json } = await buildJson(cwd, "--dry-run");

    expect(exitCode).toBe(0);
    expect(json).toMatchObject({ ok: true, dryRun: true, written: [] });
    expect(parse(json.preview as string)).toMatchObject({ id: "visitor-001" });
    expect(existsSync(path.join(cwd, ".humanish"))).toBe(false);
    const human = await build(cwd, "--dry-run");
    expect(human.output.indexOf("schema: humanish.persona.v1")).toBeGreaterThan(0);
    expect(existsSync(path.join(cwd, ".humanish"))).toBe(false);
  });
});

describe("humanish personas build output folder", () => {
  it("warns when .gitignore does not list .humanish/, and still writes", async () => {
    const cwd = await project(false);

    const { exitCode, json } = await buildJson(cwd);

    expect(exitCode).toBe(0);
    expect(json.warnings).toHaveLength(1);
    expect((await builtFiles(cwd)).size).toBe(4);
  });

  it("warns when humanish/personas/ has a file with a built id", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
    await writeFile(path.join(cwd, "humanish", "personas", "visitor-002.yaml"), "kept\n");

    const { json } = await buildJson(cwd);

    expect(json.warnings).toHaveLength(1);
  });

  it("refuses to replace an existing persona file unless --force", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, PERSONAS_DIR), { recursive: true });
    await writeFile(path.join(cwd, PERSONAS_DIR, "visitor-002.yaml"), "kept\n");

    const refused = await buildJson(cwd);

    expect(refused.exitCode).toBe(2);
    expect(refused.json).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_PERSONAS_FILE_EXISTS" },
    });
    expect([...(await builtFiles(cwd)).entries()]).toEqual([["visitor-002.yaml", "kept\n"]]);

    const forced = await build(cwd, "--force");
    expect(forced.exitCode).toBe(0);
    expect((await builtFiles(cwd)).size).toBe(4);
    expect((await builtFiles(cwd)).get("visitor-002.yaml")).not.toBe("kept\n");
  });

  it("checks every target before writing any, even with --force", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, PERSONAS_DIR, "visitor-003.yaml"), { recursive: true });

    const { exitCode, json } = await buildJson(cwd, "--force");

    expect(exitCode).toBe(2);
    expect(json).toMatchObject({
      ok: false,
      written: [],
      error: { code: "HUMANISH_PERSONAS_TARGET_NOT_FILE" },
    });
    expect(await readdir(path.join(cwd, PERSONAS_DIR))).toEqual(["visitor-003.yaml"]);
  });

  it("says which files were written when a write fails", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, PERSONAS_DIR), { recursive: true });
    await chmod(path.join(cwd, PERSONAS_DIR), 0o500);
    try {
      const { exitCode, json } = await buildJson(cwd);
      expect(exitCode).toBe(2);
      expect(json).toMatchObject({
        ok: false,
        written: [],
        error: { code: "HUMANISH_PERSONAS_WRITE_FAILED" },
      });
    } finally {
      await chmod(path.join(cwd, PERSONAS_DIR), 0o700);
    }
  });
});
