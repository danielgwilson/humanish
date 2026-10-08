import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { ORIENTATION_SCHEMA, formatOrientationHuman } from "../../src/cli/orientation.js";
import { PRODUCT_SENTENCE } from "../../src/cli/product-sentence.js";
import { createProgram } from "../../src/cli/program.js";

/** The first line of `README.md` that is neither blank nor a heading: the tagline under the title. */
async function readmeTagline(): Promise<string | undefined> {
  return (await readFile("README.md", "utf8"))
    .split("\n")
    .find((line) => line.trim() !== "" && !line.startsWith("#"));
}

describe("the product sentence", () => {
  it("opens `README.md` and the skill, and reads the same in package.json, --help and bare humanish", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      description: string;
    };
    const skillDescription = /^description: (.+)$/m.exec(
      await readFile("skills/humanish/SKILL.md", "utf8"),
    )?.[1];
    const orientation = formatOrientationHuman(
      {
        schema: ORIENTATION_SCHEMA,
        initialized: false,
        studyCount: 0,
        studyIds: [],
        runCount: 0,
        nextCommands: [],
      },
      "person",
    );

    expect({
      // Line 3 of `README.md` goes on to say what a run does, so it is held to its opening sentence.
      readme: (await readmeTagline())?.slice(0, PRODUCT_SENTENCE.length),
      packageJson: packageJson.description,
      help: createProgram().description(),
      orientation: orientation.split("\n")[0],
      skill: skillDescription?.slice(0, PRODUCT_SENTENCE.length),
    }).toEqual({
      readme: PRODUCT_SENTENCE,
      packageJson: PRODUCT_SENTENCE,
      help: PRODUCT_SENTENCE,
      orientation: `humanish: ${PRODUCT_SENTENCE}`,
      skill: PRODUCT_SENTENCE,
    });
  });
});
