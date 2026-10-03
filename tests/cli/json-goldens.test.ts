// Pins the JSON contract of every structured command: field names and value types, plus check
// names and enum values (the pins below). Ids, paths, timestamps and messages vary by machine and
// run, so a golden records "string" for each of them. A changed field name, a dropped field, a new
// field, a changed type, a renamed check or a new enum value fails here, so a PR that rewrites
// human output cannot move the JSON beside it.
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
  const text = stdout.join("");
  try {
    return { exitCode, json: JSON.parse(text) };
  } catch {
    throw new Error(`humanish ${args.join(" ")} printed no JSON: ${text.slice(0, 200)}`);
  }
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

// Run in order against one fresh project: doctor before init, then init and one dry run. Each
// command gets `--cwd <project>` except those in NO_CWD, which take no project.
const NO_CWD = new Set(["comms-providers", "keys-list", "telemetry-status"]);
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
  ["study-list", ["study", "list"]],
  ["study-show", ["study", "show", "first-run"]],
  ["feedback-draft", ["feedback", "draft"]],
  ["export", ["export", "--local-only"]],
  ["study-check", ["study", "check", "first-run"]],
  ["analyze-refused", ["analyze"]],
  ["analyze-list", ["analyze", "list"]],
  ["feedback-list", ["feedback", "list"]],
  ["feedback-verify", ["feedback", "verify"]],
  ["feedback-issue-url", ["feedback", "issue-url", "--repo", "example/app"]],
  ["reclaim", ["reclaim"]],
  ["comms-providers", ["comms", "providers"]],
  ["comms-connections-list", ["comms", "connections", "list"]],
  ["keys-list", ["keys", "list"]],
  ["telemetry-status", ["telemetry", "status"]],
  ["lab-run", ["lab", "run", "first-run"]],
];

type Json = Record<string, unknown>;
const rows = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
// A local agent row exists only on a machine with Codex or Claude Code installed.
const doctorNames = (json: Json) =>
  rows(json.checks)
    .map((check) => check.name)
    .filter((name) => typeof name === "string" && !name.startsWith("local agent"));

/**
 * Values pinned beside the shape: check names and enum fields, so a renamed check or a new enum
 * value fails here. Machine-dependent values (statuses, local agent rows, messages) stay out.
 */
const PINS: Readonly<Record<string, (json: Json) => unknown>> = {
  "doctor-before-init": (json) => ({ checks: doctorNames(json) }),
  doctor: (json) => ({ checks: doctorNames(json) }),
  init: (json) => ({
    mode: json.mode,
    actions: [...new Set(rows(json.changes).map((change) => change.action))].sort(),
  }),
  run: (json) => ({ mode: json.mode }),
  "lab-run": (json) => ({ mode: json.mode }),
  verify: (json) => ({
    checks: rows(json.checks).map((check) => [check.name, check.ok]),
    shareSafety: (json.shareSafety as Json).status,
  }),
  review: (json) => ({ verdict: json.verdict }),
  runs: (json) => ({ modes: rows(json.runs).map((run) => run.mode) }),
  export: (json) => ({ shareSafety: (json.shareSafety as Json).status }),
  "study-list": (json) => ({ ids: rows(json.studies).map((study) => study.id) }),
  "study-check": (json) => ({
    route: json.route,
    reachability: json.reachability,
    checks: rows(json.checks).map((check) => check.name),
  }),
  "analyze-refused": (json) => ({ code: (json.error as Json).code }),
  "comms-providers": (json) => ({ ids: rows(json.providers).map((provider) => provider.id) }),
  "keys-list": (json) => ({ action: json.action }),
};

describe("CLI JSON goldens", () => {
  let cwd: string;
  const shapes = new Map<string, { exitCode: number; shape: Shape; pinned?: unknown }>();

  // A key exported in the developer's shell would turn a note row into an ok row.
  const keyNames = [
    "OPENAI_API_KEY",
    "E2B_API_KEY",
    "GH_TOKEN",
    "CODEX_API_KEY",
    "AGENTMAIL_API_KEY",
  ];
  const savedKeys = new Map(keyNames.map((name) => [name, process.env[name]]));

  const savedConfigHome = process.env.XDG_CONFIG_HOME;

  beforeAll(async () => {
    for (const name of keyNames) delete process.env[name];
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-json-goldens-"));
    // keys list and telemetry status read the user config directory; give them an empty one.
    process.env.XDG_CONFIG_HOME = path.join(cwd, "user-config");
    for (const [name, args] of STEPS) {
      const { exitCode, json } = await runJson(NO_CWD.has(name) ? args : [...args, "--cwd", cwd]);
      const pin = PINS[name];
      shapes.set(name, {
        exitCode,
        shape: shapeOf(json),
        ...(pin === undefined ? {} : { pinned: pin(json as Json) }),
      });
    }
  }, 120_000);

  afterAll(async () => {
    for (const [name, value] of savedKeys) if (value !== undefined) process.env[name] = value;
    if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfigHome;
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(STEPS.map(([name]) => name))(
    "%s keeps its JSON field names, types and pinned values",
    async (name) => {
      await expect(`${JSON.stringify(shapes.get(name), null, 2)}\n`).toMatchFileSnapshot(
        `../golden/cli-json/${name}.json`,
      );
    },
  );

  it("marks a field missing from some array items optional and joins differing types", () => {
    expect(shapeOf([{ a: 1, b: "x" }, { a: null }])).toEqual([
      { a: "null | number", "b?": "string" },
    ]);
  });
});
