import { describe, expect, it } from "vitest";
import {
  findDocBackendWords,
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

  it("counts lab and labs, and no longer counts study", () => {
    expect(words("LabConfig")).toEqual(["lab"]);
    expect(words("runLab")).toEqual(["lab"]);
    expect(words("listLabs")).toEqual(["lab"]);
    expect(words("HUMANISH_CUA_LAB_UNPRICED_CAP")).toEqual(["lab"]);
    expect(words("studyUsd")).toEqual([]);
    expect(words("readStudiesIndex")).toEqual([]);
  });

  it("leaves words that only contain a retired word alone", () => {
    for (const name of [
      "plane",
      "SharedWorldPlane",
      "simulation",
      "similar",
      "roleplay",
      "seatbelt",
      "label",
      "labelText",
      "Labels",
      "collaborate",
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
    expect(findRetiredPathWords("src/cli/commands/lab-run.ts")).toEqual([
      { line: 0, word: "lab", identifier: "lab-run" },
    ]);
    expect(findRetiredPathWords("src/lab/runLaneIndex.ts")).toEqual([
      { line: 0, word: "lab", identifier: "lab" },
      { line: 0, word: "lane", identifier: "runLaneIndex" },
    ]);
    for (const path of [
      "src/routes/computer-use/participant-execution.ts",
      "src/routes/shared-world/bundle-records.ts",
      "src/routes/shared-world/plane.ts",
      "src/run/simulation-ids.ts",
      "src/study/files.ts",
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
        "src/lab/keys.ts",
        // A file exemption covers that file only.
        "src/lab/keys.ts.backup.ts",
        "src/lab/types.ts.generated.ts",
      ].filter(isCounted),
    ).toEqual([
      "src/routes/computer-use/lanes.ts",
      "src/lab/keys.ts.backup.ts",
      "src/lab/types.ts.generated.ts",
    ]);
  });
});

describe("findDocBackendWords", () => {
  it("counts backend in any case or compound, and the routesTo predicates, by line", () => {
    const text = [
      "Narrow on `outcome.route`.",
      "| `LabOutcome.backend`, `LabBackend` | `outcome.route` |",
      "`selectLabBackend` and the `routesTo*` predicates; routesToComputerUse too.",
      "Backends report results.",
    ].join("\n");
    expect(findDocBackendWords(text)).toEqual([
      { line: 2, word: "backend" },
      { line: 2, word: "LabBackend" },
      { line: 3, word: "selectLabBackend" },
      { line: 3, word: "routesTo" },
      { line: 3, word: "routesToComputerUse" },
      { line: 4, word: "Backends" },
    ]);
  });

  it("ignores words that only contain the letters", () => {
    expect(findDocBackendWords("backendless routes and a backended draft")).toEqual([]);
  });
});
