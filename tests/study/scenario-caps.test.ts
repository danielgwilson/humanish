import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parseStudy, parseStudyDocument } from "../../src/study/config.js";
import { runStudyWith } from "../../src/run-study.js";
import { actorOf, capsOf } from "../../src/study/study-fields.js";
import { STUDY_SCHEMA, V2_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function computerUseLab(caps: Record<string, number>): Record<string, unknown> {
  return {
    schema: V2_SCHEMA,
    id: "scenario-caps",
    subject: { source: "app-url", appUrl: "https://example.com/" },
    actors: [{ type: "openai-computer-use" }],
    execution: { target: "e2b-desktop" },
    scenario: { mode: "live", caps },
    policies: { allowPublicTargets: true },
  };
}

function terminalLab(caps: Record<string, number>): Record<string, unknown> {
  return {
    schema: STUDY_SCHEMA,
    id: "scenario-caps-terminal",
    route: "terminal",
    mode: "dry-run",
    subject: {
      source: "terminal-product",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] },
    },
    actor: { type: "codex-exec", mission: "Discover widgetsmith-cli from public surfaces." },
    caps: caps,
    execution: { target: "e2b-terminal" },
  };
}

describe("scenario.caps dollar fields on a computer-use lab", () => {
  it.each(["maxUsd", "maxTotalUsd"])(
    "refuses a positive %s at parse and names the execution.caps field",
    (key) => {
      const result = parseStudyDocument(computerUseLab({ [key]: 3, maxJobs: 0, maxMinutes: 12 }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
      expect(result.error.message).toContain(`execution.caps.${key}`);
    },
  );

  it("parses zeros with the inert-field warning", () => {
    const result = parseStudyDocument(computerUseLab({ maxUsd: 0, maxTotalUsd: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toContain(
      "scenario.caps (needs subject.source: terminal-product",
    );
  });

  it("leaves a terminal lab's positive scenario.caps.maxUsd alone", () => {
    const result = parseStudy(terminalLab({ maxUsd: 1.5, maxJobs: 0, maxMinutes: 10 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(capsOf(result.config, "terminal")?.maxUsd).toBe(1.5);
  });

  it.each(["maxUsd", "maxTotalUsd"])(
    "refuses an unparsed lab with a positive %s at the computer-use route before any desktop",
    async (key) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "humanish-scenario-caps-"));
      let loads = 0;
      const loadDesktopModule = async (): Promise<E2BDesktopModule> => {
        loads += 1;
        throw new Error("the refused lab must not load the E2B desktop module");
      };
      try {
        const outcome = await runStudyWith(
          computerUseLab({ [key]: 3 }) as unknown as StudyConfig,
          {
            cwd,
            dryRun: false,
            env: { OPENAI_API_KEY: "test-openai", E2B_API_KEY: "test-e2b" },
          },
          {
            desktopModule: loadDesktopModule,
          },
        );
        expect(outcome.route).toBe("computer-use");
        expect(outcome.result.ok).toBe(false);
        expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_INVALID");
        expect(outcome.result.error?.message).toContain(`execution.caps.${key}`);
        expect(loads).toBe(0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it.each(["detect-taskly-clean", "detect-taskly-planted", "detect-todomvc"])(
    "caps the committed %s lab through execution.caps.maxUsd with bounded output",
    async (id) => {
      const raw: unknown = parse(
        await readFile(path.join(repoRoot, "humanish", "studies", `${id}.yaml`), "utf8"),
      );
      const result = parseStudy(raw);
      expect(result.ok ? "ok" : result.error.message).toBe("ok");
      if (!result.ok) return;
      expect(capsOf(result.config, "computer-use")?.maxUsd).toBe(3);
      expect(actorOf(result.config)?.maxOutputTokens).toBe(8192);
    },
  );

  it("finds no committed computer-use lab with a positive scenario.caps dollar field", async () => {
    const dir = path.join(repoRoot, "humanish", "studies");
    const refused: string[] = [];
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".yaml"))) {
      const result = parseStudy(parse(await readFile(path.join(dir, file), "utf8")));
      if (!result.ok && result.error.message.includes("scenario.caps.")) refused.push(file);
    }
    expect(refused).toEqual([]);
  });
});
