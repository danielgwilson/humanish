import path from "node:path";

import { describe, expect, it } from "vitest";

import { placeRun, runnerKeysLine } from "../../src/cli/commands/study-remote.js";
import type { StudyCommandOptions } from "../../src/cli/io.js";
import { parseStudy } from "../../src/study/config.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type Patch } from "../admission/fixtures.js";

const cwd = path.resolve("/synthetic/project");
const studyPath = path.join(cwd, "humanish/studies/study.yaml");

/** A computer-use study on hosted desktops with a public app: one that can run remotely. */
function study(patch: Patch = {}): StudyConfig {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      subject: { source: "app-url", appUrl: "https://app.example.com/" },
      policies: { allowPublicTargets: true },
      execution: { target: "modal-desktop", timeoutMs: 300_000 },
      review: { analysis: false },
      ...patch,
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

const place = (config: StudyConfig, options: Partial<StudyCommandOptions> = {}) =>
  placeRun({ options: { cwd, ...options }, config, studyPath, env: {}, packaged: true });

describe("where a study's run executes", () => {
  it("runs remotely by default when the study can", () => {
    expect(place(study())).toMatchObject({ kind: "remote", plan: { provider: "modal" } });
  });

  it("stays on this machine with --local or execution.remote: false", () => {
    expect(place(study(), { local: true })).toEqual({ kind: "local" });
    expect(place(study({ execution: { target: "modal-desktop", remote: false } }))).toEqual({
      kind: "local",
    });
  });

  it("lets one run override the study's field either way", () => {
    expect(
      place(study({ execution: { target: "modal-desktop", timeoutMs: 300_000, remote: false } }), {
        remote: true,
      }),
    ).toMatchObject({ kind: "remote" });
    expect(
      place(study({ execution: { target: "modal-desktop", remote: true } }), { local: true }),
    ).toEqual({ kind: "local" });
  });

  it("says why a hosted study it cannot move stays here, and stays quiet for a local one", () => {
    const localApp = study({ subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" } });
    expect(place(localApp)).toMatchObject({
      kind: "local",
      note: expect.stringContaining("Not running remotely: its app URL points at this machine"),
    });
    expect(place(study(), { scorer: "scorer.mjs" })).toMatchObject({
      kind: "local",
      note: expect.stringContaining("--scorer"),
    });
    const onThisMachine = study({
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      policies: undefined,
      execution: { target: "local", timeoutMs: 300_000 },
    });
    expect(place(onThisMachine)).toEqual({ kind: "local" });
  });

  it("refuses a required remote run that cannot happen, with the reason", () => {
    const localApp = study({ subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" } });
    expect(place(localApp, { remote: true })).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("This study cannot run remotely"),
    });
    expect(place(localApp, { remote: false })).toMatchObject({ kind: "local" });
  });

  it("never launches a runner from inside a runner, whatever the study or flags say", () => {
    const inside = { HUMANISH_INSIDE_RUNNER: "1" };
    expect(
      placeRun({ options: { cwd }, config: study(), studyPath, env: inside, packaged: true }),
    ).toEqual({
      kind: "local",
    });
    expect(
      placeRun({
        options: { cwd },
        config: study({ execution: { target: "modal-desktop", timeoutMs: 300_000, remote: true } }),
        studyPath,
        env: inside,
        packaged: true,
      }),
    ).toEqual({ kind: "local" });
    expect(
      placeRun({
        options: { cwd, remote: true },
        config: study(),
        studyPath,
        env: inside,
        packaged: true,
      }),
    ).toMatchObject({ kind: "refused" });
  });

  it("keeps a dry run here, even when the study or the run asks for a remote one", () => {
    expect(place(study(), { dryRun: true })).toEqual({ kind: "local" });
    expect(place(study(), { dryRun: true, remote: true })).toMatchObject({
      kind: "local",
      note: expect.stringContaining("dry run"),
    });
    expect(
      place(study({ mode: "dry-run", execution: { target: "modal-desktop", remote: true } })),
    ).toMatchObject({ kind: "local" });
  });

  it("keeps a run from a source checkout here, which a runner cannot install", () => {
    const fromSource = placeRun({
      options: { cwd },
      config: study(),
      studyPath,
      env: {},
      packaged: false,
    });
    expect(fromSource).toMatchObject({ kind: "local", note: expect.stringContaining("source") });
    // A study that could not run remotely anyway gives its own reason.
    const localApp = study({ subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" } });
    expect(
      placeRun({ options: { cwd }, config: localApp, studyPath, env: {}, packaged: false }),
    ).toMatchObject({ kind: "local", note: expect.stringContaining("points at this machine") });
  });

  it("keeps a study with email comms here", () => {
    const withComms = study({ comms: { email: { kind: "real", connection: "synthetic-inbox" } } });
    expect(place(withComms)).toMatchObject({
      kind: "local",
      note: expect.stringContaining("email"),
    });
  });

  it("runs a live terminal study remotely on its shell sandbox's provider", () => {
    const terminal = (execution: Patch["execution"]) => {
      const parsed = parseStudy(lab("terminal", { mode: "live", execution }));
      if (!parsed.ok) throw new Error(parsed.error.message);
      return placeRun({
        options: { cwd },
        config: parsed.config,
        studyPath,
        env: {},
        packaged: true,
      });
    };
    expect(
      terminal({
        target: "e2b-terminal",
        terminal: { transport: "exec-stream", stdin: "disabled" },
      }),
    ).toMatchObject({ kind: "remote", plan: { provider: "e2b", route: "terminal" } });
    expect(terminal({ target: "modal-terminal", runtimeAuth: "openai-env" })).toMatchObject({
      kind: "remote",
      plan: { provider: "modal", route: "terminal" },
    });
  });

  it("says nothing for a hosted study of a kind that never runs remotely", () => {
    const parsed = parseStudy(lab("scriptedAppUrl", { mode: "live" }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const scripted = placeRun({
      options: { cwd },
      config: parsed.config,
      studyPath,
      env: {},
      packaged: true,
    });
    expect(scripted).toEqual({ kind: "local" });
  });
});

describe("the line that names a runner's keys before the run", () => {
  it("on E2B, names the keys E2B's proxy holds apart from those sent as environment variables", () => {
    const line = runnerKeysLine("e2b", {
      held: ["E2B_API_KEY", "OPENAI_API_KEY"],
      sent: ["HUMANISH_E2B_MAX_SANDBOX_MINUTES"],
    });
    expect(line).toMatch(/E2B's egress proxy holds E2B_API_KEY, OPENAI_API_KEY\b/);
    expect(line).toMatch(/HUMANISH_E2B_MAX_SANDBOX_MINUTES as environment variables/);
  });

  it("on Modal, says every key enters the runner as an environment variable", () => {
    const line = runnerKeysLine("modal", {
      held: [],
      sent: ["MODAL_TOKEN_ID", "OPENAI_API_KEY"],
    });
    expect(line).toMatch(/MODAL_TOKEN_ID, OPENAI_API_KEY as environment variables/);
    expect(line).not.toMatch(/proxy holds/);
  });
});
