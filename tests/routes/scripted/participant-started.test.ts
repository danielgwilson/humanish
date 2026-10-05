// A scripted run counts as one where participants ran once a surface's session starts, whether or
// not the session returns. Two surfaces start; one returns and one throws after it acted, as a
// failed trace write would. The surfaces run under Promise.all, so the run publishes no session
// result and no stream trace, yet the analysis events still fire.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runScriptedBrowserSession } from "../../../src/actors/scripted-browser/actor.js";
import type { AutomaticAnalysisOutcome } from "../../../src/analysis/job.js";
import { runStudyWith } from "../../../src/run-study.js";
import type { StudyEvent } from "../../../src/study/run-study-events.js";
import { parseStudyDocument } from "../../../src/study/config.js";
import { V2_SCHEMA } from "../../../src/study/types.js";
import { makeTestTempDir } from "../../helpers/temp-dir.js";

describe("scripted run whose surface session throws after it started", () => {
  it("still emits the analysis events", async () => {
    const cwd = await makeTestTempDir("humanish-scripted-started-");
    const scenario = await readFile(
      path.resolve("humanish", "scenarios", "scripted-first-run.yaml"),
      "utf8",
    );
    await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
    await writeFile(path.join(cwd, "humanish", "scenarios", "scripted-first-run.yaml"), scenario);
    const parsed = parseStudyDocument({
      schema: V2_SCHEMA,
      id: "scripted-started",
      title: "Scripted session start",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:9/" },
      actors: [{ type: "scripted-browser", persona: "synthetic-new-user", count: 2 }],
      scenario: { ref: "scripted-first-run", mode: "live" },
      review: { analysis: { maxCostUsd: 1 } },
      execution: { target: "local", timeoutMs: 30_000 },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);

    const started: string[] = [];
    const events: StudyEvent["type"][] = [];
    const analysis = vi.fn(
      async () => ({ state: "skipped", reason: "synthetic" }) as AutomaticAnalysisOutcome,
    );
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, open: false, onEvent: (event) => void events.push(event.type) },
      {
        browserCommand: "/synthetic/browser",
        analysis: { run: analysis },
        runScriptedSession: async (options) => {
          started.push(options.surface.id);
          if (options.surface.id !== "desktop")
            throw new Error("synthetic trace write failure after the session acted");
          // The desktop surface returns: its browser fails to launch, a harness-error session.
          return runScriptedBrowserSession({
            ...options,
            launchBrowser: async () => {
              throw new Error("synthetic launch failure");
            },
          });
        },
      },
    );
    if (outcome.route !== "scripted") throw new Error(`unexpected route ${outcome.route}`);

    expect(started.toSorted()).toEqual(["desktop", "mobile"]);
    expect(outcome.result.sessions).toEqual([]);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    ) as { streams: Array<{ actor?: unknown }> };
    expect(bundle.streams.some((stream) => stream.actor !== undefined)).toBe(false);
    expect(analysis).toHaveBeenCalledOnce();
    expect(events.filter((type) => type.startsWith("analysis-"))).toEqual([
      "analysis-started",
      "analysis-finished",
    ]);
  });
});
