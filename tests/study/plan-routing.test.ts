// Pins the route every config shape selects, and the value of every composition predicate, over a
// grid that includes partial and unsupported configs a library caller can pass. The predicates
// overlap (a provisioned shared-world config is also isComputerUseComposition), so each is pinned
// on its own rather than derived from the route.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { routeOf } from "../../src/study/plan.js";
import {
  isComputerUseComposition,
  isSharedWorldComposition,
  isExternalPublicSharedWorldComposition,
  isProvisionedScriptedBrowserComposition,
  isProvisionedSharedWorldComposition,
  isScriptedBrowserComposition,
  isTerminalProductComposition,
} from "../../src/study/routing.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { committedLabs } from "../helpers/committed-labs.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const sources = [
  "this-repo",
  "clone",
  "app-url",
  "local-app",
  "terminal-product",
  "desktop-cli",
  "local-tree",
];
const targets = [undefined, "local", "e2b-desktop", "e2b-terminal"];
const actors = [
  "openai-computer-use",
  "local-agent",
  "scripted-browser",
  "codex-exec",
  "codex-app-server",
  "synthetic-persona",
  "not-an-actor",
];

const predicates = {
  computerUse: isComputerUseComposition,
  sharedWorld: isSharedWorldComposition,
  provisionedSharedWorld: isProvisionedSharedWorldComposition,
  externalPublicSharedWorld: isExternalPublicSharedWorldComposition,
  scriptedBrowser: isScriptedBrowserComposition,
  provisionedScriptedBrowser: isProvisionedScriptedBrowserComposition,
  terminalProduct: isTerminalProductComposition,
};

/** "route predicate-names-that-hold", one line per config. */
function describeRouting(config: StudyConfig): string {
  const held = Object.entries(predicates)
    .filter(([, predicate]) => predicate(config))
    .map(([name]) => name);
  return [routeOf(config), ...held].join(" ");
}

describe("lab routing", () => {
  it("pins the route and every composition predicate over the config grid", async () => {
    const grid: Record<string, string> = {};
    // The topology axis is the declared route: `route: shared-world`, or a route routeOf does not
    // read. Its row keys keep the v2 name, so the golden stays comparable.
    for (const source of sources)
      for (const target of targets)
        for (const type of actors)
          for (const topology of [undefined, "shared-world"])
            for (const allowPublicTargets of [undefined, true]) {
              const config = {
                schema: STUDY_SCHEMA,
                id: "grid",
                route: topology ?? "computer-use",
                subject: { source },
                actor: { type },
                ...(target === undefined ? {} : { execution: { target } }),
                ...(allowPublicTargets === undefined ? {} : { policies: { allowPublicTargets } }),
              } as unknown as StudyConfig;
              const key = [
                source,
                target ?? "-",
                type,
                topology ?? "-",
                allowPublicTargets ? "public" : "-",
              ];
              grid[key.join(" ")] = describeRouting(config);
            }
    expect(Object.keys(grid)).toHaveLength(784);
    await expect(`${JSON.stringify(grid, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/plans/routing-grid.json",
    );
  });

  it("pins the route of every committed lab", async () => {
    const committed: Record<string, string> = {};
    for (const [id, config] of await committedLabs(ROOT)) committed[id] = describeRouting(config);
    expect(Object.keys(committed).length).toBeGreaterThan(0);
    await expect(`${JSON.stringify(committed, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/plans/routing-committed.json",
    );
  });
});
