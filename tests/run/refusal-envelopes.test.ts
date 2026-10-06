// Pins the text of the refusal envelopes no golden holds: the option refusal on each route and the
// shared-world CLI's own refusal. A result is written as JSON, so its key order is part of what a
// caller reads, and each site keeps its own order.

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommanderError } from "commander";
import { afterAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { createProgram } from "../../src/cli/program.js";
import { runStudy, type RunStudyOptions } from "../../src/run-study.js";
import { lab, type BaseName } from "../admission/fixtures.js";
import { libraryConfig } from "../helpers/library-config.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const removedOption = {
  code: "HUMANISH_STUDY_OPTION_UNSUPPORTED",
  message:
    '`rerun.laneIds` was removed in 0.107.0. Use `rerun.participantIds`. See docs/contracts/schemas.md, "Library options".',
};

// The option refusal lists the shared fields first and each route's own fields after `error`.
const optionRefusals: [BaseName, Record<string, unknown>][] = [
  [
    "preview",
    {
      schema: "humanish.study-result.v1",
      route: "preview",
      studyId: "adm-preview",
      ok: false,
      cwd: "[cwd]",
      warnings: [],
      error: removedOption,
    },
  ],
  [
    "cuAppUrl",
    {
      schema: "humanish.study-result.v1",
      route: "computer-use",
      studyId: "adm-cuappurl",
      ok: false,
      cwd: "[cwd]",
      actor: "openai-computer-use",
      dryRun: true,
      runId: "not-created",
      warnings: [],
      error: removedOption,
      appUrl: "http://127.0.0.1:3000/",
      lanes: [],
    },
  ],
  [
    "scriptedAppUrl",
    {
      schema: "humanish.study-result.v1",
      route: "scripted",
      studyId: "adm-scriptedappurl",
      ok: false,
      cwd: "[cwd]",
      actor: "scripted-browser",
      dryRun: true,
      runId: "not-created",
      warnings: [],
      error: removedOption,
      appUrl: "http://127.0.0.1:3000/",
      sessions: [],
    },
  ],
  [
    "terminal",
    {
      schema: "humanish.study-result.v1",
      route: "terminal",
      studyId: "adm-terminal",
      ok: false,
      cwd: "[cwd]",
      actor: "codex-exec",
      dryRun: true,
      runId: "not-created",
      warnings: [],
      error: removedOption,
      product: "widgetsmith-cli",
    },
  ],
  [
    "sharedProvisioned",
    {
      schema: "humanish.study-result.v1",
      route: "shared-world",
      studyId: "adm-sharedprovisioned",
      ok: false,
      cwd: "[cwd]",
      actor: "openai-computer-use",
      dryRun: true,
      runId: "not-created",
      warnings: [],
      error: removedOption,
      topology: "shared-world",
      topologyMode: "concurrent",
      roleCount: 2,
      concurrency: 2,
      roles: [],
    },
  ],
];

describe("refusal envelopes", () => {
  it.each(optionRefusals)("the option refusal on %s keeps its text", async (base, expected) => {
    const cwd = "/refusal-envelope-fixture";
    const outcome = await runStudy(libraryConfig(lab(base)), {
      cwd,
      rerun: { sourceRunId: "prior-run", laneIds: ["lane-01"] },
    } as unknown as RunStudyOptions);
    const text = JSON.stringify(outcome.result).split(cwd).join("[cwd]");
    expect(text).toBe(JSON.stringify(expected));
  });

  it("the shared-world CLI refusal keeps its text", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-refusal-envelope-"));
    dirs.push(cwd);
    await writeFile(path.join(cwd, "package.json"), '{ "name": "refusal-envelope-fixture" }\n');
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    const study = { ...lab("sharedProvisioned", { mode: "live" }), id: "sw-live" };
    await writeFile(path.join(cwd, "humanish", "studies", "sw-live.yaml"), stringify(study));

    const stdout: string[] = [];
    let exitCode = 0;
    const program = createProgram({
      writeOut: (text) => stdout.push(text),
      writeErr: () => undefined,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    program.exitOverride();
    // --serve follows the live run, so the port is checked before the run starts.
    const args = ["watch", "sw-live", "--port", "99999", "--serve", "--json", "--cwd", cwd];
    try {
      await program.parseAsync(["node", "humanish", ...args], { from: "node" });
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
      exitCode = error.exitCode;
    }

    expect(exitCode).toBe(2);
    let text = stdout.join("").trim();
    for (const dir of [await realpath(cwd), cwd]) text = text.split(dir).join("[cwd]");
    expect(text).toBe(
      JSON.stringify(
        {
          schema: "humanish.study-result.v1",
          route: "shared-world",
          studyId: "sw-live",
          ok: false,
          cwd: "[cwd]",
          actor: "openai-computer-use",
          topology: "shared-world",
          topologyMode: "concurrent",
          roleCount: 2,
          concurrency: 2,
          dryRun: false,
          runId: "not-created",
          roles: [],
          warnings: [],
          error: {
            code: "HUMANISH_SHARED_WORLD_FAILED",
            message: "--port must be an integer between 0 and 65535.",
          },
        },
        null,
        2,
      ),
    );
  });
});
