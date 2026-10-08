import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { STUDY_SCHEMA } from "../../src/study/types.js";
import { readStudySummary } from "../../src/study/summary.js";
import { lab as admissionLab } from "../admission/fixtures.js";

const base = {
  schema: STUDY_SCHEMA,
  id: "key-check",
  route: "computer-use",
  mode: "live",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actor: { type: "openai-computer-use", mission: "Use the app." },
  execution: { target: "e2b-desktop" },
};

async function summary(config: unknown, env: NodeJS.ProcessEnv) {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-summary-keys-"));
  try {
    await mkdir(path.join(cwd, "humanish/studies"), { recursive: true });
    await writeFile(path.join(cwd, "humanish/studies/key-check.yaml"), stringify(config));
    const result = await readStudySummary(cwd, "key-check", {
      checkKeys: true,
      env: { HUMANISH_STRICT_KEYS: "1", ...env },
    });
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain("synthetic-credential");
    return result!;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("TUI key summary follows the configured route", () => {
  it("checks a dry-run study's keys against the live plan its live row names", async () => {
    // `humanish run` on this file runs a dry run; the screen still offers a live run, so the keys
    // it shows are the ones a live run of this study needs.
    expect(await summary({ ...base, mode: "dry-run" }, {})).toMatchObject({
      mode: "dry-run",
      keysReady: false,
      missingKeys: ["E2B_API_KEY", "OPENAI_API_KEY"],
    });
    expect(await summary(base, {})).toMatchObject({ mode: "live" });
  });

  it("reports the live plan's refusal for a study that can only run dry", async () => {
    // The first-run starter's shape.
    const result = await summary(
      {
        schema: STUDY_SCHEMA,
        id: "key-check",
        route: "preview",
        mode: "dry-run",
        subject: { source: "this-repo" },
        actor: { type: "synthetic-persona" },
        participants: 4,
      },
      {},
    );
    expect(result.keysReady).toBeUndefined();
    expect(result.planRefusal).toBe(
      "this-repo studies are dry-run only; use a clone or app-url subject for a live run.",
    );
  });

  it("requires desktop plus model for API computer use", async () => {
    expect(await summary(base, { E2B_API_KEY: "synthetic-credential-desktop" })).toMatchObject({
      keysReady: false,
      missingKeys: ["OPENAI_API_KEY"],
    });
    expect(
      await summary(base, {
        E2B_API_KEY: "synthetic-credential-desktop",
        OPENAI_API_KEY: "synthetic-credential-model",
      }),
    ).toMatchObject({ keysReady: true });
  });

  it("does not block local-agent participants on the optional analysis key", async () => {
    const result = await summary(
      { ...base, actor: { type: "local-agent", localAgent: "codex", mission: "Use the app." } },
      { E2B_API_KEY: "synthetic-credential-desktop" },
    );
    expect(result.keysReady).toBe(true);
    expect(result.missingKeys).toBeUndefined();
  });

  it("accepts terminal CODEX_API_KEY without requiring a second model key", async () => {
    const config = {
      ...base,
      route: "terminal",
      subject: {
        source: "terminal-product",
        product: { name: "example-cli", publicSurfaces: ["https://example.test"] },
      },
      actor: { type: "codex-exec", mission: "Use the CLI." },
      // A live terminal run without a cap does not plan.
      caps: { maxUsd: 0, maxMinutes: 5 },
      execution: {
        target: "e2b-terminal",
        runtimeAuth: "openai-env",
        terminal: { transport: "exec-stream", stdin: "disabled" },
      },
    };
    expect(
      await summary(config, {
        E2B_API_KEY: "synthetic-credential-desktop",
        CODEX_API_KEY: "synthetic-credential-model",
      }),
    ).toMatchObject({ keysReady: true });
    expect(await summary(config, { E2B_API_KEY: "synthetic-credential-desktop" })).toMatchObject({
      keysReady: false,
      missingKeys: ["OPENAI_API_KEY"],
    });
  });

  it("names a clone subject's missing env after the provider keys", async () => {
    const clone = admissionLab("cuClone", {
      id: "key-check",
      mode: "live",
      subject: { env: ["SYNTHETIC_SUBJECT_TOKEN"] },
    });
    expect(await summary(clone, {})).toMatchObject({
      keysReady: false,
      missingKeys: ["E2B_API_KEY", "OPENAI_API_KEY", "SYNTHETIC_SUBJECT_TOKEN"],
    });
    expect(
      await summary(clone, {
        E2B_API_KEY: "synthetic-credential-desktop",
        OPENAI_API_KEY: "synthetic-credential-model",
        SYNTHETIC_SUBJECT_TOKEN: "synthetic-credential-subject",
      }),
    ).toMatchObject({ keysReady: true });
  });

  it("reports the planner's refusal in place of the keys for a lab that will not plan", async () => {
    // A 55-minute session derives a sandbox deadline past the 60-minute limit.
    const result = await summary(
      { ...base, execution: { ...base.execution, timeoutMs: 3_300_000 } },
      {},
    );
    expect(result.keysReady).toBeUndefined();
    expect(result.missingKeys).toBeUndefined();
    expect(result.planRefusal).toContain("may not live longer than 60m");
  });

  it("requires no provider keys for a local scripted browser", async () => {
    expect(
      await summary(
        {
          ...base,
          route: "scripted",
          actor: { type: "scripted-browser" },
          execution: { target: "local" },
          scenario: "humanish/scenarios/entry.yaml",
        },
        {},
      ),
    ).toMatchObject({ keysReady: true });
  });
});

describe("TUI caps summary", () => {
  it("shows a computer-use lab's execution.caps", async () => {
    const capped = { ...base, caps: { maxUsd: 2, maxTotalUsd: 5 } };
    expect((await summary(capped, {})).caps).toEqual({ laneUsd: 2, studyUsd: 5 });
  });

  it("draws no cap for a computer-use lab that declares none", async () => {
    expect((await summary(base, {})).caps).toEqual({});
  });

  it("leaves out the caps of a route whose dollar caps it does not show", async () => {
    // A live terminal study must declare caps.maxUsd 0; showing it as a participant cap would
    // misstate what bounds the run.
    const terminal = {
      ...base,
      route: "terminal",
      subject: {
        source: "terminal-product",
        product: { name: "example-cli", publicSurfaces: ["https://example.test"] },
      },
      actor: { type: "codex-exec", mission: "Use the CLI." },
      caps: { maxUsd: 0, maxMinutes: 5 },
      execution: {
        target: "e2b-terminal",
        runtimeAuth: "openai-env",
        terminal: { transport: "exec-stream", stdin: "disabled" },
      },
    };
    expect((await summary(terminal, {})).caps).toBeUndefined();
  });
});

describe("lab summary participants", () => {
  const roster = (personas: (string | undefined)[]) => ({
    ...base,
    mode: "dry-run",
    participants: personas.map((persona, index) => ({
      id: `entry-0${index + 1}`,
      ...(persona === undefined ? {} : { persona }),
    })),
  });

  it("names a roster's personas and counts every roster entry", async () => {
    expect((await summary(roster(["p-one", "p-two", undefined]), {})).participants).toBe(
      "p-one · p-two",
    );
    expect((await summary(roster(["p-one", "p-one", undefined]), {})).participants).toBe(
      "3 × p-one",
    );
  });
  it("probes the vendor stores through keyDeps, not the machine's own home", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-summary-keydeps-"));
    try {
      await mkdir(path.join(cwd, "humanish/studies"), { recursive: true });
      await writeFile(path.join(cwd, "humanish/studies/key-check.yaml"), stringify(base));
      const withLogin = path.join(cwd, "home-with-e2b");
      await mkdir(path.join(withLogin, ".e2b"), { recursive: true });
      await writeFile(
        path.join(withLogin, ".e2b", "config.json"),
        JSON.stringify({ teamApiKey: "synthetic-credential-e2b-store" }),
      );
      const read = (homeDir: string) =>
        readStudySummary(cwd, "key-check", {
          checkKeys: true,
          env: { OPENAI_API_KEY: "synthetic-credential-model" },
          keyDeps: { homeDir, execText: async () => null },
        });
      expect(await read(withLogin)).toMatchObject({ keysReady: true });
      expect(await read(path.join(cwd, "empty-home"))).toMatchObject({
        keysReady: false,
        missingKeys: ["E2B_API_KEY"],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
