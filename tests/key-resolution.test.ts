import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeMissingKeys,
  discoverProviderKeys,
  listUserKeys,
  missingKeyHint,
  probeKeySources,
  resolveKeyName,
  setUserKey,
  unsetUserKey,
  userKeyStorePath
} from "../src/key-resolution.js";

describe("provider-key discovery (#436)", () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-keys-cwd-"));
    home = await mkdtemp(path.join(tmpdir(), "humanish-keys-home-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const noGh = async (): Promise<string | null> => null;
  const deps = () => ({ homeDir: home, execText: noGh });

  async function writeOverlay(lines: string[]): Promise<void> {
    await mkdir(path.join(cwd, ".humanish", "local"), { recursive: true });
    await writeFile(path.join(cwd, ".humanish", "local", "provider.env"), `${lines.join("\n")}\n`, "utf8");
  }
  async function writeE2bConfig(value: unknown): Promise<void> {
    await mkdir(path.join(home, ".e2b"), { recursive: true });
    await writeFile(path.join(home, ".e2b", "config.json"), JSON.stringify(value), "utf8");
  }
  async function writeUserStore(lines: string[]): Promise<void> {
    const store = path.join(home, ".config", "humanish");
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, "keys.env"), `${lines.join("\n")}\n`, "utf8");
  }

  it("fills from the project overlay and ANNOUNCES name + source, never the value", async () => {
    await writeOverlay(["OPENAI_API_KEY=sk-test-overlay-secret"]);
    const env: NodeJS.ProcessEnv = {};
    const announced: string[] = [];
    const fills = await discoverProviderKeys({ cwd, env, announce: (l) => announced.push(l), deps: deps() });
    expect(env.OPENAI_API_KEY).toBe("sk-test-overlay-secret");
    expect(fills).toEqual([{ name: "OPENAI_API_KEY", source: path.join(".humanish", "local", "provider.env") }]);
    expect(announced.join("\n")).toContain("OPENAI_API_KEY from");
    expect(announced.join("\n")).not.toContain("sk-test-overlay-secret");
  });

  it("is FILL-ONLY at every rung: process env beats overlay beats vendor store beats user store", async () => {
    await writeOverlay(["OPENAI_API_KEY=from-overlay", "E2B_API_KEY=from-overlay"]);
    await writeE2bConfig({ teamApiKey: "from-e2b-config" });
    await writeUserStore(["OPENAI_API_KEY=from-user-store", "CODEX_API_KEY=from-user-store"]);
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "from-process-env" };
    await discoverProviderKeys({ cwd, env, announce: () => {}, deps: deps() });
    expect(env.OPENAI_API_KEY).toBe("from-process-env"); // env won
    expect(env.E2B_API_KEY).toBe("from-overlay"); // overlay beat the e2b config
    expect(env.CODEX_API_KEY).toBe("from-user-store"); // the store still fills allowlisted names nothing else had
  });

  it("an explicitly-set EMPTY env value is PRESENT and never overridden (red-team)", async () => {
    await writeE2bConfig({ teamApiKey: "from-e2b-config" });
    const env: NodeJS.ProcessEnv = { E2B_API_KEY: "" };
    await discoverProviderKeys({ cwd, env, announce: () => {}, deps: deps() });
    expect(env.E2B_API_KEY).toBe(""); // "off" stays off
  });

  it("ignores and NAMES non-provider names in the overlay — NODE_OPTIONS can never ride in (red-team)", async () => {
    await writeOverlay(["OPENAI_API_KEY=k", "NODE_OPTIONS=--require /tmp/payload.js", "LD_PRELOAD=/tmp/evil.so"]);
    const env: NodeJS.ProcessEnv = {};
    const announced: string[] = [];
    const fills = await discoverProviderKeys({ cwd, env, announce: (l) => announced.push(l), deps: deps() });
    expect(env.OPENAI_API_KEY).toBe("k");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(fills.map((f) => f.name)).toEqual(["OPENAI_API_KEY"]);
    expect(announced.join("\n")).toContain("ignored non-provider name NODE_OPTIONS");
    expect(announced.join("\n")).not.toContain("payload.js"); // names, never values
  });

  it("a parse-invalid overlay applies NOTHING — no half-loaded unannounced fills (red-team)", async () => {
    await writeOverlay(["OPENAI_API_KEY=first", "not a valid line !!!"]);
    const env: NodeJS.ProcessEnv = {};
    const fills = await discoverProviderKeys({ cwd, env, announce: () => {}, deps: deps() });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(fills).toEqual([]);
  });

  it("one mangled store line degrades to that line alone — the store's own lenient grammar (red-team)", async () => {
    await writeUserStore(["OPENAI_API_KEY=good-value", "mangled line without equals"]);
    const env: NodeJS.ProcessEnv = {};
    await discoverProviderKeys({ cwd, env, announce: () => {}, deps: deps() });
    expect(env.OPENAI_API_KEY).toBe("good-value");
  });

  it("reads the e2b CLI's own login store for E2B_API_KEY (teamApiKey, then apiKey; garbage = miss)", async () => {
    await writeE2bConfig({ email: "x@example.test", teamApiKey: "e2b-team-key" });
    const env: NodeJS.ProcessEnv = {};
    const fills = await discoverProviderKeys({ cwd, env, announce: () => {}, deps: deps() });
    expect(env.E2B_API_KEY).toBe("e2b-team-key");
    expect(fills[0]?.source).toContain("e2b auth login");

    const env2: NodeJS.ProcessEnv = {};
    await writeE2bConfig({ apiKey: "e2b-plain-key" });
    await discoverProviderKeys({ cwd, env: env2, announce: () => {}, deps: deps() });
    expect(env2.E2B_API_KEY).toBe("e2b-plain-key");

    const env3: NodeJS.ProcessEnv = {};
    await writeE2bConfig({ nested: { not: "a key" } });
    await discoverProviderKeys({ cwd, env: env3, announce: () => {}, deps: deps() });
    expect(env3.E2B_API_KEY).toBeUndefined();
  });

  it("consults gh auth token only when NEITHER GitHub env name is set", async () => {
    const calls: string[][] = [];
    const gh = async (cmd: string, args: string[]): Promise<string | null> => {
      calls.push([cmd, ...args]);
      return "gh-token-value";
    };
    const env: NodeJS.ProcessEnv = {};
    await discoverProviderKeys({ cwd, env, announce: () => {}, deps: { homeDir: home, execText: gh } });
    expect(env.GH_TOKEN).toBe("gh-token-value");
    expect(calls).toEqual([["gh", "auth", "token"]]);

    const env2: NodeJS.ProcessEnv = { GITHUB_TOKEN: "already-here" };
    calls.length = 0;
    await discoverProviderKeys({ cwd, env: env2, announce: () => {}, deps: { homeDir: home, execText: gh } });
    expect(calls).toEqual([]); // GITHUB_TOKEN present -> gh never runs
    expect(env2.GH_TOKEN).toBeUndefined();
  });

  it("HUMANISH_STRICT_KEYS=1 disables every rung (the pre-#436 behavior)", async () => {
    await writeOverlay(["OPENAI_API_KEY=from-overlay"]);
    const env: NodeJS.ProcessEnv = { HUMANISH_STRICT_KEYS: "1" };
    const fills = await discoverProviderKeys({ cwd, env, announce: () => {}, deps: deps() });
    expect(fills).toEqual([]);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("refuses to read an overlay that is a symlink (retargeting shape)", async () => {
    await mkdir(path.join(cwd, ".humanish", "local"), { recursive: true });
    const outside = path.join(home, "outside.env");
    await writeFile(outside, "OPENAI_API_KEY=via-symlink\n", "utf8");
    await symlink(outside, path.join(cwd, ".humanish", "local", "provider.env"));
    const env: NodeJS.ProcessEnv = {};
    await discoverProviderKeys({ cwd, env, announce: () => {}, deps: deps() });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("probeKeySources reports the winning source per key WITHOUT mutating env", async () => {
    await writeOverlay(["E2B_API_KEY=from-overlay"]);
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "in-env" };
    const probes = await probeKeySources(["OPENAI_API_KEY", "E2B_API_KEY", "GH_TOKEN"], { cwd, env, deps: deps() });
    expect(probes).toEqual([
      { name: "OPENAI_API_KEY", source: "process env", hint: missingKeyHint("OPENAI_API_KEY") },
      { name: "E2B_API_KEY", source: path.join(".humanish", "local", "provider.env"), hint: missingKeyHint("E2B_API_KEY") },
      { name: "GH_TOKEN", source: null, hint: missingKeyHint("GH_TOKEN") }
    ]);
    expect(env.E2B_API_KEY).toBeUndefined(); // probe did not fill
  });

  it("describeMissingKeys names the fill command per key, and says so when discovery is off", () => {
    const text = describeMissingKeys(["OPENAI_API_KEY", "E2B_API_KEY"], {});
    expect(text).toContain("humanish keys set openai");
    expect(text).toContain("e2b auth login");
    expect(text).toContain("provider.env");
    const strict = describeMissingKeys(["E2B_API_KEY"], { HUMANISH_STRICT_KEYS: "1" });
    expect(strict).toContain("HUMANISH_STRICT_KEYS=1");
  });
});

describe("the user key store (`humanish keys`)", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "humanish-keys-store-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const deps = () => ({ homeDir: home });

  it("set writes 0600, list shows NAMES only, unset removes, and discovery reads it back", async () => {
    const env: NodeJS.ProcessEnv = {};
    const written = setUserKey("OPENAI_API_KEY", "sk-user-store-secret", env, deps());
    expect(written.path).toBe(userKeyStorePath(env, deps()));
    const mode = (await stat(written.path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect((await stat(path.dirname(written.path))).mode & 0o777).toBe(0o700);
    expect(listUserKeys(env, deps())).toEqual(["OPENAI_API_KEY"]);

    const runEnv: NodeJS.ProcessEnv = {};
    await discoverProviderKeys({ cwd: home, env: runEnv, announce: () => {}, deps: { ...deps(), execText: async () => null } });
    expect(runEnv.OPENAI_API_KEY).toBe("sk-user-store-secret");

    expect(unsetUserKey("OPENAI_API_KEY", env, deps())).toBe(true);
    expect(listUserKeys(env, deps())).toEqual([]);
    expect(await readFile(written.path, "utf8")).toBe("");
  });

  it("set refuses multi-line or empty values and invalid names", () => {
    expect(() => setUserKey("OPENAI_API_KEY", "a\nb", {}, deps())).toThrow(/single non-empty line/);
    expect(() => setUserKey("OPENAI_API_KEY", "   ", {}, deps())).toThrow(/single non-empty line/);
    expect(() => setUserKey("not a name", "x", {}, deps())).toThrow(/valid env name/);
  });

  it("resolveKeyName maps vendor aliases and accepts raw env names only", () => {
    expect(resolveKeyName("openai")).toBe("OPENAI_API_KEY");
    expect(resolveKeyName("E2B")).toBe("E2B_API_KEY");
    expect(resolveKeyName("MY_CUSTOM_KEY")).toBe("MY_CUSTOM_KEY");
    expect(resolveKeyName("not a name")).toBeNull();
  });

  it("the store holds PROVIDER keys only — an arbitrary-name store would be env injection with extra steps (red-team)", () => {
    expect(() => setUserKey("NODE_OPTIONS", "--require /tmp/x.js", {}, deps())).toThrow(/provider keys only/);
    expect(() => setUserKey("MY_CUSTOM_KEY", "v", {}, deps())).toThrow(/provider keys only/);
  });

  it("awkward values ('#'-leading, embedded '=') round-trip set -> discovery byte-identically (red-team)", async () => {
    setUserKey("OPENAI_API_KEY", "#not-a-comment=with=equals", {}, deps());
    const env: NodeJS.ProcessEnv = {};
    await discoverProviderKeys({ cwd: home, env, announce: () => {}, deps: { ...deps(), execText: async () => null } });
    expect(env.OPENAI_API_KEY).toBe("#not-a-comment=with=equals");
  });

  it("set refuses a symlinked store FILE and a symlinked store DIRECTORY (red-team, reproduced writes-through-link)", async () => {
    const { mkdir: mkdirP, symlink: symlinkP, writeFile: writeFileP } = await import("node:fs/promises");
    // Symlinked file: keys.env -> attacker target.
    const cfg = path.join(home, ".config", "humanish");
    await mkdirP(cfg, { recursive: true });
    const target = path.join(home, "attacker-target.env");
    await writeFileP(target, "", "utf8");
    await symlinkP(target, path.join(cfg, "keys.env"));
    expect(() => setUserKey("OPENAI_API_KEY", "sk-x", {}, deps())).toThrow();
    expect(await readFile(target, "utf8")).toBe(""); // nothing crossed the link

    // Symlinked parent dir: ~/.config/humanish -> attacker dir.
    const home2 = await mkdtemp(path.join(tmpdir(), "humanish-keys-sym2-"));
    try {
      const attackerDir = path.join(home2, "attacker-dir");
      await mkdirP(path.join(home2, ".config"), { recursive: true });
      await mkdirP(attackerDir, { recursive: true });
      await symlinkP(attackerDir, path.join(home2, ".config", "humanish"));
      expect(() => setUserKey("OPENAI_API_KEY", "sk-x", {}, { homeDir: home2 })).toThrow(/symlinked store directory/);
      // And discovery refuses to READ through the symlinked dir.
      await writeFileP(path.join(attackerDir, "keys.env"), "OPENAI_API_KEY=planted\n", "utf8");
      const env: NodeJS.ProcessEnv = {};
      await discoverProviderKeys({ cwd: home2, env, announce: () => {}, deps: { homeDir: home2, execText: async () => null } });
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it("a relative XDG_CONFIG_HOME is IGNORED per spec — the store never lands in the current repo (red-team)", () => {
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: "relative/dir" };
    expect(path.isAbsolute(userKeyStorePath(env, deps()))).toBe(true);
    expect(userKeyStorePath(env, deps())).toContain(home);
  });
});
