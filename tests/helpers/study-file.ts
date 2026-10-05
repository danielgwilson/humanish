// Test studies on disk are humanish.study.v3 files under humanish/studies/. The shared fixtures in
// tests/admission/fixtures.ts and tests/fixtures/task-route-preflight/labs.json are v3 manifests,
// written as they are. Some callers still build humanish.lab.v2 objects; this converts those the
// way `humanish migrate` does. The converter plans the v2 and the v3 study and refuses when the
// plans differ, so the file a test writes runs the same as the object it describes.
import { parse, stringify } from "yaml";

import { parseStudy } from "../../src/study/config.js";
import { convertStudyText, isStudyV3 } from "../../src/study/migrate/convert.js";
import type { StudyConfig } from "../../src/study/types.js";

/**
 * The humanish.study.v3 text for a study, given as an object or as YAML text. A v3 study is
 * written as it is. A humanish.lab.v2 one is converted, and this throws when it does not convert.
 * A key the study's route never reads is dropped by the conversion; it throws unless `drops` names
 * exactly the keys dropped, so a fixture that relies on such a key's warning fails here instead of
 * passing without it.
 */
export function studyFileText(
  v2: object | string,
  cwd = process.cwd(),
  drops: readonly string[] = [],
): string {
  const text = typeof v2 === "string" ? v2 : stringify(v2);
  if (isStudyV3(typeof v2 === "string" ? parse(v2) : v2)) {
    if (drops.length > 0) throw new Error(`A v3 study drops nothing; got [${drops.join(", ")}].`);
    return text;
  }
  const converted = convertStudyText(text, cwd);
  if (!converted.ok) throw new Error(`This fixture does not convert to v3: ${converted.reason}`);
  const dropped = converted.conversion.dropped.map((key) => key.path).sort();
  if (dropped.join(",") !== [...drops].sort().join(","))
    throw new Error(
      `Converting this fixture to v3 drops [${dropped.join(", ")}], not [${drops.join(", ")}].`,
    );
  return converted.conversion.text;
}

/** The StudyConfig the public parser makes from studyFileText's v3 file. */
export function studyConfig(
  v2: object | string,
  cwd = process.cwd(),
  drops: readonly string[] = [],
): StudyConfig {
  const parsed = parseStudy(parse(studyFileText(v2, cwd, drops)));
  if (!parsed.ok) throw new Error(`The converted fixture does not parse: ${parsed.error.message}`);
  return parsed.config;
}
