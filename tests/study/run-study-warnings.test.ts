// prepareStudy's run carries the warnings its admitted hooks wrote, with or without a scorer that
// joins after the route's checks. The CLI passes its scorer that way.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdapterScorerModule } from "../../src/study/adapter-scorer-loader.js";
import { parseStudyDocument } from "../../src/study/config.js";
import type { StudyConfig } from "../../src/study/types.js";
import type { RunScorerProvenance } from "../../src/run/bundle.js";
import { prepareStudy } from "../../src/run-study.js";
import { lab } from "../admission/fixtures.js";

const WARNING = "RunLabOptions.onEvent failed on plan: observer down";

const scorer: AdapterScorerModule = {
  score: () => ({
    schema: "humanish.adapter-score.v1",
    namespace: "late",
    status: "pass",
    score: 1,
    summary: "ok",
  }),
};
const scorerProvenance: RunScorerProvenance = {
  schema: "humanish.scorer-provenance.v1",
  ref: "scorer.mjs",
  digest: "000000000000",
  source: "cli-flag",
  exports: ["score"],
};

function config(base: "cuAppUrl" | "scriptedAppUrl" = "cuAppUrl"): StudyConfig {
  const parsed = parseStudyDocument(lab(base));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("a scorer that joins after the route's checks", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-lab-warnings-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function prepared(base?: "scriptedAppUrl") {
    const result = await prepareStudy(config(base), {
      cwd,
      dryRun: true,
      onEvent: () => {
        throw new Error("observer down");
      },
    });
    if (!result.ok) throw new Error("the lab was refused before it ran");
    return result;
  }

  it("keeps an onEvent failure from the checks on the run's result", async () => {
    const outcome = await (await prepared()).run({ scorer, scorerProvenance });
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.warnings).toContain(WARNING);
  });

  it("refuses a late scorer the route cannot honor", async () => {
    // Scripted runs take no scorer, so one that joins after the checks is refused.
    const late = await prepared("scriptedAppUrl");
    const outcome = await late.run({ scorer, scorerProvenance });
    expect(outcome.result.error?.code).toBe("HUMANISH_STUDY_OPTION_UNSUPPORTED");
  });
});
