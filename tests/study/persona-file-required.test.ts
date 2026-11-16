// A persona the study names has to resolve to a readable persona file on every route that sends a
// persona to its participants. An id the study did not name, the route's built-in fallback, needs
// no file.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PersonaConfigError } from "../../src/study/persona.js";
import { resolveStudyPersonas } from "../../src/study/persona-resolve.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type BaseName } from "../admission/fixtures.js";
import { libraryConfig } from "../helpers/library-config.js";
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
