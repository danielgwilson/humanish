// A persona the study names has to resolve to a readable persona file on every route that sends a
// persona to its participants. An id the study did not name, the route's built-in fallback, needs
// no file.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PersonaConfigError } from "../../src/study/persona.js";
import { resolveStudyPersonas } from "../../src/study/persona-resolve.js";
import type { StudyConfig } from "../../src/study/types.js";
import { parse as parseYaml, stringify } from "yaml";

import { createProgram } from "../../src/cli/program.js";
import { parseStudy } from "../../src/study/config.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import { lab, SCENARIO_YAML, type BaseName } from "../admission/fixtures.js";
import { libraryConfig } from "../helpers/library-config.js";
import { runComputerUse, runSharedWorld, runTerminal } from "../helpers/route-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

/** Each route's study shape, naming `personaId` where that route's studies name a persona. */
const shapes: Record<string, (personaId: string) => StudyConfig> = {
  "computer-use": (personaId) => libraryConfig(lab("cuAppUrl", {}, { persona: personaId })),
  "shared-world": (personaId) =>
    libraryConfig(
      lab("sharedProvisioned", {
        actor: { persona: undefined },
        participants: [
          { id: "author", persona: personaId, entry: "/seat-1" },
          { id: "reviewer", entry: "/seat-2" },
        ],
      }),
    ),
  terminal: (personaId) => libraryConfig(lab("terminal", {}, { persona: personaId })),
};

/** Each route's study shape with no persona named, so the route uses its built-in fallback. */
const unnamed: Record<string, BaseName> = {
  "computer-use": "cuAppUrl",
  "shared-world": "sharedExternal",
  terminal: "terminal",
};

async function project(files: Record<string, string> = {}): Promise<string> {
  const cwd = await makeTestTempDir("humanish-persona-required-");
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, relative)), { recursive: true });
    await writeFile(path.join(cwd, relative), text);
  }
  return cwd;
}

async function refusal(cwd: string, config: StudyConfig): Promise<PersonaConfigError> {
  const error = await resolveStudyPersonas(cwd, config).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(PersonaConfigError);
  return error as PersonaConfigError;
}

describe.each(Object.keys(shapes))("a %s study", (route) => {
  it("stops on a named persona with no file and lists each path it tried", async () => {
    const cwd = await project();
    const error = await refusal(cwd, shapes[route]!("weekend-planner"));
    expect(error.message).toContain("weekend-planner");
    for (const tried of [
      "humanish/personas/weekend-planner.yaml",
      "humanish/personas/weekend-planner.yml",
      ".humanish/local/personas/weekend-planner.yaml",
      ".humanish/local/personas/weekend-planner.yml",
    ])
      expect(error.message).toContain(tried);
  });

  it("stops on a named persona whose file is not valid YAML and names that file", async () => {
    const cwd = await project({
      "humanish/personas/weekend-planner.yaml": "background: [unclosed\n",
    });
    const error = await refusal(cwd, shapes[route]!("weekend-planner"));
    expect(error.message).toContain("humanish/personas/weekend-planner.yaml");
  });

  it.each([
    ["is empty", ""],
    ["holds only prose", "Sam plans trips with friends.\n"],
  ])("stops on a named persona whose file %s and names that file", async (_case, text) => {
    const cwd = await project({ "humanish/personas/weekend-planner.yaml": text });
    const error = await refusal(cwd, shapes[route]!("weekend-planner"));
    expect(error.message).toContain("humanish/personas/weekend-planner.yaml");
  });

  it("offers a file whose id reads back as the id when the id looks like a number", async () => {
    const cwd = await project();
    const error = await refusal(cwd, shapes[route]!("2024"));
    const idLine = error.message.split("\n").find((line) => line.startsWith("id: "));
    expect(parseYaml(idLine ?? "")).toEqual({ id: "2024" });
  });

  it("names where a file that is not YAML stopped, without a trailing colon", async () => {
    const cwd = await project({ "humanish/personas/weekend-planner.yaml": "background: [a\n" });
    const error = await refusal(cwd, shapes[route]!("weekend-planner"));
    expect(error.message).not.toMatch(/:\)/);
  });

  it("stops on a named persona whose id cannot be a file name", async () => {
    const cwd = await project();
    const error = await refusal(cwd, shapes[route]!("../weekend-planner"));
    expect(error.message).toContain("../weekend-planner");
  });

  it("uses the persona file the study names", async () => {
    const cwd = await project({
      "humanish/personas/weekend-planner.yaml":
        "schema: humanish.persona.v1\nid: weekend-planner\nbackground: Plans a weekend trip.\n",
    });
    const { personas } = await resolveStudyPersonas(cwd, shapes[route]!("weekend-planner"));
    expect(personas.get("weekend-planner")?.background).toBe("Plans a weekend trip.");
  });

  it("needs no file when the study names no persona", async () => {
    const cwd = await project();
    const config = libraryConfig(lab(unnamed[route]!, {}, { persona: undefined }));
    await expect(resolveStudyPersonas(cwd, config)).resolves.toEqual({
      personas: new Map(),
      warnings: [],
    });
  });
});

describe("a scripted study", () => {
  it("keeps a persona with no file as a recorded id with a warning", async () => {
    const cwd = await project();
    const { personas, warnings } = await resolveStudyPersonas(
      cwd,
      libraryConfig(lab("scriptedAppUrl")),
    );
    expect(personas.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});

describe("an actor persona that every participant overrides", () => {
  const rosters: Record<string, () => StudyConfig> = {
    "computer-use": () =>
      libraryConfig(
        lab(
          "cuAppUrl",
          {
            participants: [
              { id: "first", persona: "planner-one" },
              { id: "second", persona: "planner-two" },
            ],
          },
          { persona: "unused-label" },
        ),
      ),
    "shared-world": () =>
      libraryConfig(
        lab("sharedProvisioned", {
          actor: { persona: "unused-label" },
          participants: [
            { id: "author", persona: "planner-one", entry: "/seat-1" },
            { id: "reviewer", persona: "planner-two", entry: "/seat-2" },
          ],
        }),
      ),
  };

  it.each(Object.keys(rosters))("needs no file on a %s study", async (route) => {
    const persona = (id: string) => `schema: humanish.persona.v1\nid: ${id}\nbackground: Plans.\n`;
    const cwd = await project({
      "humanish/personas/planner-one.yaml": persona("planner-one"),
      "humanish/personas/planner-two.yaml": persona("planner-two"),
    });
    const { personas } = await resolveStudyPersonas(cwd, rosters[route]!());
    expect([...personas.keys()].sort()).toEqual(["planner-one", "planner-two"]);
  });
});

describe("a route that plans its own participants", () => {
  const runners = {
    "computer-use": (cwd: string, config: StudyConfig) =>
      runComputerUse({ cwd, config, dryRun: true, env: {} }),
    "shared-world": (cwd: string, config: StudyConfig) =>
      runSharedWorld({ cwd, config, dryRun: true, env: {} }),
    terminal: (cwd: string, config: StudyConfig) =>
      runTerminal({ cwd, config, dryRun: true, env: {} }),
  };

  it.each(Object.keys(runners) as (keyof typeof runners)[])(
    "stops on a named persona with no file on the %s route",
    async (route) => {
      const cwd = await project();
      await expect(runners[route](cwd, shapes[route]!("weekend-planner"))).rejects.toBeInstanceOf(
        PersonaConfigError,
      );
    },
  );

  it("gives a terminal study that names no persona the built-in id with no file", async () => {
    const cwd = await project();
    const result = await runTerminal({
      cwd,
      config: libraryConfig(lab("terminal", {}, { persona: undefined })),
      dryRun: true,
      env: {},
    });
    expect(result.ok).toBe(true);
  });
});

// The preview route refuses a persona at parse, so only the scripted route can name one here.
describe("a route that sends no persona", () => {
  /** Runs `humanish run <study> --dry-run --json` in `cwd` and returns its exit code and result. */
  async function dryRun(cwd: string, study: string) {
    let exitCode = 0;
    const stdout: string[] = [];
    const program = createProgram({
      writeOut: (text) => stdout.push(text),
      writeErr: () => undefined,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    await program.parseAsync(
      ["node", "humanish", "run", study, "--cwd", cwd, "--dry-run", "--no-open", "--json"],
      { from: "node" },
    );
    return { exitCode, result: JSON.parse(stdout.join("")) as { ok: boolean; error?: unknown } };
  }

  const studies: Record<string, () => Record<string, unknown>> = {
    "a scripted study with a persona file whose background is a list": () =>
      lab("scriptedAppUrl", {}, { persona: "list-background" }),
    "a scripted study whose persona has no file": () =>
      lab("scriptedAppUrl", {}, { persona: "weekend-planner" }),
  };

  it.each(Object.keys(studies))("runs %s", async (name) => {
    const raw = studies[name]!();
    const cwd = await project({
      "package.json": '{ "name": "persona-route-fixture" }\n',
      "humanish/scenarios/adm-journey.yaml": SCENARIO_YAML,
      "humanish/personas/list-background.yaml":
        "schema: humanish.persona.v1\nid: list-background\nbackground: [a, b]\n",
      [`humanish/studies/${String(raw.id)}.yaml`]: stringify(raw),
    });
    const { exitCode, result } = await dryRun(cwd, String(raw.id));
    expect({ exitCode, ok: result.ok, error: result.error }).toEqual({
      exitCode: 0,
      ok: true,
      error: undefined,
    });
  });
});

describe("a persona value that is not text", () => {
  it.each([
    ["a number", 123],
    ["true", true],
    ["an empty value", null],
    ["a list", ["weekend-planner"]],
  ])("is refused at parse on actor.persona when it is %s", (_case, value) => {
    const parsed = parseStudy(lab("cuAppUrl", {}, { persona: value }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("actor.persona");
  });

  it("is refused at parse on a participant's persona", () => {
    const parsed = parseStudy(
      lab("cuAppUrl", { participants: [{ id: "first", persona: 2024 }, { id: "second" }] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("participants[0].persona");
  });
});

describe("study check on a persona that does not resolve", () => {
  it("fails on the persona alone, with no background warning for the others", async () => {
    const raw = lab(
      "cuAppUrl",
      {
        participants: [
          { id: "first", persona: "has-background" },
          { id: "second", persona: "weekend-planner" },
        ],
      },
      { persona: undefined },
    );
    const cwd = await project({
      "humanish/personas/has-background.yaml":
        "schema: humanish.persona.v1\nid: has-background\nbackground: Plans trips.\n",
      "humanish/studies/example.yaml": stringify(raw),
    });
    const check = await runStudyPreflight({ cwd, study: "example" });
    const row = check.checks.find((entry) => entry.name === "persona");
    expect({
      ok: check.ok,
      code: check.error?.code,
      row: row?.ok,
      warnings: check.warnings,
    }).toEqual({ ok: false, code: "HUMANISH_STUDY_INVALID", row: false, warnings: [] });
    // The row names the problem; the error holds the file to paste, so it prints once.
    expect(check.error?.message.startsWith(row?.message ?? "")).toBe(true);
    expect(row?.message).not.toBe(check.error?.message);
  });
});
