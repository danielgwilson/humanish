// Every configuration refusal the terminal runner makes before a run starts, alone and paired with
// the next rule in its chain, so a change to which refusal wins shows up as a golden diff.

import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { StudyConfig } from "../../../src/study/types.js";
import { V2_SCHEMA } from "../../../src/study/types.js";
import { runTerminalProductLab } from "../../../src/routes/terminal/route.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const valid = {
  schema: V2_SCHEMA,
  id: "terminal-admission",
  subject: {
    source: "terminal-product",
    product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] },
  },
  actors: [{ type: "codex-exec" }],
  execution: { target: "e2b-terminal", runtimeAuth: "openai-env" },
  scenario: { caps: { maxUsd: 0, maxMinutes: 5 } },
};

type Patch = (config: Record<string, unknown>) => void;
const rules: [string, Patch][] = [
  ["real receiving", (c) => (c.comms = { email: { kind: "real", connection: "team-inbox" } })],
  [
    "media",
    (c) => (c.execution = { ...(c.execution as object), desktop: { recording: { audio: false } } }),
  ],
  ["invalid analysis", (c) => (c.review = { analysis: "yes" })],
  ["tasks", (c) => (c.actors = [{ type: "codex-exec", tasks: [{ id: "t", goal: "g" }] }])],
  ["unregistered actor", (c) => (c.actors = [{ type: "not-an-actor" }])],
  [
    "runtime version",
    (c) => (c.execution = { ...(c.execution as object), runtime: { version: "latest" } }),
  ],
  [
    "product without surfaces",
    (c) => (c.subject = { source: "terminal-product", product: { name: "w", publicSurfaces: [] } }),
  ],
  ["live without caps", (c) => (c.scenario = { mode: "live" })],
  [
    "live positive maxUsd",
    (c) => (c.scenario = { mode: "live", caps: { maxUsd: 1, maxMinutes: 5 } }),
  ],
];

function configWith(patches: Patch[]): StudyConfig {
  const config = structuredClone(valid) as Record<string, unknown>;
  for (const patch of patches) patch(config);
  return config as unknown as StudyConfig;
}

const cases: [string, StudyConfig][] = [
  ...rules.map(([name, patch]) => [name, configWith([patch])] as [string, StudyConfig]),
  // Missing caps and a positive maxUsd cannot both hold, so the last rule is not paired.
  ...rules.slice(0, -2).map(([name, patch], index) => {
    const [next, nextPatch] = rules[index + 1]!;
    // Tasks live on the actor, so pairing tasks with an unregistered actor keeps both.
    const patches =
      next === "unregistered actor"
        ? [
            patch,
            (c: Record<string, unknown>) =>
              (c.actors = [{ type: "not-an-actor", tasks: [{ id: "t", goal: "g" }] }]),
          ]
        : [nextPatch, patch];
    return [`${name} and ${next}`, configWith(patches)] as [string, StudyConfig];
  }),
];

describe("terminal admission order", () => {
  it("pins each refusal and which one wins", async () => {
    const results: Record<string, unknown> = {};
    for (const [name, config] of cases) {
      const cwd = await mkdtemp(path.join(tmpdir(), "humanish-terminal-admission-"));
      dirs.push(cwd);
      const dryRun = config.scenario?.mode !== "live";
      const result = await runTerminalProductLab({ cwd, config, dryRun, env: {} });
      expect(await readdir(cwd), name).toEqual([]);
      let text = JSON.stringify(result);
      for (const dir of [await realpath(cwd), cwd]) text = text.split(dir).join("[cwd]");
      results[name] = JSON.parse(text);
    }
    await expect(`${JSON.stringify(results, null, 2)}\n`).toMatchFileSnapshot(
      "../../golden/routes/terminal-admission.json",
    );
  });
});
