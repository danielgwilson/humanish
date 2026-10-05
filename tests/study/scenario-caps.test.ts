// A study's `caps` block holds the dollar caps a route enforces. A humanish.lab.v2 computer-use file
// that put a dollar cap in `scenario.caps` ran uncapped, so migrate refuses to convert it.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { parseStudy } from "../../src/study/config.js";
import { convertStudyText } from "../../src/study/migrate/convert.js";
import { V2_SCHEMA } from "../../src/study/migrate/v2.js";
import { STUDY_SCHEMA } from "../../src/study/types.js";

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

describe("dollar caps", () => {
  it.each(["maxUsd", "maxTotalUsd"])(
    "migrate refuses a v2 computer-use file with a positive scenario.caps.%s, naming execution.caps",
    (key) => {
      const result = convertStudyText(
        stringify(computerUseLab({ [key]: 3, maxJobs: 0, maxMinutes: 12 })),
        repoRoot,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(`execution.caps.${key}`);
    },
  );

  it("migrate drops a v2 computer-use file's zero scenario.caps", () => {
    const result = convertStudyText(
      stringify(computerUseLab({ maxUsd: 0, maxTotalUsd: 0 })),
      repoRoot,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.conversion.dropped.map((key) => key.path)).toEqual(["scenario.caps"]);
  });

  it("leaves a terminal study's positive caps.maxUsd alone", () => {
    const result = parseStudy(terminalLab({ maxUsd: 1.5, maxJobs: 0, maxMinutes: 10 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.caps?.maxUsd).toBe(1.5);
  });

  it.each(["detect-taskly-clean", "detect-taskly-planted", "detect-todomvc"])(
    "caps the committed %s study through caps.maxUsd with bounded output",
    async (id) => {
      const raw: unknown = parse(
        await readFile(path.join(repoRoot, "humanish", "studies", `${id}.yaml`), "utf8"),
      );
      const result = parseStudy(raw);
      expect(result.ok ? "ok" : result.error.message).toBe("ok");
      if (!result.ok) return;
      expect(result.config.caps?.maxUsd).toBe(3);
      expect(result.config.actor?.maxOutputTokens).toBe(8192);
    },
  );

  it("parses every committed study", async () => {
    const dir = path.join(repoRoot, "humanish", "studies");
    const refused: string[] = [];
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".yaml"))) {
      const result = parseStudy(parse(await readFile(path.join(dir, file), "utf8")));
      if (!result.ok) refused.push(file);
    }
    expect(refused).toEqual([]);
  });
});
