import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor.js";

const study = [
  "schema: humanish.study.v3",
  "id: preview",
  "route: computer-use",
  "mode: live",
  "subject: {source: app-url, appUrl: 'https://preview.example.test/'}",
  "actor: {type: openai-computer-use}",
  "execution: {target: e2b-desktop}",
  "policies: {allowPublicTargets: true}",
  "review: {analysis: {provider: gemini, maxCostUsd: 2}}",
].join("\n");
const base = {
  HUMANISH_STRICT_KEYS: "1",
  PATH: "",
  OPENAI_API_KEY: "synthetic-marker",
  E2B_API_KEY: "synthetic-marker",
};

it("reports the Gemini key for a study analyzed on Gemini, from either spelling", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-gemini-"));
  try {
    await mkdir(path.join(cwd, "humanish/studies"), { recursive: true });
    await writeFile(path.join(cwd, "package.json"), "{}");
    await writeFile(path.join(cwd, "humanish/studies/preview.yaml"), study);
    const row = async (env: Record<string, string>) => {
      const result = await doctor(cwd, {
        study: "preview",
        env,
        localAgents: { which: async () => undefined },
      });
      expect(result.checks.some((check) => check.name === "key GEMINI_API_KEY")).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/synthetic-marker/);
      return result.checks.find((check) => check.name === "post-run analysis");
    };
    expect(await row(base)).toMatchObject({
      status: "note",
      message: expect.stringMatching(/GEMINI_API_KEY is missing/),
    });
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY"])
      expect(await row({ ...base, [name]: "synthetic-marker" })).toMatchObject({
        status: "ok",
        message: expect.stringMatching(/sends the evidence and captures to Google/),
      });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
