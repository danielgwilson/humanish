// The config `humanish study show --json` prints is a study file: parseStudy accepts it and returns
// the same config. That holds once StudyConfig has the v3 file's shape. Until then the printed
// config keeps the v2 keys (`actors:`) under the v3 schema, parseStudy refuses it, and each case
// below is marked `it.fails`. Drop `.fails` with the change that gives StudyConfig the v3 shape.
// The corpus is every committed study, every study each init starter set writes, and
// tests/fixtures/study-summary/mixed-participants.yaml, whose participant group the parser expands.
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseStudy } from "../../src/study/config.js";
import {
  STARTER_VARIANTS,
  starterStudies,
  studyShowJson,
  writeStarterProject,
} from "../helpers/study-corpus.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = "humanish/studies/mixed-participants.yaml";

interface Case {
  readonly label: string;
  /** Which project the study is in: "committed", "fixture" or a starter set's name. */
  readonly project: string;
  readonly study: string;
}

const CASES: readonly Case[] = [
  ...readdirSync(path.join(ROOT, "humanish", "studies"))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({
      label: `committed ${name}`,
      project: "committed",
      study: path.posix.join("humanish", "studies", name),
    })),
  ...STARTER_VARIANTS.flatMap((variant) =>
    starterStudies(variant.files).map((file) => ({
      label: `${variant.name} starter ${path.posix.basename(file.path)}`,
      project: variant.name,
      study: file.path,
    })),
  ),
  { label: "fixture mixed-participants.yaml", project: "fixture", study: FIXTURE },
];

describe("study show --json prints a config parseStudy reads back", () => {
  let temp: string;
  const projects = new Map<string, string>([["committed", ROOT]]);

  beforeAll(async () => {
    temp = await mkdtemp(path.join(tmpdir(), "humanish-study-show-roundtrip-"));
    for (const [index, variant] of STARTER_VARIANTS.entries()) {
      const dir = path.join(temp, `starter-${index}`);
      await writeStarterProject(dir, variant.files);
      projects.set(variant.name, dir);
    }
    const fixture = path.join(temp, "fixture");
    await mkdir(path.join(fixture, "humanish", "studies"), { recursive: true });
    await copyFile(
      path.join(ROOT, "tests", "fixtures", "study-summary", "mixed-participants.yaml"),
      path.join(fixture, FIXTURE),
    );
    projects.set("fixture", fixture);
  });

  afterAll(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  async function shown({ project, study }: Case) {
    const cwd = projects.get(project);
    if (cwd === undefined) throw new Error(`no project ${project}`);
    return studyShowJson(cwd, study);
  }

  // Keeps the round trip below from passing as `.fails` because study show itself broke.
  it.each(CASES)("study show prints a config for $label", async (study) => {
    const { exitCode, json } = await shown(study);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.config).toBeTypeOf("object");
  });

  it.fails.each(CASES)("the config of $label parses back to itself", async (study) => {
    const { json } = await shown(study);
    const result = parseStudy(json.config);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.config).toEqual(json.config);
  });
});
