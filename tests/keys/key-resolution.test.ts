import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeMissingKeys,
  discoverProviderKeys,
  listUserKeys,
  missingKeyHint,
  probeKeySources,
  resolveKeyName,
  setUserKey,
  unsetUserKey,
  userKeyStorePath,
} from "../../src/keys/key-resolution.js";

describe("provider-key discovery", () => {
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
    await writeFile(
      path.join(cwd, ".humanish", "local", "provider.env"),
      `${lines.join("\n")}\n`,
      "utf8",
    );
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

  it("fills from the project overlay and announces name + source, never the value", async () => {
    await writeOverlay(["OPENAI_API_KEY=sk-test-overlay-secret"]);
    const env: NodeJS.ProcessEnv = {};
    const announced: string[] = [];
    const fills = await discoverProviderKeys({
      cwd,
      env,
      announce: (l) => announced.push(l),
      deps: deps(),
    });
    expect(env.OPENAI_API_KEY).toBe("sk-test-overlay-secret");
    expect(fills).toEqual([
      { name: "OPENAI_API_KEY", source: path.join(".humanish", "local", "provider.env") },
    ]);
    expect(announced.join("\n")).toContain("OPENAI_API_KEY from");
    expect(announced.join("\n")).not.toContain("sk-test-overlay-secret");
  });

  it("is fill-only at every rung: process env beats overlay beats vendor store beats user store", async () => {
    await writeOverlay(["OPENAI_API_KEY=from-overlay", "E2B_API_KEY=from-overlay"]);
    await writeE2bConfig({ teamApiKey: "from-e2b-config" });
    await writeUserStore(["OPENAI_API_KEY=from-user-store", "CODEX_API_KEY=from-user-store"]);
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "from-process-env" };
    await discoverProviderKeys({ cwd, env, announce: () => {}, deps: deps() });
    expect(env.OPENAI_API_KEY).toBe("from-process-env"); // env won
    expect(env.E2B_API_KEY).toBe("from-overlay"); // overlay beat the e2b config
    expect(env.CODEX_API_KEY).toBe("from-user-store"); // the store still fills allowlisted names nothing else had
  });

  it("an explicitly-set empty env value is present and never overridden", async () => {
    await writeE2bConfig({ teamApiKey: "from-e2b-config" });
    const env: NodeJS.ProcessEnv = { E2B_API_KEY: "" };
    await discoverProviderKeys({ cwd, env, announce: () => {}, deps: deps() });
    expect(env.E2B_API_KEY).toBe(""); // "off" stays off
  });

  it("ignores and names non-provider names in the overlay: NODE_OPTIONS can never ride in", async () => {
    await writeOverlay([
      "OPENAI_API_KEY=k",
      "NODE_OPTIONS=--require /tmp/payload.js",
      "LD_PRELOAD=/tmp/evil.so",
    ]);
    const env: NodeJS.ProcessEnv = {};
    const announced: string[] = [];
    const fills = await discoverProviderKeys({
      cwd,
      env,
      announce: (l) => announced.push(l),
      deps: deps(),
    });
    expect(env.OPENAI_API_KEY).toBe("k");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(fills.map((f) => f.name)).toEqual(["OPENAI_API_KEY"]);
    expect(announced.join("\n")).toContain("ignored non-provider name NODE_OPTIONS");
    expect(announced.join("\n")).not.toContain("payload.js"); // names, never values
  });

  it("a parse-invalid overlay applies nothing: no half-loaded unannounced fills", async () => {
    await writeOverlay(["OPENAI_API_KEY=first", "not a valid line !!!"]);
    const env: NodeJS.ProcessEnv = {};
    const fills = await discoverProviderKeys({ cwd, env, announce: () => {}, deps: deps() });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(fills).toEqual([]);
  });

  it("one mangled store line degrades to that line alone: the store's own lenient grammar", async () => {
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

  it("consults gh auth token only when neither GitHub env name is set", async () => {
    const calls: string[][] = [];
    const gh = async (cmd: string, args: string[]): Promise<string | null> => {
      calls.push([cmd, ...args]);
      return "gh-token-value";
    };
    const env: NodeJS.ProcessEnv = {};
    await discoverProviderKeys({
      cwd,
      env,
      announce: () => {},
      deps: { homeDir: home, execText: gh },
    });
    expect(env.GH_TOKEN).toBe("gh-token-value");
    expect(calls).toEqual([["gh", "auth", "token"]]);

    const env2: NodeJS.ProcessEnv = { GITHUB_TOKEN: "already-here" };
    calls.length = 0;
    await discoverProviderKeys({
      cwd,
      env: env2,
      announce: () => {},
      deps: { homeDir: home, execText: gh },
    });
    expect(calls).toEqual([]); // GITHUB_TOKEN present -> gh never runs
    expect(env2.GH_TOKEN).toBeUndefined();
  });

  it("with announced, fills every key as without it and announces only the named fills", async () => {
    await writeE2bConfig({ teamApiKey: "test-e2b-key" });
    await writeUserStore([
      "OPENAI_API_KEY=test-openai-key",
      "AGENTMAIL_API_KEY=test-agentmail-key",
    ]);
    const calls: string[][] = [];
    const gh = async (cmd: string, args: string[]): Promise<string | null> => {
      calls.push([cmd, ...args]);
      return "gh-token-value";
    };
    const run = async (announced?: ReadonlySet<string>) => {
      const env: NodeJS.ProcessEnv = {};
      const lines: string[] = [];
      const fills = await discoverProviderKeys({
        cwd,
        env,
        announce: (line) => lines.push(line),
        deps: { homeDir: home, execText: gh },
        ...(announced === undefined ? {} : { announced }),
      });
      return { env, fills, lines };
    };

    const all = await run();
    const filtered = await run(new Set(["OPENAI_API_KEY"]));

    expect(filtered.fills).toEqual(all.fills);
    expect(filtered.env).toEqual(all.env);
    expect(all.lines).toHaveLength(4);
    expect(filtered.lines).toEqual([
      "humanish keys: OPENAI_API_KEY from ~/.config/humanish/keys.env",
    ]);
    expect(calls).toEqual([
      ["gh", "auth", "token"],
      ["gh", "auth", "token"],
    ]);
  });

  it("runs gh with no provider key in its environment, filled or exported", async () => {
    // The CLI discovers into process.env itself, so this does too. Every name it touches is
    // stubbed first, so vitest restores all of them after the test.
    const bin = path.join(home, "bin");
    const dump = path.join(home, "gh-env.txt");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "gh"),
      '#!/bin/sh\n/usr/bin/env > "$GH_ENV_DUMP"\necho gh-token-value\n',
      { mode: 0o755 },
    );
    await writeOverlay(["ANTHROPIC_API_KEY=synthetic-overlay-anthropic"]);
    await writeE2bConfig({ teamApiKey: "synthetic-e2b-store" });
    const exported = {
      OPENAI_API_KEY: "synthetic-exported-openai",
      CODEX_API_KEY: "synthetic-exported-codex",
      AGENTMAIL_API_KEY: "synthetic-exported-agentmail",
    };
    for (const name of ["ANTHROPIC_API_KEY", "E2B_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"])
      vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(exported)) vi.stubEnv(name, value);
    vi.stubEnv("HUMANISH_STRICT_KEYS", undefined);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    vi.stubEnv("GH_ENV_DUMP", dump);
    await discoverProviderKeys({
      cwd,
      env: process.env,
      announce: () => {},
      deps: { homeDir: home },
    });

    // gh ran after the overlay and e2b rungs filled their keys.
    expect(process.env.GH_TOKEN).toBe("gh-token-value");
    expect(process.env.ANTHROPIC_API_KEY).toBe("synthetic-overlay-anthropic");
    expect(process.env.E2B_API_KEY).toBe("synthetic-e2b-store");
    const seen = await readFile(dump, "utf8");
    expect(seen).toContain(`GH_ENV_DUMP=${dump}`);
    for (const name of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "E2B_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "CODEX_API_KEY",
      "AGENTMAIL_API_KEY",
    ])
      expect(seen).not.toMatch(new RegExp(`^${name}=`, "m"));
    for (const value of [
      ...Object.values(exported),
      "synthetic-overlay-anthropic",
      "synthetic-e2b-store",
    ])
      expect(seen).not.toContain(value);
  });

  it("HUMANISH_STRICT_KEYS=1 disables every rung", async () => {
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

  it("probeKeySources reports the winning source per key without mutating env", async () => {
    await writeOverlay(["E2B_API_KEY=from-overlay"]);
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "in-env" };
    const probes = await probeKeySources(["OPENAI_API_KEY", "E2B_API_KEY", "GH_TOKEN"], {
      cwd,
      env,
      deps: deps(),
    });
    expect(probes).toEqual([
      { name: "OPENAI_API_KEY", source: "process env", hint: missingKeyHint("OPENAI_API_KEY") },
      {
        name: "E2B_API_KEY",
        source: path.join(".humanish", "local", "provider.env"),
        hint: missingKeyHint("E2B_API_KEY"),
      },
      { name: "GH_TOKEN", source: null, hint: missingKeyHint("GH_TOKEN") },
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

  it("set writes 0600, list shows names only, unset removes, and discovery reads it back", async () => {
    const env: NodeJS.ProcessEnv = {};
    const written = setUserKey("OPENAI_API_KEY", "sk-user-store-secret", env, deps());
    expect(written.path).toBe(userKeyStorePath(env, deps()));
    const mode = (await stat(written.path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect((await stat(path.dirname(written.path))).mode & 0o777).toBe(0o700);
    expect(listUserKeys(env, deps())).toEqual(["OPENAI_API_KEY"]);

    const runEnv: NodeJS.ProcessEnv = {};
    await discoverProviderKeys({
      cwd: home,
      env: runEnv,
      announce: () => {},
      deps: { ...deps(), execText: async () => null },
    });
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

  it("the store holds provider keys only: an arbitrary-name store would be env injection with extra steps", () => {
    expect(() => setUserKey("NODE_OPTIONS", "--require /tmp/x.js", {}, deps())).toThrow(
      /provider keys only/,
    );
    expect(() => setUserKey("MY_CUSTOM_KEY", "v", {}, deps())).toThrow(/provider keys only/);
  });

  it("awkward values ('#'-leading, embedded '=') round-trip set -> discovery byte-identically", async () => {
    setUserKey("OPENAI_API_KEY", "#not-a-comment=with=equals", {}, deps());
    const env: NodeJS.ProcessEnv = {};
    await discoverProviderKeys({
      cwd: home,
      env,
      announce: () => {},
      deps: { ...deps(), execText: async () => null },
    });
    expect(env.OPENAI_API_KEY).toBe("#not-a-comment=with=equals");
  });

  it("set refuses a symlinked store file and a symlinked store directory", async () => {
    const {
      mkdir: mkdirP,
      symlink: symlinkP,
      writeFile: writeFileP,
    } = await import("node:fs/promises");
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
      expect(() => setUserKey("OPENAI_API_KEY", "sk-x", {}, { homeDir: home2 })).toThrow(
        /symlinked store directory/,
      );
      // And discovery refuses to read through the symlinked dir.
      await writeFileP(path.join(attackerDir, "keys.env"), "OPENAI_API_KEY=planted\n", "utf8");
      const env: NodeJS.ProcessEnv = {};
      await discoverProviderKeys({
        cwd: home2,
        env,
        announce: () => {},
        deps: { homeDir: home2, execText: async () => null },
      });
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it("a relative XDG_CONFIG_HOME is ignored per spec: the store never lands in the current repo", () => {
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: "relative/dir" };
    expect(path.isAbsolute(userKeyStorePath(env, deps()))).toBe(true);
    expect(userKeyStorePath(env, deps())).toContain(home);
  });
});
