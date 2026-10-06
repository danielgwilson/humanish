// Each route scrubs the literal values it knows (provider keys, subject env values and the other
// values its source list names) from the evidence it writes. These tests pin, per route, which
// values are scrubbed, the marker that replaces them and the shortest value scrubbed, through one
// evidence file each. Every value is built at run time.

import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorCapabilities } from "../../src/actors/contract.js";
import type {
  CuaExecutor,
  CuaObservation,
  CuaProvider,
  CuaTurn,
} from "../../src/actors/computer-use/loop.js";
import type {
  ScriptedBrowserLike,
  ScriptedLocatorLike,
  ScriptedPageLike,
} from "../../src/actors/scripted-browser/types.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { parseStudy } from "../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import type { E2BDesktopModule, E2BDesktopSandbox } from "../../src/substrates/e2b/sdk.js";
import { syntheticPng1x1 } from "../image-fixtures.js";
import { evaluatePagePredicate } from "../helpers/scripted-page-predicate.js";
import { passingRun, streamingRun, terminalConfig } from "../helpers/terminal-live-fake.js";
import { runComputerUse, runScripted, runSharedWorld, runTerminal } from "../helpers/route-run.js";

/** A value with no secret shape, so only the literal scrub can remove it. */
const opaque = (label: string): string =>
  ["synthetic", label, "value", "do", "not", "leak"].join("-");
/** A value with spaces, which a URL carries percent-encoded. */
const spaced = (label: string): string => ["synthetic", label, "value do not leak"].join(" ");
/** A value under the default four-character floor. */
const SHORT = ["q", "7", "z"].join("");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-known-secrets-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function parsed(raw: Record<string, unknown>): StudyConfig {
  const result = parseStudy(raw);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

async function runBundle(runId: string): Promise<{ text: string; bundle: RunBundle }> {
  const text = await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8");
  return { text, bundle: JSON.parse(text) as RunBundle };
}

const cloneSubject = (env: string[]) => ({
  source: "clone",
  repos: ["example-org/example-app"],
  env,
  serve: { install: "pnpm install", start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
});
/** A clone served at a public sandbox URL, which holds only seeded synthetic data. */
const syntheticCloneSubject = (env: string[]) => ({
  ...cloneSubject(env),
  exposure: "synthetic",
  state: { seed: [{ name: "migrate", command: "pnpm db:migrate" }] },
});

describe("computer use scrubs its known values with [REDACTED_SECRET]", () => {
  it("scrubs both provider keys and the subject env on a dry run, and leaves a value under four characters", async () => {
    const openai = opaque("openai");
    const e2b = opaque("e2b");
    const password = opaque("password");
    const config = parsed({
      schema: STUDY_SCHEMA,
      id: "known-secrets-computer-use",
      title: "Known secrets on computer use",
      route: "computer-use",
      mode: "dry-run",
      subject: cloneSubject(["APP_PASSWORD", "APP_PIN"]),
      actor: {
        type: "openai-computer-use",
        mission: `Sign in with ${openai} ${e2b} ${password} ${SHORT}.`,
      },
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    });
    const result = await runComputerUse({
      cwd,
      config,
      dryRun: true,
      env: { OPENAI_API_KEY: openai, E2B_API_KEY: e2b, APP_PASSWORD: password, APP_PIN: SHORT },
    });
    expect(result.error).toBeUndefined();
    const { text, bundle } = await runBundle(result.runId);
    for (const value of [openai, e2b, password]) expect(text).not.toContain(value);
    expect(bundle.streams[0]?.assignment?.mission).toBe(
      `Sign in with [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] ${SHORT}.`,
    );
  });
});

describe("shared world scrubs its known values with [REDACTED_SECRET]", () => {
  it("scrubs both provider keys, the subject env and a checkpoint's redact values on a dry run", async () => {
    const openai = opaque("openai");
    const e2b = opaque("e2b");
    const password = opaque("password");
    const checkpointValue = opaque("checkpoint");
    const config = parsed({
      schema: STUDY_SCHEMA,
      id: "known-secrets-shared-world",
      title: "Known secrets on shared world",
      route: "shared-world",
      mode: "dry-run",
      subject: {
        ...cloneSubject(["APP_PASSWORD", "APP_PIN"]),
        exposure: "synthetic",
        state: {
          seed: [{ name: "migrate", command: "pnpm db:migrate" }],
          checkpoint: [{ name: "count", command: "pnpm count", redact: [checkpointValue] }],
        },
      },
      actor: {
        type: "openai-computer-use",
        mission: `Share with ${openai} ${e2b} ${password} ${checkpointValue} ${SHORT}.`,
      },
      participants: [
        { id: "participant-a", persona: "first-time-visitor", entry: "/a" },
        { id: "participant-b", persona: "returning-user", entry: "/b" },
      ],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
    });
    const result = await runSharedWorld({
      cwd,
      config,
      dryRun: true,
      env: { OPENAI_API_KEY: openai, E2B_API_KEY: e2b, APP_PASSWORD: password, APP_PIN: SHORT },
    });
    expect(result.error).toBeUndefined();
    const { text, bundle } = await runBundle(result.runId);
    for (const value of [openai, e2b, password, checkpointValue]) expect(text).not.toContain(value);
    expect(bundle.streams.map((stream) => stream.assignment?.mission)).toEqual([
      `Share with [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] ${SHORT}.`,
      `Share with [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] ${SHORT}.`,
    ]);
  });
});

describe("terminal scrubs its known values with [REDACTED_SECRET]", () => {
  it("scrubs all three keys on a dry run, and leaves a key under four characters", async () => {
    const codex = opaque("codex");
    const openai = opaque("openai");
    const config = terminalConfig({
      mode: "dry-run",
      actor: {
        type: "codex-exec",
        persona: "autonomous-creative-agent",
        mission: `Discover with ${codex} ${openai} ${SHORT}.`,
      },
    });
    const result = await runTerminal({
      cwd,
      config,
      dryRun: true,
      env: { CODEX_API_KEY: codex, OPENAI_API_KEY: openai, E2B_API_KEY: SHORT },
    });
    expect(result.ok).toBe(true);
    const { bundle } = await runBundle(result.runId);
    expect(bundle.streams[0]?.assignment).toEqual({
      mission: `Discover with [REDACTED_SECRET] [REDACTED_SECRET] ${SHORT}.`,
    });
  });

  it("scrubs the runtime key and the E2B key from a live run's mission and terminal output", async () => {
    const runtimeKey = opaque("runtime");
    const e2b = opaque("e2b");
    const config = terminalConfig({
      actor: {
        type: "codex-exec",
        persona: "autonomous-creative-agent",
        mission: `Discover with ${runtimeKey} ${e2b}.`,
      },
    });
    const run = passingRun({ env: { OPENAI_API_KEY: runtimeKey, E2B_API_KEY: e2b } });
    const result = await runTerminal({ cwd, config, dryRun: false, ...run });
    expect(result.ok).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const { bundle } = await runBundle(result.runId);
    expect(bundle.streams[0]?.assignment).toEqual({
      mission: "Discover with [REDACTED_SECRET] [REDACTED_SECRET].",
    });
    for (const file of ["run.json", "terminal-ledgers.json", "terminal-events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(runtimeKey);
      expect(text, file).not.toContain(e2b);
    }
  });
});

describe("scripted scrubs its known values with [REDACTED_SECRET]", () => {
  it("scrubs the E2B key, the clone repo and the subject env from a live run's session error, and leaves a value under four characters", async () => {
    const e2b = opaque("e2b");
    const password = opaque("password");
    const repo = "example-org/example-app";
    const config = parsed({
      schema: STUDY_SCHEMA,
      id: "known-secrets-scripted",
      title: "Known secrets on scripted",
      route: "scripted",
      mode: "live",
      subject: syntheticCloneSubject(["APP_PASSWORD", "APP_PIN"]),
      actor: { type: "scripted-browser", persona: "synthetic-new-user" },
      surfaces: ["desktop"],
      scenario: "scripted-first-run",
      execution: { target: "e2b-desktop", timeoutMs: 30_000 },
    });
    await writeScenario(cwd);
    const result = await runScripted({
      cwd,
      config,
      dryRun: false,
      env: { E2B_API_KEY: e2b, APP_PASSWORD: password, APP_PIN: SHORT },
      deps: {
        desktopModule: async () => subjectModule(),
        browserCommand: "/synthetic/browser",
        detachedTimers: { now: () => 0, sleep: async () => undefined },
        runScriptedSession: async () => {
          throw new Error(`session failed on ${repo} with ${password}, ${e2b} and ${SHORT}`);
        },
      },
    });
    expect(result.ok).toBe(false);
    const { text } = await runBundle(result.runId);
    for (const value of [password, e2b]) expect(text).not.toContain(value);
    expect(text).toContain(
      `session failed on [REDACTED_SECRET] with [REDACTED_SECRET], [REDACTED_SECRET] and ${SHORT}`,
    );
  });
});

describe("scripted scrubs its known values from the step trace", () => {
  it("leaves no copy of the E2B key in any run file when the app URL, a step URL, label, goal and failed step hold it", async () => {
    const e2b = opaque("e2b");
    await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "scenarios", "known-values.yaml"),
      [
        "schema: humanish.scenario.v1",
        "id: known-values",
        `title: Settings for ${e2b}`,
        `goal: Open the settings page for ${e2b}.`,
        "browser:",
        "  startPath: /",
        "  steps:",
        "    - id: step-01-load",
        `      label: Open settings for ${e2b}`,
        "      action: goto",
        `      path: /settings/${e2b}`,
        "    - id: step-02-confirm",
        "      label: Confirm the greeting",
        "      action: waitForText",
        "      expect:",
        `        text: Welcome ${e2b}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await withLoopbackApp((appUrl) =>
      runScripted({
        cwd,
        config: parsed({
          schema: STUDY_SCHEMA,
          id: "known-secrets-scripted-trace",
          title: "Known secrets in a scripted step trace",
          route: "scripted",
          mode: "live",
          subject: { source: "app-url", appUrl: `${appUrl}app/${e2b}/` },
          actor: { type: "scripted-browser", persona: "synthetic-new-user" },
          scenario: "known-values",
          execution: { target: "local", timeoutMs: 30_000 },
          review: { analysis: false },
        }),
        dryRun: false,
        env: { E2B_API_KEY: e2b },
        deps: { launchBrowser: async () => urlRecordingBrowser() },
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.sessions.map((session) => session.completionReason)).toEqual(["step_failed"]);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    expect(await runFiles(runDir)).toContain("traces/desktop.json");
    expect(await filesHolding(runDir, [e2b])).toEqual([]);
    const trace = JSON.parse(await readFile(path.join(runDir, "traces", "desktop.json"), "utf8"));
    expect(trace.steps[0].url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/settings\/\[REDACTED_SECRET\]$/,
    );
    expect(trace.steps[0].label).toBe("Open settings for [REDACTED_SECRET]");
    expect(trace.steps[1].reason).toContain("Welcome [REDACTED_SECRET]");
  });
});

describe("computer use and terminal scrub their known values from every run file", () => {
  it("computer use: a participant that narrates both keys, one percent-encoded, leaves no copy in any run file", async () => {
    const openai = opaque("openai");
    const e2b = spaced("e2b");
    const values = [openai, e2b, encodeURIComponent(e2b)];
    const capabilities: ActorCapabilities = {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: false,
      byoModel: true,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "open",
    };
    let turn = 0;
    const provider: CuaProvider = {
      id: "narrating-brain",
      version: "0.1.0",
      requiresFrame: false,
      capabilities,
      async nextTurn(): Promise<CuaTurn> {
        turn += 1;
        const quoted = `${openai} at http://127.0.0.1:5173/k/${encodeURIComponent(e2b)}`;
        return turn >= 2
          ? {
              actions: [],
              pendingSafetyChecks: [],
              done: true,
              message: `Done. The page showed ${quoted}, which was confusing.`,
            }
          : {
              actions: [{ kind: "type", text: `${openai} ${e2b}` }],
              pendingSafetyChecks: [],
              done: false,
              reasoning: `The page shows ${quoted}.`,
              message: `Typing ${quoted}.`,
            };
      },
    };
    const executor: CuaExecutor = {
      async observe(): Promise<CuaObservation> {
        return {
          stateSignature: `sig-${turn}`,
          url: `http://127.0.0.1:5173/k/${encodeURIComponent(e2b)}`,
          text: `token ${openai}`,
          appState: { turn },
        };
      },
      async execute(): Promise<void> {},
    };
    const result = await runComputerUse({
      cwd,
      config: parsed({
        schema: STUDY_SCHEMA,
        id: "known-secrets-computer-use-files",
        title: "Known secrets in computer-use run files",
        route: "computer-use",
        mode: "live",
        subject: { source: "local-app", appUrl: "http://localhost:5173/" },
        actor: { type: "openai-computer-use", persona: "pixel-pat", mission: "Find the token." },
        review: { analysis: false },
      }),
      dryRun: false,
      env: { OPENAI_API_KEY: openai, E2B_API_KEY: e2b },
      inProcess: { executor: async () => executor },
      createProvider: async () => provider,
    });
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(await filesHolding(path.join(cwd, ".humanish", "runs", result.runId), values)).toEqual(
      [],
    );
  });

  it("terminal: output that prints both keys, encoded and split across chunks, leaves no copy in any run file", async () => {
    const runtimeKey = opaque("runtime");
    const e2b = `${spaced("e2b")}/"quoted"`;
    const encoded = encodeURIComponent(e2b);
    const pathEncoded = encodeURI(e2b);
    const escaped = JSON.stringify(e2b).slice(1, -1);
    const nested = JSON.stringify({ item: { aggregated_output: JSON.stringify({ key: e2b }) } });
    const escapedTwice = JSON.stringify(escaped).slice(1, -1);
    const values = [runtimeKey, e2b, encoded, pathEncoded, escaped, escapedTwice];
    const config = terminalConfig({
      actor: {
        type: "codex-exec",
        persona: "autonomous-creative-agent",
        mission: "Discover the CLI.",
      },
    });
    const run = {
      ...streamingRun((nonce) => [
        `key ${runtimeKey}\n`,
        `see https://example.test/k/${encoded}\n`,
        `raw ${e2b}\n`,
        `json ${JSON.stringify({ key: e2b })}\n`,
        `split https://example.test/k/${encoded.slice(0, 12)}`,
        `${encoded.slice(12)} and ${escaped.slice(0, 12)}`,
        `${escaped.slice(12)} and https://example.test/${pathEncoded.slice(0, 12)}`,
        `${pathEncoded.slice(12)}\n`,
        `${nested}\n`,
        `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonce}\n`,
      ]),
      env: { OPENAI_API_KEY: runtimeKey, E2B_API_KEY: e2b },
    };
    const result = await runTerminal({ cwd, config, dryRun: false, ...run });
    expect(result.ok).toBe(true);
    expect(await filesHolding(path.join(cwd, ".humanish", "runs", result.runId), values)).toEqual(
      [],
    );
  });
});

/** Each file under `root` that holds one of `values`, with the value it holds. */
async function filesHolding(root: string, values: readonly string[]): Promise<string[]> {
  const holding: string[] = [];
  for (const file of await runFiles(root)) {
    const bytes = await readFile(path.join(root, file));
    for (const value of values) if (bytes.includes(value)) holding.push(`${file}: ${value}`);
  }
  return holding;
}

/** Every file under `root`, as a path relative to it. */
async function runFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

/** Serves a page on a loopback port for the session's reachability probe. */
async function withLoopbackApp<T>(run: (appUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<main>landing page</main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A browser whose page reports the URL each goto asked for, and whose body never changes. */
function urlRecordingBrowser(): ScriptedBrowserLike {
  const png = syntheticPng1x1();
  const state = { url: "about:blank", body: "landing page" };
  const locator: ScriptedLocatorLike = {
    first: () => locator,
    fill: async () => undefined,
    click: async () => undefined,
    press: async () => undefined,
    count: async () => 1,
    waitFor: async () => undefined,
    isVisible: async () => true,
  };
  const page: ScriptedPageLike = {
    goto: async (url) => {
      state.url = url;
      return undefined;
    },
    locator: () => locator,
    keyboard: { press: async () => undefined },
    waitForTimeout: async () => undefined,
    waitForFunction: async (expression) => {
      if (evaluatePagePredicate(expression, state.body)) return undefined;
      throw new Error(`Timeout waiting for ${expression}`);
    },
    screenshot: async ({ path: screenshotPath }) => {
      if (screenshotPath) await writeFile(screenshotPath, png);
      return png;
    },
    url: () => state.url,
    evaluate: async <T>() => state.body as unknown as T,
  };
  return { newContext: async () => ({ newPage: async () => page }), close: async () => undefined };
}

/** The committed demo scenario, copied so the run binds to the real file. */
async function writeScenario(root: string): Promise<void> {
  const source = path.join(process.cwd(), "humanish", "scenarios", "scripted-first-run.yaml");
  await mkdir(path.join(root, "humanish", "scenarios"), { recursive: true });
  await writeFile(
    path.join(root, "humanish", "scenarios", "scripted-first-run.yaml"),
    await readFile(source, "utf8"),
    "utf8",
  );
}

/** A subject sandbox that clones, installs and serves without doing anything. */
function subjectModule(): E2BDesktopModule {
  const sandbox = {
    sandboxId: "fake-subject-001",
    commands: {
      run: async (command: string) => {
        if (command.includes("/status")) return { exitCode: 0, stdout: "0\n" };
        if (command.includes("rev-parse")) return { exitCode: 0, stdout: "12".repeat(20) + "\n" };
        if (command.includes("curl")) return { exitCode: 0, stdout: "READY\n" };
        return { exitCode: 0, stdout: "" };
      },
    },
    files: { write: async () => undefined },
    launch: async () => undefined,
    open: async () => undefined,
    getHost: (port: number) => `${port}-fake-subject-001.e2b.app`,
    screenshot: async () => new Uint8Array([1, 2, 3, 4]),
    wait: async () => undefined,
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async () => undefined,
    },
  } as unknown as E2BDesktopSandbox;
  return {
    Sandbox: {
      create: async () => sandbox,
      kill: async () => true,
      list: () => ({ hasNext: false, nextItems: async () => [] }),
    },
  } as unknown as E2BDesktopModule;
}
