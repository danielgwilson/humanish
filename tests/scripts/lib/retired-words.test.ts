import { describe, expect, it } from "vitest";
import {
  findRetiredPathWords,
  findRetiredWords,
  identifierWords,
  isCounted,
  retiredWordOf,
} from "../../../scripts/lib/retired-words.js";

const words = (name: string) =>
  identifierWords(name)
    .map(retiredWordOf)
    .filter((word) => word !== undefined);

describe("retired vocabulary count", () => {
  it("matches whole words inside identifiers, singular or plural, in any case", () => {
    expect(words("laneId")).toEqual(["lane"]);
    expect(words("CuaLaneSpec")).toEqual(["lane"]);
    expect(words("LANE_ID_PATTERN")).toEqual(["lane"]);
    expect(words("MAX_CUA_LANES")).toEqual(["lane"]);
    expect(words("e2bLane")).toEqual(["lane"]);
    expect(words("seatLaneDeps")).toEqual(["seat", "lane"]);
    expect(words("roles")).toEqual(["role"]);
    expect(words("simCount")).toEqual(["sim"]);
    expect(words("sims")).toEqual(["sim"]);
  });

  it("reads -ies as the plural of study", () => {
    expect(retiredWordOf("studies")).toBe("study");
    expect(retiredWordOf("Studies")).toBe("study");
    expect(words("studyUsd")).toEqual(["study"]);
    expect(words("readStudiesIndex")).toEqual(["study"]);
    expect(words("STUDY_COST_ACCOUNTING_UNAVAILABLE")).toEqual(["study"]);
    // Another -ies word maps to its own -y singular, which is not retired.
    expect(retiredWordOf("entries")).toBeUndefined();
    expect(words("studied")).toEqual([]);
  });

  it("leaves words that only contain a retired word alone", () => {
    for (const name of [
      "plane",
      "SharedWorldPlane",
      "simulation",
      "similar",
      "roleplay",
      "seatbelt",
    ])
      expect(words(name), name).toEqual([]);
  });

  it("counts identifiers only, not comments or string contents, with their lines", () => {
    const source = [
      "// every lane gets a seat",
      'const label = "lane-01 role sim";',
      "const laneId = 1;",
      "type SeatPlan = { roles: string[] };",
      "export function runSim(plan: SeatPlan) {",
      "  return plan.roles.length + laneId;",
      "}",
    ].join("\n");
    expect(findRetiredWords("src/example.ts", source)).toEqual([
      { line: 3, word: "lane", identifier: "laneId" },
      { line: 4, word: "seat", identifier: "SeatPlan" },
      { line: 4, word: "role", identifier: "roles" },
      { line: 5, word: "sim", identifier: "runSim" },
      { line: 5, word: "seat", identifier: "SeatPlan" },
      { line: 6, word: "role", identifier: "roles" },
      { line: 6, word: "lane", identifier: "laneId" },
    ]);
  });

  it("counts retired words in directory and file names, at line 0", () => {
    expect(findRetiredPathWords("src/routes/computer-use/lanes.ts")).toEqual([
      { line: 0, word: "lane", identifier: "lanes" },
    ]);
    expect(findRetiredPathWords("src/routes/shared-world/seat-records.ts")).toEqual([
      { line: 0, word: "seat", identifier: "seat-records" },
    ]);
    expect(findRetiredPathWords("src/run/study-files.ts")).toEqual([
      { line: 0, word: "study", identifier: "study-files" },
    ]);
    expect(findRetiredPathWords("src/studies/runLaneIndex.ts")).toEqual([
      { line: 0, word: "study", identifier: "studies" },
      { line: 0, word: "lane", identifier: "runLaneIndex" },
    ]);
    for (const path of [
      "src/routes/computer-use/participant-execution.ts",
      "src/routes/shared-world/bundle-records.ts",
      "src/routes/shared-world/plane.ts",
      "src/run/simulation-ids.ts",
    ])
      expect(findRetiredPathWords(path), path).toEqual([]);
  });

  it("counts src/ TypeScript outside the Observer projection", () => {
    expect(
      [
        "src/routes/computer-use/lanes.ts",
        "src/observer/data.ts",
        "observer/lib/study-analysis.ts",
        "tests/routes/computer-use/lanes.test.ts",
        "src/run/bundle.md",
        "src/lab/parse/actors.ts",
        "src/run/bundle-shape.ts",
        "src/deprecated.ts",
        // A file exemption covers that file only.
        "src/deprecated.ts.backup.ts",
        "src/lab/types.ts.generated.ts",
      ].filter(isCounted),
    ).toEqual([
      "src/routes/computer-use/lanes.ts",
      "src/deprecated.ts.backup.ts",
      "src/lab/types.ts.generated.ts",
    ]);
  });
});
