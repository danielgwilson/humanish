// Pins the route every config shape selects, and the value of every exported routesTo* predicate,
// over a grid that includes partial and unsupported configs a library caller can pass. The
// predicates overlap (a provisioned shared-world config is also routesToComputerUse), so each is
// pinned on its own rather than derived from the route.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { listLabManifests, resolveLabManifest } from "../../src/lab/discover.js";
import { selectLabBackend } from "../../src/lab/engine.js";
import {
  routesToComputerUse,
  routesToConcurrentSharedWorld,
  routesToExternalPublicSharedWorld,
  routesToProvisionedScriptedBrowser,
  routesToProvisionedSharedWorld,
  routesToScriptedBrowser,
  routesToSharedWorld,
  routesToTerminalProduct,
} from "../../src/lab/routing.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";

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
  computerUse: routesToComputerUse,
  sharedWorld: routesToSharedWorld,
  provisionedSharedWorld: routesToProvisionedSharedWorld,
  externalPublicSharedWorld: routesToExternalPublicSharedWorld,
  concurrentSharedWorld: routesToConcurrentSharedWorld,
  scriptedBrowser: routesToScriptedBrowser,
  provisionedScriptedBrowser: routesToProvisionedScriptedBrowser,
  terminalProduct: routesToTerminalProduct,
};

/** "backend predicate-names-that-hold", one line per config. */
function describeRouting(config: LabConfig): string {
  const held = Object.entries(predicates)
    .filter(([, predicate]) => predicate(config))
    .map(([name]) => name);
  return [selectLabBackend(config), ...held].join(" ");
}

describe("lab routing", () => {
  it("pins the backend and every routesTo* predicate over the config grid", async () => {
    const grid: Record<string, string> = {};
    for (const source of sources)
      for (const target of targets)
        for (const type of actors)
          for (const topology of [undefined, "shared-world"])
            for (const allowPublicTargets of [undefined, true]) {
              const config = {
                schema: LAB_CONFIG_SCHEMA,
                id: "grid",
                subject: { source, ...(topology === undefined ? {} : { topology }) },
                actors: [{ type }],
                ...(target === undefined ? {} : { execution: { target } }),
                ...(allowPublicTargets === undefined ? {} : { policies: { allowPublicTargets } }),
              } as unknown as LabConfig;
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
    for (const lab of (await listLabManifests(ROOT)).labs) {
      const resolved = await resolveLabManifest(ROOT, lab.id);
      if (!resolved.ok) throw new Error(`${lab.id}: ${resolved.error.message}`);
      committed[lab.id] = describeRouting(resolved.config);
    }
    expect(Object.keys(committed).length).toBeGreaterThan(0);
    await expect(`${JSON.stringify(committed, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/plans/routing-committed.json",
    );
  });
});
