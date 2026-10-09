// Every configuration refusal the computer-use runner makes before a run starts, alone and paired
// with a later rule in its chain, so a change to which refusal wins shows up as a golden diff. The
// last rule (a live run without keys) is checked by the route itself after the chain.

import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { StudyConfig } from "../../../src/study/types.js";
import type { StudyDeps } from "../../../src/study/study-deps.js";
import type { ComputerUseRunInput } from "../../../src/routes/computer-use/types.js";
import { libraryLab } from "../../admission/fixtures.js";
import { runComputerUse } from "../../helpers/route-run.js";

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
const actor = (config: Raw): Raw => config.actor as Raw;
const cloneSubject = libraryLab("cuClone").subject as Raw;
const asClone = (config: Raw): void => {
  if (record(config, "subject").source !== "clone") config.subject = structuredClone(cloneSubject);
};
const camera = { camera: { source: "synthetic" } };
const inProcess = { executor: true, provider: true } as const;

const rules = new Map<string, Rule>([
  ["invalid analysis", { mutate: (c) => (c.review = { analysis: "yes" }) }],
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
  ["invalid wait limit", { mutate: (c) => (actor(c).maxWaitMs = 0) }],
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
  // Admission checks this after every planner rule, so its pairs name it as the later rule.
  ["local browser without a runtime", { mutate: (c) => (record(c, "execution").target = "local") }],
  ["sandbox deadline", { mutate: (c) => (record(c, "execution").timeoutMs = 3_300_000) }],
  ["shared-world topology", { mutate: (c) => (c.route = "shared-world") }],
  ["in-process clone subject", { mutate: asClone, ...inProcess }],
  [
    "in-process desktop-cli without a product",
    { mutate: (c) => (c.subject = { source: "desktop-cli" }), ...inProcess },
  ],
  ["desktop-cli without a product", { mutate: (c) => (c.subject = { source: "desktop-cli" }) }],
  ["count override above the cap", { mutate: () => undefined, countOverride: 101 }],
  ["in-process fan-out", { mutate: (c) => (c.participants = 2), ...inProcess }],
  ["live without keys", { mutate: (c) => (c.mode = "live") }],
]);

// Each rule paired with a later one that can hold at the same time. Rules on exclusive subjects
// (a clone and a local-tree, a local-app and an app-url) skip to the next rule that can.
const pairs: [string, string][] = [
  ["invalid analysis", "unregistered actor"],
  ["unregistered actor", "media with firefox"],
  ["media with firefox", "invalid output limit"],
  ["invalid output limit", "invalid wait limit"],
  ["invalid output limit", "output limit with a caller provider"],
  ["invalid wait limit", "output limit with a caller provider"],
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
  ["local-app without executor", "sandbox deadline"],
  // A planner rule refuses before admission finds no local desktop.
  ["shared-world topology", "local browser without a runtime"],
  ["count override above the cap", "local browser without a runtime"],
  ["in-process fan-out", "local browser without a runtime"],
  // Admission checks for the local desktop before it checks keys.
  ["local browser without a runtime", "live without keys"],
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
  config: StudyConfig;
  deps: StudyDeps;
  driving: Pick<ComputerUseRunInput, "inProcess" | "createProvider">;
  countOverride?: number;
} {
  const config = libraryLab("cuAppUrl");
  // The later rule first, so the earlier rule's change is the one that stands where they overlap.
  const selected = names.map((name) => rules.get(name)!);
  for (const rule of [...selected].reverse()) rule.mutate(config);
  const never = async (): Promise<never> => {
    throw new Error("admission cases must not reach a caller hook");
  };
  const deps: StudyDeps = { desktopModule: never };
  const driving = {
    ...(selected.some((rule) => rule.executor) ? { inProcess: { executor: never } } : {}),
    ...(selected.some((rule) => rule.provider) ? { createProvider: never } : {}),
  };
  const countOverride = selected.find((rule) => rule.countOverride !== undefined)?.countOverride;
  return {
    config: config as unknown as StudyConfig,
    deps,
    driving,
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
      const { config, deps, driving, countOverride } = caseOf(names);
      const dryRun = config.mode !== "live";
      const result = await runComputerUse({
        cwd,
        config,
        dryRun,
        env: {},
        deps,
        ...driving,
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

  it("reads committed personas before it refuses the participant cap", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-cu-admission-"));
    dirs.push(cwd);
    await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "personas", "first-time-visitor.yaml"),
      "background: 5\n",
    );
    const { config, deps } = caseOf([]);
    await expect(
      runComputerUse({ cwd, config, dryRun: true, env: {}, deps, countOverride: 101 }),
    ).rejects.toThrow("Persona background must be text.");
  });
});
