// Text an operator writes into a study file or a persona file reaches the run bundle through every
// message the run builds from it. A sandbox URL or a key that lands there unredacted makes verify
// grade the run blocked, so a hosted run fails its own verification, or the secret is shared with
// the bundle. This file plants secret-shaped values in every field that keeps free text and compares
// each dry-run bundle with a control run that holds plain markers in the same fields. Each shape of
// secret gets its own run, so a field's length cap cannot cut one shape off behind another. A key is
// also planted in base64 and percent-encoded, two encodings verify's scan decodes.
//
// The fields come from the study key table (src/study/keys.ts) and the persona file fields
// (src/study/persona.ts). A field keeps free text on a route when the parser keeps a probe sentence
// in it as written, so a new free-text field is planted without a change here. A field inside a
// list, or one the parser takes only next to required siblings, is reached only when the base study
// holds that structure, so the scaffold below adds it where a route accepts it. A test fails when a
// field is neither planted on some route nor listed in NOT_FREE_TEXT.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runStudy } from "../../src/run-study.js";
import { isRecord } from "../../src/run/type-guards.js";
import { parseStudy } from "../../src/study/config.js";
import { studyKeyPaths } from "../../src/study/keys.js";
import { PERSONA_FIELDS, TRAIT_FIELDS, parseResolvedPersona } from "../../src/study/persona.js";
import type { StudyConfig } from "../../src/study/types.js";
import { verifyRun } from "../../src/verify/verify.js";
import { lab, SCENARIO_YAML, type RawLab } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

// Fields whose text names a file the run reads, so a run with any other text there is refused. The
// runs keep the base study's value in them. A new one makes the control run fail.
const REFERENCES = ["scenario"];

// Candidate fields that take no free text on any route, by what the parser takes there. The second
// test fails when a candidate field is neither discovered as free text on some route nor listed
// here, so a new field is planted, or listed here with what it takes.
const NOT_FREE_TEXT: Readonly<Record<string, readonly string[]>> = {
  "a number, a boolean, or a pair or mapping of them": [
    "actor.dwell.everyMs",
    "actor.dwell.ms",
    "actor.idleWaitMs",
    "actor.maxOutputTokens",
    "actor.maxWaitMs",
    "caps.maxJobs",
    "caps.maxMinutes",
    "caps.maxTotalUsd",
    "caps.maxUsd",
    "comms.email.port",
    "comms.email.smtp.port",
    "defaults.open",
    "execution.completionTimeoutMs",
    "execution.concurrency",
    "execution.desktop.codexAppServer",
    "execution.desktop.fidelity.deviceScaleFactor",
    "execution.desktop.fidelity.mobileEmulation",
    "execution.desktop.fidelity.touch",
    "execution.desktop.recording",
    "execution.desktop.resolution",
    "execution.desktop.sandboxTimeoutMs",
    "execution.remote",
    "execution.terminal.doNotTrack",
    "execution.timeoutMs",
    "participants.count",
    "participants.dwell.everyMs",
    "participants.dwell.ms",
    "participants.endAfterMs",
    "participants.host",
    "participants.idleWaitMs",
    "participants.maxSessionMs",
    "participants.startAfterMs",
    "participants.startEveryMs",
    "participants.windDownMs",
    "policies.allowGitHubMutation",
    "policies.allowPaymentCredentials",
    "policies.allowPrivateRepoAccess",
    "policies.allowProviderCredentials",
    "policies.allowPublicTargets",
    "policies.mediaPermission",
    "policies.redactRepos",
    "policies.redactScreenshots",
    "subject.clone.depth",
    "subject.clone.fanout",
    "subject.clone.keep",
    "subject.localTree.keep",
    "subject.localTree.maxArchiveBytes",
    "subject.publicTarget.authorized",
    "subject.serve.buildTimeoutMs",
    "subject.serve.installTimeoutMs",
    "subject.serve.readyTimeoutMs",
    "subject.state.seed.timeoutMs",
  ],
  "one of a fixed set of words": [
    "actor.dwell.then",
    "actor.localAgent",
    "actor.provider",
    "actor.reasoningEffort",
    "actor.serviceTier",
    "comms.email.kind",
    "execution.desktop.browser",
    "execution.desktop.device",
    "execution.runtimeAuth",
    "execution.target",
    "execution.terminal.stdin",
    "execution.terminal.transport",
    "mode",
    "participants.device",
    "participants.dwell.then",
    "participants.reasoningEffort",
    "route",
    "schema",
    "subject.exposure",
    "subject.source",
    "subject.state.seed.when",
    "surfaces",
  ],
  "an id, label, slug, plain path, version, time zone or environment variable name": [
    "actor.clock.timeZone",
    "actor.dwell.when.any.appStatePathEquals.path",
    "actor.dwell.when.any.id",
    "actor.stopWhen.any.appStatePathEquals.path",
    "actor.stopWhen.any.id",
    "actor.tasks.id",
    "actor.tasks.success.any.appStatePathEquals.path",
    "actor.tasks.success.any.id",
    "comms.email.connection",
    "comms.email.external.authTokenEnv",
    "comms.email.injectEnv",
    "comms.email.smtp.hostEnv",
    "comms.email.smtp.passwordEnv",
    "comms.email.smtp.portEnv",
    "comms.email.smtp.userEnv",
    "execution.runtime.version",
    "id",
    "participants.actorType",
    "participants.caseGroup",
    "participants.clock.timeZone",
    "participants.dwell.when.any.appStatePathEquals.path",
    "participants.dwell.when.any.id",
    "participants.id",
    "participants.stopWhen.any.appStatePathEquals.path",
    "participants.stopWhen.any.id",
    "participants.surface",
    "subject.env",
    "subject.product.name",
    "subject.product.workdir",
    "subject.publicTarget.owner",
    "subject.repos",
    "subject.state.checkpoint.name",
    "subject.state.external",
    "subject.state.seed.name",
  ],
  "a URL, URL path, origin or media file path": [
    "actor.dwell.when.any.urlPathEquals",
    "actor.stopWhen.any.urlPathEquals",
    "actor.tasks.success.any.urlPathEquals",
    "comms.email.allowedOrigins",
    "comms.email.external.catchBaseUrl",
    "comms.email.external.inboxBaseUrl",
    "comms.email.linkOrigin",
    "execution.desktop.media.camera.source",
    "execution.desktop.media.microphone.source",
    "execution.network.origins",
    "participants.dwell.when.any.urlPathEquals",
    "participants.stopWhen.any.urlPathEquals",
    "participants.target",
    "subject.appUrl",
    "subject.product.publicSurfaces",
    "subject.serve.url",
  ],
  // The parser refuses an `as` that looks like a secret (tests/study/secret-shaped-ids.test.ts),
  // and a dry run refuses a `from` that names no file in the study's folder.
  "a file path inside the study's folder or the desktop's home folder": [
    "participants.files.as",
    "participants.files.from",
  ],
  "nothing: every route refuses a reserved field": [
    "review.milestones",
    "review.scoring",
    "review.vocabulary",
  ],
};

// One base study for each route. The computer-use studies write their bundles through different
// modules: a participant list is a fan-out, and a study without one runs a single participant. The
// local-tree study is the only one that takes `subject.localTree`.
const BASES: readonly (readonly [string, RawLab])[] = [
  ["computer-use fan-out", lab("cuAppUrl", { participants: [{ id: "p1" }] })],
  ["computer-use clone", lab("cuClone")],
  ["computer-use local tree", lab("cuLocalTree")],
  ["scripted", lab("scriptedAppUrl")],
  ["terminal", lab("terminal")],
  ["shared-world", lab("sharedProvisioned")],
  ["preview", lab("preview")],
];

/** A stop condition with every kind of rule that holds text, the app-state one with its `path`. */
const condition = (url: string) => ({
  any: [{ urlIncludes: url, appStatePathEquals: { path: "state.done", equals: true } }],
});

/** An inbox for one participant. The address is joined here so this file holds no address literal. */
const inbox = (participant: string) => [
  { lane: participant, address: [participant, "example.test"].join("@") },
];

// Added to a base study in this order where the study does not set the path yet and the route
// accepts the result, so the probe reaches the text fields inside list entries and next to the
// siblings they need. A path listed twice holds alternatives for routes that refuse the first.
const SCAFFOLD: readonly (readonly [string, unknown])[] = [
  ["participants.stopWhen", condition("/done")],
  ["participants.dwell", { ms: 20_000, when: condition("/wait") }],
  ["actor.stopWhen", condition("/done")],
  ["actor.dwell", { ms: 20_000, when: condition("/wait") }],
  ["actor.tasks", [{ id: "t1", goal: "Find the page.", success: condition("/found") }]],
  ["subject.state.seed", [{ name: "seed", command: "pnpm db:seed" }]],
  ["subject.state.checkpoint", [{ name: "count", command: "psql count" }]],
  ["execution.desktop.fidelity", { mobileEmulation: false }],
  ["review.analysis", { maxCostUsd: 1, question: "Which step was hard?" }],
  ["comms.email", { injectEnv: "RESEND_BASE_URL" }],
  ["comms.email", { external: { catchBaseUrl: "http://127.0.0.1:8025/" } }],
  ["comms.email.smtp", { hostEnv: "SMTP_HOST", portEnv: "SMTP_PORT", user: "u", password: "p" }],
  ["comms.email.recipients", inbox("p1")],
  ["comms.email.recipients", inbox("author")],
  ["comms.email.recipients", inbox("lane-01")],
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

type Literal = keyof ReturnType<typeof plantedLiterals>;

interface Shape {
  /** The value planted in a field. */
  readonly text: FieldText;
  /** The literals that value holds. */
  readonly literals: readonly Literal[];
  /** How the value writes each literal. */
  readonly encode: (literal: string) => string;
}

const asWritten = (literal: string): string => literal;
const base64 = (literal: string): string => Buffer.from(literal).toString("base64");
// encodeURIComponent keeps `-`, so each one is escaped here. verify's scan reads `%2D` as `-`.
const percentEncoded = (literal: string): string => literal.replaceAll("-", "%2D");

// Each shape is a numbered step, so the mission and instruction checks quote it in a "reads like a
// script" warning. One shape per value keeps the longest within the 80 characters a persona trait
// keeps, so every planted literal reaches the run whole. The encoded keys are ones verify decodes.
const SHAPES: Readonly<Record<string, Shape>> = {
  "sandbox URL": {
    text: (field) => `1. Open ${plantedLiterals(field).url}`,
    literals: ["url", "host", "token"],
    encode: asWritten,
  },
  "API key": {
    text: (field) => `1. Sign in with ${plantedLiterals(field).key}`,
    literals: ["key"],
    encode: asWritten,
  },
  "bearer header": {
    text: (field) => `1. Send Authorization: Bearer ${plantedLiterals(field).bearer}`,
    literals: ["bearer"],
    encode: asWritten,
  },
  "base64 API key": {
    text: (field) => `1. Sign in with ${base64(plantedLiterals(field).key)}`,
    literals: ["key"],
    encode: base64,
  },
  "percent-encoded API key": {
    text: (field) => `1. Sign in with ${percentEncoded(plantedLiterals(field).key)}`,
    literals: ["key"],
    encode: percentEncoded,
  },
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

/** Each value at a dotted path, through every entry of each list on the way. */
function valuesAt(node: unknown, segments: readonly string[]): unknown[] {
  if (Array.isArray(node)) return node.flatMap((item) => valuesAt(item, segments));
  const [key, ...rest] = segments;
  if (key === undefined) return [node];
  return isRecord(node) && Object.hasOwn(node, key) ? valuesAt(node[key], rest) : [];
}

/** The dotted paths of the strings inside `node`, each below `prefix`. */
function textPaths(node: unknown, prefix: string): string[] {
  if (typeof node === "string") return [prefix];
  if (Array.isArray(node)) return node.flatMap((item) => textPaths(item, prefix));
  if (!isRecord(node)) return [];
  return Object.entries(node).flatMap(([key, value]) => textPaths(value, `${prefix}.${key}`));
}

/**
 * The key table's leaves. A leaf whose parser checks its own keys and that holds a mapping in
 * `study`, such as `review.analysis`, gives the paths of the text inside that mapping instead.
 */
function candidateFields(study: RawLab): string[] {
  return leaves(studyKeyPaths(Number.POSITIVE_INFINITY)).flatMap((leaf) => {
    const inside = valuesAt(study, leaf.split("."))
      .filter(isRecord)
      .flatMap((value) => textPaths(value, leaf));
    return inside.length === 0 ? [leaf] : [...new Set(inside)];
  });
}

function withText(study: RawLab, fields: readonly TextField[], text: FieldText): RawLab {
  const copy = structuredClone(study);
  for (const { field, form } of fields) setAt(copy, field.split("."), form(text(field)));
  return copy;
}

/** The parsed config when the parser accepts `study`. */
function accepted(study: RawLab): StudyConfig | undefined {
  const parsed = parseStudy(study);
  return parsed.ok ? parsed.config : undefined;
}

function scaffolded(base: RawLab): RawLab {
  return SCAFFOLD.reduce((study, [field, value]) => {
    if (valuesAt(study, field.split(".")).length > 0) return study;
    const next = structuredClone(study);
    setAt(next, field.split("."), value);
    return accepted(next) === undefined ? study : next;
  }, base);
}

/** The candidate fields that keep a probe sentence as written in this study. */
function studyTextFields(study: RawLab): TextField[] {
  return candidateFields(study).flatMap((field) => {
    const form = FORMS.find((shape) =>
      JSON.stringify(
        accepted(withText(study, [{ field, form: shape }], () => PROBE)) ?? {},
      ).includes(PROBE),
    );
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

/** `<field>: <literal>` for each literal of `shape` that `kept` does not hold whole in a field. */
function cutShort(kept: string, fields: readonly string[], shape: Shape): string[] {
  return fields.flatMap((field) =>
    shape.literals
      .filter((literal) => !kept.includes(shape.encode(plantedLiterals(field)[literal])))
      .map((literal) => `${field}: ${literal}`),
  );
}

// A literal cut short after parsing still leaks, so a file leaks a field when it holds the first
// 21 characters of any of the field's literals, as written or as the shape encodes them. Base64
// writes three characters as four, so the base64 of 21 characters starts the base64 of the whole
// literal. The shortest literal has 22, and up to field f999 no field's first 21 characters appear
// in another field's literals. At 20, f10's URL would match f100's.
const FRAGMENT = 21;

/** `<field> in <file>` for each field whose planted value a file of the run holds. */
function leaks(run: DryRun, fields: readonly string[], shape: Shape): string[] {
  return fields.flatMap((field) => {
    const fragments = Object.values(plantedLiterals(field)).flatMap((value) => [
      value.slice(0, FRAGMENT),
      shape.encode(value.slice(0, FRAGMENT)),
    ]);
    return [...run.files]
      .filter(([, text]) => fragments.some((fragment) => text.includes(fragment)))
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

interface Discovery {
  /** The base study with the scaffold the route accepts. */
  readonly study: RawLab;
  readonly candidates: readonly string[];
  /** The free-text fields of the study, without the references. */
  readonly fields: readonly TextField[];
}

// Each route's discovery, made once by the first test that needs it.
const discoveries = new Map<string, Discovery>();
function discovery(name: string): Discovery {
  const base = BASES.find(([label]) => label === name)?.[1];
  if (base === undefined) throw new Error(`no base study named ${name}`);
  if (!discoveries.has(name)) {
    const study = scaffolded(base);
    const fields = studyTextFields(study).filter(({ field }) => !REFERENCES.includes(field));
    discoveries.set(name, { study, candidates: candidateFields(study), fields });
  }
  return discoveries.get(name)!;
}

async function prepare(name: string): Promise<Route> {
  const { study, fields } = discovery(name);
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
  if (!routes.has(name)) routes.set(name, prepare(name));
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

  it("are planted in every candidate field that takes free text on some route, and the rest are listed", () => {
    const studies = BASES.map(([name]) => discovery(name));
    const discovered = new Set([
      ...REFERENCES,
      ...studies.flatMap(({ fields }) => fields.map(({ field }) => field)),
    ]);
    // A leaf that holds a mapping on one route is covered by the text paths inside it.
    const candidates = leaves([...new Set(studies.flatMap(({ candidates }) => candidates))]);
    expect(candidates.filter((field) => !discovered.has(field)).sort()).toEqual(
      Object.values(NOT_FREE_TEXT).flat().sort(),
    );
  });

  describe.each(BASES.map(([name]) => name))("on the %s dry run", (name) => {
    it.each(Object.keys(SHAPES))(
      "stay out of every bundle file as a %s, and the run verifies as the control run does",
      async (shapeName) => {
        const shape = SHAPES[shapeName]!;
        const { study, fields, personaIds, control } = await route(name);
        expect(control.ok).toBe(true);
        // A field whose planted value the parser refuses never reaches a run.
        const planted = fields.flatMap((field) => {
          const config = accepted(withText(study, [field], shape.text));
          return config === undefined ? [] : [{ field, kept: JSON.stringify(config) }];
        });
        const persona = PERSONA.map(({ field }) => personaPath(field));
        const keptPersona = JSON.stringify(
          parseResolvedPersona(JSON.parse(personaFile(shape.text)), { id: "p", name: "P" }),
        );
        // Every planted literal reaches the run whole, so the leak check below reads all of it.
        expect([
          ...planted.flatMap(({ field, kept }) => cutShort(kept, [field.field], shape)),
          ...cutShort(keptPersona, persona, shape),
        ]).toEqual([]);

        const plantedStudy = withText(
          withText(study, fields, marker),
          planted.map(({ field }) => field),
          shape.text,
        );
        const run = await dryRun(plantedStudy, personaIds, shape.text);
        expect(leaks(run, [...planted.map(({ field }) => field.field), ...persona], shape)).toEqual(
          [],
        );
        expect(verdict(run)).toEqual(verdict(control));
      },
    );
  });
});
