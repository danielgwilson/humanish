// A study target off E2B may name an E2B app URL in a parameter, encoded or not. The run records the
// target by its digest wherever verify would read the E2B URL, so a dry run verifies share_ready and
// holds no sandbox id in any form. The sandbox id is built at run time.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { STUDY_SCHEMA } from "../../../src/study/types.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { synthetic } from "../../helpers/secret-formats.js";

const SANDBOX_ID = synthetic("abcdefghijklmnopqrstuvwxyz0123456789", 20, 80);
const SANDBOX_URL = `https://3000-${SANDBOX_ID}.${"e2b"}.app/home`;

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("a dry run whose target names an E2B app URL in a parameter", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-sandbox-url-target-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each([
    ["percent-encoded", `?next=${encodeURIComponent(SANDBOX_URL)}`],
    ["as written", `?next=${SANDBOX_URL}`],
    ["hex-encoded", `?state=${Buffer.from(SANDBOX_URL).toString("hex")}`],
  ])("verifies share_ready with the URL %s", async (_label, query) => {
    const parsed = parseStudy({
      schema: STUDY_SCHEMA,
      id: "sandbox-url-target",
      route: "computer-use",
      subject: { source: "app-url", appUrl: `https://app.example.com/sign-in${query}` },
      actor: { type: "openai-computer-use" },
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      policies: { allowPublicTargets: true },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runStudyWith(parsed.config, { cwd, dryRun: true });
    if (outcome.route !== "computer-use") throw new Error(`unexpected route ${outcome.route}`);
    const runId = outcome.result.runId;

    const verified = await verifyRun(cwd, runId);
    expect(verified.checks.filter((check) => !check.ok)).toEqual([]);
    expect(verified.shareSafety).toEqual({ status: "share_ready", reasons: [] });

    const forms = [SANDBOX_ID, Buffer.from(SANDBOX_ID).toString("hex")];
    const runDir = path.join(cwd, ".humanish", "runs", runId);
    const holding: string[] = [];
    for (const file of await filesUnder(runDir)) {
      const text = await readFile(file, "utf8");
      if (forms.some((form) => text.includes(form))) holding.push(path.relative(runDir, file));
    }
    expect(holding).toEqual([]);
  });
});
