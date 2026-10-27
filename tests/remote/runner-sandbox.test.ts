import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireRunner, E2B_RUNNER_TEMPLATE } from "../../src/remote/launch.js";
import type { RemotePlan } from "../../src/remote/plan.js";
import { createRunArtifactPaths } from "../../src/run/paths.js";

// Each provider's module records the create it was asked for; no sandbox is made.
const creates = vi.hoisted(() => [] as { provider: string; args: unknown[] }[]);
const fakeModule = (provider: string) => ({
  Sandbox: {
    create: async (...args: unknown[]) => {
      creates.push({ provider, args });
      return { sandboxId: `${provider}-runner`, kill: async () => true };
    },
  },
});
vi.mock("../../src/substrates/e2b/base-module.js", () => ({
  loadE2BBaseModule: async () => fakeModule("e2b"),
}));
vi.mock("../../src/substrates/modal/sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/substrates/modal/sandbox.js")>()),
  loadModalShellModule: async () => fakeModule("modal"),
}));

let cwd: string;
beforeEach(async () => {
  creates.length = 0;
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-runner-sandbox-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function acquire(provider: RemotePlan["provider"]) {
  const created = await createRunArtifactPaths(cwd, `cua-runner-${provider}`);
  if (!created.ok) throw new Error("run directory exists");
  const remote = { provider, runnerMs: 60 * 60_000 } as RemotePlan;
  return acquireRunner({ env: { E2B_API_KEY: "synthetic-e2b" }, remote }, created.paths, {});
}

describe("the runner sandbox", () => {
  it("on E2B, is made from the desktop template, which has room for the run's own process", async () => {
    await acquire("e2b");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.args[0]).toBe(E2B_RUNNER_TEMPLATE);
    expect(creates[0]!.args[1]).toMatchObject({ metadata: { participantId: "runner" } });
  });

  it("on Modal, is sized by its module, with no E2B template", async () => {
    await acquire("modal");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.args).toHaveLength(1);
  });
});
