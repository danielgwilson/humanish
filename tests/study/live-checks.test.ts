// The live checks each route makes on this machine before a run starts (keys, a local agent,
// subject env and an unpriced cap), two failing at once, so the golden shows which refusal wins
// on each route and its exact text. The routes share the check bodies and keep their own order:
// shared world prices its cap at plan time before keys, terminal checks its runtime key before
// E2B, and scripted reads its scenario before keys.

import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { StudyConfig } from "../../src/study/types.js";
import { lab, SCENARIO_YAML, type RawLab } from "../admission/fixtures.js";
import { libraryConfig } from "../helpers/library-config.js";
import { runComputerUse, runScripted, runSharedWorld, runTerminal } from "../helpers/route-run.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const live = { mode: "live" };
const localAgent = { type: "local-agent" };
const unpriced = { ...live, caps: { maxUsd: 1 } };
const unpricedModel = { model: "unpriced-model" };
const keys = { OPENAI_API_KEY: "sk-test-openai", E2B_API_KEY: "e2b-test-key" };
const e2b = { E2B_API_KEY: "e2b-test-key" };
const catchUnreachable = {
  comms: { email: { kind: "fake", external: { catchBaseUrl: "http://127.0.0.1:9/" } } },
};

type Route = "computer-use" | "shared-world" | "scripted" | "terminal";
interface Case {
  readonly route: Route;
  readonly raw: RawLab;
  readonly env: Record<string, string>;
  /** A `codex` on `PATH` that reports a ChatGPT sign-in. */
  readonly signedInCodex?: true;
}

const cases: Record<string, Case> = {
  "computer use: keys before the local agent": {
    route: "computer-use",
    raw: lab("cuAppUrl", live, localAgent),
    env: {},
  },
  "computer use: the local agent before subject env": {
    route: "computer-use",
    raw: lab("cuClone", { ...live, subject: { env: ["DATABASE_URL"] } }, localAgent),
    env: e2b,
  },
  "computer use: subject env before an unpriced cap": {
    route: "computer-use",
    raw: lab("cuClone", { ...unpriced, subject: { env: ["DATABASE_URL"] } }, unpricedModel),
    env: keys,
  },
  "computer use: an unpriced cap before the external catch": {
    route: "computer-use",
    raw: lab("cuAppUrl", { ...unpriced, ...catchUnreachable }, unpricedModel),
    env: keys,
  },
  "computer use: a missing OpenAI key with a signed-in agent": {
    route: "computer-use",
    raw: lab("cuAppUrl", live),
    env: e2b,
    signedInCodex: true,
  },
  "shared world: an unpriced cap before keys": {
    route: "shared-world",
    raw: lab("sharedProvisioned", unpriced, unpricedModel),
    env: {},
  },
  "shared world: keys before the local agent": {
    route: "shared-world",
    raw: lab("sharedProvisioned", live, localAgent),
    env: {},
  },
  "shared world: the local agent before subject env": {
    route: "shared-world",
    raw: lab("sharedProvisioned", live, localAgent),
    env: e2b,
  },
  "shared world: keys before subject env": {
    route: "shared-world",
    raw: lab("sharedProvisioned", live),
    env: {},
  },
  "shared world: subject env": {
    route: "shared-world",
    raw: lab("sharedProvisioned", live),
    env: keys,
  },
  "shared world: a missing OpenAI key with a signed-in agent": {
    route: "shared-world",
    raw: lab("sharedProvisioned", live),
    env: { ...e2b, DATABASE_URL: "postgres://synthetic" },
    signedInCodex: true,
  },
  "shared world external plane: a missing OpenAI key with a signed-in agent": {
    route: "shared-world",
    raw: lab("sharedExternal", live),
    env: e2b,
    signedInCodex: true,
  },
  "scripted: the scenario before keys": {
    route: "scripted",
    raw: lab("scriptedClone", { ...live, scenario: "no-such-scenario" }),
    env: {},
  },
  "scripted: keys before subject env": {
    route: "scripted",
    raw: lab("scriptedClone", { ...live, subject: { env: ["GITHUB_TOKEN"] } }),
    env: {},
  },
  "scripted: subject env": {
    route: "scripted",
    raw: lab("scriptedClone", { ...live, subject: { env: ["GITHUB_TOKEN"] } }),
    env: e2b,
  },
  "terminal: the runtime key before E2B": {
    route: "terminal",
    raw: lab("terminal", live),
    env: {},
  },
  "terminal: E2B": {
    route: "terminal",
    raw: lab("terminal", live),
    env: { OPENAI_API_KEY: "sk-test-openai" },
  },
};

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-live-checks-"));
  dirs.push(dir);
  await writeFile(path.join(dir, "package.json"), '{ "name": "live-checks-fixture" }\n');
  await mkdir(path.join(dir, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(dir, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  return dir;
}

/** A directory for `PATH` and `HOME`, holding a signed-in `codex` when asked. */
async function machineDir(signedInCodex: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-live-checks-bin-"));
  dirs.push(dir);
  if (signedInCodex) {
    const bin = path.join(dir, "codex");
    await writeFile(
      bin,
      '#!/bin/sh\nif [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi\nexit 3\n',
    );
    await chmod(bin, 0o755);
  }
  return dir;
}

async function refusalOf(testCase: Case): Promise<unknown> {
  const cwd = await projectDir();
  const machine = await machineDir(testCase.signedInCodex === true);
  const env = { ...testCase.env, PATH: machine, HOME: machine };
  const config: StudyConfig = libraryConfig(testCase.raw);
  const never = async (): Promise<never> => {
    throw new Error("a live check case must not load a desktop module");
  };
  const input = { cwd, config, dryRun: false, env, deps: { desktopModule: never } };
  const result =
    testCase.route === "computer-use"
      ? await runComputerUse(input)
      : testCase.route === "shared-world"
        ? await runSharedWorld(input)
        : testCase.route === "scripted"
          ? await runScripted(input)
          : await runTerminal(input);
  let text = JSON.stringify({ ok: result.ok, error: result.error });
  for (const dir of [await realpath(cwd), cwd, await realpath(machine), machine])
    text = text.split(dir).join("[dir]");
  return JSON.parse(text);
}

describe("live checks", () => {
  it("pins which refusal wins on each route and its text", async () => {
    const results: Record<string, unknown> = {};
    for (const [name, testCase] of Object.entries(cases)) results[name] = await refusalOf(testCase);
    await expect(`${JSON.stringify(results, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/routes/live-checks.json",
    );
  }, 60_000);
});
