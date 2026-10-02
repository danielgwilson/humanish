import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseLabConfig } from "../../../src/lab/config.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../../src/lab/types.js";
import { runCuaActorLab } from "../../../src/routes/computer-use/route.js";
import type { E2BDesktopModule } from "../../../src/substrates/e2b/sdk.js";
import { automaticAnalysisBoundary } from "../../helpers/automatic-analysis-boundary.js";

// Email receiving is prepared after the run's first snapshot and before any desktop. A failure there
// is a refusal after the run started, driven here through the real route.
vi.mock("../../../src/comms/receiving-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prepareReceivingRun: async () => {
    throw new Error("synthetic receiving setup failure");
  },
}));

function realEmailCloneConfig(): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "receiving-setup-failure",
    subject: {
      source: "clone",
      repos: ["example-org/example-app"],
      serve: {
        install: "pnpm install",
        start: "pnpm start -H 0.0.0.0",
        url: "http://127.0.0.1:3000/",
      },
    },
    actors: [
      {
        type: "openai-computer-use",
        mission: "Use your own email to join the app.",
        lanes: [{ id: "participant-a", persona: "first-time-visitor" }],
      },
    ],
    comms: { email: { connection: "mail" } },
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    scenario: { mode: "live" },
    review: { analysis: { maxCostUsd: 1 } },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("computer-use email receiving setup failure", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-receiving-refusal-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("closes the run with no outcome, keeps the first snapshot and runs no analysis or desktop", async () => {
    const created: string[] = [];
    const module = {
      Sandbox: {
        async create() {
          created.push("desktop");
          throw new Error("no desktop may be created after a receiving refusal");
        },
      },
    } as unknown as E2BDesktopModule;
    const analysis = automaticAnalysisBoundary();

    const result = await runCuaActorLab({
      cwd,
      config: realEmailCloneConfig(),
      dryRun: false,
      env: {
        OPENAI_API_KEY: "synthetic-openai",
        E2B_API_KEY: "synthetic-e2b",
        AGENTMAIL_API_KEY: "synthetic-management-key",
      },
      deps: {
        analysis: { run: analysis },

        desktopModule: async () => module,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_CUA_LAB_SUBJECT_INVALID" },
    });
    expect(result.error?.message).toContain("Real email setup failed");
    expect(created).toHaveLength(0);
    expect(analysis).not.toHaveBeenCalled();
    const runsRoot = path.join(cwd, ".humanish", "runs");
    const [runId] = (await readdir(runsRoot)).filter((entry) => entry !== "latest.json");
    // The refusal names the run it left behind.
    expect(result.runId).toBe(runId);
    const runDir = path.join(runsRoot, runId!);
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8"));
    expect(status.state).toBe("finished");
    expect(status).not.toHaveProperty("outcome");
    // The first snapshot stays as the evidence the run left, and latest.json names this run.
    const inProgress = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(inProgress.runId).toBe(runId);
    const latest = JSON.parse(await readFile(path.join(runsRoot, "latest.json"), "utf8"));
    expect(latest.runId).toBe(runId);
  });
});
