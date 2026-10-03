import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parseStudy } from "../../src/study/config.js";
import { runStudyWith } from "../../src/run-study.js";
import { V2_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { runScriptedBrowserStudy } from "../../src/routes/scripted/route.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function cloneLab(actor: string, target: string | undefined): Record<string, unknown> {
  return {
    schema: V2_SCHEMA,
    id: "clone-target",
    subject: {
      source: "clone",
      exposure: "synthetic",
      repos: ["example-org/example-app"],
      serve: { start: "pnpm start --host 0.0.0.0", url: "http://127.0.0.1:3000/" },
      state: { seed: [{ name: "seed", command: "pnpm db:seed" }] },
    },
    actors: [{ type: actor }],
    scenario: { mode: "live", ...(actor === "scripted-browser" ? { ref: "first-run" } : {}) },
    ...(target === undefined ? {} : { execution: { target } }),
  };
}

/** A config that never went through the parser, as a library caller can hand one to runStudyWith. */
function unparsedCloneLab(actor: string, target: string | undefined): StudyConfig {
  return cloneLab(actor, target) as unknown as StudyConfig;
}

/** Counts desktop module loads; a refused lab must never reach one. */
function countingDesktopModule(): { load: () => Promise<E2BDesktopModule>; loads: () => number } {
  let loads = 0;
  return {
    load: async () => {
      loads += 1;
      throw new Error("the refused lab must not load the E2B desktop module");
    },
    loads: () => loads,
  };
}

const liveKeys = { OPENAI_API_KEY: "test-openai", E2B_API_KEY: "test-e2b" };

describe("clone subjects run only on execution.target: e2b-desktop", () => {
  it.each([
    { target: "local", got: 'got "local"' },
    { target: "e2b-terminal", got: 'got "e2b-terminal"' },
    { target: undefined, got: "it is absent" },
  ])("rejects a computer-use clone lab with target $target at parse", ({ target, got }) => {
    const result = parseStudy(cloneLab("openai-computer-use", target));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
    expect(result.error.message).toContain("execution.target: e2b-desktop");
    expect(result.error.message).toContain(got);
  });

  it("no longer lets an absent target skip the clone serve check", () => {
    const lab = cloneLab("openai-computer-use", undefined);
    const { serve: _serve, ...subject } = lab.subject as Record<string, unknown>;
    const result = parseStudy({ ...lab, subject });
    expect(result.ok).toBe(false);
  });

  it("accepts a computer-use clone lab on e2b-desktop", () => {
    expect(parseStudy(cloneLab("openai-computer-use", "e2b-desktop")).ok).toBe(true);
  });

  it.each(["local", undefined])(
    "refuses an unparsed clone lab with target %s at the computer-use route before any desktop",
    async (target) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "humanish-clone-target-"));
      const desktop = countingDesktopModule();
      try {
        const outcome = await runStudyWith(
          unparsedCloneLab("openai-computer-use", target),
          {
            cwd,
            dryRun: false,
            env: liveKeys,
          },
          {
            desktopModule: desktop.load,
          },
        );
        expect(outcome.route).toBe("computer-use");
        expect(outcome.result.ok).toBe(false);
        expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_INVALID");
        expect(outcome.result.error?.message).toContain("execution.target: e2b-desktop");
        expect(desktop.loads()).toBe(0);
        expect(await readdir(cwd)).toEqual([]);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it("refuses a local-target clone lab handed straight to runScriptedBrowserLab", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-clone-target-scripted-"));
    const desktop = countingDesktopModule();
    try {
      const result = await runScriptedBrowserStudy({
        cwd,
        config: unparsedCloneLab("scripted-browser", "local"),
        dryRun: false,
        env: liveKeys,
        deps: { desktopModule: desktop.load },
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HUMANISH_SCRIPTED_SUBJECT_UNSAFE");
      expect(result.error?.message).toContain("execution.target: e2b-desktop");
      expect(desktop.loads()).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("still parses every committed clone and local-tree lab", async () => {
    const dir = path.join(repoRoot, "humanish", "studies");
    const checked: string[] = [];
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".yaml")).sort()) {
      const raw = parse(await readFile(path.join(dir, file), "utf8")) as {
        subject?: { source?: string };
      };
      const source = raw.subject?.source;
      if (source !== "clone" && source !== "local-tree") continue;
      const result = parseStudy(raw);
      expect(result.ok ? "ok" : result.error.message, file).toBe("ok");
      checked.push(file);
    }
    expect(checked.length).toBeGreaterThan(0);
  });
});
