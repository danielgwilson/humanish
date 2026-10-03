import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { saveCommsConnection } from "../../src/comms/connections.js";
import { checkCommsConnection, configureCommsStudy } from "../../src/comms/setup.js";
import { AGENTMAIL_RECEIVING_CODES, AgentMailReceivingError } from "../../src/comms/agentmail.js";
import { V2_SCHEMA } from "../../src/study/types.js";
import { parseStudyDocument } from "../../src/study/config.js";
import { resolveStudyManifest } from "../../src/study/discover.js";
import { launchRun } from "../../src/tui/launch.js";
import { setUserKey } from "../../src/keys/key-resolution.js";
import type { ReceivingAdapter } from "../../src/comms/receiving-types.js";
import { studyFileText } from "../helpers/study-file.js";
const lab = {
  schema: V2_SCHEMA,
  id: "signup",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
  actors: [{ type: "openai-computer-use", mission: "Create an account." }],
  execution: { target: "e2b-desktop" },
  scenario: { mode: "live" },
};
let cwd: string, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-comms-config-"));
  // `HOME` and `PATH` point into the temp dir. A test that turns discovery on then finds no gh, so
  // the gh rung misses and nothing is written outside the temp dir.
  env = {
    XDG_CONFIG_HOME: path.join(cwd, "keys"),
    HOME: cwd,
    PATH: path.join(cwd, "no-bin"),
    HUMANISH_STRICT_KEYS: "1",
  };
  await saveCommsConnection(cwd);
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
function adapter(
  authenticate = vi.fn(async () => ({
    provider: "agentmail" as const,
    accountId: "synthetic-org",
    scopeType: "organization" as const,
    scopeId: "synthetic-org",
  })),
): ReceivingAdapter {
  return {
    provider: "agentmail",
    addressing: "provisioned",
    idempotentAcquire: true,
    authRejectedCode: "agentmail_auth_rejected",
    codes: AGENTMAIL_RECEIVING_CODES,
    authenticate,
    acquire: vi.fn(),
    read: vi.fn(),
    release: vi.fn(),
  };
}
describe("connection authentication", () => {
  it("keeps local status offline and does not equate authentication with delivery/capacity", async () => {
    env.AGENTMAIL_API_KEY = "synthetic-check-key";
    const provider = adapter(),
      makeAdapter = vi.fn(() => provider);
    expect(await checkCommsConnection({ cwd, env, makeAdapter })).toMatchObject({
      ok: true,
      authenticated: null,
      ready: null,
      online: false,
    });
    expect(makeAdapter).not.toHaveBeenCalled();
    expect(await checkCommsConnection({ cwd, env, makeAdapter, online: true })).toMatchObject({
      ok: true,
      authenticated: true,
      ready: null,
      capacity: "unknown",
      permissions: "unknown",
    });
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(provider.read).not.toHaveBeenCalled();
    expect(provider.release).not.toHaveBeenCalled();
  });
  it("checks effective env over saved key, and an explicitly empty env suppresses the saved key", async () => {
    delete env.HUMANISH_STRICT_KEYS;
    setUserKey("AGENTMAIL_API_KEY", "synthetic-saved-key", env);
    env.AGENTMAIL_API_KEY = "synthetic-environment-key";
    const makeAdapter = vi.fn(() => adapter());
    // Discovery runs here, so it gets a temp home and no gh: no real ~/.e2b login, no real gh.
    const keyDeps = { homeDir: cwd, execText: async () => null };
    await checkCommsConnection({ cwd, env, online: true, makeAdapter, keyDeps });
    expect(makeAdapter).toHaveBeenCalledWith("synthetic-environment-key");
    env.AGENTMAIL_API_KEY = "";
    makeAdapter.mockClear();
    expect(
      await checkCommsConnection({ cwd, env, online: true, makeAdapter, keyDeps }),
    ).toMatchObject({
      ok: false,
      code: "credential_missing",
    });
    expect(makeAdapter).not.toHaveBeenCalled();
  });
  it("reports an authenticated key the adapter rejects for scope as not ready", async () => {
    env.AGENTMAIL_API_KEY = "synthetic-check-key";
    const provider = adapter();
    provider.authenticate = async () => {
      throw new AgentMailReceivingError("comms_scope_unsupported");
    };
    expect(
      await checkCommsConnection({ cwd, env, online: true, makeAdapter: () => provider }),
    ).toMatchObject({ ok: false, authenticated: true, ready: false, code: "scope_unsupported" });
  });
  it.each(["agentmail_auth_rejected", "agentmail_rate_limited", "agentmail_timeout"] as const)(
    "classifies %s without provider text or deleting stored credentials",
    async (code) => {
      env.AGENTMAIL_API_KEY = "synthetic-secret-canary";
      const provider = adapter();
      provider.authenticate = async () => {
        throw new AgentMailReceivingError(code);
      };
      const result = await checkCommsConnection({
        cwd,
        env,
        online: true,
        makeAdapter: () => provider,
      });
      expect(result).toMatchObject({
        ok: false,
        code,
        authenticated: code === "agentmail_auth_rejected" ? false : null,
      });
      expect(JSON.stringify(result)).not.toContain(env.AGENTMAIL_API_KEY);
      expect(env.AGENTMAIL_API_KEY).toBe("synthetic-secret-canary");
    },
  );
});
describe("receiving lab selection", () => {
  /** The source study: v3 under humanish/studies, or the v2 file under humanish/labs. */
  async function source(options: { v2?: boolean } = {}) {
    const dir = options.v2 ? "humanish/labs" : "humanish/studies";
    await mkdir(path.join(cwd, dir), { recursive: true });
    await writeFile(
      path.join(cwd, dir, "signup.yaml"),
      options.v2 ? stringify(lab) : studyFileText(lab, cwd),
    );
  }
  it("previews without mutation, then saves a resolvable local copy while preserving source", async () => {
    await source({ v2: true });
    const before = await readFile(path.join(cwd, "humanish/labs/signup.yaml"), "utf8");
    const plan = await configureCommsStudy({ cwd, lab: "signup", connection: "agentmail" });
    expect(plan).toMatchObject({
      ok: true,
      applied: false,
      path: ".humanish/local/studies/signup-receiving.yaml",
    });
    await expect(readFile(path.join(cwd, plan.path!))).rejects.toThrow();
    expect(
      await configureCommsStudy({
        cwd,
        lab: "signup",
        connection: "agentmail",
        apply: true,
        planToken: plan.planToken!,
      }),
    ).toMatchObject({ ok: true, applied: true });
    const selected = await resolveStudyManifest(cwd, plan.path!);
    expect(selected.ok && selected.config.comms?.email).toEqual({
      kind: "real",
      connection: "agentmail",
    });
    // The copy is a v3 study, converted from the v2 source.
    expect(selected.ok && selected.config.schema).toBe("humanish.study.v3");
    expect(await readFile(path.join(cwd, "humanish/labs/signup.yaml"), "utf8")).toBe(before);
  });
  it("rejects stale preview when the source or destination changes", async () => {
    await source();
    const plan = await configureCommsStudy({ cwd, lab: "signup", connection: "agentmail" });
    await writeFile(
      path.join(cwd, "humanish/studies/signup.yaml"),
      studyFileText({ ...lab, title: "Changed" }, cwd),
    );
    expect(
      await configureCommsStudy({
        cwd,
        lab: "signup",
        connection: "agentmail",
        apply: true,
        planToken: plan.planToken!,
      }),
    ).toMatchObject({ ok: false, applied: false });
    await expect(readFile(path.join(cwd, plan.path!))).rejects.toThrow();
  });
  it("preserves existing receiving link policy in the configured copy", async () => {
    await source();
    const email = {
      connection: "agentmail",
      allowedOrigins: ["https://accounts.example.test"],
      linkOrigin: "http://127.0.0.1:3000",
    };
    const original = studyFileText({ ...lab, comms: { email } }, cwd);
    await writeFile(path.join(cwd, "humanish/studies/signup.yaml"), original);
    const result = await configureCommsStudy({
      cwd,
      lab: "signup",
      connection: "agentmail",
      apply: true,
    });
    expect(result).toMatchObject({ ok: true, applied: true });
    const selected = await resolveStudyManifest(cwd, result.path!);
    expect(selected.ok && selected.config.comms?.email).toEqual({ kind: "real", ...email });
    expect(await readFile(path.join(cwd, "humanish/studies/signup.yaml"), "utf8")).toBe(original);
  });
  it("never overwrites a selected manifest that is already the receiving destination", async () => {
    await source();
    const first = await configureCommsStudy({
      cwd,
      lab: "signup",
      connection: "agentmail",
      apply: true,
    });
    const original = await readFile(path.join(cwd, first.path!), "utf8");
    for (const apply of [false, true]) {
      const result = await configureCommsStudy({
        cwd,
        lab: first.path!,
        connection: "agentmail",
        apply,
      });
      expect(result).toMatchObject({ ok: false, applied: false });
      expect(result.message).toContain("already the local receiving copy");
      expect(await readFile(path.join(cwd, first.path!), "utf8")).toBe(original);
    }
  });
  it("launches the exact selected local path even with a same-name committed manifest", async () => {
    await source();
    await mkdir(path.join(cwd, ".humanish/local/studies"), { recursive: true });
    await writeFile(
      path.join(cwd, ".humanish/local/studies/signup.yaml"),
      studyFileText({ ...lab, comms: { email: { connection: "agentmail" } } }, cwd),
    );
    const spawn = vi.fn(() => ({ pid: 4242, unref() {}, on() {} }));
    const launched = await launchRun({
      cwd,
      lab: "signup",
      manifestPath: ".humanish/local/studies/signup.yaml",
      mode: "live",
      spawn: spawn as never,
    });
    expect(launched.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(launched.ok && launched.run.command.at(-1)).toBe(".humanish/local/studies/signup.yaml");
  });
  it("rejects unsupported receiving and dangerous mixtures before execution", () => {
    for (const email of [
      { connection: "agentmail", injectEnv: "MAIL_API" },
      { connection: "agentmail", recipients: [] },
      { connection: "agentmail", allowedOrigins: ["https://target.test/path"] },
    ])
      expect(parseStudyDocument({ ...lab, comms: { email } }).ok).toBe(false);
    expect(
      parseStudyDocument({
        ...lab,
        actors: [{ type: "local-agent", mission: "Sign up" }],
        comms: { email: { connection: "agentmail" } },
      }).ok,
    ).toBe(false);
    const real = parseStudyDocument({
      ...lab,
      actors: [{ type: "openai-computer-use", count: 2, mission: "Sign up" }],
      comms: { email: { connection: "agentmail" } },
    });
    expect(real.ok).toBe(true);
    expect(real.ok && real.config.comms?.email?.recipients).toBeUndefined();
  });
});
