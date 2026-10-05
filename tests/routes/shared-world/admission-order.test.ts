// Every configuration refusal the shared-world runner makes before a run starts, alone and paired
// with a later rule in its chain, so a change to which refusal wins shows up as a golden diff. The
// last two rules (a live run without keys, an unreachable external comms catch) are checked by the
// route itself after the chain; the catch is probed before the run starts.

import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { StudyConfig } from "../../../src/study/types.js";
import type { StudyDeps } from "../../../src/study/study-deps.js";
import { lab } from "../../admission/fixtures.js";
import { runSharedWorld } from "../../helpers/route-run.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

type Raw = Record<string, unknown>;
interface Rule {
  readonly mutate: (config: Raw) => void;
  /** A caller-supplied session runner (never called). */
  readonly runSession?: true;
  /** Provider keys in the environment, so the route's own key check passes. */
  readonly keys?: true;
}

const record = (config: Raw, key: string): Raw => (config[key] ??= {}) as Raw;
const actor = (config: Raw): Raw => (config.actors as Raw[])[0]!;
const external = lab("sharedExternal");

const rules = new Map<string, Rule>([
  [
    "recording",
    { mutate: (c) => (record(record(c, "execution"), "desktop").recording = { audio: false }) },
  ],
  ["invalid analysis", { mutate: (c) => (c.review = { analysis: "yes" }) }],
  ["tasks", { mutate: (c) => (actor(c).tasks = [{ id: "t", goal: "g" }]) }],
  ["unregistered actor", { mutate: (c) => (actor(c).type = "not-an-actor") }],
  ["invalid output limit", { mutate: (c) => (actor(c).maxOutputTokens = 0) }],
  ["scenario dollar cap", { mutate: (c) => (record(c, "scenario").caps = { maxUsd: 1 }) }],
  ["provisioned plane concurrency 1", { mutate: (c) => (record(c, "execution").concurrency = 1) }],
  [
    "external plane without authorization",
    {
      mutate: (c) => {
        c.subject = structuredClone(external.subject);
        record(record(c, "subject"), "publicTarget").authorized = false;
        c.policies = structuredClone(external.policies);
        actor(c).lanes = structuredClone((external.actors as Raw[])[0]!.lanes);
      },
    },
  ],
  [
    "output limit with a custom session",
    { mutate: (c) => (actor(c).maxOutputTokens = 1000), runSession: true },
  ],
  [
    "live cap on an unpriced model",
    {
      mutate: (c) => {
        record(c, "scenario").mode = "live";
        actor(c).model = "unpriced-model";
        record(c, "execution").caps = { maxUsd: 1 };
      },
    },
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
  ["clone without a repo slug", { mutate: (c) => (record(c, "subject").repos = ["not a slug"]) }],
  [
    "external plane without an owner",
    {
      mutate: (c) => {
        rules.get("external plane without authorization")!.mutate(c);
        const publicTarget = record(record(c, "subject"), "publicTarget");
        publicTarget.authorized = true;
        delete publicTarget.owner;
      },
    },
  ],
  ["live without keys", { mutate: (c) => (record(c, "scenario").mode = "live") }],
  [
    "live external catch unreachable",
    {
      mutate: (c) => {
        rules.get("external plane without authorization")!.mutate(c);
        record(record(c, "subject"), "publicTarget").authorized = true;
        record(c, "scenario").mode = "live";
        c.comms = { email: { kind: "fake", external: { catchBaseUrl: "http://127.0.0.1:9/" } } };
      },
      keys: true,
    },
  ],
]);

// Each rule paired with a later one that can hold at the same time.
const pairs: [string, string][] = [
  ["recording", "invalid analysis"],
  ["invalid analysis", "tasks"],
  ["tasks", "unregistered actor"],
  ["unregistered actor", "invalid output limit"],
  ["invalid output limit", "scenario dollar cap"],
  ["scenario dollar cap", "provisioned plane concurrency 1"],
  ["provisioned plane concurrency 1", "output limit with a custom session"],
  ["external plane without authorization", "output limit with a custom session"],
  ["output limit with a custom session", "live cap on an unpriced model"],
  ["live cap on an unpriced model", "real receiving with local-agent"],
  ["real receiving with local-agent", "live without keys"],
  ["real receiving with local-agent", "clone without a repo slug"],
  ["clone without a repo slug", "live without keys"],
  ["real receiving with local-agent", "external plane without an owner"],
  ["external plane without an owner", "live without keys"],
];

function caseOf(names: readonly string[]): {
  config: StudyConfig;
  env: Record<string, string>;
  deps: StudyDeps;
} {
  const config = lab("sharedProvisioned");
  // The later rule first, so the earlier rule's change is the one that stands where they overlap.
  const selected = names.map((name) => rules.get(name)!);
  for (const rule of [...selected].reverse()) rule.mutate(config);
  const never = async (): Promise<never> => {
    throw new Error("admission cases must not reach a caller hook");
  };
  const env = selected.some((rule) => rule.keys)
    ? { OPENAI_API_KEY: "sk-test-openai", E2B_API_KEY: "e2b-test-key" }
    : {};
  const deps: StudyDeps = {
    desktopModule: never,
    ...(selected.some((rule) => rule.runSession) ? { runSession: never } : {}),
  };
  return { config: config as unknown as StudyConfig, env, deps };
}

const cases: [string, readonly string[]][] = [
  ...[...rules.keys()].map((name) => [name, [name]] as [string, string[]]),
  ...pairs.map(
    ([first, second]) => [`${first} and ${second}`, [first, second]] as [string, string[]],
  ),
];

describe("shared-world admission order", () => {
  it("pins each refusal and which one wins", async () => {
    const results: Record<string, unknown> = {};
    for (const [name, names] of cases) {
      const cwd = await mkdtemp(path.join(tmpdir(), "humanish-sw-admission-"));
      dirs.push(cwd);
      const { config, env, deps } = caseOf(names);
      const dryRun = config.scenario?.mode !== "live";
      const result = await runSharedWorld({ cwd, config, dryRun, env, deps });
      expect(await readdir(cwd), name).toEqual([]);
      let text = JSON.stringify(result);
      for (const dir of [await realpath(cwd), cwd]) text = text.split(dir).join("[cwd]");
      results[name] = JSON.parse(text);
    }
    await expect(`${JSON.stringify(results, null, 2)}\n`).toMatchFileSnapshot(
      "../../golden/routes/shared-world-admission.json",
    );
  });
});
