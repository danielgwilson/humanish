// Every configuration refusal the scripted runner makes before a run starts, alone and paired with
// the next rule in its chain, so a change to which refusal wins shows up as a golden diff. The last
// rule (a live clone without an E2B key) is checked by the route itself after the chain.

import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { StudyConfig } from "../../../src/study/types.js";
import { lab, SCENARIO_YAML } from "../../admission/fixtures.js";
import { runScripted } from "../../helpers/route-run.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

type Raw = Record<string, unknown>;
type Mutate = (config: Raw) => void;

const record = (config: Raw, key: string): Raw => config[key] as Raw;
const actor = (config: Raw): Raw => (config.actors as Raw[])[0]!;
const cloneSubject = lab("scriptedClone").subject as Raw;

const rules: [string, Mutate][] = [
  ["real receiving", (c) => (c.comms = { email: { kind: "real", connection: "team-inbox" } })],
  ["invalid analysis", (c) => (c.review = { analysis: "yes" })],
  ["tasks", (c) => (actor(c).tasks = [{ id: "t", goal: "g" }])],
  [
    "media",
    (c) => (record(c, "execution").desktop = { media: { camera: { source: "synthetic" } } }),
  ],
  [
    "clone on the local target",
    (c) => {
      c.subject = structuredClone(cloneSubject);
      record(c, "execution").target = "local";
    },
  ],
  ["unregistered actor", (c) => (actor(c).type = "not-an-actor")],
  ["public app url", (c) => (record(c, "subject").appUrl = "https://example.com/")],
  [
    "clone without serve",
    (c) => {
      const { serve: _serve, ...subject } = structuredClone(cloneSubject);
      c.subject = subject;
      record(c, "execution").target = "e2b-desktop";
    },
  ],
  ["missing scenario ref", (c) => delete record(c, "scenario").ref],
  [
    "live clone without an E2B key",
    (c) => {
      c.subject = structuredClone(cloneSubject);
      record(c, "execution").target = "e2b-desktop";
      record(c, "scenario").mode = "live";
    },
  ],
];

function configWith(mutations: Mutate[]): StudyConfig {
  const config = lab("scriptedAppUrl");
  for (const mutate of mutations) mutate(config);
  return config as unknown as StudyConfig;
}

// A loopback URL applies only to an app-url subject and serve only to a clone, so those two rules
// cannot hold at once; the URL rule is paired with the rule after them instead.
const pairs = rules.slice(0, -1).map((rule, index) => {
  const next = rule[0] === "public app url" ? rules[index + 2]! : rules[index + 1]!;
  return [rule, next] as const;
});

const cases: [string, StudyConfig][] = [
  ...rules.map(([name, mutate]) => [name, configWith([mutate])] as [string, StudyConfig]),
  ...pairs.map(
    ([[name, mutate], [next, nextMutate]]) =>
      [`${name} and ${next}`, configWith([nextMutate, mutate])] as [string, StudyConfig],
  ),
];

describe("scripted admission order", () => {
  it("pins each refusal and which one wins", async () => {
    const results: Record<string, unknown> = {};
    for (const [name, config] of cases) {
      const cwd = await mkdtemp(path.join(tmpdir(), "humanish-scripted-admission-"));
      dirs.push(cwd);
      await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
      await writeFile(path.join(cwd, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
      const dryRun = config.scenario?.mode !== "live";
      const loadDesktopModule = async (): Promise<never> => {
        throw new Error("admission cases must not load a desktop module");
      };
      const result = await runScripted({
        cwd,
        config,
        dryRun,
        env: {},
        deps: { desktopModule: loadDesktopModule },
      });
      expect(await readdir(cwd), name).toEqual(["humanish"]);
      let text = JSON.stringify(result);
      for (const dir of [await realpath(cwd), cwd]) text = text.split(dir).join("[cwd]");
      results[name] = JSON.parse(text);
    }
    await expect(`${JSON.stringify(results, null, 2)}\n`).toMatchFileSnapshot(
      "../../golden/routes/scripted-admission.json",
    );
  });
});
