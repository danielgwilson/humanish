// A participant reads its instructions as written, so a key the study wrote base64- or
// percent-encoded reaches it, and a participant that repeats the key writes it into its own text.
// verify decodes both encodings and grades a run that holds either one blocked. On each route, the
// participant here repeats both encoded keys it was given in the text that route records, and the
// test reads every file of the run for any form of the key. Every key is built at run time.

import { createServer } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";

import type { ActorCapabilities } from "../../src/actors/contract.js";
import { runCuaActorSession } from "../../src/actors/computer-use/actor.js";
import type {
  CuaExecutor,
  CuaObservation,
  CuaProvider,
  CuaTurn,
  CuaTurnRequest,
} from "../../src/actors/computer-use/loop.js";
import {
  startClaudeSession,
  type ClaudeStreamTransport,
} from "../../src/actors/local-agent/claude-session.js";
import type {
  ScriptedBrowserLike,
  ScriptedLocatorLike,
  ScriptedPageLike,
} from "../../src/actors/scripted-browser/types.js";
import type { ParticipantDesktop } from "../../src/routes/computer-use/participant-desktop.js";
import { parseStudy } from "../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { ownDesktopAllocation } from "../../src/substrates/desktop-session.js";
import { verifyRun } from "../../src/verify/verify.js";
import { syntheticPng1x1 } from "../image-fixtures.js";
import { runComputerUse, runScripted, runSharedWorld } from "../helpers/route-run.js";
import { baseSeams, concurrentStudy, makeRendezvous } from "../helpers/shared-world-fakes.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

// The Claude Code session runs over a fake stream, and the CLI's sign-in check passes; the provider
// that reads Claude Code's replies is the real one.
vi.mock("../../src/actors/local-agent/claude-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/actors/local-agent/claude-session.js")>()),
  startClaudeSession: vi.fn(),
}));
vi.mock("../../src/actors/local-agent/readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/actors/local-agent/readiness.js")>()),
  localAgentRefusal: vi.fn(async () => undefined),
}));

const KEY = ["sk", "proj", "repeated-participant-api-key-value"].join("-");
const BASE64_KEY = Buffer.from(KEY).toString("base64");
// encodeURIComponent keeps `-`, so each one is escaped here. verify reads `%2D` as `-`.
const PERCENT_KEY = KEY.replaceAll("-", "%2D");
/** Each form of the key a run file must not hold. */
const FORMS = [KEY, BASE64_KEY, PERCENT_KEY];
const MISSION = `Sign in with ${BASE64_KEY} or with ${PERCENT_KEY}.`;

/** What a participant that repeats both encoded keys says. */
const repeated = (what: string): string => `${what}: ${BASE64_KEY} and ${PERCENT_KEY}`;

function parsed(raw: Record<string, unknown>): StudyConfig {
  const result = parseStudy(raw);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

/** Every file under `root`, as a path relative to it. */
async function runFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

/** `<file>: <form>` for each run file that holds a form of the key. */
async function filesHoldingKey(root: string): Promise<string[]> {
  const holding: string[] = [];
  for (const file of await runFiles(root)) {
    const text = await readFile(path.join(root, file), "latin1");
    for (const form of FORMS) if (text.includes(form)) holding.push(`${file}: ${form}`);
  }
  return holding;
}

/** The verify grade, and each failed public-safety check with the files it names. */
async function verdict(cwd: string, runId: string) {
  const verified = await verifyRun(cwd, runId);
  return {
    grade: verified.shareSafety.status,
    findings: verified.checks
      .filter((check) => !check.ok && check.name.includes("public-safety"))
      .map((check) => check.message),
  };
}

const CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: false,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open",
};

/**
 * A participant that takes one step, then ends, repeating the encoded keys from its instructions
 * in its reasoning, messages, closing reason and closing report. `heard` holds each instructions
 * text it received.
 */
function repeatingProvider(): { provider: CuaProvider; heard: string[] } {
  const heard: string[] = [];
  let turn = 0;
  const closing = (): CuaTurn => ({
    actions: [],
    pendingSafetyChecks: [],
    done: true,
    message: repeated("REACHED THE GOAL. Reference"),
    closingReport: {
      outcome: "reached",
      summary: repeated("I signed in with"),
      frictionReports: [repeated("The page asked twice for")],
      impressions: [{ kind: "unclear", text: repeated("I did not know which to use of") }],
    },
  });
  const provider: CuaProvider = {
    id: "repeating-brain",
    version: "0.1.0",
    requiresFrame: false,
    capabilities: CAPABILITIES,
    async nextTurn(request: CuaTurnRequest): Promise<CuaTurn> {
      heard.push(request.instructions);
      turn += 1;
      if (turn >= 2) return closing();
      return {
        actions: [{ kind: "type", text: BASE64_KEY }],
        pendingSafetyChecks: [],
        done: false,
        reasoning: repeated("The mission names"),
        message: repeated("Typing the first of"),
      };
    },
    debrief: async () => closing(),
  };
  return { provider, heard };
}

/** A sign-in page that changes on every look, so no backstop ends the session. */
function signInPage(): CuaExecutor {
  let looks = 0;
  return {
    async observe(): Promise<CuaObservation> {
      looks += 1;
      return { stateSignature: `sig-${looks}`, url: "http://127.0.0.1:5173/", text: "Sign in" };
    },
    async execute(): Promise<void> {},
  };
}

/** A computer-use run of the repeating participant, with `e2bKey` as one of the run's known values. */
async function repeatingComputerUseRun(e2bKey = "synthetic-e2b-value") {
  const cwd = await makeTestTempDir("humanish-repeated-keys-");
  const { provider, heard } = repeatingProvider();
  const executor = signInPage();
  const result = await runComputerUse({
    cwd,
    config: parsed({
      schema: STUDY_SCHEMA,
      id: "repeated-keys-computer-use",
      title: "A participant repeats an encoded key",
      route: "computer-use",
      mode: "live",
      subject: { source: "local-app", appUrl: "http://localhost:5173/" },
      actor: { type: "openai-computer-use", persona: "pixel-pat", mission: MISSION },
      review: { analysis: false },
    }),
    dryRun: false,
    env: { OPENAI_API_KEY: "synthetic-openai-value", E2B_API_KEY: e2bKey },
    inProcess: { executor: async () => executor },
    createProvider: async () => provider,
  });
  expect(result.session?.completionReason).toBe("goal_satisfied");
  return { cwd, result, heard, runDir: path.join(cwd, ".humanish", "runs", result.runId) };
}

describe("a computer-use participant that repeats an encoded key it was given", () => {
  it("writes no form of the key into any run file, and verify finds nothing in the run", async () => {
    const { cwd, result, heard, runDir } = await repeatingComputerUseRun();
    // The participant received the encoded keys as written.
    expect(heard[0]).toContain(BASE64_KEY);
    expect(heard[0]).toContain(PERCENT_KEY);
    expect(await filesHoldingKey(runDir)).toEqual([]);
    const { grade, findings } = await verdict(cwd, result.runId);
    expect(findings).toEqual([]);
    expect(grade).not.toBe("blocked");
    // The participant's own words stay, with each key replaced.
    const actor = JSON.parse(await readFile(path.join(runDir, "actor.json"), "utf8")) as {
      reason: string;
      impressions: { items: { text: string }[] };
    };
    expect(actor.reason).toBe(
      "REACHED THE GOAL. Reference: [REDACTED_SECRET] and [REDACTED_SECRET]",
    );
    expect(actor.impressions.items.map((impression) => impression.text)).toEqual([
      "I did not know which to use of: [REDACTED_SECRET] and [REDACTED_SECRET]",
    ]);
  });

  it("writes no known value that a replaced key's marker spells into any run file", async () => {
    // The participant says `<key> and <key>`, so replacing the first key writes
    // `[REDACTED_SECRET] and`, which holds this known value.
    const knownValue = "SECRET] and";
    const { runDir } = await repeatingComputerUseRun(knownValue);
    const holding: string[] = [];
    for (const file of await runFiles(runDir))
      if ((await readFile(path.join(runDir, file), "latin1")).includes(knownValue))
        holding.push(file);
    expect(holding).toEqual([]);
  });
});

describe("a shared-world participant that repeats an encoded key it was given", () => {
  it("writes no form of the key into any run file, and verify finds nothing in the run", async () => {
    const cwd = await makeTestTempDir("humanish-repeated-keys-");
    const study = concurrentStudy(2, 2);
    const world = { worldVersion: 0 };
    const rendezvous = makeRendezvous(2);
    const { env, deps } = baseSeams(world, rendezvous);
    const heard: string[] = [];
    deps.runSession = async (options) => {
      // The participants overlap and each changes the shared world, as the route requires of a pass.
      await rendezvous();
      world.worldVersion += 1;
      const participant = repeatingProvider();
      const session = await runCuaActorSession({
        ...options,
        provider: participant.provider,
        executor: signInPage(),
      });
      heard.push(...participant.heard);
      return session;
    };
    const result = await runSharedWorld({
      cwd,
      config: parsed({ ...study, actor: { ...study.actor, mission: MISSION } }),
      dryRun: false,
      env,
      deps,
    });
    expect(result.error).toBeUndefined();
    expect(result.roles.map((role) => role.session?.completionReason)).toEqual([
      "goal_satisfied",
      "goal_satisfied",
    ]);
    // Each participant received the encoded keys as written.
    expect(
      heard.filter((text) => text.includes(BASE64_KEY) && text.includes(PERCENT_KEY)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(await filesHoldingKey(path.join(cwd, ".humanish", "runs", result.runId))).toEqual([]);
    const { grade, findings } = await verdict(cwd, result.runId);
    expect(findings).toEqual([]);
    expect(grade).not.toBe("blocked");
  });
});

/** A Claude Code session that takes one step, then ends, repeating the encoded keys it was given. */
function repeatingClaude(heard: string[]): ClaudeStreamTransport {
  let turns = 0;
  const reply = (body: Record<string, unknown>) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(body),
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  return {
    async turn(message) {
      heard.push(JSON.stringify(message));
      turns += 1;
      return turns === 1
        ? reply({
            reasoning: repeated("The mission names"),
            done: false,
            message: repeated("Typing the first of"),
            outcome: null,
            actions: [{ kind: "type", text: BASE64_KEY }],
          })
        : reply({
            reasoning: repeated("Both worked:"),
            done: true,
            message: repeated("REACHED THE GOAL. Reference"),
            outcome: "reached",
            actions: [],
          });
    },
    close() {},
  };
}

/** A local study desktop showing a sign-in page, so no E2B key or SDK is needed. */
function signInDesktop(): ParticipantDesktop {
  const screenshot = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  const page = signInPage();
  const allocation = ownDesktopAllocation({
    resourceId: "synthetic-desktop",
    release: async () => ({ status: "released" as const, reason: "terminated" as const }),
  });
  let released = false;
  return {
    prepare: async () => undefined,
    openSession: async () => ({
      executor: allocation.open({
        observe: async () => ({ ...(await page.observe()), screenshot }),
        execute: page.execute,
      }).executor,
    }),
    finalize: async () => {
      released = (await allocation.close()).status === "released";
    },
    snapshot: () => ({ released, streamUrlPresent: false, stateStepRecords: [], phaseRecords: [] }),
  };
}

describe("a Claude Code participant that repeats an encoded key it was given", () => {
  it("writes no form of the key into any run file, and verify finds nothing in the run", async () => {
    const cwd = await makeTestTempDir("humanish-repeated-keys-");
    const heard: string[] = [];
    const actual = await vi.importActual<
      typeof import("../../src/actors/local-agent/claude-session.js")
    >("../../src/actors/local-agent/claude-session.js");
    vi.mocked(startClaudeSession).mockImplementation((options) =>
      actual.startClaudeSession({ ...options, transport: repeatingClaude(heard) }),
    );
    const config = parsed({
      schema: STUDY_SCHEMA,
      id: "repeated-keys-claude-code",
      title: "A Claude Code participant repeats an encoded key",
      route: "computer-use",
      mode: "live",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:5173/" },
      actor: { type: "local-agent", localAgent: "claude", persona: "pixel-pat", mission: MISSION },
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      review: { analysis: false },
    });
    const result = await runComputerUse({
      cwd,
      // A Claude Code participant runs on a hosted desktop. The test gives it a local study's
      // desktop instead, so no E2B key or SDK is needed; the participant's text takes the same path.
      config: { ...config, execution: { ...config.execution, target: "local" } },
      dryRun: false,
      env: {},
      localVm: { desktop: () => signInDesktop(), analysisRefusal: () => undefined },
    });
    expect(result.error).toBeUndefined();
    expect(result.session?.completionReason).toBe("goal_satisfied");
    // The participant received the encoded keys as written.
    expect(heard[0]).toContain(BASE64_KEY);
    expect(heard[0]).toContain(PERCENT_KEY);
    expect(await filesHoldingKey(path.join(cwd, ".humanish", "runs", result.runId))).toEqual([]);
    const { grade, findings } = await verdict(cwd, result.runId);
    expect(findings).toEqual([]);
    expect(grade).not.toBe("blocked");
  });
});

/**
 * A browser whose locators fail to click the way Playwright does, quoting the selector in the
 * error's call log, so a scripted participant repeats a selector it was given.
 */
function selectorQuotingBrowser(): ScriptedBrowserLike {
  const png = syntheticPng1x1();
  let url = "about:blank";
  const locatorFor = (selector: string): ScriptedLocatorLike => {
    const locator: ScriptedLocatorLike = {
      first: () => locator,
      fill: async () => undefined,
      click: async () => {
        throw new Error(
          `locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator(${JSON.stringify(selector)}).first()\n`,
        );
      },
      press: async () => undefined,
      count: async () => 1,
      waitFor: async () => undefined,
      isVisible: async () => true,
    };
    return locator;
  };
  const page: ScriptedPageLike = {
    goto: async (next) => {
      url = next;
      return undefined;
    },
    locator: locatorFor,
    keyboard: { press: async () => undefined },
    waitForTimeout: async () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async ({ path: screenshotPath }) => {
      if (screenshotPath) await writeFile(screenshotPath, png);
      return png;
    },
    url: () => url,
    evaluate: async <T>() => "Sign in" as unknown as T,
  };
  return { newContext: async () => ({ newPage: async () => page }), close: async () => undefined };
}

/** Serves a page on a loopback port for the session's reachability probe. */
async function withLoopbackApp<T>(run: (appUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<main>Sign in</main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A scripted run of one click step on `selector`, whose browser fails it quoting the selector. */
async function selectorQuotingRun(selector: string, env: Record<string, string> = {}) {
  const cwd = await makeTestTempDir("humanish-repeated-keys-");
  await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
  await writeFile(
    path.join(cwd, "humanish", "scenarios", "repeated-keys.yaml"),
    [
      "schema: humanish.scenario.v1",
      "id: repeated-keys",
      "title: Sign in",
      "goal: Sign in.",
      "browser:",
      "  startPath: /",
      "  steps:",
      "    - id: step-01-sign-in",
      "      label: Sign in",
      "      action: click",
      `      selector: ${JSON.stringify(selector)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  const result = await withLoopbackApp((appUrl) =>
    runScripted({
      cwd,
      config: parsed({
        schema: STUDY_SCHEMA,
        id: "repeated-keys-scripted",
        title: "A scripted participant repeats an encoded key",
        route: "scripted",
        mode: "live",
        subject: { source: "app-url", appUrl },
        actor: { type: "scripted-browser", persona: "synthetic-new-user" },
        scenario: "repeated-keys",
        execution: { target: "local", timeoutMs: 30_000 },
        review: { analysis: false },
      }),
      dryRun: false,
      env,
      deps: { launchBrowser: async () => selectorQuotingBrowser() },
    }),
  );
  expect(result.error).toBeUndefined();
  expect(result.sessions.map((session) => session.completionReason)).toEqual(["step_failed"]);
  return { cwd, runId: result.runId, root: path.join(cwd, ".humanish", "runs", result.runId) };
}

describe("a scripted participant that repeats an encoded key it was given", () => {
  it("writes no form of the key into any run file, and verify finds nothing in the run", async () => {
    const { cwd, runId, root } = await selectorQuotingRun(
      `[data-key='${BASE64_KEY}'], [data-key='${PERCENT_KEY}']`,
    );
    expect(await filesHoldingKey(root)).toEqual([]);
    const { grade, findings } = await verdict(cwd, runId);
    expect(findings).toEqual([]);
    expect(grade).not.toBe("blocked");
  });

  it("writes no known value that a replaced key's marker spells into any run file", async () => {
    const knownValue = "SECRET] and";
    const { root } = await selectorQuotingRun(
      `[data-key='${BASE64_KEY}'] and [data-key='${PERCENT_KEY}']`,
      { E2B_API_KEY: knownValue },
    );
    const holding: string[] = [];
    for (const file of await runFiles(root))
      if ((await readFile(path.join(root, file), "latin1")).includes(knownValue))
        holding.push(file);
    expect(holding).toEqual([]);
  });

  it("keeps a known value that starts with an encoded key whole for its scrub", async () => {
    const suffix = "private-suffix-of-the-known-value";
    const { root } = await selectorQuotingRun(`[data-key='${BASE64_KEY} ${suffix}']`, {
      E2B_API_KEY: `${BASE64_KEY} ${suffix}`,
    });
    const holding: string[] = [];
    for (const file of await runFiles(root))
      if ((await readFile(path.join(root, file), "latin1")).includes(suffix)) holding.push(file);
    expect(holding).toEqual([]);
  });
});
