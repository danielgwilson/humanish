// Bare `doctor` after `init --yes` on a machine with no keys: init's next step (`run first-run`)
// needs no key, so doctor passes, and each key row names the labs that need it. `--lab` still fails
// on a key the selected lab requires.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import type { DetectLocalAgentsOptions } from "../../src/actors/local-agent/cli.js";
import { doctor, type DoctorResult } from "../../src/cli/doctor.js";
import { saveCommsConnection } from "../../src/comms/connections.js";
import { runInit } from "../../src/study/init.js";
import { STUDY_SCHEMA } from "../../src/study/types.js";

const keyless = { HUMANISH_STRICT_KEYS: "1", PATH: "" };
const noAgents: DetectLocalAgentsOptions = { which: async () => undefined };
const row = (result: DoctorResult, name: string) =>
  result.checks.find((check) => check.name === name);

describe("doctor without --lab", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-bare-"));
    await runInit({ cwd, yes: true, env: keyless });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("passes with no keys, and a missing key a lab needs is a note naming that lab", async () => {
    const result = await doctor(cwd, { env: keyless, localAgents: noAgents });
    expect(result.ok).toBe(true);
    expect(row(result, "key E2B_API_KEY")).toMatchObject({ ok: true, status: "note" });
    expect(row(result, "key E2B_API_KEY")?.message).toMatch(/^missing; used by try-live; /);
    expect(row(result, "key GH_TOKEN")).toMatchObject({ ok: true, status: "ok" });
    expect(row(result, "key GH_TOKEN")?.message).toContain("not used by any study in this project");
  });

  it("names the labs on a present key's row too", async () => {
    const env = { ...keyless, E2B_API_KEY: "synthetic-desktop-canary" };
    const result = await doctor(cwd, { env, localAgents: noAgents });
    expect(row(result, "key E2B_API_KEY")).toMatchObject({ ok: true, status: "ok" });
    expect(row(result, "key E2B_API_KEY")?.message).toMatch(/; used by try-live$/);
    expect(JSON.stringify(result)).not.toContain("synthetic-desktop-canary");
  });

  it("ends each key row with the command that fills that key", async () => {
    const result = await doctor(cwd, { env: keyless, localAgents: noAgents });
    expect(
      result.checks
        .filter((check) => check.name.startsWith("key "))
        .map((check) => `${check.name}: ${check.message}`),
    ).toEqual([
      "key OPENAI_API_KEY: missing; used by try-live; run `humanish keys set openai`",
      "key E2B_API_KEY: missing; used by try-live; run `e2b auth login`, or `humanish keys set e2b`",
      "key GH_TOKEN: missing; not used by any study in this project; run `gh auth login`, or `humanish keys set github`",
      "key CODEX_API_KEY: missing; not used by any study in this project; run `humanish keys set CODEX_API_KEY`",
    ]);
  });

  it("adds the key a study's email connection names after the same four rows", async () => {
    await saveCommsConnection(cwd);
    await writeFile(
      path.join(cwd, "humanish", "studies", "signup.yaml"),
      stringify({
        schema: STUDY_SCHEMA,
        id: "signup",
        route: "computer-use",
        mode: "live",
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
        actor: { type: "openai-computer-use", mission: "Create an account." },
        execution: { target: "e2b-desktop" },
        comms: { email: { kind: "real", connection: "agentmail" } },
      }),
    );
    const result = await doctor(cwd, { study: "signup", env: keyless, localAgents: noAgents });
    expect(
      result.checks
        .filter((check) => check.name.startsWith("key "))
        .map((check) => `${check.name}: ${check.message}`),
    ).toEqual([
      "key OPENAI_API_KEY: missing from every source; run `humanish keys set openai`",
      "key E2B_API_KEY: missing from every source; run `e2b auth login`, or `humanish keys set e2b`",
      "key GH_TOKEN: not required for the selected participant route; run `gh auth login`, or `humanish keys set github`",
      "key CODEX_API_KEY: not required for the selected participant route; run `humanish keys set CODEX_API_KEY`",
      "key AGENTMAIL_API_KEY: missing from every source; provide AGENTMAIL_API_KEY through process env or --dotenv",
    ]);
  });

  it("finds a lab whose file name differs from its id", async () => {
    const labs = path.join(cwd, "humanish", "studies");
    const tryLive = await readFile(path.join(labs, "try-live.yaml"), "utf8");
    expect(tryLive).toMatch(/^id: try-live$/m);
    await writeFile(
      path.join(labs, "checkout.yaml"),
      tryLive.replace(/^id: try-live$/m, "id: checkout-live"),
    );
    const result = await doctor(cwd, { env: keyless, localAgents: noAgents });
    expect(row(result, "key E2B_API_KEY")?.message).toMatch(
      /^missing; used by checkout-live and try-live; /,
    );
  });

  it("still fails under --lab when the selected lab needs a missing key", async () => {
    const result = await doctor(cwd, { study: "try-live", env: keyless, localAgents: noAgents });
    expect(result.ok).toBe(false);
    expect(row(result, "key E2B_API_KEY")).toMatchObject({ ok: false, status: "missing" });
  });

  it("gives each installed local agent its own row, and an unsigned one is a note", async () => {
    const result = await doctor(cwd, {
      env: keyless,
      localAgents: {
        which: async (bin) => `/synthetic/${bin}`,
        exists: async () => false,
        authProbe: async (bin) =>
          bin.endsWith("codex")
            ? { code: 0, stdout: "", stderr: "Logged in using ChatGPT" }
            : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" },
      },
    });
    const agentRows = result.checks.filter((check) => check.name.startsWith("local agent"));
    expect(agentRows.map(({ name, status }) => [name, status])).toEqual([
      ["local agent codex", "ok"],
      ["local agent claude", "note"],
    ]);
    expect(agentRows[1]?.message).toContain("run `claude auth login`");
  });
});

/** Claude Code as `claude auth status` and `claude --version` answer under `env`. */
function claudeProbe(state: {
  signedIn: "yes" | "no" | "env-only" | "unreadable";
  version: string;
}): NonNullable<DetectLocalAgentsOptions["authProbe"]> {
  return async (_bin, args, env) => {
    if (args[0] === "--version") return { code: 0, stdout: `${state.version}\n`, stderr: "" };
    if (state.signedIn === "unreadable") return { code: 2, stdout: "", stderr: "unknown command" };
    // A login held only in ANTHROPIC_API_KEY is gone from the participant's environment.
    const loggedIn =
      state.signedIn === "yes" || (state.signedIn === "env-only" && !!env.ANTHROPIC_API_KEY);
    return { code: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn }), stderr: "" };
  };
}

describe("doctor's Claude Code row", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-claude-"));
    await runInit({ cwd, yes: true, env: keyless });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const claudeOnly = (state: Parameters<typeof claudeProbe>[0]): DetectLocalAgentsOptions => ({
    which: async (bin) => (bin === "claude" ? `/synthetic/${bin}` : undefined),
    exists: async () => false,
    authProbe: claudeProbe(state),
  });
  const env = { ...keyless, ANTHROPIC_API_KEY: "synthetic-anthropic-canary" };

  it.each([
    ["signed in at the floor", "ok", { signedIn: "yes", version: "2.1.248 (Claude Code)" }],
    ["signed in above the floor", "ok", { signedIn: "yes", version: "2.1.289 (Claude Code)" }],
    ["signed in below the floor", "note", { signedIn: "yes", version: "2.1.247 (Claude Code)" }],
    ["signed in with no readable version", "note", { signedIn: "yes", version: "unreadable" }],
    [
      "signed in only through ANTHROPIC_API_KEY",
      "note",
      { signedIn: "env-only", version: "2.1.289" },
    ],
    ["signed out", "note", { signedIn: "no", version: "2.1.289 (Claude Code)" }],
    ["of unknown sign-in", "note", { signedIn: "unreadable", version: "2.1.289" }],
  ] as const)("marks a Claude Code %s as %s", async (_name, status, state) => {
    const result = await doctor(cwd, { env, localAgents: claudeOnly(state) });
    const claude = row(result, "local agent claude");
    expect(claude).toMatchObject({ ok: true, status });
    if (status === "ok")
      expect(claude?.message).toContain("can use it instead of a provider API key");
    else expect(claude?.message).not.toContain("can use it");
    // The row is a capability: without --study it never fails doctor.
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-anthropic-canary");
  });

  it("says why a signed-in Claude Code below the floor cannot run participants", async () => {
    const state = { signedIn: "yes", version: "2.1.247 (Claude Code)" } as const;
    const result = await doctor(cwd, { env, localAgents: claudeOnly(state) });
    expect(row(result, "local agent claude")?.message).toMatch(
      /cannot run participants yet\. .*2\.1\.248.*2\.1\.247/,
    );
  });

  it("fails --study on a study whose participant is that Claude Code", async () => {
    const studies = path.join(cwd, "humanish", "studies");
    const tryLive = await readFile(path.join(studies, "try-live.yaml"), "utf8");
    // maxOutputTokens is an OpenAI computer-use field; a local-agent study refuses it.
    await writeFile(
      path.join(studies, "try-live.yaml"),
      tryLive
        .replace(/^ {2}type: openai-computer-use$/m, "  type: local-agent\n  localAgent: claude")
        .replace(/^ {2}maxOutputTokens: \d+\n/m, ""),
    );
    const study = async (state: Parameters<typeof claudeProbe>[0]) =>
      row(
        await doctor(cwd, { study: "try-live", env, localAgents: claudeOnly(state) }),
        "local participant authentication",
      );
    expect(await study({ signedIn: "yes", version: "2.1.289" })).toMatchObject({
      ok: true,
      status: "ok",
    });
    for (const state of [
      { signedIn: "yes", version: "2.1.247" },
      { signedIn: "env-only", version: "2.1.289" },
    ] as const)
      expect(await study(state), state.signedIn).toMatchObject({ ok: false, status: "missing" });
  });
});
