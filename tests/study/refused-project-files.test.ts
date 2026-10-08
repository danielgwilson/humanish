// A persona or scenario file that is there and cannot be read stops resolution with an error that
// names it. Resolution never moves on to a lower-priority file of the same name in its place.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveScriptedScenario } from "../../src/routes/scripted/scenario.js";
import { prepareSelectedOutputDirectory } from "../../src/run/contained-output.js";
import { resolveCommittedPersona } from "../../src/study/persona-resolve.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

// YAML comments take an otherwise ordinary file one byte past the 4 MiB a project file is read to.
const overLimit = (yaml: string): string =>
  `${yaml}#${"x".repeat(4 * 1024 * 1024 - yaml.length - 1)}\n`;

async function project(): Promise<{ cwd: string }> {
  return { cwd: await makeTestTempDir("humanish-refused-project-file-") };
}

describe("a project file over the read limit", () => {
  it("stops persona resolution instead of using the lower-priority file", async () => {
    const { cwd } = await project();
    await mkdir(path.join(cwd, "humanish/personas"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish/personas/explorer.yaml"),
      overLimit("background: The committed persona.\n"),
    );
    await writeFile(
      path.join(cwd, "humanish/personas/explorer.yml"),
      "background: A different persona.\n",
    );
    const projectRoot = await prepareSelectedOutputDirectory(cwd, cwd);

    await expect(resolveCommittedPersona(projectRoot, "explorer")).rejects.toThrow(
      "humanish/personas/explorer.yaml is larger than 4194304 bytes",
    );
  });

  it("stops scenario resolution instead of using the lower-priority file", async () => {
    const { cwd } = await project();
    const scenario = await readFile(path.resolve("humanish/scenarios/scripted-first-run.yaml"));
    await mkdir(path.join(cwd, "humanish/scenarios"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish/scenarios/signup.yaml"),
      overLimit(scenario.toString("utf8")),
    );
    await writeFile(path.join(cwd, "humanish/scenarios/signup.yml"), scenario);
    const projectRoot = await prepareSelectedOutputDirectory(cwd, cwd);

    expect(await resolveScriptedScenario(projectRoot, "signup")).toEqual({
      ok: false,
      message:
        'scenario "signup" could not be read: humanish/scenarios/signup.yaml is larger than 4194304 bytes, the most humanish reads of it.',
    });
  });
});
