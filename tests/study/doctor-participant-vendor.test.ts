// doctor --study reports the key of the vendor a study's participants run on, and fails when that
// key is missing; a study on another vendor is not told it needs the key.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { doctor } from "../../src/cli/doctor.js";

const study = (actor: string) =>
  [
    "schema: humanish.study.v3",
    "id: vendor",
    "route: computer-use",
    "mode: live",
    "subject: {source: app-url, appUrl: 'https://preview.example.test/'}",
    `actor: ${actor}`,
    "execution: {target: e2b-desktop}",
    "policies: {allowPublicTargets: true}",
    "review: {analysis: false}",
  ].join("\n");

const base = { HUMANISH_STRICT_KEYS: "1", PATH: "", E2B_API_KEY: "synthetic-marker" };

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-vendor-"));
  await mkdir(path.join(cwd, "humanish/studies"), { recursive: true });
  await writeFile(path.join(cwd, "package.json"), "{}");
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function keyRow(actor: string, env: Record<string, string>, name: string) {
  await writeFile(path.join(cwd, "humanish/studies/vendor.yaml"), study(actor));
  const result = await doctor(cwd, {
    study: "vendor",
    env,
    localAgents: { which: async () => undefined },
  });
  expect(JSON.stringify(result)).not.toMatch(/synthetic-marker/);
  return result.checks.find((check) => check.name === `key ${name}`);
}

describe("doctor --study for a participant on Anthropic", () => {
  const claude = "{type: computer-use, model: claude-haiku-5-5}";

  it("fails on a missing ANTHROPIC_API_KEY and names the command that stores it", async () => {
    expect(await keyRow(claude, base, "ANTHROPIC_API_KEY")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/missing from every source.*humanish keys set anthropic/),
    });
  });

  it("passes with the key present", async () => {
    const env = { ...base, ANTHROPIC_API_KEY: "synthetic-marker" };
    expect(await keyRow(claude, env, "ANTHROPIC_API_KEY")).toMatchObject({ ok: true });
  });

  it("does not ask an OpenAI study for the Anthropic key", async () => {
    const env = { ...base, OPENAI_API_KEY: "synthetic-marker" };
    expect(await keyRow("{type: computer-use}", env, "ANTHROPIC_API_KEY")).toBeUndefined();
    expect(await keyRow("{type: computer-use}", env, "OPENAI_API_KEY")).toMatchObject({
      ok: true,
    });
  });
});
