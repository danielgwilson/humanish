import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runConcurrentSharedWorld } from "../../../src/routes/shared-world/route.js";
import type { LabConfig } from "../../../src/lab/types.js";
import { lab } from "../../admission/fixtures.js";

// Email receiving is prepared after the run starts and before any sandbox. A failure there is a
// refusal after the run started, driven here through the real route.
vi.mock("../../../src/comms/receiving-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prepareReceivingRun: async () => {
    throw new Error("synthetic receiving setup failure");
  },
}));

function realEmailSharedWorldConfig(): LabConfig {
  return lab("sharedProvisioned", {
    comms: { email: { kind: "real", connection: "team-inbox" } },
    scenario: { mode: "live" },
  }) as unknown as LabConfig;
}

describe("shared-world email receiving setup failure", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-sw-receiving-refusal-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("names the run it leaves behind and creates no sandbox", async () => {
    let desktops = 0;
    const result = await runConcurrentSharedWorld({
      cwd,
      config: realEmailSharedWorldConfig(),
      dryRun: false,
      hooks: {
        env: {
          OPENAI_API_KEY: "synthetic-openai",
          E2B_API_KEY: "synthetic-e2b",
          DATABASE_URL: "postgres://synthetic",
        },
        loadDesktopModule: async () => {
          desktops += 1;
          throw new Error("no sandbox may be created after a receiving refusal");
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID" },
    });
    expect(desktops).toBe(0);
    const runsRoot = path.join(cwd, ".humanish", "runs");
    const [runId] = (await readdir(runsRoot)).filter((entry) => entry !== "latest.json");
    expect(result.runId).toBe(runId);
    const status = JSON.parse(await readFile(path.join(runsRoot, runId!, "status.json"), "utf8"));
    expect(status.state).toBe("finished");
    expect(status).not.toHaveProperty("outcome");
  });
});
