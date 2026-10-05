// parseStudyV3 parses a humanish.study.v3 file into its own shape, beside parseStudy, which rewrites
// the file into the v2 spelling first. For every input here, toLegacy of parseStudyV3's config must
// deep-equal parseStudy's config with the same warnings, and a refusal must have the same code and
// message. For the committed studies, the starters and the fixtures, the config parseStudyV3 returns
// must also parse back to itself. A study with a receiving email connection does not yet: its parsed
// `comms.email` gains `kind: real`, which a file with a `connection` may not set.
//
// The inputs: the committed studies, every study a starter set writes, the v2 fixtures and edge
// files in the v3 form migrate writes, and every study the cases of four test files parse. Those
// files are imported below, so their cases run in this file too, while config.js records each
// document passed to parseStudy or parseStudyDocument. A recorded v2 document joins the inputs in
// the v3 form migrate writes, when migrate converts it.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

import type * as ConfigModule from "../../src/study/config.js";
import { parseStudy } from "../../src/study/config.js";
import { convertStudyText } from "../../src/study/migrate/convert.js";
import { parseStudyV3, toLegacy } from "../../src/study/parse/study.js";
import { STUDY_SCHEMA, V2_SCHEMA } from "../../src/study/types.js";
import { STARTER_VARIANTS, starterStudies } from "../helpers/study-corpus.js";

const recorded = vi.hoisted(() => [] as unknown[]);

vi.mock("../../src/study/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  const record = (raw: unknown): void => {
    try {
      recorded.push(structuredClone(raw));
    } catch {
      recorded.push(raw);
    }
  };
  return {
    ...actual,
    parseStudy: (raw: unknown) => {
      record(raw);
      return actual.parseStudy(raw);
    },
    parseStudyDocument: (raw: unknown) => {
      record(raw);
      return actual.parseStudyDocument(raw);
    },
  };
});

await import("./study-v3.test.js");
await import("./study-v3-errors.test.js");
await import("./config.test.js");
await import("../surface/docs-examples.test.js");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface Input {
  readonly label: string;
  readonly raw: unknown;
}

function isV2(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && "schema" in raw && raw.schema === V2_SCHEMA;
}

function mismatch(check: () => void): string[] {
  try {
    check();
    return [];
  } catch (error) {
    return [String(error)];
  }
}

// How the two parsers differ on one input. Empty when they agree.
function differences(raw: unknown): string[] {
  const before = parseStudy(structuredClone(raw));
  const after = parseStudyV3(structuredClone(raw));
  if (!before.ok || !after.ok) {
    const left = JSON.stringify(before.ok ? "parsed" : before.error);
    const right = JSON.stringify(after.ok ? "parsed" : after.error);
    return left === right ? [] : [`parseStudy ${left}, parseStudyV3 ${right}`];
  }
  return [
    ...mismatch(() => expect(toLegacy(after.config)).toStrictEqual(before.config)),
    ...mismatch(() => expect(after.warnings).toStrictEqual(before.warnings)),
  ];
}

// Whether parseStudyV3's config parses back to itself. Empty when it does or the input is refused.
function roundTrip(raw: unknown): string[] {
  const parsed = parseStudyV3(structuredClone(raw));
  if (!parsed.ok) return [];
  const again = parseStudyV3(structuredClone(parsed.config));
  return again.ok
    ? mismatch(() => expect(again.config).toStrictEqual(parsed.config))
    : [`its config does not parse back: ${again.error.message}`];
}

function expectSame(inputs: readonly Input[], ...checks: ((raw: unknown) => string[])[]): void {
  const failures = inputs.flatMap(({ label, raw }) =>
    [differences, ...checks].flatMap((check) => check(raw).map((found) => `${label}: ${found}`)),
  );
  expect(failures).toEqual([]);
}

// One input per distinct document, so a document many cases parse is compared once.
function distinct(raws: readonly unknown[], label: string): Input[] {
  const seen = new Map<string, unknown>();
  for (const raw of raws) {
    const key = JSON.stringify(raw) ?? String(raw);
    if (!seen.has(key)) seen.set(key, raw);
  }
  return [...seen.values()].map((raw, index) => ({ label: `${label} ${index}`, raw }));
}

async function yamlFiles(dir: string): Promise<{ label: string; text: string }[]> {
  const names = (await readdir(path.join(ROOT, dir))).filter((name) => /\.ya?ml$/.test(name));
  return Promise.all(
    names.sort().map(async (name) => ({
      label: path.posix.join(dir, name),
      text: await readFile(path.join(ROOT, dir, name), "utf8"),
    })),
  );
}

// The v3 form migrate writes for each v2 document it converts.
function converted(sources: readonly { label: string; text: string }[]): Input[] {
  return sources.flatMap(({ label, text }) => {
    const result = convertStudyText(text, ROOT);
    return result.ok ? [{ label, raw: parse(result.conversion.text) as unknown }] : [];
  });
}

const study = {
  schema: STUDY_SCHEMA,
  id: "differential",
  route: "computer-use",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actor: { type: "openai-computer-use" },
  execution: { target: "e2b-desktop" },
};

describe("parseStudyV3 beside parseStudy", () => {
  it("parses each committed study and starter as parseStudy does, and back to itself", async () => {
    const files = [
      ...(await yamlFiles("humanish/studies")),
      ...STARTER_VARIANTS.flatMap((variant) =>
        starterStudies(variant.files).map((file) => ({
          label: `${variant.name} ${file.path}`,
          text: file.contents,
        })),
      ),
      {
        label: "mixed-participants.yaml",
        text: await readFile(
          path.join(ROOT, "tests/fixtures/study-summary/mixed-participants.yaml"),
          "utf8",
        ),
      },
    ];
    expect(files).toHaveLength(21 + 12 + 1);
    expectSame(
      files.map(({ label, text }) => ({ label, raw: parse(text) as unknown })),
      roundTrip,
    );
  });

  it("parses the v3 form of each v2 fixture and edge file as parseStudy does, and back to itself", async () => {
    const sources = [
      ...(await yamlFiles("tests/fixtures/labs-v2")),
      ...(await yamlFiles("tests/fixtures/labs-v2-edges")),
    ];
    const inputs = converted(sources);
    expect(inputs).toHaveLength(21 + 7);
    expectSame(inputs, roundTrip);
  });

  // Runs after the imported cases, which filled `recorded`.
  it("parses every study the imported cases parse, and the v3 form of their v2 studies, as parseStudy does", () => {
    const v2 = distinct(recorded.filter(isV2), "recorded v2");
    const inputs = [
      ...distinct(
        recorded.filter((raw) => !isV2(raw)),
        "recorded",
      ),
      ...converted(v2.map(({ label, raw }) => ({ label, text: stringify(raw) }))),
    ];
    // 99 recorded and 121 converted when this was written. The floor catches a recording that
    // silently stopped.
    expect(inputs.length).toBeGreaterThan(150);
    expectSame(inputs);
  }, 120_000);

  // The v2 rewrite gives a shared world without `subject` a `subject: { topology }`, and parses
  // `caps` inside `execution`, after `execution.desktop`. parseStudyV3 does neither, so these two
  // files report a different first error.
  it("reports a different first error only where the v2 rewrite moved a key", () => {
    const refusals = (raw: unknown) =>
      [parseStudy(raw), parseStudyV3(raw)].map((result) => (result.ok ? "parsed" : result.error));
    const invalid = (message: string) => ({ code: "HUMANISH_STUDY_INVALID", message });
    expect(
      refusals({ ...study, route: "shared-world", subject: undefined, participants: [{}, {}] }),
    ).toEqual([
      invalid(
        "`subject.source` must be one of: this-repo, clone, app-url, local-app, terminal-product, desktop-cli, local-tree.",
      ),
      invalid("`subject` is required and must be an object."),
    ]);
    expect(
      refusals({
        ...study,
        caps: { maxUsd: -1 },
        execution: { target: "e2b-desktop", runtimeAuth: "openai-key" },
      }),
    ).toEqual([
      invalid("`caps.maxUsd` must be a non-negative number."),
      invalid(
        "`execution.runtimeAuth` must be openai-env or openai-egress (the terminal agent's runtime-auth channel).",
      ),
    ]);
  });
});
