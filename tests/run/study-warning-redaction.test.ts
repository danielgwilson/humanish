// A study warning can quote the study file, and the file may name a sandbox URL a participant needs,
// such as a run inbox page or a second app. The run records each warning in its bundle, so the
// quote goes through the same redaction as a run failure, and verify then finds no sandbox URL.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runStudy } from "../../src/run-study.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { parseStudy } from "../../src/study/config.js";
import { verifyRun } from "../../src/verify/verify.js";
import { lab, SCENARIO_YAML } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const INBOX = "https://3000-isbxwarningfixture01.e2b.app/inbox";

async function project(): Promise<string> {
  const cwd = await makeTestTempDir("humanish-warning-redaction-");
  await writeFile(path.join(cwd, "package.json"), '{ "name": "warning-redaction-fixture" }\n');
  await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(cwd, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  return cwd;
}

describe("a study warning that quotes a sandbox URL", () => {
  it("is recorded redacted, and the dry run still verifies share_ready", async () => {
    const parsed = parseStudy(
      lab("cuAppUrl", {}, { mission: `When the code arrives, read it at ${INBOX} and sign in.` }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.warnings.some((warning) => warning.includes(INBOX))).toBe(true);

    const cwd = await project();
    const outcome = await runStudy(parsed.config, { cwd, dryRun: true });
    const { runId } = outcome.result as { runId?: string };
    if (runId === undefined) throw new Error(`no run: ${JSON.stringify(outcome.result)}`);
    const runDir = path.join(cwd, ".humanish", "runs", runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const warning = bundle.events.find(
      (event) => event.type === "study.warning" && event.message.includes("reads like a script"),
    );
    expect(warning?.message).toContain("[REDACTED_");
    expect(await readFile(path.join(runDir, "events.ndjson"), "utf8")).not.toContain("e2b.app");

    const verified = await verifyRun(cwd, runId);
    expect(verified.shareSafety.status).toBe("share_ready");
  });
});
