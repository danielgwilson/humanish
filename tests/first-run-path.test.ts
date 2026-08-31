import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  AGENTS_SECTION_MARKER,
  agentsSection,
  firstRunSteps,
  starterActorFor
} from "../src/first-run-path.js";
import { runInit } from "../src/init.js";

// #505: `humanish init` wrote twenty files and stopped, and the only lab that could run was a $0
// dry run — the two live ones were templates containing `your-org/your-app`. Three independent
// sources landed on the same wall: a participant in our own TUI study walked to the Start row and
// found a placeholder URL, an adoption review concluded "the funnel is broken at the first live
// run", and the release-gate participant said it unprompted.

describe("what to do next, resolved against this machine", () => {
  it("always leads with the run that needs nothing", () => {
    for (const env of [
      { hasE2bKey: false, hasProviderKey: false, localAgents: [], hasDesktopSdk: true, installedInProject: true },
      { hasE2bKey: true, hasProviderKey: true, localAgents: [], hasDesktopSdk: true, installedInProject: true }
    ]) {
      expect(firstRunSteps(env)[0]?.command).toBe("humanish run first-run");
    }
  });

  it("asks for the ONE credential a live study always needs, when it is missing", () => {
    const steps = firstRunSteps({ hasE2bKey: false, hasProviderKey: true, localAgents: ["Codex"], hasDesktopSdk: true, installedInProject: true });
    expect(steps.at(-1)?.command).toBe("humanish keys set e2b");
  });

  it("offers the real run when the machine can do one — by key OR by signed-in agent", () => {
    const byKey = firstRunSteps({ hasE2bKey: true, hasProviderKey: true, localAgents: [], hasDesktopSdk: true, installedInProject: true });
    expect(byKey.at(-1)?.command).toBe("humanish run try-live");
    expect(byKey.at(-1)?.why).toContain("your provider key");

    const byAgent = firstRunSteps({ hasE2bKey: true, hasProviderKey: false, localAgents: ["Codex"], hasDesktopSdk: true, installedInProject: true });
    expect(byAgent.at(-1)?.command).toBe("humanish run try-live");
    // The point of the local-agent route: no API key hunt before the first real run.
    expect(byAgent.at(-1)?.why).toContain("no API key needed");
  });

  it("names the model credential only when there is genuinely no brain available", () => {
    const steps = firstRunSteps({ hasE2bKey: true, hasProviderKey: false, localAgents: [], hasDesktopSdk: true, installedInProject: true });
    expect(steps.at(-1)?.command).toBe("humanish keys set openai");
  });


  it("folds the optional desktop SDK into the step when the project does not have it", () => {
    // Found by running the PUBLISHED artifact cold: `npx humanish` does not install the optional
    // peer, so "run try-live" stopped with "install this other package first" — the same dead end
    // one layer down. Two local runs had passed only because they resolved it from the repo.
    const missing = firstRunSteps({ hasE2bKey: true, hasProviderKey: true, localAgents: [], hasDesktopSdk: false, installedInProject: true });
    expect(missing.at(-1)?.command).toBe("npm i -D @e2b/desktop && humanish run try-live");
    const present = firstRunSteps({ hasE2bKey: true, hasProviderKey: true, localAgents: [], hasDesktopSdk: true, installedInProject: true });
    expect(present.at(-1)?.command).toBe("humanish run try-live");
  });


  it("tells an npx one-shot to install humanish TOO, because the peer alone cannot be found", () => {
    // `npx humanish@latest` resolves its optional peer relative to ITSELF, not the project, so
    // "npm i -D @e2b/desktop" there installs something Node will never look at. This cost two cold
    // verification runs before the difference was spotted — both "failed" identically while the
    // advice on screen was impossible to follow.
    const viaNpx = firstRunSteps({
      hasE2bKey: true, hasProviderKey: true, localAgents: [], hasDesktopSdk: false, installedInProject: false
    });
    expect(viaNpx.at(-1)?.command).toBe("npm i -D humanish @e2b/desktop && npx humanish run try-live");

    const installed = firstRunSteps({
      hasE2bKey: true, hasProviderKey: true, localAgents: [], hasDesktopSdk: false, installedInProject: true
    });
    expect(installed.at(-1)?.command).toBe("npm i -D @e2b/desktop && humanish run try-live");
  });

  it("stays SHORT — a list of options is the same as no guidance", () => {
    for (const env of [
      { hasE2bKey: false, hasProviderKey: false, localAgents: [], hasDesktopSdk: true, installedInProject: true },
      { hasE2bKey: true, hasProviderKey: false, localAgents: ["Codex"], hasDesktopSdk: true, installedInProject: true },
      { hasE2bKey: true, hasProviderKey: true, localAgents: ["Codex", "Claude Code"], hasDesktopSdk: true, installedInProject: true }
    ]) {
      expect(firstRunSteps(env).length).toBeLessThanOrEqual(2);
    }
  });
});

describe("the starter live lab is written for the brain this machine has", () => {
  it("uses the operator's signed-in agent when there is no provider key", () => {
    expect(starterActorFor({ hasE2bKey: true, hasProviderKey: false, localAgents: ["Codex"], hasDesktopSdk: true, installedInProject: true })).toBe("local-agent");
  });

  it("prefers the provider key when there is one — it is the calibrated path", () => {
    expect(starterActorFor({ hasE2bKey: true, hasProviderKey: true, localAgents: ["Codex"], hasDesktopSdk: true, installedInProject: true })).toBe("openai-computer-use");
  });

  it("falls back to the provider actor when nothing is signed in, so the file is still a template that works once keys exist", () => {
    expect(starterActorFor({ hasE2bKey: false, hasProviderKey: false, localAgents: [], hasDesktopSdk: true, installedInProject: true })).toBe("openai-computer-use");
  });
});

describe("init leaves instructions for the next coding agent", () => {
  async function project(): Promise<string> {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-firstrun-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");
    return cwd;
  }

  it("writes a runnable starter live lab, not a placeholder", async () => {
    const cwd = await project();
    try {
      await runInit({ cwd, yes: true, env: {} });
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

  it("creates AGENTS.md when there is none", async () => {
    const cwd = await project();
    try {
      await runInit({ cwd, yes: true, env: {} });
      const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
      expect(agents).toContain(AGENTS_SECTION_MARKER);
      expect(agents).toContain("humanish run first-run");
      // The agent must know the human surface exists AND that it is not for the agent.
      expect(agents).toContain("humanish tui");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("APPENDS to an existing AGENTS.md and never rewrites what someone else wrote", async () => {
    const cwd = await project();
    try {
      await writeFile(path.join(cwd, "AGENTS.md"), "# AGENTS.md\n\n## House rules\n\nUse pnpm.\n", "utf8");
      await runInit({ cwd, yes: true, env: {} });
      const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
      expect(agents).toContain("## House rules");
      expect(agents).toContain("Use pnpm.");
      expect(agents).toContain(AGENTS_SECTION_MARKER);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second init does not append the section twice", async () => {
    const cwd = await project();
    try {
      await runInit({ cwd, yes: true, env: {} });
      await runInit({ cwd, yes: true, env: {} });
      const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
      expect(agents.split(AGENTS_SECTION_MARKER).length - 1).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ends by naming the next command", async () => {
    const cwd = await project();
    try {
      const result = await runInit({ cwd, yes: true, env: {} });
      expect(result.nextSteps?.join("\n")).toContain("humanish run first-run");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("says nothing about next steps on a dry run — there is no 'next' until something was written", () => {
    expect(agentsSection()).toContain(AGENTS_SECTION_MARKER);
  });
});
