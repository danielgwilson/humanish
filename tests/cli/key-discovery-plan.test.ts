import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

// The command stops after key discovery: the computer-use route's CLI setup is replaced by one that
// returns no run, so no browser, agent, desktop, scorer or provider starts.
vi.mock("../../src/cli/commands/study-route-computer-use.js", () => ({
  computerUseRouteRun: () => undefined,
}));

import { createProgram } from "../../src/cli/program.js";
import {
  discoverProviderKeys,
  type KeyResolutionDeps,
  type ResolvedKeyFill,
} from "../../src/keys/key-resolution.js";
import { runInit } from "../../src/study/init.js";
import { lab } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { studyFileText } from "../helpers/study-file.js";

// A live `lab run` fills every provider key it finds, exactly as discovery without a filter does,
// and prints a `humanish keys:` line only for the keys its plan reads.
const PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "E2B_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CODEX_API_KEY",
  "AGENTMAIL_API_KEY",
];
const STORE = "~/.config/humanish/keys.env";
const E2B_LOGIN = "~/.e2b/config.json (e2b auth login)";

beforeEach(() => {
  for (const name of [...PROVIDER_KEYS, "HUMANISH_STRICT_KEYS", "XDG_CONFIG_HOME"])
    vi.stubEnv(name, undefined);
});

/** A home whose key store and e2b login hold keys, and a `gh auth token` that records its calls. */
async function machine(store: readonly string[]): Promise<{
  deps: KeyResolutionDeps;
  commands: string[];
}> {
  const home = await makeTestTempDir("humanish-key-plan-home-");
  await mkdir(path.join(home, ".config", "humanish"), { recursive: true });
  await writeFile(path.join(home, ".config", "humanish", "keys.env"), `${store.join("\n")}\n`, {
    mode: 0o600,
  });
  await mkdir(path.join(home, ".e2b"));
  await writeFile(path.join(home, ".e2b", "config.json"), '{ "teamApiKey": "test-e2b-key" }\n');
  const commands: string[] = [];
  const execText: KeyResolutionDeps["execText"] = async (command, commandArgs) => {
    commands.push([command, ...commandArgs].join(" "));
    return "test-gh-token-from-gh";
  };
  return { deps: { homeDir: home, execText }, commands };
}

const EVERY_KEY_STORE = [
  "OPENAI_API_KEY=test-openai-key",
  "ANTHROPIC_API_KEY=test-anthropic-key",
  "CODEX_API_KEY=test-codex-key",
  "AGENTMAIL_API_KEY=test-agentmail-key",
];

interface LiveRun {
  keyLines: string[];
  fills: ResolvedKeyFill[];
  /** What discovery without a filter, the code path on main, fills from the same sources. */
  unfiltered: ResolvedKeyFill[];
  commands: string[];
}

/** Runs `lab run <id>` live with `store` in the user key store. */
async function liveRun(cwd: string, id: string, store = EVERY_KEY_STORE): Promise<LiveRun> {
  const { deps, commands } = await machine(store);
  const stderr: string[] = [];
  let fills: ResolvedKeyFill[] = [];
  const program = createProgram({
    writeOut: () => {},
    writeErr: (text) => stderr.push(text),
    setExitCode: () => {},
    keyDiscovery: async (args) => {
      fills = await discoverProviderKeys({ ...args, deps });
      return fills;
    },
  });
  program.exitOverride();
  await program.parseAsync(["node", "humanish", "run", id, "--cwd", cwd, "--no-open"], {
    from: "node",
  });
  const keyLines = stderr
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("humanish keys:"));
  const runCommands = [...commands];
  const unfiltered = await discoverProviderKeys({ cwd, env: {}, announce: () => {}, deps });
  return { keyLines, fills, unfiltered, commands: runCommands };
}

async function initLocalBrowser(): Promise<string> {
  const cwd = await makeTestTempDir("humanish-key-plan-");
  await writeFile(path.join(cwd, "package.json"), '{ "name": "key-plan-fixture" }\n');
  const result = await runInit({
    cwd,
    yes: true,
    env: { HOME: cwd },
    localBrowser: { appUrl: "http://127.0.0.1:4173/", mission: "Save a synthetic note." },
  });
  expect(result.ok).toBe(true);
  return cwd;
}

async function patchLocalBrowser(cwd: string, patch: Record<string, unknown>): Promise<void> {
  const labPath = path.join(cwd, "humanish", "studies", "local-browser.yaml");
  const starter = parse(await readFile(labPath, "utf8")) as Record<string, unknown>;
  await writeFile(labPath, stringify({ ...starter, ...patch }));
}

/** A project with one lab, `hosted`. */
async function project(raw: object): Promise<string> {
  const cwd = await makeTestTempDir("humanish-key-plan-hosted-");
  await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
  await writeFile(
    path.join(cwd, "humanish", "studies", "hosted.yaml"),
    studyFileText({ ...raw, id: "hosted" }, cwd),
  );
  return cwd;
}

async function writeOverlay(cwd: string, line: string): Promise<void> {
  await mkdir(path.join(cwd, ".humanish", "local"), { recursive: true });
  await writeFile(path.join(cwd, ".humanish", "local", "provider.env"), `${line}\n`);
}

const live = { scenario: { mode: "live" }, execution: { caps: { maxUsd: 1 } } };

describe("a live lab run prints key lines for the keys its plan reads", () => {
  it("init's local-browser starter prints no key line", async () => {
    const run = await liveRun(await initLocalBrowser(), "local-browser");

    expect(run.keyLines).toEqual([]);
    expect(run.fills).toEqual(run.unfiltered);
    expect(run.fills.map((fill) => fill.name)).toContain("GH_TOKEN");
  });

  it("prints OPENAI_API_KEY for a local-browser lab whose automatic analysis runs on OpenAI", async () => {
    const cwd = await initLocalBrowser();
    await patchLocalBrowser(cwd, { review: { analysis: { maxCostUsd: 1 } } });

    const run = await liveRun(cwd, "local-browser");

    expect(run.keyLines).toEqual([`humanish keys: OPENAI_API_KEY from ${STORE}`]);
    expect(run.fills).toEqual(run.unfiltered);
  });

  it("prints the model and desktop keys for a hosted computer-use lab", async () => {
    const run = await liveRun(await project(lab("cuAppUrl", live)), "hosted");

    expect(run.keyLines.toSorted()).toEqual([
      `humanish keys: E2B_API_KEY from ${E2B_LOGIN}`,
      `humanish keys: OPENAI_API_KEY from ${STORE}`,
    ]);
    expect(run.fills).toEqual(run.unfiltered);
  });

  it("prints every fill, as before, for a live lab its plan refuses", async () => {
    // The lab parses, but its session budget derives a sandbox deadline past the provider's
    // maximum, so the computer-use plan refuses it.
    const cwd = await project(
      lab("cuAppUrl", { ...live, execution: { caps: { maxUsd: 1 }, timeoutMs: 360_000_000 } }),
    );

    const run = await liveRun(cwd, "hosted");

    expect(run.keyLines).toHaveLength(run.unfiltered.length);
    expect(run.keyLines).toContain("humanish keys: GH_TOKEN from gh auth token");
  });
});

// Each lab below passes the parser and the planner and reads a key its plan's requirements do not
// list. Discovery fills each key as it does without a filter.
describe("a live lab run fills every key discovery finds", () => {
  it("a Claude Code participant gets ANTHROPIC_API_KEY, and its line prints", async () => {
    const cwd = await project(
      lab(
        "cuAppUrl",
        { scenario: { mode: "live" }, review: { analysis: false } },
        { type: "local-agent", localAgent: "claude", mission: "Sign up." },
      ),
    );

    const run = await liveRun(cwd, "hosted");

    expect(run.fills).toEqual(run.unfiltered);
    expect(run.keyLines.toSorted()).toEqual([
      `humanish keys: ANTHROPIC_API_KEY from ${STORE}`,
      `humanish keys: E2B_API_KEY from ${E2B_LOGIN}`,
    ]);
    expect(process.env.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
  });

  it("a declared scorer may read any key, so every fill prints", async () => {
    const cwd = await initLocalBrowser();
    await mkdir(path.join(cwd, "humanish", "scorers"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "scorers", "judge.mjs"),
      "export const score = () => {};\n",
    );
    await patchLocalBrowser(cwd, { review: { scorer: { ref: "humanish/scorers/judge.mjs" } } });

    const run = await liveRun(cwd, "local-browser");

    expect(run.fills).toEqual(run.unfiltered);
    expect(run.keyLines).toHaveLength(run.unfiltered.length);
    expect(process.env.OPENAI_API_KEY).toBe("test-openai-key");
  });

  it("the external catch token a lab names is filled from the project overlay, and its line prints", async () => {
    const cwd = await project(
      lab("cuAppUrl", {
        ...live,
        review: { analysis: false },
        comms: {
          email: {
            external: { catchBaseUrl: "http://127.0.0.1:4025", authTokenEnv: "AGENTMAIL_API_KEY" },
          },
        },
      }),
    );
    await writeOverlay(cwd, "AGENTMAIL_API_KEY=test-catch-token-from-overlay");

    const run = await liveRun(cwd, "hosted", ["OPENAI_API_KEY=test-openai-key"]);

    expect(run.fills).toEqual(run.unfiltered);
    expect(run.keyLines.toSorted()).toEqual([
      `humanish keys: AGENTMAIL_API_KEY from ${path.join(".humanish", "local", "provider.env")}`,
      `humanish keys: E2B_API_KEY from ${E2B_LOGIN}`,
      `humanish keys: OPENAI_API_KEY from ${STORE}`,
    ]);
    expect(process.env.AGENTMAIL_API_KEY).toBe("test-catch-token-from-overlay");
  });

  it("an overlay GITHUB_TOKEN still keeps gh auth token from filling GH_TOKEN", async () => {
    const cwd = await project(lab("cuClone", { ...live, subject: { env: ["GH_TOKEN"] } }));
    await writeOverlay(cwd, "GITHUB_TOKEN=test-github-token-from-overlay");

    const run = await liveRun(cwd, "hosted", [
      "OPENAI_API_KEY=test-openai-key",
      "GH_TOKEN=test-gh-token-from-store",
    ]);

    expect(run.fills).toEqual(run.unfiltered);
    expect(run.commands).toEqual([]);
    expect(process.env.GH_TOKEN).toBe("test-gh-token-from-store");
    expect(run.keyLines.toSorted()).toEqual([
      `humanish keys: E2B_API_KEY from ${E2B_LOGIN}`,
      `humanish keys: GH_TOKEN from ${STORE}`,
      `humanish keys: OPENAI_API_KEY from ${STORE}`,
    ]);
  });
});
