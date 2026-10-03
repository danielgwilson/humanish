// Bare `doctor` after `init --yes` on a machine with no keys: init's next step (`run first-run`)
// needs no key, so doctor passes, and each key row names the labs that need it. `--lab` still fails
// on a key the selected lab requires.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DetectLocalAgentsOptions } from "../../src/actors/local-agent/cli.js";
import { doctor, type DoctorResult } from "../../src/cli/doctor.js";
import { runInit } from "../../src/study/init.js";

const keyless = { HUMANISH_STRICT_KEYS: "1", PATH: "" };
const noAgents: DetectLocalAgentsOptions = { which: async () => undefined };
const row = (result: DoctorResult, name: string) =>
  result.checks.find((check) => check.name === name);

describe("doctor without --lab", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-bare-"));
    await runInit({ cwd, yes: true, env: keyless });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("passes with no keys, and a missing key a lab needs is a note naming that lab", async () => {
    const result = await doctor(cwd, { env: keyless, localAgents: noAgents });
    expect(result.ok).toBe(true);
    expect(row(result, "key E2B_API_KEY")).toMatchObject({ ok: true, status: "note" });
    expect(row(result, "key E2B_API_KEY")?.message).toMatch(/^missing; used by try-live; /);
    expect(row(result, "key GH_TOKEN")).toMatchObject({ ok: true, status: "ok" });
    expect(row(result, "key GH_TOKEN")?.message).toContain("not used by any lab in this project");
  });

  it("names the labs on a present key's row too", async () => {
    const env = { ...keyless, E2B_API_KEY: "synthetic-desktop-canary" };
    const result = await doctor(cwd, { env, localAgents: noAgents });
    expect(row(result, "key E2B_API_KEY")).toMatchObject({ ok: true, status: "ok" });
    expect(row(result, "key E2B_API_KEY")?.message).toMatch(/; used by try-live$/);
    expect(JSON.stringify(result)).not.toContain("synthetic-desktop-canary");
  });

  it("finds a lab whose file name differs from its id", async () => {
    const labs = path.join(cwd, "humanish", "studies");
    const tryLive = await readFile(path.join(labs, "try-live.yaml"), "utf8");
    expect(tryLive).toMatch(/^id: try-live$/m);
    await writeFile(
      path.join(labs, "checkout.yaml"),
      tryLive.replace(/^id: try-live$/m, "id: checkout-live"),
    );
    const result = await doctor(cwd, { env: keyless, localAgents: noAgents });
    expect(row(result, "key E2B_API_KEY")?.message).toMatch(
      /^missing; used by checkout-live and try-live; /,
    );
  });

  it("still fails under --lab when the selected lab needs a missing key", async () => {
    const result = await doctor(cwd, { lab: "try-live", env: keyless, localAgents: noAgents });
    expect(result.ok).toBe(false);
    expect(row(result, "key E2B_API_KEY")).toMatchObject({ ok: false, status: "missing" });
  });

  it("gives each installed local agent its own row, and an unsigned one is a note", async () => {
    const result = await doctor(cwd, {
      env: keyless,
      localAgents: {
        which: async (bin) => `/synthetic/${bin}`,
        exists: async () => false,
        authProbe: async (bin) =>
          bin.endsWith("codex")
            ? { code: 0, stdout: "", stderr: "Logged in using ChatGPT" }
            : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" },
      },
    });
    const agentRows = result.checks.filter((check) => check.name.startsWith("local agent"));
    expect(agentRows.map(({ name, status }) => [name, status])).toEqual([
      ["local agent codex", "ok"],
      ["local agent claude", "note"],
    ]);
    expect(agentRows[1]?.message).toContain("run `claude auth login`");
  });
});
