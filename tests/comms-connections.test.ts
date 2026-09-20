import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMS_CONFIG_PATH, readCommsConnections, readCommsSetup, saveCommsConnection } from "../src/comms-connections.js";
import { resolveKeyName, setUserKey, userKeyStorePath } from "../src/key-resolution.js";

describe("communication connection setup", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-comms-setup-")); env = { XDG_CONFIG_HOME: path.join(cwd, "user-config") }; });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
  const deps = () => ({ homeDir: cwd, execText: async () => null });

  it("inspects a fresh directory without creating storage or claiming authentication", async () => {
    const status = await readCommsSetup(cwd, env, deps());
    expect(status).toMatchObject({ ok: true, connections: [], credential: { present: false, stored: false } });
    expect(status.message).toContain("have not been verified");
    await expect(stat(path.join(cwd, ".humanish"))).rejects.toThrow();
  });
  it("stores a key only in the user store, supports the alias and persists a non-secret profile", async () => {
    const canary = "synthetic-agentmail-credential-canary";
    expect(resolveKeyName("agentmail")).toBe("AGENTMAIL_API_KEY");
    setUserKey("AGENTMAIL_API_KEY", canary, env);
    expect((await stat(userKeyStorePath(env))).mode & 0o777).toBe(0o600);
    expect((await saveCommsConnection(cwd)).ok).toBe(true);
    const status = await readCommsSetup(cwd, env, deps());
    expect(status).toMatchObject({ ok: true, credential: { present: true, stored: true }, connections: [{ name: "agentmail", provider: "agentmail", apiKeyEnv: "AGENTMAIL_API_KEY" }] });
    expect(JSON.stringify(status)).not.toContain(canary);
    expect(await readFile(path.join(cwd, COMMS_CONFIG_PATH), "utf8")).not.toContain(canary);
    expect((await saveCommsConnection(cwd, "second")).ok).toBe(true);
    expect(Object.keys((await readCommsConnections(cwd)).connections)).toEqual(["agentmail", "second"]);
  });
  it("preserves explicit env precedence and an explicitly empty override; strict mode ignores the store", async () => {
    setUserKey("AGENTMAIL_API_KEY", "synthetic-store-key", env);
    expect((await readCommsSetup(cwd, { ...env, AGENTMAIL_API_KEY: "synthetic-env-key" }, deps())).credential).toMatchObject({ present: true, source: "process env", stored: true });
    expect((await readCommsSetup(cwd, { ...env, AGENTMAIL_API_KEY: "" }, deps())).credential).toMatchObject({ present: false, explicitlyEmpty: true, stored: true });
    expect((await readCommsSetup(cwd, { ...env, HUMANISH_STRICT_KEYS: "1" }, deps())).credential).toMatchObject({ present: false, strict: true, stored: true });
  });
  it("preserves an existing connection with different settings", async () => {
    expect((await saveCommsConnection(cwd, "agentmail", "OTHER_MAIL_KEY")).ok).toBe(true);
    expect((await saveCommsConnection(cwd)).ok).toBe(false);
    expect((await readCommsConnections(cwd)).connections.agentmail?.apiKeyEnv).toBe("OTHER_MAIL_KEY");
  });
  it("refuses invalid names and values without echoing them", async () => {
    const canary = "synthetic-invalid-secret-value";
    expect(await saveCommsConnection(cwd, "../outside", canary)).toMatchObject({ ok: false });
    expect(JSON.stringify(await saveCommsConnection(cwd, "mail", canary))).not.toContain(canary);
    await expect(stat(path.join(cwd, ".humanish"))).rejects.toThrow();
  });
  it("preserves malformed configuration and redacts parser diagnostics", async () => {
    await mkdir(path.join(cwd, ".humanish/local"), { recursive: true });
    const invalid = "secret: [synthetic-parser-canary";
    await writeFile(path.join(cwd, COMMS_CONFIG_PATH), invalid);
    const status = await readCommsSetup(cwd, env, deps());
    expect(status.ok).toBe(false);
    expect(JSON.stringify(status)).not.toContain("synthetic-parser-canary");
    expect((await saveCommsConnection(cwd)).ok).toBe(false);
    expect(await readFile(path.join(cwd, COMMS_CONFIG_PATH), "utf8")).toBe(invalid);
  });
  it("refuses a symlinked connection file without changing its target", async () => {
    await mkdir(path.join(cwd, ".humanish/local"), { recursive: true });
    const target = path.join(cwd, "target");
    await writeFile(target, "untouched");
    await symlink(target, path.join(cwd, COMMS_CONFIG_PATH));
    expect((await saveCommsConnection(cwd)).ok).toBe(false);
    expect((await readCommsSetup(cwd, env, deps())).ok).toBe(false);
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
  it("refuses redirected parent directories and existing writer locks", async () => {
    await mkdir(path.join(cwd, "target"));
    await symlink(path.join(cwd, "target"), path.join(cwd, ".humanish"));
    expect((await saveCommsConnection(cwd)).ok).toBe(false);
    await rm(path.join(cwd, ".humanish"));
    await mkdir(path.join(cwd, ".humanish/local"), { recursive: true });
    await writeFile(path.join(cwd, ".humanish/local/.comms-setup.lock"), "owned-by-another-writer");
    expect((await saveCommsConnection(cwd)).message).toContain("locked");
    expect(await readFile(path.join(cwd, ".humanish/local/.comms-setup.lock"), "utf8")).toBe("owned-by-another-writer");
  });
});
