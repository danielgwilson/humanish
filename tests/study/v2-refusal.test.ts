// humanish no longer runs a humanish.lab.v2 study. The package's parser and runner refuse one with
// HUMANISH_STUDY_V2_UNSUPPORTED, naming humanish migrate; migrate's own parser still reads it.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runStudy } from "../../src/run-study.js";
import { parseStudy, parseStudyDocument } from "../../src/study/config.js";
import { V2_SCHEMA } from "../../src/study/types.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const v2 = {
  schema: V2_SCHEMA,
  id: "old",
  subject: { source: "this-repo" },
  actors: [{ type: "synthetic-persona" }],
  scenario: { mode: "dry-run" },
};
const refusal = {
  code: "HUMANISH_STUDY_V2_UNSUPPORTED",
  message:
    "This is a humanish.lab.v2 study, which humanish no longer reads. Convert its file with humanish migrate <path>.",
};

describe("a humanish.lab.v2 study", () => {
  it("is refused by parseStudy and still read by parseStudyDocument", () => {
    expect(parseStudy(v2)).toEqual({ ok: false, error: refusal });
    const read = parseStudyDocument(v2);
    expect(read.ok && read.config.schema).toBe(V2_SCHEMA);
  });

  it.each([
    ["preview", v2],
    [
      "computer-use",
      {
        ...v2,
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
        actors: [{ type: "openai-computer-use", mission: "Use the app." }],
        execution: { target: "e2b-desktop" },
      },
    ],
  ])(
    "is refused by runStudy in the %s route's envelope before anything runs",
    async (route, study) => {
      const cwd = await makeTestTempDir("humanish-v2-refusal-");
      const read = parseStudyDocument(study);
      if (!read.ok) throw new Error(read.error.message);

      const outcome = await runStudy(read.config, { cwd, dryRun: true });
      expect(outcome.route).toBe(route);
      expect(outcome.result).toMatchObject({ ok: false, error: refusal });
      await expect(readdir(path.join(cwd, ".humanish"))).rejects.toThrow(/ENOENT/);
    },
  );
});
