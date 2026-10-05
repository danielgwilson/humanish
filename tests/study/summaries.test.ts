// Pins what the TUI's study screen and `humanish study show` say about each study: the summary
// readStudySummary builds (src/tui/contract.ts) and the personas list `study show --json` prints.
// Both read the participants through casts and structural types the compiler does not check against
// StudyConfig, so a change to the config's shape could turn them into defaults without an error.
// The corpus is every committed study, every study each init starter set writes, and
// tests/fixtures/study-summary/mixed-participants.yaml. Rerun with
// `pnpm vitest run tests/study/summaries.test.ts -u` to rewrite tests/golden/plans/summaries.json.
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readStudySummary } from "../../src/study/summary.js";
import {
  STARTER_VARIANTS,
  committedStudyPaths,
  copyCommittedProject,
  starterStudies,
  studyShowJson,
  writeStarterProject,
} from "../helpers/study-corpus.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = path.join(ROOT, "tests", "fixtures", "study-summary");

// Display text copied from the file as written, under top-level keys v3 keeps. Left out so a copy
// edit to a committed study does not rewrite the golden.
const UNPINNED = new Set(["title", "description"]);

/** The summary without key checks, and the persona ids `study show` lists with whether each resolved. */
async function describeStudy(cwd: string, study: string): Promise<[string, unknown]> {
  const summary = await readStudySummary(cwd, study);
  if (summary === null) throw new Error(`${study}: no summary`);
  const pinned = Object.fromEntries(Object.entries(summary).filter(([key]) => !UNPINNED.has(key)));
  const shown = await studyShowJson(cwd, study);
  if (shown.exitCode !== 0 || !shown.json.ok) throw new Error(`${study}: study show refused`);
  const personas = (shown.json.personas ?? []).map((persona) => {
    // The brief is the persona file rendered for the prompt; persona-background.test.ts covers it.
    expect(persona.brief !== undefined, `${study} ${persona.id}`).toBe(persona.resolved);
    return { id: persona.id, resolved: persona.resolved };
  });
  return [summary.studyId, { summary: pinned, personas }];
}

describe("study summaries and study show personas", () => {
  it("pins each study's summary and persona list", async () => {
    const committed = await makeTestTempDir("humanish-summaries-committed-");
    await copyCommittedProject(ROOT, committed);
    const committedStudies: Record<string, unknown> = {};
    for (const study of await committedStudyPaths(ROOT)) {
      const [id, entry] = await describeStudy(committed, study);
      committedStudies[id] = entry;
    }

    const starters: Record<string, unknown> = {};
    for (const variant of STARTER_VARIANTS) {
      const project = await makeTestTempDir("humanish-summaries-starter-");
      await writeStarterProject(project, variant.files);
      const studies: Record<string, unknown> = {};
      for (const file of starterStudies(variant.files)) {
        const [id, entry] = await describeStudy(project, file.path);
        studies[id] = entry;
      }
      starters[variant.name] = studies;
    }

    const fixture = "humanish/studies/mixed-participants.yaml";
    await copyFile(path.join(FIXTURES, "mixed-participants.yaml"), path.join(committed, fixture));
    const [id, entry] = await describeStudy(committed, fixture);

    const golden = { committed: committedStudies, starters, fixtures: { [id]: entry } };
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/plans/summaries.json",
    );
  });
});
