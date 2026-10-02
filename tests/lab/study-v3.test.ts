// A humanish.study.v3 file parses into the same config as its humanish.lab.v2 source, so the planner
// cannot tell them apart. Each committed lab and each starter variant gets a v3 twin, built here by
// the key mapping in handoffs/2026-10-02-study/DESIGN.md section 3, and three twins are written out
// by hand. Error cases are in study-v3-errors.test.ts.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parseLabConfig } from "../../src/lab/config.js";
import { DEFAULT_LOCAL_BROWSER_STARTER, starterFilesFor } from "../../src/lab/init-templates.js";
import { planLab } from "../../src/lab/plan.js";
import type { PlanResult } from "../../src/lab/plan-types.js";
import { routeOf, type LabRoute } from "../../src/lab/routing.js";
import { LAB_CONFIG_SCHEMA, STUDY_SCHEMA, type LabConfig } from "../../src/lab/types.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

type Raw = Record<string, unknown>;

function record(value: unknown): Raw | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}

function parsed(raw: unknown): { config: LabConfig; warnings: string[] } {
  const result = parseLabConfig(raw);
  if (!result.ok) throw new Error(result.error.message);
  return { config: result.config, warnings: result.warnings };
}

// The v2 keys no v3 study has: each is inert on the route, so the twin leaves it out.
const INERT_EVERYWHERE: readonly [section: string, key: string][] = [
  ["execution", "completionTimeoutMs"],
  ["scenario", "inline"],
  ["review", "scoring"],
  ["review", "milestones"],
  ["review", "vocabulary"],
];

/**
 * The v3 twin of a v2 file, and the v2 paths it leaves out because the route does not read them.
 * This is the mapping `humanish migrate` will apply.
 */
function twin(v2: Raw, route: LabRoute): { study: Raw; dropped: string[] } {
  const source = structuredClone(v2);
  const dropped: string[] = [];
  const drop = (section: Raw | undefined, key: string, label: string) => {
    if (section?.[key] === undefined) return;
    dropped.push(label);
    delete section[key];
  };
  const subject = record(source.subject)!;
  const actor = record((source.actors as unknown[])[0])!;
  const execution = record(source.execution);
  const scenario = record(source.scenario) ?? {};

  delete subject.topology;
  const { count, lanes, roster } = actor;
  const focus = record(actor.laneFocus);
  for (const key of ["count", "lanes", "roster", "laneFocus"]) delete actor[key];
  drop(focus, "id", "actors[0].laneFocus.id");
  drop(focus, "label", "actors[0].laneFocus.label");

  const study: Raw = { schema: STUDY_SCHEMA, id: source.id };
  for (const key of ["title", "description"])
    if (source[key] !== undefined) study[key] = source[key];
  study.route = route;
  if (scenario.mode !== undefined) study.mode = scenario.mode;
  study.subject = subject;
  study.actor = actor;
  if (route === "scripted") {
    if (count !== undefined) study.surfaces = count === 2 ? ["desktop", "mobile"] : ["desktop"];
  } else if (lanes !== undefined || roster !== undefined) {
    study.participants = lanes ?? roster;
  } else if (focus?.instruction !== undefined) {
    study.participants = {
      ...(count === undefined ? {} : { count }),
      instruction: focus.instruction,
    };
  } else if (count !== undefined) {
    study.participants = count;
  }

  const caps = route === "terminal" ? scenario.caps : execution?.caps;
  if (caps !== undefined) study.caps = caps;
  if (route === "terminal") {
    drop(execution, "caps", "execution.caps");
    drop(execution, "timeoutMs", "execution.timeoutMs");
  } else {
    drop(scenario, "caps", "scenario.caps");
  }
  if (execution !== undefined) delete execution.caps;
  for (const [section, key] of INERT_EVERYWHERE)
    drop(record(source[section]), key, `${section}.${key}`);
  drop(record(execution?.desktop), "codexAppServer", "execution.desktop.codexAppServer");
  drop(source, "personas", "personas");
  if (execution !== undefined && Object.keys(execution).length > 0) study.execution = execution;
  if (scenario.ref !== undefined) study.scenario = scenario.ref;
  for (const key of ["policies", "review", "defaults", "comms"]) {
    const section = record(source[key]);
    if (section !== undefined && Object.keys(section).length > 0) study[key] = section;
  }
  return { study, dropped };
}

// The v2 source without the keys its twin leaves out.
function withoutPaths(v2: Raw, paths: readonly string[]): Raw {
  const copy = structuredClone(v2);
  for (const label of paths) {
    const segments = label.replace("actors[0]", "actors.0").split(".");
    const key = segments.pop()!;
    let section: unknown = copy;
    for (const segment of segments) section = (section as Raw)[segment];
    delete (section as Raw)[key];
  }
  return copy;
}

function plans(config: LabConfig): Record<"dry" | "live", PlanResult> {
  return {
    dry: planLab(config, { cwd: ROOT, dryRun: true }),
    live: planLab(config, { cwd: ROOT, dryRun: false }),
  };
}

const forwardDeclared = (warning: string) => warning.startsWith("Forward-declared fields");

// Every check a twin must pass. Returns the keys it left out.
function expectTwin(name: string, v2: Raw): string[] {
  const source = parsed(v2);
  const route = routeOf(source.config);
  const { study, dropped } = twin(v2, route);
  const result = parseLabConfig(study);
  if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
  const projected = parsed(withoutPaths(v2, dropped));
  expect({ ...result.config, schema: LAB_CONFIG_SCHEMA }, name).toEqual(projected.config);
  expect(result.config.schema, name).toBe(STUDY_SCHEMA);
  expect(plans(result.config), name).toEqual(plans(projected.config));
  expect(result.warnings, name).toEqual(source.warnings.filter((w) => !forwardDeclared(w)));
  // The v2 file already warns about each key the twin leaves out, except terminal timeoutMs,
  // which the inert-field table does not list.
  const warned = source.warnings.find(forwardDeclared) ?? "";
  for (const label of dropped.filter((key) => key !== "execution.timeoutMs"))
    expect(warned, `${name}: ${label}`).toContain(label);
  return dropped;
}

async function committedSources(): Promise<[string, Raw][]> {
  const dir = path.join(ROOT, "humanish", "labs");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".yaml")).sort();
  return Promise.all(
    names.map(async (name): Promise<[string, Raw]> => [
      name,
      parse(await readFile(path.join(dir, name), "utf8")) as Raw,
    ]),
  );
}

describe("humanish.study.v3 twins", () => {
  it("parse every committed lab into the same config, plans and warnings", async () => {
    const sources = await committedSources();
    expect(sources).toHaveLength(21);
    const dropped: Record<string, string[]> = {};
    for (const [name, v2] of sources) {
      const left = expectTwin(name, v2);
      if (left.length > 0) dropped[name] = left;
    }
    // What migrate will report as removed.
    expect(dropped).toEqual({
      "first-contact.yaml": ["execution.timeoutMs"],
      "handed-a-human-surface.yaml": ["execution.timeoutMs"],
      "last-mile.yaml": ["execution.timeoutMs"],
      "terminal-product-demo.yaml": ["execution.timeoutMs"],
    });
  });

  it("parse every starter variant into the same config, plans and warnings", () => {
    const variants = [
      starterFilesFor("openai-computer-use"),
      starterFilesFor("local-agent", DEFAULT_LOCAL_BROWSER_STARTER, "codex"),
      starterFilesFor("local-agent", DEFAULT_LOCAL_BROWSER_STARTER, "claude"),
    ];
    const seen = new Set<string>();
    for (const [index, files] of variants.entries()) {
      for (const file of files.filter((f) => /^humanish\/labs\/.*\.yaml$/.test(f.path))) {
        expect(expectTwin(`${index}:${file.path}`, parse(file.contents) as Raw)).toEqual([]);
        seen.add(file.path);
      }
    }
    expect([...seen].sort()).toEqual([
      "humanish/labs/cua-browser.yaml",
      "humanish/labs/first-run.yaml",
      "humanish/labs/lobby-trivia-3player.yaml",
      "humanish/labs/local-browser.yaml",
      "humanish/labs/try-live.yaml",
    ]);
  });
});

function starter(file: string, ...args: Parameters<typeof starterFilesFor>): Raw {
  const found = starterFilesFor(...args).find((f) => f.path === `humanish/labs/${file}`);
  return parse(found!.contents) as Raw;
}

describe("hand-written humanish.study.v3 twins", () => {
  it("first-run", () => {
    const v2 = starter("first-run.yaml", "openai-computer-use");
    const study = parse(`schema: humanish.study.v3
id: first-run
title: ${JSON.stringify(v2.title)}
description: ${JSON.stringify(v2.description)}
route: preview
mode: dry-run
subject:
  source: this-repo
actor:
  type: synthetic-persona
participants: 4
defaults:
  open: true
`);
    expect({ ...parsed(study).config, schema: LAB_CONFIG_SCHEMA }).toEqual(parsed(v2).config);
  });

  it("local-browser", () => {
    const v2 = starter("local-browser.yaml", "openai-computer-use");
    const study = parse(`schema: humanish.study.v3
id: local-browser
title: ${JSON.stringify(v2.title)}
description: ${JSON.stringify(v2.description)}
route: computer-use
mode: live
subject:
  source: app-url
  appUrl: ${JSON.stringify(DEFAULT_LOCAL_BROWSER_STARTER.appUrl)}
actor:
  type: local-agent
  localAgent: codex
  persona: synthetic-new-user
  mission: ${JSON.stringify(DEFAULT_LOCAL_BROWSER_STARTER.mission)}
execution:
  target: local
  concurrency: 1
  timeoutMs: 120000
defaults:
  open: true
`);
    expect({ ...parsed(study).config, schema: LAB_CONFIG_SCHEMA }).toEqual(parsed(v2).config);
  });

  it("try-live, openai-computer-use variant", () => {
    const v2 = starter("try-live.yaml", "openai-computer-use");
    const study = parse(`schema: humanish.study.v3
id: try-live
title: ${JSON.stringify(v2.title)}
description: ${JSON.stringify(v2.description)}
route: computer-use
mode: live
subject:
  source: clone
  repos: [drawdb-io/drawdb]
  clone: { depth: 1 }
  serve:
    install: npm install --no-audit --no-fund
    build: npm run build
    start: npx vite preview --host 127.0.0.1 --port 3000
    url: http://127.0.0.1:3000/
actor:
  type: openai-computer-use
  maxOutputTokens: 8192
  persona: synthetic-new-user
  mission: >-
    You have never seen this diagram tool before. Add two tables and give them meaningful names,
    then stop and say what you did, what confused you, and where you hesitated.
caps:
  maxUsd: 2
execution:
  target: e2b-desktop
  timeoutMs: 600000
defaults:
  open: true
`);
    expect({ ...parsed(study).config, schema: LAB_CONFIG_SCHEMA }).toEqual(parsed(v2).config);
  });
});
