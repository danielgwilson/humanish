/**
 * Fails when the study file parser accepts a top-level or second-level field, or a persona file
 * field or trait, that site/content/docs/study-files.mdx does not name in a code span. Run by
 * docs:check.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { studyKeyPaths } from "../src/study/keys.js";
import { PERSONA_FIELDS, TRAIT_FIELDS } from "../src/study/persona.js";
import { STUDY_FIELD_PAGE, missingFields } from "./lib/study-field-docs.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(resolve(root, STUDY_FIELD_PAGE), "utf8");

const studyFields = studyKeyPaths(2);
const personaFields = [...PERSONA_FIELDS, ...[...TRAIT_FIELDS].map((trait) => `traits.${trait}`)];
const missing = [
  ...missingFields(page, studyFields).map((path) => `study file field \`${path}\``),
  ...missingFields(page, personaFields).map((path) => `persona file field \`${path}\``),
];

for (const field of missing) {
  process.stderr.write(`${STUDY_FIELD_PAGE} does not name the ${field}\n`);
}
if (missing.length > 0) {
  process.stderr.write(
    `${missing.length} field(s) the parser accepts are missing from the reference. Add a row for each, with its full path in a code span.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${STUDY_FIELD_PAGE} names all ${studyFields.length} study fields to two levels and all ${personaFields.length} persona fields.\n`,
  );
}
