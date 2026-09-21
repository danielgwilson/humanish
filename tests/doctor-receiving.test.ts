import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../src/run.js";
import { saveCommsConnection } from "../src/comms-connections.js";
import { setUserKey } from "../src/key-resolution.js";

const noAgents = { which: async () => undefined };
const manifest = [
  "schema: humanish.lab.v2", "id: preview", "subject:", "  source: app-url",
  "  appUrl: https://preview.example.test/", "actors:", "  - type: openai-computer-use",
  "execution:", "  target: e2b-desktop", "scenario:", "  mode: live",
  "policies:", "  allowPublicTargets: true", "comms:", "  email:", "    connection: study-mail"
].join("\n");

describe("doctor checks the selected receiving credential without contacting its provider", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  const fetch = vi.fn(() => { throw new Error("Doctor must not contact a provider"); });
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-receiving-"));
    env = { HUMANISH_STRICT_KEYS: "1", PATH: "", GH_TOKEN: "",
      OPENAI_API_KEY: "synthetic-model-canary", E2B_API_KEY: "synthetic-desktop-canary",
      XDG_CONFIG_HOME: path.join(cwd, "user-config") };
    await mkdir(path.join(cwd, "humanish/labs"), { recursive: true });
    await writeFile(path.join(cwd, ".gitignore"), ".humanish/\n");
    await writeFile(path.join(cwd, "humanish/labs/preview.yaml"), manifest);
    fetch.mockClear();
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(async () => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    await rm(cwd, { recursive: true, force: true });
  });
  const inspect = async () => {
    const before = { ...env };
    const result = await doctor(cwd, { lab: "preview", env, localAgents: noAgents });
    expect(env).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("synthetic-");
    return result;
  };

  for (const name of ["AGENTMAIL_API_KEY", "STUDY_MAIL_KEY"]) {
    it.each(["present", "absent", "empty"])(`reports ${name} when %s`, async state => {
      expect((await saveCommsConnection(cwd, "study-mail", name)).ok).toBe(true);
      if (state !== "absent") env[name] = state === "present" ? "synthetic-mail-canary" : " ";
      const result = await inspect();
      const present = state === "present";
      expect(result.ok).toBe(present);
      const key = result.checks.find(check => check.name === `key ${name}`);
      const connection = result.checks.find(check => check.name === "real email connection");
      expect(key?.ok).toBe(present);
      expect(connection?.ok).toBe(present);
      expect(key?.message).toContain(present ? "process env; presence only, validity not tested" : "--env-file");
      expect(connection?.message).toContain(present ? "Local presence only" : `Missing ${name}`);
      if (!present) expect(connection?.message).not.toContain("Local presence only");
      if (name === "STUDY_MAIL_KEY") expect(key?.message).not.toContain("keys set STUDY_MAIL_KEY");
    });
  }

  it.each(["saved", "env", "empty", "strict"])("honors saved-key discovery and precedence: %s", async source => {
    expect((await saveCommsConnection(cwd, "study-mail")).ok).toBe(true);
    env.HUMANISH_STRICT_KEYS = source === "strict" ? "1" : "0";
    setUserKey("AGENTMAIL_API_KEY", "synthetic-saved-mail-canary", env);
    if (source === "env") env.AGENTMAIL_API_KEY = "synthetic-env-mail-canary";
    if (source === "empty") env.AGENTMAIL_API_KEY = "";
    const result = await inspect();
    const present = source === "saved" || source === "env";
    expect(result.ok).toBe(present);
    expect(result.checks.find(check => check.name === "real email connection")?.ok).toBe(present);
    const key = result.checks.find(check => check.name === "key AGENTMAIL_API_KEY");
    expect(key?.ok).toBe(present);
    if (source === "saved") expect(key?.message).toContain("keys.env; presence only, validity not tested");
    if (source === "env") expect(key?.message).toContain("process env; presence only, validity not tested");
  });

  it("distinguishes a missing connection from its missing credential", async () => {
    const result = await inspect();
    expect(result.ok).toBe(false);
    expect(result.checks.find(check => check.name === "real email connection")).toMatchObject({
      ok: false, message: "The selected email connection is missing or invalid. Open Connections in the TUI."
    });
    expect(result.checks.some(check => check.name === "key AGENTMAIL_API_KEY")).toBe(false);
  });

  it("does not require the receiving credential for a dry run", async () => {
    expect((await saveCommsConnection(cwd, "study-mail")).ok).toBe(true);
    await writeFile(path.join(cwd, "humanish/labs/preview.yaml"), manifest.replace("mode: live", "mode: dry-run"));
    const result = await inspect();
    expect(result.ok).toBe(true);
    expect(result.checks.find(check => check.name === "key AGENTMAIL_API_KEY")?.message).toContain("not required");
    expect(result.checks.some(check => check.name === "real email connection")).toBe(false);
  });
});
