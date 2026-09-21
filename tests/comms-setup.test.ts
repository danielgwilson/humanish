import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { saveCommsConnection } from "../src/comms-connections.js";
import { checkCommsConnection, configureCommsLab } from "../src/comms-setup.js";
import { AgentMailReceivingError } from "../src/comms-agentmail.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import { resolveLabManifest } from "../src/labs.js";
import { launchRun } from "../src/tui-launch.js";
import { setUserKey } from "../src/key-resolution.js";
import type { ReceivingAdapter } from "../src/comms-receiving-types.js";
const lab = { schema: LAB_CONFIG_SCHEMA, id: "signup", subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" }, actors: [{ type: "openai-computer-use", mission: "Create an account." }], execution: { target: "e2b-desktop" }, scenario: { mode: "live" } };
let cwd: string, env: NodeJS.ProcessEnv;
beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-comms-config-")); env = { XDG_CONFIG_HOME: path.join(cwd, "keys"), HUMANISH_STRICT_KEYS: "1" }; await saveCommsConnection(cwd); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
function adapter(authenticate = vi.fn(async () => ({ provider: "agentmail" as const, accountId: "synthetic-org", scopeType: "organization" as const, scopeId: "synthetic-org" }))): ReceivingAdapter { return { provider: "agentmail", authenticate, acquire: vi.fn(), read: vi.fn(), release: vi.fn() }; }
describe("connection authentication", () => {
  it("keeps local status offline and does not equate authentication with delivery/capacity", async () => {
    env.AGENTMAIL_API_KEY = "synthetic-check-key";
    const provider = adapter(), makeAdapter = vi.fn(() => provider);
    expect(await checkCommsConnection({ cwd, env, makeAdapter })).toMatchObject({ ok: true, authenticated: null, ready: null, online: false });
    expect(makeAdapter).not.toHaveBeenCalled();
    expect(await checkCommsConnection({ cwd, env, makeAdapter, online: true })).toMatchObject({ ok: true, authenticated: true, ready: null, capacity: "unknown", permissions: "unknown" });
    expect(provider.acquire).not.toHaveBeenCalled(); expect(provider.read).not.toHaveBeenCalled(); expect(provider.release).not.toHaveBeenCalled();
  });
  it("checks effective env over saved key, and an explicitly empty env suppresses the saved key", async () => {
    delete env.HUMANISH_STRICT_KEYS; setUserKey("AGENTMAIL_API_KEY", "synthetic-saved-key", env);
    env.AGENTMAIL_API_KEY = "synthetic-environment-key";
    const makeAdapter = vi.fn(() => adapter());
    await checkCommsConnection({ cwd, env, online: true, makeAdapter });
    expect(makeAdapter).toHaveBeenCalledWith("synthetic-environment-key");
    env.AGENTMAIL_API_KEY = ""; makeAdapter.mockClear();
    expect(await checkCommsConnection({ cwd, env, online: true, makeAdapter })).toMatchObject({ ok: false, code: "credential_missing" });
    expect(makeAdapter).not.toHaveBeenCalled();
  });
  it.each(["agentmail_auth_rejected", "agentmail_rate_limited", "agentmail_timeout"] as const)("classifies %s without provider text or deleting stored credentials", async code => {
    env.AGENTMAIL_API_KEY = "synthetic-secret-canary";
    const provider = adapter(); provider.authenticate = async () => { throw new AgentMailReceivingError(code); };
    const result = await checkCommsConnection({ cwd, env, online: true, makeAdapter: () => provider });
    expect(result).toMatchObject({ ok: false, code, authenticated: code === "agentmail_auth_rejected" ? false : null });
    expect(JSON.stringify(result)).not.toContain(env.AGENTMAIL_API_KEY);
    expect(env.AGENTMAIL_API_KEY).toBe("synthetic-secret-canary");
  });
});
describe("receiving lab selection", () => {
  async function source() { await mkdir(path.join(cwd, "humanish/labs"), { recursive: true }); await writeFile(path.join(cwd, "humanish/labs/signup.yaml"), stringify(lab)); }
  it("previews without mutation, then saves a resolvable local copy while preserving source", async () => {
    await source(); const before = await readFile(path.join(cwd, "humanish/labs/signup.yaml"), "utf8");
    const plan = await configureCommsLab({ cwd, lab: "signup", connection: "agentmail" });
    expect(plan).toMatchObject({ ok: true, applied: false, path: ".humanish/local/labs/signup-receiving.yaml" });
    await expect(readFile(path.join(cwd, plan.path!))).rejects.toThrow();
    expect(await configureCommsLab({ cwd, lab: "signup", connection: "agentmail", apply: true, planToken: plan.planToken! })).toMatchObject({ ok: true, applied: true });
    const selected = await resolveLabManifest(cwd, plan.path!);
    expect(selected.ok && selected.config.comms?.email).toEqual({ kind: "real", connection: "agentmail" });
    expect(await readFile(path.join(cwd, "humanish/labs/signup.yaml"), "utf8")).toBe(before);
  });
  it("rejects stale preview when the source or destination changes", async () => {
    await source(); const plan = await configureCommsLab({ cwd, lab: "signup", connection: "agentmail" });
    await writeFile(path.join(cwd, "humanish/labs/signup.yaml"), stringify({ ...lab, title: "Changed" }));
    expect(await configureCommsLab({ cwd, lab: "signup", connection: "agentmail", apply: true, planToken: plan.planToken! })).toMatchObject({ ok: false, applied: false });
    await expect(readFile(path.join(cwd, plan.path!))).rejects.toThrow();
  });
  it("launches the exact selected local path even with a same-name committed manifest", async () => {
    await source(); await mkdir(path.join(cwd, ".humanish/local/labs"), { recursive: true });
    await writeFile(path.join(cwd, ".humanish/local/labs/signup.yaml"), stringify({ ...lab, comms: { email: { connection: "agentmail" } } }));
    const spawn = vi.fn(() => ({ pid: 4242, unref() {}, on() {} }));
    const launched = await launchRun({ cwd, lab: "signup", manifestPath: ".humanish/local/labs/signup.yaml", mode: "live", spawn: spawn as never });
    expect(launched.ok).toBe(true); expect(spawn).toHaveBeenCalledTimes(1);
    expect(launched.ok && launched.run.command.at(-1)).toBe(".humanish/local/labs/signup.yaml");
  });
  it("rejects unsupported receiving and dangerous mixtures before execution", () => {
    for (const email of [{ connection: "agentmail", injectEnv: "MAIL_API" }, { connection: "agentmail", recipients: [] }, { connection: "agentmail", allowedOrigins: ["https://target.test/path"] }]) expect(parseLabConfig({ ...lab, comms: { email } }).ok).toBe(false);
    expect(parseLabConfig({ ...lab, actors: [{ type: "local-agent", mission: "Sign up" }], comms: { email: { connection: "agentmail" } } }).ok).toBe(false);
    const real = parseLabConfig({ ...lab, actors: [{ type: "openai-computer-use", count: 2, mission: "Sign up" }], comms: { email: { connection: "agentmail" } } });
    expect(real.ok).toBe(true); expect(real.ok && real.config.comms?.email?.recipients).toBeUndefined();
  });
});
