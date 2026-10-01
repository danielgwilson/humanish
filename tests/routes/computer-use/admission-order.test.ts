// Every configuration refusal the computer-use runner makes before a run starts, alone and paired
// with a later rule in its chain, so a change to which refusal wins shows up as a golden diff. The
// last rule (a live run without keys) is checked by the route itself after the chain.

import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { LabConfig } from "../../../src/lab/types.js";
import { runCuaActorLab } from "../../../src/routes/computer-use/route.js";
import type { CuaActorLabHooks } from "../../../src/routes/computer-use/types.js";
import { lab } from "../../admission/fixtures.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

type Raw = Record<string, unknown>;
interface Rule {
  readonly mutate: (config: Raw) => void;
  readonly executor?: true;
  readonly provider?: true;
  /** The runner's count override (the CLI's --count). */
  readonly countOverride?: number;
}

const record = (config: Raw, key: string): Raw => (config[key] ??= {}) as Raw;
const actor = (config: Raw): Raw => (config.actors as Raw[])[0]!;
const cloneSubject = lab("cuClone").subject as Raw;
const asClone = (config: Raw): void => {
  if (record(config, "subject").source !== "clone") config.subject = structuredClone(cloneSubject);
};
const camera = { camera: { source: "synthetic" } };
const inProcess = { executor: true, provider: true } as const;

const rules = new Map<string, Rule>([
  ["invalid analysis", { mutate: (c) => (c.review = { analysis: "yes" }) }],
  [
    "tasks on a second actor",
    {
      mutate: (c) =>
        (c.actors as Raw[]).push({ type: "openai-computer-use", tasks: [{ id: "t", goal: "g" }] }),
    },
  ],
  ["unregistered actor", { mutate: (c) => (actor(c).type = "not-an-actor") }],
  [
    "media with firefox",
    {
      mutate: (c) =>
        Object.assign(record(record(c, "execution"), "desktop"), {
          browser: "firefox",
          media: camera,
        }),
    },
  ],
  ["invalid output limit", { mutate: (c) => (actor(c).maxOutputTokens = 0) }],
  ["scenario dollar cap", { mutate: (c) => (record(c, "scenario").caps = { maxUsd: 1 }) }],
  [
    "output limit with a caller provider",
    { mutate: (c) => (actor(c).maxOutputTokens = 1000), provider: true },
  ],
  [
    "real receiving with local-agent",
    {
      mutate: (c) => {
        c.comms = { email: { kind: "real", connection: "team-inbox" } };
        actor(c).type = "local-agent";
      },
    },
  ],
  [
    "in-process real receiving",
    {
      mutate: (c) => (c.comms = { email: { kind: "real", connection: "team-inbox" } }),
      ...inProcess,
    },
  ],
  [
    "in-process media",
    { mutate: (c) => (record(record(c, "execution"), "desktop").media = camera), ...inProcess },
  ],
  [
    "in-process recording",
    {
      mutate: (c) => (record(record(c, "execution"), "desktop").recording = { audio: false }),
      ...inProcess,
    },
  ],
  [
    "clone on the local target",
    {
      mutate: (c) => {
        asClone(c);
        record(c, "execution").target = "local";
      },
    },
  ],
  [
    "clone without serve",
    {
      mutate: (c) => {
        asClone(c);
        delete record(c, "subject").serve;
      },
    },
  ],
  ["local-tree without serve", { mutate: (c) => (c.subject = { source: "local-tree" }) }],
  [
    "state on app-url",
    {
      mutate: (c) =>
        (record(c, "subject").state = { seed: [{ name: "seed", command: "pnpm db:seed" }] }),
    },
  ],
  ["public app url", { mutate: (c) => (record(c, "subject").appUrl = "https://example.com/") }],
  ["executor without provider", { mutate: () => undefined, executor: true }],
  [
    "local-app without executor",
    {
      mutate: (c) => {
        c.subject = { source: "local-app", appUrl: "http://127.0.0.1:3000/" };
        record(c, "execution").target = "local";
      },
    },
  ],
  ["local browser without a runtime", { mutate: (c) => (record(c, "execution").target = "local") }],
  [
    "lanes and count",
    {
      mutate: (c) => {
        actor(c).count = 2;
        actor(c).lanes = [{ id: "one" }, { id: "two" }];
      },
    },
  ],
  ["sandbox deadline", { mutate: (c) => (record(c, "execution").timeoutMs = 3_300_000) }],
  ["shared-world topology", { mutate: (c) => (record(c, "subject").topology = "shared-world") }],
  ["in-process clone subject", { mutate: asClone, ...inProcess }],
  [
    "in-process desktop-cli without a product",
    { mutate: (c) => (c.subject = { source: "desktop-cli" }), ...inProcess },
  ],
  ["desktop-cli without a product", { mutate: (c) => (c.subject = { source: "desktop-cli" }) }],
  ["count override above the cap", { mutate: () => undefined, countOverride: 17 }],
  ["in-process fan-out", { mutate: (c) => (actor(c).count = 2), ...inProcess }],
  ["live without keys", { mutate: (c) => (record(c, "scenario").mode = "live") }],
]);

// Each rule paired with a later one that can hold at the same time. Rules on exclusive subjects
// (a clone and a local-tree, a local-app and an app-url) skip to the next rule that can.
const pairs: [string, string][] = [
  ["invalid analysis", "tasks on a second actor"],
  ["tasks on a second actor", "unregistered actor"],
  ["unregistered actor", "media with firefox"],
  ["media with firefox", "invalid output limit"],
  ["invalid output limit", "scenario dollar cap"],
  ["scenario dollar cap", "output limit with a caller provider"],
  ["output limit with a caller provider", "in-process real receiving"],
  ["real receiving with local-agent", "in-process real receiving"],
  ["in-process real receiving", "in-process media"],
  ["in-process media", "in-process recording"],
  ["in-process recording", "clone on the local target"],
  ["clone on the local target", "clone without serve"],
  ["clone without serve", "public app url"],
  ["local-tree without serve", "public app url"],
  ["state on app-url", "public app url"],
  ["public app url", "executor without provider"],
  ["executor without provider", "local-app without executor"],
  ["local-app without executor", "lanes and count"],
  ["local browser without a runtime", "lanes and count"],
  ["lanes and count", "sandbox deadline"],
  ["sandbox deadline", "count override above the cap"],
  ["sandbox deadline", "shared-world topology"],
  ["shared-world topology", "count override above the cap"],
  ["shared-world topology", "in-process clone subject"],
  ["in-process clone subject", "count override above the cap"],
  ["desktop-cli without a product", "count override above the cap"],
  ["count override above the cap", "in-process fan-out"],
  ["in-process fan-out", "live without keys"],
];

function caseOf(names: readonly string[]): {
  config: LabConfig;
  hooks: CuaActorLabHooks;
  countOverride?: number;
} {
  const config = lab("cuAppUrl");
  // The later rule first, so the earlier rule's change is the one that stands where they overlap.
  const selected = names.map((name) => rules.get(name)!);
  for (const rule of [...selected].reverse()) rule.mutate(config);
  const never = async (): Promise<never> => {
    throw new Error("admission cases must not reach a caller hook");
  };
  const hooks: CuaActorLabHooks = {
    env: {},
    loadDesktopModule: never,
    ...(selected.some((rule) => rule.executor) ? { buildExecutor: never } : {}),
    ...(selected.some((rule) => rule.provider) ? { buildProvider: never } : {}),
  };
  const countOverride = selected.find((rule) => rule.countOverride !== undefined)?.countOverride;
  return {
    config: config as unknown as LabConfig,
    hooks,
    ...(countOverride === undefined ? {} : { countOverride }),
  };
}

const cases: [string, readonly string[]][] = [
  ...[...rules.keys()].map((name) => [name, [name]] as [string, string[]]),
  ...pairs.map(
    ([first, second]) => [`${first} and ${second}`, [first, second]] as [string, string[]],
  ),
];

describe("computer-use admission order", () => {
  it("pins each refusal and which one wins", async () => {
    const results: Record<string, unknown> = {};
    for (const [name, names] of cases) {
      const cwd = await mkdtemp(path.join(tmpdir(), "humanish-cu-admission-"));
      dirs.push(cwd);
      const { config, hooks, countOverride } = caseOf(names);
      const dryRun = config.scenario?.mode !== "live";
      const result = await runCuaActorLab({
        cwd,
        config,
        dryRun,
        hooks,
        ...(countOverride === undefined ? {} : { countOverride }),
      });
      expect(await readdir(cwd), name).toEqual([]);
      let text = JSON.stringify(result);
      for (const dir of [await realpath(cwd), cwd]) text = text.split(dir).join("[cwd]");
      results[name] = JSON.parse(text);
    }
    await expect(`${JSON.stringify(results, null, 2)}\n`).toMatchFileSnapshot(
      "../../golden/routes/computer-use-admission.json",
    );
  });

  it("reads committed personas before it refuses the lane cap", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-cu-admission-"));
    dirs.push(cwd);
    await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "personas", "first-time-visitor.yaml"),
      "background: 5\n",
    );
    const { config, hooks } = caseOf([]);
    await expect(
      runCuaActorLab({ cwd, config, dryRun: true, hooks, countOverride: 17 }),
    ).rejects.toThrow("Persona background must be text.");
  });
});
