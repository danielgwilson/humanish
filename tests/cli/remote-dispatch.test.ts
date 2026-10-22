import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runRoute } from "../../src/cli/commands/study-route-run.js";
import type { StudyOutcome } from "../../src/run-study.js";
import { parseStudy } from "../../src/study/config.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab } from "../admission/fixtures.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-remote-dispatch-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

/** A computer-use study that could run remotely: hosted desktops and a public app. */
function remoteStudy(): StudyConfig {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      subject: { source: "app-url", appUrl: "https://app.example.com/" },
      policies: { allowPublicTargets: true },
      execution: { target: "modal-desktop", timeoutMs: 300_000 },
      review: { analysis: false },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

async function dispatch(env: Record<string, string>) {
  let launched = false;
  const presented: StudyOutcome[] = [];
  await runRoute(
    remoteStudy(),
    {
      options: { cwd, env, dryRun: false },
      present: async (outcome) => void presented.push(outcome),
    },
    undefined,
    undefined,
    async () => {
      launched = true;
    },
  );
  return { launched, presented };
}

describe("a study placed remotely", () => {
  it("is refused here, before any runner, when this machine would refuse it", async () => {
    const { launched, presented } = await dispatch({});
    expect(launched).toBe(false);
    expect(presented[0]?.result).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_COMPUTER_USE_KEYS_MISSING" },
    });
  });

  it("is launched remotely once the same checks admit it", async () => {
    const { launched, presented } = await dispatch({
      OPENAI_API_KEY: "synthetic-openai-key",
      MODAL_TOKEN_ID: "synthetic-modal-id",
      MODAL_TOKEN_SECRET: "synthetic-modal-secret",
    });
    expect(launched).toBe(true);
    expect(presented).toEqual([]);
  });
});
