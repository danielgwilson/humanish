// Pins the v2 files migrate refuses and its reason for each. tests/golden/migrate/refusals.json holds
// the v2 studies tests stopped parsing when they moved to humanish.study.v3 and that the v2 parser
// or migrate refused, the library admission cases that have no v3 form, and one file for each rule
// migrate applies only to v2 keys. Its `from` says where each came from. A rewrite of how migrate
// reads v2 must still refuse every case. The golden writes email addresses as <email>.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { convertStudyText } from "../../src/study/migrate/convert.js";
import { V2_SCHEMA } from "../../src/study/migrate/v2.js";

interface RefusalCase {
  readonly name: string;
  readonly from: string;
  readonly v2: Record<string, unknown>;
  readonly refused: string;
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const cases = JSON.parse(
  readFileSync(new URL("../golden/migrate/refusals.json", import.meta.url), "utf8"),
) as RefusalCase[];
const ADDRESS = ["participant", "example.test"].join("@");

describe("migrate's refusals", () => {
  it("holds v2 files under distinct names", () => {
    expect(cases.length).toBeGreaterThan(200);
    expect(new Set(cases.map((item) => item.name)).size).toBe(cases.length);
    expect(cases.filter((item) => item.v2.schema !== V2_SCHEMA)).toEqual([]);
  });

  it.each(cases)("refuses $name", ({ v2, refused }) => {
    const file = JSON.parse(JSON.stringify(v2).replaceAll("<email>", ADDRESS)) as unknown;
    expect(convertStudyText(stringify(file), ROOT)).toEqual({ ok: false, reason: refused });
  });
});
