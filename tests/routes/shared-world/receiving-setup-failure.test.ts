import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudyConfig } from "../../../src/study/types.js";
import { lab } from "../../admission/fixtures.js";
import { libraryConfig } from "../../helpers/library-config.js";
import { runSharedWorld } from "../../helpers/route-run.js";

// Email receiving is prepared after the run starts and before any sandbox. A failure there is a
// refusal after the run started, driven here through the real route.
vi.mock("../../../src/comms/receiving-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prepareReceivingRun: async () => {
    throw new Error("synthetic receiving setup failure");
  },
}));

function realEmailSharedWorldConfig(): StudyConfig {
  return libraryConfig(
    lab("sharedProvisioned", {
      comms: { email: { kind: "real", connection: "team-inbox" } },
      mode: "live",
    }),
  );
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
    const result = await runSharedWorld({
      cwd,
      config: realEmailSharedWorldConfig(),
      dryRun: false,
      env: {
        OPENAI_API_KEY: "synthetic-openai",
        E2B_API_KEY: "synthetic-e2b",
        DATABASE_URL: "postgres://synthetic",
      },
      deps: {
        desktopModule: async () => {
          desktops += 1;
          throw new Error("no sandbox may be created after a receiving refusal");
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_SHARED_WORLD_INVALID" },
    });
    expect(desktops).toBe(0);
    const runsRoot = path.join(cwd, ".humanish", "runs");
    const [runId] = (await readdir(runsRoot)).filter((entry) => entry !== "latest.json");
    // The refusal names the run it left behind, in the place the envelope gives runId.
    expect(result.runId).toBe(runId);
    expect(Object.keys(result)).toEqual([
      "schema",
      "route",
      "studyId",
      "ok",
      "cwd",
      "actor",
      "topology",
      "topologyMode",
      "roleCount",
      "concurrency",
      "dryRun",
      "runId",
      "roles",
      "warnings",
      "error",
      "automaticAnalysisTrigger",
      "automaticAnalysis",
    ]);
    const status = JSON.parse(await readFile(path.join(runsRoot, runId!, "status.json"), "utf8"));
    expect(status.state).toBe("finished");
    expect(status).not.toHaveProperty("outcome");
  });
});
