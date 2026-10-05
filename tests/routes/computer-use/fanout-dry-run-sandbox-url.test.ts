// A dry run of a fan-out study whose app runs on an E2B host writes a bundle that verifies, as a live
// run does: every record names the app URL by its digest. The sandbox id is built at run time.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { synthetic } from "../../helpers/secret-formats.js";

const SANDBOX_ID = synthetic("abcdefghijklmnopqrstuvwxyz0123456789", 20, 70);
const APP_URL = `https://3000-${SANDBOX_ID}.${"e2b"}.app/`;

function hostedFanoutConfig(): StudyConfig {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "hosted-fanout",
    title: "Hosted fan-out",
    route: "computer-use",
    subject: { source: "app-url", appUrl: APP_URL },
    actor: { type: "openai-computer-use", mission: "Sign up and stop." },
    participants: [
      { id: "newcomer", persona: "first-time-visitor", target: `${APP_URL}sign-up` },
      { id: "returning", persona: "power-user", target: `${APP_URL}sign-in` },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    policies: { allowPublicTargets: true },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("a fan-out dry run against an E2B app URL", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-fanout-sandbox-url-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("verifies share_ready and holds no sandbox id", async () => {
    const outcome = await runStudyWith(hostedFanoutConfig(), { cwd, dryRun: true });
    if (outcome.route !== "computer-use") throw new Error(`unexpected route ${outcome.route}`);
    const runId = outcome.result.runId;
    const runDir = path.join(cwd, ".humanish", "runs", runId);

    const verified = await verifyRun(cwd, runId);
    expect(verified.checks.filter((check) => !check.ok)).toEqual([]);
    expect(verified.ok).toBe(true);
    expect(verified.shareSafety).toEqual({ status: "share_ready", reasons: [] });

    const holding: string[] = [];
    for (const file of await filesUnder(runDir))
      if ((await readFile(file, "utf8")).includes(SANDBOX_ID))
        holding.push(path.relative(runDir, file));
    expect(holding).toEqual([]);

    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.review.summary).toMatch(
      /^Dry-run fan-out: 2 participants composed for openai-computer-use against \[target-url:[0-9a-f]{16}\]/,
    );
    const review = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(review.startsWith("# Hosted fan-out\n")).toBe(true);
  });
});
