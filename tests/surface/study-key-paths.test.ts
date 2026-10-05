// A message that names a study-file key must spell it the way a humanish.study.v3 file does: a
// person who follows `set execution.caps.maxTotalUsd` gets a study that fails to parse. This reads
// every string literal and template text under src/ and tui/src/ with the walker check-code-prose
// uses, takes each dotted path that starts with a study's top-level key, and checks it against the
// key table parseStudy enforces.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { stringsOf } from "../../scripts/lib/src-strings.mjs";
import { isStudyKeyPath } from "../../src/study/keys.js";
import { studySpelling } from "../../src/study/parse/study-v3.js";

// The top-level keys of a v3 file, then the v2 keys v3 dropped. A path a string names reads as a
// study key when it starts with one of these.
const ROOTS = [
  "schema",
  "id",
  "title",
  "description",
  "route",
  "mode",
  "subject",
  "actor",
  "participants",
  "surfaces",
  "caps",
  "execution",
  "scenario",
  "policies",
  "review",
  "defaults",
  "comms",
  "actors",
  "personas",
];

// A root, then one or more `.key`, `[n]` or `[]` segments. `config.actors[0]` and
// `src/routes/route.ts` are code and file paths, so a root after a word character, `.`, `/`, `-`
// or `$` does not start a match.
const PATH = new RegExp(
  `(?<![\\w./$-])(?:${ROOTS.join("|")})(?:\\[\\d*\\]|\\.[A-Za-z_]\\w*)+`,
  "g",
);
// `review.json`, `actor.json` and `comms.yaml` are file names.
const FILE_NAME = /\.(?:json|jsonl|md|ya?ml|ts|mjs|js|txt|html)$/;

// parseStudy reads a v3 file through the v2 parser and rewrites these files' messages with
// studySpelling, so they may use the v2 spelling it rewrites. The routes repeat some of the same
// checks for a config built without parseStudy, which has the v2 shape.
const SPELLED = new Set([
  "src/study/config.ts",
  "src/study/keys.ts",
  "src/study/validation.ts",
  "src/study/composition-rules.ts",
  "src/study/warnings.ts",
  "src/study/parse/actors.ts",
  "src/study/parse/comms.ts",
  "src/study/parse/execution.ts",
  "src/study/parse/subject.ts",
  "src/study/parse/subject-state.ts",
  "src/study/parse/values.ts",
]);

const MIGRATE = "migrate names the v2 keys of the file it converts";
const V2_ONLY = "a v3 file cannot set this key, so only migrate's v2 parse reaches the message";
const PREFLIGHT = "a preflight target's kind or label, typed values in the preflight JSON";
const NOT_STUDY = "not a study key";

/** Paths a file names on purpose that are not v3 keys: the file, the path and why. */
const ALLOWED: readonly { file: string; path: string; reason: string }[] = [
  {
    file: "src/analysis/automatic-config.ts",
    path: "review.analysis.question",
    reason: "the key table stops at review.analysis; resolveAutomaticAnalysis checks its keys",
  },
  {
    file: "src/analysis/automatic-config.ts",
    path: "review.analysis.provider",
    reason: "the key table stops at review.analysis; resolveAutomaticAnalysis checks its keys",
  },
  {
    file: "src/observer/library.ts",
    path: "id.className",
    reason: `${NOT_STUDY}: a DOM element in the page script`,
  },
  {
    file: "src/observer/library.ts",
    path: "id.textContent",
    reason: `${NOT_STUDY}: a DOM element in the page script`,
  },
  {
    file: "src/routes/computer-use/subject-projection.ts",
    path: "subject.commit",
    reason: `${NOT_STUDY}: the run result's subject`,
  },
  {
    file: "src/verify/shared-world-concurrent.ts",
    path: "subject.state.provenance",
    reason: `${NOT_STUDY}: the run bundle's subject`,
  },
  {
    file: "src/routes/shared-world/bundle-records.ts",
    path: "actor.running",
    reason: `${NOT_STUDY}: an event type`,
  },
  { file: "src/run/dry-run.ts", path: "scenario.selected", reason: `${NOT_STUDY}: an event type` },
  {
    file: "src/run/dry-run.ts",
    path: "review.skeleton.created",
    reason: `${NOT_STUDY}: an event type`,
  },
  { file: "src/study/migrate/convert.ts", path: "actors[0]", reason: MIGRATE },
  { file: "src/study/migrate/convert.ts", path: "actors[0].count", reason: MIGRATE },
  { file: "src/study/migrate/convert.ts", path: "actors[0].laneFocus", reason: MIGRATE },
  { file: "src/study/migrate/convert.ts", path: "scenario.ref", reason: MIGRATE },
  { file: "src/study/migrate/convert.ts", path: "scenario.mode", reason: MIGRATE },
  { file: "src/study/migrate/convert.ts", path: "subject.topology", reason: MIGRATE },
  {
    file: "src/study/parse/study-v3.ts",
    path: "actors[0]",
    reason: "studySpelling's own input: the v2 path it rewrites",
  },
  {
    file: "src/study/parse/study-v3.ts",
    path: "subject.topology",
    reason: "studySpelling's input, and the message for a file that still sets the moved key",
  },
  {
    file: "src/study/parse/study-v3.ts",
    path: "execution.caps",
    reason: "the message for a file that still sets the moved key",
  },
  { file: "src/study/parse/subject.ts", path: "subject.topology", reason: V2_ONLY },
  { file: "src/study/composition-rules.ts", path: "subject.topology", reason: V2_ONLY },
  {
    file: "src/study/warnings.ts",
    path: "subject.topology",
    reason: `${V2_ONLY}; migrate reports it as dropped`,
  },
  {
    file: "src/study/warnings.ts",
    path: "scenario.inline",
    reason: `${V2_ONLY}; migrate reports it as dropped`,
  },
  { file: "src/study/preflight.ts", path: "actors[0].lanes", reason: PREFLIGHT },
  { file: "src/study/preflight.ts", path: "actors[0].lanes[].target", reason: PREFLIGHT },
  { file: "src/study/preflight.ts", path: "subject.product.publicSurface", reason: PREFLIGHT },
  { file: "src/study/preflight-probes.ts", path: "actors[0].lanes[].target", reason: PREFLIGHT },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly path: string;
}

function namedPaths(): Hit[] {
  const found: Hit[] = [];
  for (const file of [...sourceFiles("src"), ...sourceFiles("tui/src")]) {
    const text = readFileSync(file, "utf8");
    const spelled = SPELLED.has(file);
    for (const string of stringsOf(parseSync(file, text).program, false, true)) {
      const message = spelled ? studySpelling(string.text, "computer-use", []) : string.text;
      for (const match of message.matchAll(PATH)) {
        if (FILE_NAME.test(match[0]) || isStudyKeyPath(match[0])) continue;
        const offset = string.start + (spelled ? 0 : (match.index ?? 0));
        found.push({ file, line: text.slice(0, offset).split("\n").length, path: match[0] });
      }
    }
  }
  return found;
}

const hits = namedPaths();

describe("messages name study keys by their v3 path", () => {
  it("every dotted study path in a src string is a key a v3 file can set", () => {
    const unknown = hits
      .filter((hit) => !ALLOWED.some((entry) => entry.file === hit.file && entry.path === hit.path))
      .map((hit) => {
        const v3 = studySpelling(hit.path, "computer-use", []);
        const hint = v3 !== hit.path && isStudyKeyPath(v3) ? ` (say ${v3})` : "";
        return `${hit.file}:${hit.line} ${hit.path}${hint}`;
      });
    expect(unknown).toEqual([]);
  });

  it("every allowlist entry still matches a string", () => {
    for (const entry of ALLOWED) {
      expect(
        hits.some((hit) => hit.file === entry.file && hit.path === entry.path),
        `${entry.file} ${entry.path}: ${entry.reason}`,
      ).toBe(true);
    }
  });
});
