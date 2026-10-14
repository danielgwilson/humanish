// A scripted run records its scenario's title, goal and step labels in run.json, review.md and the
// Observer data. verify reads those files as written and decoded, so a key in that text, in any
// encoding verify decodes, must not reach them. Each key is built at run time.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runStudy } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { lab, SCENARIO_YAML } from "../../admission/fixtures.js";
import { makeTestTempDir } from "../../helpers/temp-dir.js";

/** A distinct key for each scenario field, so a leak names the field it came from. */
const keyOf = (field: string): string => ["sk", "proj", `planted-${field}-api-key-value`].join("-");

const ENCODINGS: Readonly<Record<string, (key: string) => string>> = {
  "as written": (key) => key,
  base64: (key) => Buffer.from(key).toString("base64"),
  // encodeURIComponent keeps `-`, so each one is escaped here. verify reads `%2D` as `-`.
  "percent-encoded": (key) => key.replaceAll("-", "%2D"),
};

/** A scripted dry run whose scenario title, goal and only step label each end with `text(field)`. */
async function scriptedDryRun(text: (field: string) => string) {
  const cwd = await makeTestTempDir("humanish-scenario-keys-");
  await writeFile(path.join(cwd, "package.json"), '{ "name": "scenario-keys-fixture" }\n');
  await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
  // The step has no id, so the parser derives one from the label.
  const scenario = SCENARIO_YAML.replace(
    "title: Admission journey",
    `title: Journey ${text("title")}`,
  )
    .replace("goal: Load the app.", `goal: Sign in with ${text("goal")}`)
    .replace(
      "    - id: step-01-load\n      label: Load landing page",
      `    - label: Load ${text("label")}`,
    );
  await writeFile(path.join(cwd, "humanish", "scenarios", "adm-journey.yaml"), scenario);
  const parsed = parseStudy(lab("scriptedAppUrl"));
  if (!parsed.ok) throw new Error(parsed.error.message);
  const { runId } = (await runStudy(parsed.config, { cwd, dryRun: true })).result as {
    runId: string;
  };
  const runDir = path.join(cwd, ".humanish", "runs", runId);
  const files = new Map<string, string>();
  for (const entry of await readdir(runDir, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      files.set(path.relative(runDir, file), await readFile(file, "latin1"));
    }
  return { files, grade: (await verifyRun(cwd, runId)).shareSafety.status };
}

describe("a key in a scripted scenario's text", () => {
  it.each(Object.entries(ENCODINGS))(
    "stays out of every run file %s, and the run verifies as a plain one does",
    async (_name, encode) => {
      const control = await scriptedDryRun(() => "plain words");
      const run = await scriptedDryRun((field) => encode(keyOf(field)));
      const leaks = [...run.files].flatMap(([file, text]) =>
        ["title", "goal", "label"]
          .filter((field) => text.includes(encode(keyOf(field)).slice(0, 20)))
          .map((field) => `${field} in ${file}`),
      );
      expect(leaks).toEqual([]);
      expect(run.grade).toBe(control.grade);
    },
  );
});
