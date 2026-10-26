// A computer-use study on `execution.target: modal-desktop` runs the hosted-desktop route on a Modal
// sandbox: the plan asks for the Modal token pair and allows a 24-hour sandbox, the run journals
// its sandbox as Modal's, and the bundle names the desktop modal-desktop and prices it at Modal's
// rate. A fake sandbox module stands in for Modal.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseSandboxOwners, parseSandboxReceipts } from "../../../src/run/sandbox-receipts.js";
import { parseStudy } from "../../../src/study/config.js";
import { planStudy } from "../../../src/study/plan.js";
import type { StudyConfig } from "../../../src/study/types.js";
import { lab } from "../../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedParticipant,
  TWO_TURN_SESSION,
} from "../../helpers/fanout-desktop.js";
import { makeTestTempDir } from "../../helpers/temp-dir.js";

const ENV = {
  OPENAI_API_KEY: "test-openai-key",
  MODAL_TOKEN_ID: "test-modal-id",
  MODAL_TOKEN_SECRET: "test-modal-secret",
};

function study(execution: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      review: { analysis: false },
      execution: { target: "modal-desktop", ...execution },
      ...extra,
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function refusal(config: StudyConfig): string | undefined {
  const planned = planStudy(config, { cwd: "/nonexistent", env: ENV });
  return planned.ok ? undefined : planned.refusal.message;
}

/** Why parsing or planning refuses the study, or undefined. */
function refused(execution: Record<string, unknown>): string | undefined {
  try {
    return refusal(study(execution));
  } catch (error) {
    return (error as Error).message;
  }
}

describe("planning a computer-use study on a Modal desktop", () => {
  it("names Modal as the desktop's provider and needs the Modal token pair, not an E2B key", () => {
    const planned = planStudy(study(), { cwd: "/nonexistent", env: ENV });
    if (!planned.ok) throw new Error(planned.refusal.message);
    const plan = planned.planned.plan;
    if (plan.route !== "computer-use" || plan.runner.desktop !== "e2b-desktop")
      throw new Error("expected a hosted computer-use plan");
    expect(plan.runner.provider).toBe("modal");
    expect(plan.requirements).toEqual([
      { kind: "key", name: "MODAL_TOKEN_ID" },
      { kind: "key", name: "MODAL_TOKEN_SECRET" },
      { kind: "key", name: "OPENAI_API_KEY" },
    ]);
  });

  it("allows a session past E2B's default hour", () => {
    expect(refusal(study({ timeoutMs: 3 * 60 * 60_000 }))).toBeUndefined();
  });

  it.each([
    ["an E2B template", { desktop: { template: "custom-desktop" } }],
    ["Firefox", { desktop: { browser: "firefox" } }],
  ])("refuses %s", (_name, execution) => {
    expect(refused(execution)).toMatch(/Modal desktop|e2b-desktop/);
  });
});

describe("a computer-use run on a Modal desktop", () => {
  it("journals Modal's sandbox and records a modal-desktop priced at Modal's rate", async () => {
    const cwd = await makeTestTempDir("humanish-modal-desktop-run-");
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      study(),
      { cwd, env: ENV, open: false },
      {
        desktopModule: async () => handle.module,
        subjectPhaseSink: () => undefined,
        runSession: async (session) =>
          runCuaActorSession({
            ...session,
            participant: scriptedParticipant(TWO_TURN_SESSION),
          }),
      },
    );
    const runId = String((outcome.result as { runId?: unknown }).runId);
    const runDir = path.join(cwd, ".humanish", "runs", runId);
    const journal = await readFile(path.join(runDir, "sandbox-receipts.ndjson"), "utf8");
    expect(parseSandboxReceipts(journal)).toEqual([expect.objectContaining({ provider: "modal" })]);
    expect(parseSandboxOwners(journal, runId)).toEqual([
      expect.objectContaining({ provider: "modal" }),
    ]);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as {
      providerResources: { provider: string }[];
      cost: {
        breakdown: { kind: string; source?: string; desktop?: { resourceSource?: string } }[];
      };
    };
    expect(bundle.providerResources.map((resource) => resource.provider)).toEqual([
      "modal-desktop",
    ]);
    expect(bundle.cost.breakdown).toContainEqual(
      expect.objectContaining({
        kind: "desktop-minutes",
        source: "modal.com/pricing",
        desktop: expect.objectContaining({ resourceSource: "modal.create" }),
      }),
    );
  });
});
