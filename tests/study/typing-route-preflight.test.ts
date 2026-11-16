import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { parseStudy } from "../../src/study/config.js";
import { inspectStudyManifest } from "../../src/study/discover.js";
import type { StudyConfig } from "../../src/study/types.js";
import { runStudyWith } from "../../src/run-study.js";
import { routeOf } from "../../src/study/plan.js";
import { runScripted, runTerminal } from "../helpers/route-run.js";

const fixtures = (
  JSON.parse(
    await readFile(new URL("../fixtures/task-route-preflight/labs.json", import.meta.url), "utf8"),
  ) as Array<{ name: string; config: Record<string, unknown>; route: string }>
).map((fixture) => ({
  ...fixture,
  // The routes whose participants read the composed computer-use prompt.
  reads: fixture.route === "computer-use" || fixture.route === "shared-world",
}));

const OWN_TYPING = "TYPING_ONLY_SENTINEL";

function withTyping(config: Record<string, unknown>, typing: unknown): Record<string, unknown> {
  const declared = structuredClone(config);
  (declared.actor as Record<string, unknown>).typing = typing;
  return declared;
}

function validConfig(raw: Record<string, unknown>): StudyConfig {
  const parsed = parseStudy(raw);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("actor.typing admission", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-typing-preflight-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(fixtures)("parses typing on $name only where the route reads it", ({ config, reads }) => {
    for (const typing of [false, OWN_TYPING]) {
      const result = parseStudy(withTyping(config, typing));
      expect(result.ok, JSON.stringify(result)).toBe(reads);
      if (result.ok) expect(result.config.actor.typing).toBe(typing);
      else {
        expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
        expect(result.error.message).toMatch(/^`actor\.typing`/);
        expect(result.error.message).not.toContain(OWN_TYPING);
      }
    }
  });

  it.each([
    ["true", true],
    ["an empty string", "  "],
    ["a number", 3],
    ["text longer than 4,000 characters", "a".repeat(4_001)],
  ])("refuses typing set to %s", (_label, typing) => {
    const supported = fixtures.find(({ reads }) => reads)!.config;
    const result = parseStudy(withTyping(supported, typing));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/^`actor\.typing`/);
  });

  it.each(fixtures.filter(({ reads }) => !reads))(
    "refuses a library config with typing on $name before any runner side effect",
    async ({ config }) => {
      const parsed = validConfig(config);
      parsed.actor.typing = OWN_TYPING; // A library caller skips parseStudy.
      const forbidden = vi.fn(async () => {
        throw new Error("provider/user hook forbidden");
      });
      const output = path.join(cwd, "must-not-exist");
      const outcome = await runStudyWith(
        parsed,
        { cwd: output, dryRun: false, env: {} },
        {
          desktopModule: forbidden,
          runSession: forbidden,
          runScriptedSession: forbidden,
          renderObserver: forbidden,
        },
      );
      expect(outcome.route).toBe(routeOf(parsed));
      expect(outcome.result.error).toMatchObject({ code: "HUMANISH_STUDY_TYPING_UNSUPPORTED" });
      expect(JSON.stringify(outcome.result)).not.toContain(OWN_TYPING);
      expect(forbidden).not.toHaveBeenCalled();
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(cwd)).toEqual([]);
    },
  );

  it.each([
    ["terminal", runTerminal],
    ["scripted", runScripted],
  ] as const)(
    "direct %s entry refuses typing even when given a computer-use config",
    async (_route, runner) => {
      const config = validConfig(fixtures.find(({ reads }) => reads)!.config);
      config.actor.typing = false;
      const result = await runner({ cwd: path.join(cwd, "must-not-exist"), config, dryRun: false });
      expect(result.error?.code).toBe("HUMANISH_STUDY_TYPING_UNSUPPORTED");
      expect(await readdir(cwd)).toEqual([]);
    },
  );
});

describe("humanish study show --json", () => {
  it.each([false, OWN_TYPING])("shows actor.typing %s as the study sets it", async (typing) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-typing-show-"));
    try {
      const study = withTyping(fixtures.find(({ reads }) => reads)!.config, typing);
      await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
      await writeFile(
        path.join(cwd, "humanish", "studies", "typing.yaml"),
        stringify({ ...study, id: "typing" }),
      );
      const shown = await inspectStudyManifest(cwd, "typing");
      expect(shown.ok, JSON.stringify(shown)).toBe(true);
      expect(shown.config?.actor.typing).toBe(typing);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
