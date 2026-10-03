// Test studies on disk are humanish.study.v3 files under humanish/studies/. Many fixtures are
// still written in the humanish.lab.v2 shape, so this converts them the way `humanish migrate`
// does. The converter plans the v2 and the v3 study and refuses when the plans differ, so the file
// a test writes runs the same as the object it describes.
import { parse, stringify } from "yaml";

import { parseStudy } from "../../src/study/config.js";
import { convertStudyText } from "../../src/study/convert.js";
import type { StudyConfig } from "../../src/study/types.js";

/**
 * The humanish.study.v3 text for a study given in the humanish.lab.v2 shape, as an object or as
 * YAML text. Throws when the study does not convert. A key the study's route never reads is
 * dropped by the conversion; it throws unless `drops` names exactly the keys dropped, so a fixture
 * that relies on such a key's warning fails here instead of passing without it.
 */
export function studyFileText(
  v2: object | string,
  cwd = process.cwd(),
  drops: readonly string[] = [],
): string {
  const converted = convertStudyText(typeof v2 === "string" ? v2 : stringify(v2), cwd);
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
