// runStudy takes a StudyConfig a library caller may have built without parseStudy. Since 0.111.0
// that config has the keys of a humanish.study.v3 file, and the planners read only those. runStudy
// refuses, in the route's own envelope and before anything runs, a config that still sets a
// humanish 0.110 field, one with no `actor`, and one whose `route` is not the route it takes.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runStudy } from "../../src/run-study.js";
import { parseStudy } from "../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

type Raw = Record<string, unknown>;

const study: Raw = {
  schema: STUDY_SCHEMA,
  id: "library-config",
  route: "computer-use",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actor: { type: "openai-computer-use", mission: "Use the app." },
  execution: { target: "e2b-desktop" },
};

async function refused(config: Raw) {
  const cwd = await makeTestTempDir("humanish-library-config-");
  const outcome = await runStudy(config as unknown as StudyConfig, { cwd, dryRun: true });
  await expect(readdir(path.join(cwd, ".humanish"))).rejects.toThrow(/ENOENT/);
  return outcome;
}

describe("runStudy with a config built without parseStudy", () => {
  it.each([
    [
      "execution.caps",
      { ...study, execution: { target: "e2b-desktop", caps: { maxUsd: 1 } } },
      "`execution.caps` is `caps`",
    ],
    [
      "actors",
      { ...study, actor: undefined, actors: [{ type: "openai-computer-use", count: 2 }] },
      "`actors[0]` is `actor`",
    ],
    ["a scenario object", { ...study, scenario: { mode: "live" } }, "`scenario.mode` is `mode`"],
    [
      "subject.topology",
      { ...study, subject: { ...(study.subject as Raw), topology: "shared-world" } },
      "`subject.topology: shared-world` is `route: shared-world`",
    ],
    ["personas", { ...study, personas: [{ id: "x" }] }, "`personas` has no field now"],
    [
      "a participant key on the actor",
      { ...study, actor: { type: "openai-computer-use", count: 3 } },
      "`actor.count`, `actor.lanes`, `actor.roster` and `actor.laneFocus` are `participants`",
    ],
    [
      "laneFocus on the actor",
      { ...study, actor: { type: "openai-computer-use", laneFocus: { instruction: "Export." } } },
      "`actor.count`, `actor.lanes`, `actor.roster` and `actor.laneFocus` are `participants`",
    ],
  ])("refuses a config that still sets %s", async (_field, config, move) => {
    const outcome = await refused(config);
    expect(outcome.route).toBe("computer-use");
    expect(outcome.result).toMatchObject({
      ok: false,
      runId: "not-created",
      error: { code: "HUMANISH_STUDY_V2_UNSUPPORTED" },
    });
    expect(outcome.result.error?.message).toContain(move);
    expect(outcome.result.error?.message).toContain("0.111.0 release notes");
  });

  it("names every 0.110 field a config sets", async () => {
    const outcome = await refused({
      ...study,
      execution: { target: "e2b-desktop", caps: { maxUsd: 1 } },
      personas: [{ id: "x" }],
    });
    expect(outcome.result.error?.message).toContain("`execution.caps` is `caps`");
    expect(outcome.result.error?.message).toContain("`personas` has no field now");
  });

  it("refuses a config with no actor", async () => {
    const outcome = await refused({ ...study, actor: undefined });
    expect(outcome.route).toBe("computer-use");
    expect(outcome.result.error).toEqual({
      code: "HUMANISH_STUDY_INVALID",
      message: "A study needs `actor:`, an object with at least `type`.",
    });
  });

  it("refuses a config with no route", async () => {
    const outcome = await refused({ ...study, route: undefined });
    expect(outcome.result.error).toEqual({
      code: "HUMANISH_STUDY_INVALID",
      message:
        "A study needs `route:`, one of preview, computer-use, shared-world, terminal, scripted.",
    });
  });

  it("refuses a declared route the config does not take, with parseStudy's message", async () => {
    const config = { ...study, route: "shared-world" };
    const outcome = await refused(config);
    expect(outcome.route).toBe("computer-use");
    const parsed = parseStudy({ ...config, route: "preview" });
    if (parsed.ok) throw new Error("parsed");
    expect(parsed.error.message).toContain("This study declares route: preview, but");
    expect(outcome.result.error).toEqual({
      code: "HUMANISH_STUDY_INVALID",
      message: parsed.error.message.replace("route: preview", "route: shared-world"),
    });
  });

  it("runs a v3 config", async () => {
    const cwd = await makeTestTempDir("humanish-library-config-");
    const outcome = await runStudy(study as unknown as StudyConfig, { cwd, dryRun: true });
    expect(outcome.route).toBe("computer-use");
    expect(outcome.result.ok).toBe(true);
  });
});
