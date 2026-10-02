// Pins the JSON contract of every structured command: field names and value types, never values.
// Ids, paths, timestamps and messages vary by machine and run, so a golden records "string" for
// each of them. A changed field name, a dropped field, a new field or a changed type fails here,
// so a PR that rewrites human output cannot move the JSON beside it.
import { CommanderError, type Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";

type Shape = string | Shape[] | { [key: string]: Shape };

async function runJson(args: string[]): Promise<{ exitCode: number; json: unknown }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: () => {},
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(["node", "humanish", ...args, "--json"], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { exitCode, json: JSON.parse(stdout.join("")) };
}

/** A value's shape: primitives become their type name; arrays merge their elements' shapes. */
function shapeOf(value: unknown): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const shapes = value.map(shapeOf);
    return shapes.length === 0 ? [] : [shapes.reduce(mergeShapes)];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(
      entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, shapeOf(item)]),
    );
  }
  return typeof value;
}

/** Two shapes of the same field: object keys missing from either side end in "?". */
function mergeShapes(a: Shape, b: Shape): Shape {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    const items = [...a, ...b];
    return items.length === 0 ? [] : [items.reduce(mergeShapes)];
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const required = (key: string) => key.replace(/\?$/, "");
    const merged: Record<string, Shape> = {};
    const names = new Set([...Object.keys(a), ...Object.keys(b)].map(required));
    for (const name of [...names].sort((x, y) => x.localeCompare(y))) {
      const left = a[name] ?? a[`${name}?`];
      const right = b[name] ?? b[`${name}?`];
      const optional = a[name] === undefined || b[name] === undefined;
      const shape =
        left === undefined ? right! : right === undefined ? left : mergeShapes(left, right);
      merged[optional ? `${name}?` : name] = shape;
    }
    return merged;
  }
  const alternatives = new Set(
    [a, b].flatMap((shape) =>
      typeof shape === "string" ? shape.split(" | ") : JSON.stringify(shape),
    ),
  );
  return [...alternatives].sort().join(" | ");
}

// Run in order against one fresh project: doctor before init, then init and one dry run.
const STEPS: ReadonlyArray<readonly [name: string, args: string[]]> = [
  ["doctor-before-init", ["doctor"]],
  ["init", ["init", "--yes"]],
  ["run", ["run", "first-run"]],
  ["doctor", ["doctor"]],
  ["verify", ["verify"]],
  ["review", ["review"]],
  ["runs", ["runs"]],
  ["stats", ["stats"]],
  ["cleanup", ["cleanup"]],
  ["lab-list", ["lab", "list"]],
  ["lab-inspect", ["lab", "inspect", "first-run"]],
  ["feedback-draft", ["feedback", "draft"]],
  ["export", ["export", "--local-only"]],
];

describe("CLI JSON goldens", () => {
  let cwd: string;
  const shapes = new Map<string, { exitCode: number; shape: Shape }>();

  // A key exported in the developer's shell would turn a note row into an ok row.
  const keyNames = ["OPENAI_API_KEY", "E2B_API_KEY", "GH_TOKEN", "CODEX_API_KEY"];
  const savedKeys = new Map(keyNames.map((name) => [name, process.env[name]]));

  beforeAll(async () => {
    for (const name of keyNames) delete process.env[name];
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-json-goldens-"));
    for (const [name, args] of STEPS) {
      const { exitCode, json } = await runJson([...args, "--cwd", cwd]);
      shapes.set(name, { exitCode, shape: shapeOf(json) });
    }
  }, 120_000);

  afterAll(async () => {
    for (const [name, value] of savedKeys) if (value !== undefined) process.env[name] = value;
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(STEPS.map(([name]) => name))("%s keeps its JSON field names and types", async (name) => {
    await expect(`${JSON.stringify(shapes.get(name), null, 2)}\n`).toMatchFileSnapshot(
      `../golden/cli-json/${name}.json`,
    );
  });

  it("marks a field missing from some array items optional and joins differing types", () => {
    expect(shapeOf([{ a: 1, b: "x" }, { a: null }])).toEqual([
      { a: "null | number", "b?": "string" },
    ]);
  });
});
