// The library's 0.107 names stay one minor as deprecated aliases. Each must be its new name's
// function, constant, class or type, so old imports, calls and `instanceof` checks keep working,
// and each must carry @deprecated so an editor marks it.
import { readFile } from "node:fs/promises";

import { parseSync } from "oxc-parser";
import { describe, expect, expectTypeOf, it } from "vitest";
import { stringify } from "yaml";

import * as humanish from "../../src/index.js";
import type {
  BrowserLabScoringContext,
  BrowserScoringContext,
  ComputerUseAction,
  ComputerUseExecutor,
  ComputerUseLoopOptions,
  ComputerUseLoopResult,
  ComputerUseObservation,
  ComputerUseProvider,
  ComputerUseSafetyCheck,
  ComputerUseTurn,
  ComputerUseTurnRequest,
  CuaAction,
  CuaExecutor,
  CuaLoopOptions,
  CuaLoopResult,
  CuaObservation,
  CuaProvider,
  CuaSafetyCheck,
  CuaTurn,
  CuaTurnRequest,
  LabConfig,
  LabEvent,
  LabOutcome,
  LabResult,
  LabRoute,
  RunLabOptions,
  RunStudyOptions,
  StudyConfig,
  StudyEvent,
  StudyOutcome,
  StudyResult,
  StudyRoute,
} from "../../src/index.js";

describe("deprecated library names", () => {
  it("are the same functions and class as their new names", () => {
    expect(humanish.runLab).toBe(humanish.runStudy);
    expect(humanish.parseLabConfig).toBe(humanish.parseStudy);
    expect(humanish.CuaAdmissionLimitError).toBe(humanish.ComputerUseAdmissionLimitError);
  });

  it("match instanceof under either class name", () => {
    expect(new humanish.CuaAdmissionLimitError()).toBeInstanceOf(
      humanish.ComputerUseAdmissionLimitError,
    );
    expect(new humanish.ComputerUseAdmissionLimitError()).toBeInstanceOf(
      humanish.CuaAdmissionLimitError,
    );
  });

  it("keep LAB_CONFIG_SCHEMA as the v2 schema id beside STUDY_SCHEMA", () => {
    expect(humanish.LAB_CONFIG_SCHEMA).toBe("humanish.lab.v2");
    expect(humanish.STUDY_SCHEMA).toBe("humanish.study.v3");
  });

  it("parse a v2 document built with LAB_CONFIG_SCHEMA and a v3 one to the same config", () => {
    const v2 = humanish.parseLabConfig({
      schema: humanish.LAB_CONFIG_SCHEMA,
      id: "alias-check",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona", count: 2 }],
      scenario: { mode: "dry-run" },
    });
    const v3 = humanish.parseStudy({
      schema: humanish.STUDY_SCHEMA,
      id: "alias-check",
      route: "preview",
      mode: "dry-run",
      subject: { source: "this-repo" },
      actor: { type: "synthetic-persona" },
      participants: 2,
    });
    expect(v2.ok && v3.ok).toBe(true);
    if (!v2.ok || !v3.ok) return;
    expect(stringify({ ...v3.config, schema: v2.config.schema })).toBe(stringify(v2.config));
  });

  it("are the same types as their new names", () => {
    expectTypeOf<LabConfig>().toEqualTypeOf<StudyConfig>();
    expectTypeOf<LabEvent>().toEqualTypeOf<StudyEvent>();
    expectTypeOf<LabOutcome>().toEqualTypeOf<StudyOutcome>();
    expectTypeOf<LabResult>().toEqualTypeOf<StudyResult>();
    expectTypeOf<LabResult<"terminal">>().toEqualTypeOf<StudyResult<"terminal">>();
    expectTypeOf<LabRoute>().toEqualTypeOf<StudyRoute>();
    expectTypeOf<RunLabOptions>().toEqualTypeOf<RunStudyOptions>();
    expectTypeOf<BrowserLabScoringContext>().toEqualTypeOf<BrowserScoringContext>();
    expectTypeOf<CuaAction>().toEqualTypeOf<ComputerUseAction>();
    expectTypeOf<CuaExecutor>().toEqualTypeOf<ComputerUseExecutor>();
    expectTypeOf<CuaLoopOptions>().toEqualTypeOf<ComputerUseLoopOptions>();
    expectTypeOf<CuaLoopResult>().toEqualTypeOf<ComputerUseLoopResult>();
    expectTypeOf<CuaObservation>().toEqualTypeOf<ComputerUseObservation>();
    expectTypeOf<CuaProvider>().toEqualTypeOf<ComputerUseProvider>();
    expectTypeOf<CuaSafetyCheck>().toEqualTypeOf<ComputerUseSafetyCheck>();
    expectTypeOf<CuaTurn>().toEqualTypeOf<ComputerUseTurn>();
    expectTypeOf<CuaTurnRequest>().toEqualTypeOf<ComputerUseTurnRequest>();
    expectTypeOf(humanish.runLab).toEqualTypeOf(humanish.runStudy);
    expectTypeOf(humanish.parseLabConfig).toEqualTypeOf(humanish.parseStudy);
  });

  it("each carry @deprecated where they are declared", async () => {
    const file = "src/library-aliases.ts";
    const text = await readFile(file, "utf8");
    const { program, comments } = parseSync(file, text);
    const exported = program.body.filter(
      (statement) => statement.type === "ExportNamedDeclaration",
    );
    const undeprecated = exported.filter(
      (statement) =>
        !comments.some(
          (comment) =>
            comment.type === "Block" &&
            comment.value.includes("@deprecated") &&
            text.slice(comment.end, statement.start).trim() === "",
        ),
    );
    expect(exported).toHaveLength(21);
    expect(undeprecated.map((statement) => text.slice(statement.start, statement.end))).toEqual([]);
  });
});
