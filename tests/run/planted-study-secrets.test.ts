// Text an operator writes into a study file or a persona file reaches the run bundle through every
// message the run builds from it. A sandbox URL or a key that lands there unredacted makes verify
// grade the run blocked, so a hosted run fails its own verification, or the secret is shared with
// the bundle. This file plants secret-shaped values in every field that keeps free text and compares
// each dry-run bundle with a control run that holds plain markers in the same fields.
//
// The fields come from the study key table (src/study/keys.ts) and the persona file fields
// (src/study/persona.ts). A field keeps free text on a route when the parser keeps a probe sentence
// in it as written, so a new free-text field is planted without a change here. A field inside a
// list is reached only when the base study holds that list, so the scaffold below adds the lists
// each route reads.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runStudy } from "../../src/run-study.js";
import { isRecord } from "../../src/run/type-guards.js";
import { parseStudy } from "../../src/study/config.js";
import { studyKeyPaths } from "../../src/study/keys.js";
import { PERSONA_FIELDS, TRAIT_FIELDS, parseResolvedPersona } from "../../src/study/persona.js";
import { verifyRun } from "../../src/verify/verify.js";
import { lab, SCENARIO_YAML, type RawLab } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

// Fields whose planted text reaches the bundle unredacted today. The last test of each route fails
// when a field here is redacted on a route that records it; remove the field then.
const KNOWN_GAPS = ["title", "actor.persona", "participants.persona", "execution.desktop.template"];

// Fields whose text names a file the run reads, so a run with any other text there is refused. The
// runs keep the base study's value in them. A new one makes the control run fail.
const REFERENCES = ["scenario"];

// One base study for each route. The two computer-use studies write their bundles through different
// modules: a participant list is a fan-out, and a study without one runs a single participant.
const BASES: readonly (readonly [string, RawLab])[] = [
  ["computer-use fan-out", lab("cuAppUrl", { participants: [{ id: "p1" }] })],
  ["computer-use clone", lab("cuClone")],
  ["scripted", lab("scriptedAppUrl")],
  ["terminal", lab("terminal")],
  ["shared-world", lab("sharedProvisioned")],
  ["preview", lab("preview")],
];

// Added to a base study in this order when its route accepts them, so the probe reaches the text
// fields inside list entries. A route that refuses one keeps the base study's value.
const SCAFFOLD: readonly (readonly [string, unknown])[] = [
  ["participants.stopWhen", { any: [{ urlIncludes: "/done" }] }],
  ["participants.dwell", { ms: 20_000, when: { any: [{ urlIncludes: "/wait" }] } }],
  ["actor.stopWhen", { any: [{ urlIncludes: "/done" }] }],
  ["actor.dwell", { ms: 20_000, when: { any: [{ urlIncludes: "/wait" }] } }],
  [
    "actor.tasks",
    [{ id: "t1", goal: "Find the page.", success: { any: [{ urlIncludes: "/found" }] } }],
  ],
  ["subject.state.seed", [{ name: "seed", command: "pnpm db:seed" }]],
];

const PROBE = "Probe sentence: any words, at all.";

// The shapes a text field takes: a string, a list of strings, or a mapping of names to strings.
const FORMS: readonly ((text: string) => unknown)[] = [
  (text) => text,
  (text) => [text],
  (text) => ({ PLANTED_NAME: text }),
];

interface TextField {
  readonly field: string;
  readonly form: (text: string) => unknown;
}

/** The value a run writes into a field, by the field's dotted path. */
type FieldText = (field: string) => string;

/** A plain value that is also a persona id, so a field that names a persona resolves a file. */
const marker: FieldText = (field) =>
  `marker-${field.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase()}-end`;

// A short id per field keeps the sandbox URL inside the 80 characters a persona trait keeps.
const fieldIds = new Map<string, string>();
const fieldId = (field: string): string => {
  if (!fieldIds.has(field)) fieldIds.set(field, `f${fieldIds.size + 1}`);
  return fieldIds.get(field)!;
};

/** The secret-shaped values planted in one field, built here so this file holds no flagged literal. */
function plantedLiterals(field: string) {
  const id = fieldId(field);
  const host = `3000-isbx${id}planted.e2b.app`;
  const token = `planted-${id}-query-token`;
  return {
    url: `https://${host}/?${"tok" + "en"}=${token}`,
    host,
    token,
    key: ["sk", "proj", `planted-${id}-api-key-value`].join("-"),
    bearer: `planted-${id}-bearer-token-value`,
  };
}

// A numbered step, so the mission and instruction checks quote it in a "reads like a script" warning.
const planted: FieldText = (field) => {
  const { url, key, bearer } = plantedLiterals(field);
  return `1. Open ${url} then sign in with ${key} and send Authorization: Bearer ${bearer}`;
};

/** Set `value` at a dotted path in every entry of each list on the way. True when it set one. */
function setAt(node: unknown, segments: readonly string[], value: unknown): boolean {
  if (Array.isArray(node))
    return node.reduce<boolean>((set, item) => setAt(item, segments, value) || set, false);
  if (!isRecord(node)) return false;
  const [key, ...rest] = segments;
  if (key === undefined) return false;
  if (rest.length === 0) {
    node[key] = structuredClone(value);
    return true;
  }
  node[key] ??= {};
  return setAt(node[key], rest, value);
}

/** The paths no other path extends. */
const leaves = (paths: readonly string[]): string[] =>
  paths.filter((field) => !paths.some((other) => other.startsWith(`${field}.`)));

function withText(study: RawLab, fields: readonly TextField[], text: FieldText): RawLab {
  const copy = structuredClone(study);
  for (const { field, form } of fields) setAt(copy, field.split("."), form(text(field)));
  return copy;
}

function scaffolded(base: RawLab): RawLab {
  return SCAFFOLD.reduce((study, [field, value]) => {
    const next = structuredClone(study);
    setAt(next, field.split("."), value);
    return parseStudy(next).ok ? next : study;
  }, base);
}

/** The study key table's fields that keep a probe sentence as written in this study. */
function studyTextFields(study: RawLab): TextField[] {
  return leaves(studyKeyPaths(Number.POSITIVE_INFINITY)).flatMap((field) => {
    const form = FORMS.find((shape) => {
      const parsed = parseStudy(withText(study, [{ field, form: shape }], () => PROBE));
      return parsed.ok && JSON.stringify(parsed.config).includes(PROBE);
    });
    return form === undefined ? [] : [{ field, form }];
  });
}

/** The persona file fields that keep a probe sentence as written, by their path in the file. */
function personaTextFields(): TextField[] {
  const fields = [...PERSONA_FIELDS, ...[...TRAIT_FIELDS].map((trait) => `traits.${trait}`)];
  return leaves(fields).flatMap((field) => {
    const form = FORMS.find((shape) => {
      const record = {};
      setAt(record, field.split("."), shape(PROBE));
      try {
        return JSON.stringify(parseResolvedPersona(record, { id: "p", name: "P" })).includes(PROBE);
      } catch {
        return false;
      }
    });
    return form === undefined ? [] : [{ field, form }];
  });
}

const PERSONA = personaTextFields();
const personaPath = (field: string): string => `persona.${field}`;

/** A persona file (JSON is YAML) with `text` of each persona field's path in that field. */
function personaFile(text: FieldText): string {
  const record = {};
  for (const { field, form } of PERSONA)
    setAt(record, field.split("."), form(text(personaPath(field))));
  return JSON.stringify(record);
}

interface DryRun {
  readonly ok: boolean;
  readonly grade: string;
  /** Each file under the run folder, by its path there. */
  readonly files: ReadonlyMap<string, string>;
}

/** A dry run of `study` in a new project, with a persona file holding `personaText` under each id. */
async function dryRun(
  study: RawLab,
  personaIds: readonly string[],
  personaText: FieldText,
): Promise<DryRun> {
  const parsed = parseStudy(study);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const cwd = await makeTestTempDir("humanish-planted-");
  await writeFile(path.join(cwd, "package.json"), '{ "name": "planted-secrets-fixture" }\n');
  await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
  await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
  await writeFile(path.join(cwd, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  for (const id of personaIds)
    await writeFile(path.join(cwd, "humanish", "personas", `${id}.yaml`), personaFile(personaText));

  const outcome = await runStudy(parsed.config, { cwd, dryRun: true });
  const { ok, runId } = outcome.result as { ok: boolean; runId?: string };
  if (runId === undefined) throw new Error(`no run: ${JSON.stringify(outcome.result)}`);
  const runDir = path.join(cwd, ".humanish", "runs", runId);
  const files = new Map<string, string>();
  for (const entry of await readdir(runDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files.set(path.relative(runDir, file), await readFile(file, "latin1"));
  }
  const verified = await verifyRun(cwd, runId);
  return { ok, grade: verified.shareSafety.status, files };
}

const verdict = (run: DryRun) => ({ ok: run.ok, grade: run.grade });

/** `<field> in <file>` for each field whose planted value a file of the run holds. */
function leaks(run: DryRun, fields: readonly string[]): string[] {
  return fields.flatMap((field) => {
    const values = Object.values(plantedLiterals(field));
    return [...run.files]
      .filter(([, text]) => values.some((value) => text.includes(value)))
      .map(([file]) => `${field} in ${file}`);
  });
}

interface Route {
  readonly study: RawLab;
  /** The free-text fields of the route's base study. */
  readonly fields: readonly TextField[];
  readonly personaIds: readonly string[];
  readonly control: DryRun;
  /** The study and persona fields whose marker a control bundle file holds. */
  readonly recorded: readonly string[];
}

async function prepare(base: RawLab): Promise<Route> {
  const study = scaffolded(base);
  const fields = studyTextFields(study).filter(({ field }) => !REFERENCES.includes(field));
  const personaIds = fields.map(({ field }) => marker(field));
  const control = await dryRun(withText(study, fields, marker), personaIds, marker);
  const texts = [...control.files.values()];
  const recorded = [
    ...fields.map(({ field }) => field),
    ...PERSONA.map(({ field }) => personaPath(field)),
  ].filter((field) => texts.some((text) => text.includes(marker(field))));
  return { study, fields, personaIds, control, recorded };
}

// Each route's control run, made once by the first test that needs it.
const routes = new Map<string, Promise<Route>>();
function route(name: string): Promise<Route> {
  const base = BASES.find(([label]) => label === name)?.[1];
  if (base === undefined) throw new Error(`no base study named ${name}`);
  if (!routes.has(name)) routes.set(name, prepare(base));
  return routes.get(name)!;
}

describe("secrets planted in the text of a study", () => {
  it("are planted in every free-text field, the mission, instructions and persona background among them", async () => {
    const { fields, recorded } = await route("computer-use fan-out");
    expect(fields.map(({ field }) => field)).toEqual(
      expect.arrayContaining(["actor.mission", "participants.instruction", "actor.tasks.goal"]),
    );
    expect(PERSONA.map(({ field }) => field)).toContain("background");
    // The control bundle holds these markers, so the planted runs scan files that record the fields.
    expect(recorded).toEqual(expect.arrayContaining(["actor.mission", "persona.background"]));
  });

  describe.each(BASES.map(([name]) => name))("on the %s dry run", (name) => {
    it("stay out of every bundle file, and the run verifies as the control run does", async () => {
      const { study, fields, personaIds, control } = await route(name);
      expect(control.ok).toBe(true);
      const plantable = fields.filter(
        (field) =>
          !KNOWN_GAPS.includes(field.field) &&
          // A field whose planted value the parser refuses never reaches a run.
          parseStudy(withText(study, [field], planted)).ok,
      );
      const plantedStudy = withText(withText(study, fields, marker), plantable, planted);
      const run = await dryRun(plantedStudy, personaIds, marker);
      expect(
        leaks(
          run,
          plantable.map(({ field }) => field),
        ),
      ).toEqual([]);
      expect(verdict(run)).toEqual(verdict(control));
    });

    it("stay out of every bundle file when planted in a persona file", async () => {
      const { study, fields, personaIds, control } = await route(name);
      const run = await dryRun(withText(study, fields, marker), personaIds, planted);
      expect(
        leaks(
          run,
          PERSONA.map(({ field }) => personaPath(field)),
        ),
      ).toEqual([]);
      expect(verdict(run)).toEqual(verdict(control));
    });

    it("reach the bundle unredacted in each known-gap field the route records", async () => {
      const { study, fields, personaIds, recorded } = await route(name);
      const gapFields = fields.filter(({ field }) => KNOWN_GAPS.includes(field));
      const gaps = gapFields.map(({ field }) => field);
      const plantedStudy = withText(withText(study, fields, marker), gapFields, planted);
      const run = await dryRun(plantedStudy, personaIds, marker);
      const leaked = gaps.filter((field) => leaks(run, [field]).length > 0);
      expect(leaked).toEqual(gaps.filter((field) => recorded.includes(field)));
    });
  });
});
