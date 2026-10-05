// Pins what migrate's converter writes for each v2 file: the converted text, the route, the keys it
// moved and the keys it dropped, or the reason it refused. The inputs are the 21 files in
// tests/fixtures/labs-v2 and the edge cases in tests/fixtures/labs-v2-edges, conversions where
// v2 normalizes a value away or a key has no v3 home. A rewrite of the converter must leave
// tests/golden/migrate/labs-v2.json byte-identical. Rerun with
// `pnpm vitest run tests/study/migrate-golden.test.ts -u` to rewrite it.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { convertStudyText } from "../../src/study/migrate/convert.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Goldens hold no email-shaped strings. The converter copies these values unchanged, so masking
// them hides no conversion.
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Each YAML file in a fixture directory, converted, by file name. */
async function conversions(dir: string): Promise<Record<string, unknown>> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".yaml")).sort();
  const converted: Record<string, unknown> = {};
  for (const name of names) {
    const result = convertStudyText(await readFile(path.join(dir, name), "utf8"), ROOT);
    if (!result.ok) {
      converted[name] = { refused: result.reason };
      continue;
    }
    const { route, moved, dropped, text } = result.conversion;
    // One line per array element keeps a changed line a one-line diff.
    converted[name] = { route, moved, dropped, text: text.split("\n") };
  }
  return converted;
}

describe("migrate's conversions", () => {
  it("pin the converted text, route, moved and dropped keys of each v2 fixture", async () => {
    const fixtures = path.join(ROOT, "tests", "fixtures");
    const golden = {
      "labs-v2": await conversions(path.join(fixtures, "labs-v2")),
      edges: await conversions(path.join(fixtures, "labs-v2-edges")),
    };
    expect(Object.keys(golden["labs-v2"])).toHaveLength(21);
    await expect(
      `${JSON.stringify(golden, null, 2).replace(EMAIL, "<email>")}\n`,
    ).toMatchFileSnapshot("../golden/migrate/labs-v2.json");
  });
});
