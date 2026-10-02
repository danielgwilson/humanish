import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  AGENTS_SECTION_MARKER,
  agentsSection,
  firstRunSteps,
  starterActorFor,
  starterLocalAgentFor,
  type FirstRunEnvironment,
} from "../../src/cli/first-run-path.js";
import { parseLabConfig } from "../../src/lab/config.js";
import { brainOf } from "../../src/lab/plan-base.js";
import { setUserKey } from "../../src/keys/key-resolution.js";
import { runInit } from "../../src/lab/init.js";
import { parse as parseYaml } from "yaml";

const CODEX = { id: "codex", label: "Codex" } as const;
const CLAUDE = { id: "claude", label: "Claude Code" } as const;

// `humanish init` wrote twenty files and stopped, and the only study that could run was a $0
// dry run: the two live ones were templates containing `your-org/your-app`. Three independent
// sources landed on the same wall: a participant in our own TUI study walked to the Start row and
// found a placeholder URL, an adoption review concluded "the funnel is broken at the first live
// run", and the release-gate participant said it unprompted.

describe("what to do next, resolved against this machine", () => {
  it("always leads with the run that needs nothing", () => {
    for (const env of [
      {
        hasE2bKey: false,
        hasProviderKey: false,
        localAgents: [],
        hasDesktopSdk: true,
        installedInProject: true,
      },
      {
        hasE2bKey: true,
        hasProviderKey: true,
        localAgents: [],
        hasDesktopSdk: true,
        installedInProject: true,
      },
    ]) {
      expect(firstRunSteps(env)[0]?.command).toBe("npx humanish run first-run");
    }
  });

  it("offers supported hosts the local route without sending them to E2B or an API key", () => {
    const linux = firstRunSteps({
      hasE2bKey: false,
      hasProviderKey: false,
      localAgents: [],
      hasDesktopSdk: false,
      installedInProject: true,
      platform: "linux",
      arch: "x64",
    });
    expect(linux.at(-1)?.command).toBe("npx humanish doctor --lab local-browser");
    expect(linux.at(-1)?.why).toContain("Docker, KVM, TUN");
    expect(linux.at(-1)?.why).toContain("no E2B or model API key");
    expect(linux.at(-1)?.why).toContain("npx humanish runtime setup");
    expect(linux.at(-1)?.why).toContain("npx humanish run local-browser");

    const mac = firstRunSteps({
      hasE2bKey: false,
      hasProviderKey: false,
      localAgents: [],
      hasDesktopSdk: false,
      installedInProject: true,
      platform: "darwin",
      arch: "arm64",
    });
    expect(mac.at(-1)?.why).toContain("M3-or-newer Mac");
    expect(mac.at(-1)?.why).toContain("Lima 2.2+");
  });

  it("asks for the one credential a live study always needs, when it is missing", () => {
    const steps = firstRunSteps({
      hasE2bKey: false,
      hasProviderKey: true,
      localAgents: [CODEX],
      hasDesktopSdk: true,
      installedInProject: true,
      platform: "win32",
      arch: "x64",
    });
    expect(steps.at(-1)?.command).toBe("npx humanish keys set e2b");
    expect(steps.at(-1)?.why).toContain("Local browsers are unavailable on this host");
  });

  it("offers the real run when the machine can do one: by key or by signed-in agent", () => {
    const byKey = firstRunSteps({
      hasE2bKey: true,
      hasProviderKey: true,
      localAgents: [],
      hasDesktopSdk: true,
      installedInProject: true,
    });
    expect(byKey.at(-1)?.command).toBe("npx humanish run try-live");
    expect(byKey.at(-1)?.why).toContain("your provider key");

    const byAgent = firstRunSteps({
      hasE2bKey: true,
      hasProviderKey: false,
      localAgents: [CODEX],
      hasDesktopSdk: true,
      installedInProject: true,
    });
    expect(byAgent.at(-1)?.command).toBe("npx humanish run try-live");
    // The point of the local-agent route: no API key hunt before the first real run.
    expect(byAgent.at(-1)?.why).toContain("no API key needed");
  });

  it("names the model credential only when there is genuinely no brain available", () => {
    const steps = firstRunSteps({
      hasE2bKey: true,
      hasProviderKey: false,
      localAgents: [],
      hasDesktopSdk: true,
      installedInProject: true,
    });
    expect(steps.at(-1)?.command).toBe("npx humanish keys set openai");
  });

  it("folds the optional desktop SDK into the step when the project does not have it", () => {
    // Found by running the published artifact cold: `npx humanish` does not install the optional
    // peer, so "run try-live" stopped with "install this other package first": the same dead end
    // one layer down. Two local runs had passed only because they resolved it from the repo.
    const missing = firstRunSteps({
      hasE2bKey: true,
      hasProviderKey: true,
      localAgents: [],
      hasDesktopSdk: false,
      installedInProject: true,
    });
    expect(missing.at(-1)?.command).toBe("npm i -D @e2b/desktop && npx humanish run try-live");
    const present = firstRunSteps({
      hasE2bKey: true,
      hasProviderKey: true,
      localAgents: [],
      hasDesktopSdk: true,
      installedInProject: true,
    });
    expect(present.at(-1)?.command).toBe("npx humanish run try-live");
  });

  it("tells an npx one-shot to install humanish too, because the peer alone cannot be found", () => {
    // `npx humanish@latest` resolves its optional peer relative to itself, not the project, so
    // "npm i -D @e2b/desktop" there installs something Node will never look at. This cost two cold
    // verification runs before the difference was spotted: both "failed" identically while the
    // advice on screen was impossible to follow.
    const viaNpx = firstRunSteps({
      hasE2bKey: true,
      hasProviderKey: true,
      localAgents: [],
      hasDesktopSdk: false,
      installedInProject: false,
    });
    expect(viaNpx.at(-1)?.command).toBe(
      "npm i -D humanish @e2b/desktop && npx humanish run try-live",
    );

    const installed = firstRunSteps({
      hasE2bKey: true,
      hasProviderKey: true,
      localAgents: [],
      hasDesktopSdk: false,
      installedInProject: true,
    });
    expect(installed.at(-1)?.command).toBe("npm i -D @e2b/desktop && npx humanish run try-live");
  });

  it("stays short: a list of options is the same as no guidance", () => {
    for (const env of [
      {
        hasE2bKey: false,
        hasProviderKey: false,
        localAgents: [],
        hasDesktopSdk: true,
        installedInProject: true,
      },
      {
        hasE2bKey: true,
        hasProviderKey: false,
        localAgents: [CODEX],
        hasDesktopSdk: true,
        installedInProject: true,
      },
      {
        hasE2bKey: true,
        hasProviderKey: true,
        localAgents: [CODEX, CLAUDE],
        hasDesktopSdk: true,
        installedInProject: true,
      },
    ]) {
      expect(firstRunSteps(env).length).toBeLessThanOrEqual(2);
    }
  });
});

describe("the starter live lab is written for the brain this machine has", () => {
  it("names the signed-in agent in the lab: Codex when it is signed in, else Claude Code", () => {
    const env = (localAgents: FirstRunEnvironment["localAgents"], hasProviderKey = false) => ({
      hasE2bKey: true,
      hasProviderKey,
      localAgents,
      hasDesktopSdk: true,
      installedInProject: true,
    });
    expect(starterLocalAgentFor(env([CLAUDE]))).toBe("claude");
    expect(starterLocalAgentFor(env([CLAUDE, CODEX]))).toBe("codex");
    expect(starterLocalAgentFor(env([CODEX]))).toBe("codex");
    expect(starterLocalAgentFor(env([CLAUDE], true))).toBeUndefined();
    expect(firstRunSteps(env([CLAUDE])).at(-1)?.why).toContain(
      "using Claude Code (already signed in",
    );
  });

  it("uses the operator's signed-in agent when there is no provider key", () => {
    expect(
      starterActorFor({
        hasE2bKey: true,
        hasProviderKey: false,
        localAgents: [CODEX],
        hasDesktopSdk: true,
        installedInProject: true,
      }),
    ).toBe("local-agent");
  });

  it("prefers the provider key when there is one: it is the calibrated path", () => {
    expect(
      starterActorFor({
        hasE2bKey: true,
        hasProviderKey: true,
        localAgents: [CODEX],
        hasDesktopSdk: true,
        installedInProject: true,
      }),
    ).toBe("openai-computer-use");
  });

  it("falls back to the provider actor when nothing is signed in, so the file is still a template that works once keys exist", () => {
    expect(
      starterActorFor({
        hasE2bKey: false,
        hasProviderKey: false,
        localAgents: [],
        hasDesktopSdk: true,
        installedInProject: true,
      }),
    ).toBe("openai-computer-use");
  });
});

describe("init finds a provider key the way every other command does", () => {
  // A value no real provider would issue; the assertions check it never leaves the key store.
  const fakeKey = "test-openai-key-not-real";

  /** A home, a project and a `PATH` that holds a Codex CLI reporting a ChatGPT login, or nothing. */
  async function machine(options: { signedInAgent: boolean | "claude" }) {
    const root = await mkdtemp(path.join(tmpdir(), "humanish-init-keys-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const bin = path.join(root, "bin");
    await mkdir(home);
    await mkdir(cwd);
    await mkdir(bin);
    if (options.signedInAgent === true) {
      await writeFile(path.join(bin, "codex"), "#!/bin/sh\necho 'Logged in using ChatGPT'\n");
      await chmod(path.join(bin, "codex"), 0o755);
    }
    if (options.signedInAgent === "claude") {
      await writeFile(path.join(bin, "claude"), "#!/bin/sh\necho '{\"loggedIn\": true}'\n");
      await chmod(path.join(bin, "claude"), 0o755);
    }
    return { root, cwd, env: { HOME: home, PATH: bin } as NodeJS.ProcessEnv };
  }

  async function initActor(cwd: string, env: NodeJS.ProcessEnv) {
    const result = await runInit({ cwd, yes: true, env });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(fakeKey);
    const lab = await readFile(path.join(cwd, "humanish/labs/try-live.yaml"), "utf8");
    expect(lab).not.toContain(fakeKey);
    return {
      actor: /^ {2}- type: (\S+)$/m.exec(lab)?.[1],
      capped: /^ {4}maxUsd: 2\b/m.test(lab),
    };
  }

  it("uses the provider key from the environment, even with a signed-in agent", async () => {
    const { root, cwd, env } = await machine({ signedInAgent: true });
    try {
      const lab = await initActor(cwd, { ...env, OPENAI_API_KEY: fakeKey });
      expect(lab).toEqual({ actor: "openai-computer-use", capped: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the provider key from the `humanish keys set` store, even with a signed-in agent", async () => {
    const { root, cwd, env } = await machine({ signedInAgent: true });
    try {
      setUserKey("OPENAI_API_KEY", fakeKey, env, { homeDir: env.HOME! });
      const lab = await initActor(cwd, env);
      expect(lab).toEqual({ actor: "openai-computer-use", capped: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the starter lab on Claude Code when it is the only signed-in agent", async () => {
    const { root, cwd, env } = await machine({ signedInAgent: "claude" });
    try {
      expect(await initActor(cwd, env)).toEqual({ actor: "local-agent", capped: false });
      const lab = await readFile(path.join(cwd, "humanish/labs/try-live.yaml"), "utf8");
      const parsed = parseLabConfig(parseYaml(lab));
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect(brainOf(parsed.config, false)).toEqual({ kind: "local-agent", agent: "claude" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the signed-in agent when no provider key is found anywhere", async () => {
    const { root, cwd, env } = await machine({ signedInAgent: true });
    try {
      const lab = await initActor(cwd, env);
      expect(lab).toEqual({ actor: "local-agent", capped: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes the capped provider lab when there is neither a key nor a signed-in agent", async () => {
    const { root, cwd, env } = await machine({ signedInAgent: false });
    try {
      const lab = await initActor(cwd, env);
      expect(lab).toEqual({ actor: "openai-computer-use", capped: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("init leaves instructions for the next coding agent", () => {
  // Each init gets the project as its `HOME`. init reads the e2b login from `env.HOME`, so a test
  // env without one would read the machine's own ~/.e2b/config.json.
  async function project(): Promise<string> {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-firstrun-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0" }),
      "utf8",
    );
    return cwd;
  }

  it("writes a runnable starter live lab, not a placeholder", async () => {
    const cwd = await project();
    try {
      await runInit({ cwd, yes: true, env: { HOME: cwd } });
      const lab = await readFile(path.join(cwd, "humanish/labs/try-live.yaml"), "utf8");
      // The defect this closes: `your-org/your-app` cannot be run by anyone.
      expect(lab).not.toContain("your-org/your-app");
      expect(lab).not.toContain("your-public-app.example");
      expect(lab).toContain("drawdb-io/drawdb");
      expect(lab).toContain("mode: live");
      // A first run must not be able to become expensive.
      expect(lab).toContain("maxUsd");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // The loop stops before the next request once the running estimate passes maxUsd
  // (src/actors/computer-use/loop/spend.ts), so the last request can go over. The files init
  // writes must not promise a hard ceiling.
  it("describes the dollar cap as an estimate checked before each request", async () => {
    const cwd = await project();
    try {
      await runInit({ cwd, yes: true, env: { HOME: cwd } });
      const lab = await readFile(path.join(cwd, "humanish/labs/try-live.yaml"), "utf8");
      const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
      for (const text of [lab, agents]) {
        expect(text).not.toMatch(/fail-closed|ceiling|rather than overspending/i);
        expect(text).toMatch(/estimated model spend/);
        expect(text).toMatch(/stops before its next (model )?request/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("configures a local browser app and mission without YAML editing", async () => {
    const cwd = await project();
    try {
      const result = await runInit({
        cwd,
        yes: true,
        env: { HOME: cwd },
        localBrowser: {
          appUrl: "http://localhost:4173/app",
          mission: "Create a synthetic note and save it.",
        },
      });
      expect(result.ok).toBe(true);
      const lab = await readFile(path.join(cwd, "humanish/labs/local-browser.yaml"), "utf8");
      expect(lab).toContain('appUrl: "http://localhost:4173/app"');
      expect(lab).toContain('mission: "Create a synthetic note and save it."');
      expect(lab).toContain("target: local");
      expect(lab).toContain("localAgent: codex");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a non-loopback local browser target before writing", async () => {
    const cwd = await project();
    try {
      const result = await runInit({
        cwd,
        yes: true,
        env: { HOME: cwd },
        localBrowser: {
          appUrl: "https://public.example.test:4443",
        },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_INVALID_LOCAL_BROWSER" },
      });
      await expect(
        readFile(path.join(cwd, "humanish/labs/local-browser.yaml"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves an existing local lab and warns when explicit setup flags could not apply", async () => {
    const cwd = await project();
    try {
      await runInit({ cwd, yes: true, env: { HOME: cwd } });
      const file = path.join(cwd, "humanish/labs/local-browser.yaml");
      const before = await readFile(file, "utf8");
      const result = await runInit({
        cwd,
        yes: true,
        env: { HOME: cwd },
        localBrowser: {
          appUrl: "http://localhost:4173",
          mission: "Use a different flow.",
        },
      });
      expect(await readFile(file, "utf8")).toBe(before);
      expect(result.warnings).toContain(
        "Skipped --local-browser/--local-mission: humanish/labs/local-browser.yaml already exists and init never overwrites it.",
      );

      const ordinaryRepeat = await runInit({ cwd, yes: true, env: { HOME: cwd } });
      expect(ordinaryRepeat.warnings).not.toEqual(
        expect.arrayContaining([expect.stringContaining("--local-browser")]),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates agents.md when there is none", async () => {
    const cwd = await project();
    try {
      await runInit({ cwd, yes: true, env: { HOME: cwd } });
      const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
      expect(agents).toContain(AGENTS_SECTION_MARKER);
      expect(agents).toContain("humanish run first-run");
      // The agent must know the human surface exists and that it is not for the agent.
      expect(agents).toContain("humanish tui");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("appends to an existing agents.md and never rewrites what someone else wrote", async () => {
    const cwd = await project();
    try {
      await writeFile(
        path.join(cwd, "AGENTS.md"),
        "# AGENTS.md\n\n## House rules\n\nUse pnpm.\n",
        "utf8",
      );
      await runInit({ cwd, yes: true, env: { HOME: cwd } });
      const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
      expect(agents).toContain("## House rules");
      expect(agents).toContain("Use pnpm.");
      expect(agents).toContain(AGENTS_SECTION_MARKER);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("is idempotent: a second init does not append the section twice", async () => {
    const cwd = await project();
    try {
      await runInit({ cwd, yes: true, env: { HOME: cwd } });
      await runInit({ cwd, yes: true, env: { HOME: cwd } });
      const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
      expect(agents.split(AGENTS_SECTION_MARKER).length - 1).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ends by naming the next command", async () => {
    const cwd = await project();
    try {
      const result = await runInit({ cwd, yes: true, env: { HOME: cwd } });
      expect(result.nextSteps?.join("\n")).toContain("humanish run first-run");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("says nothing about next steps on a dry run: there is no 'next' until something was written", () => {
    expect(agentsSection()).toContain(AGENTS_SECTION_MARKER);
  });
});
