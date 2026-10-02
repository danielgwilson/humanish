import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkRestrictedCodexAnalysisReadiness,
  createRestrictedCodexAnalysisProvider,
} from "../../../src/analysis/restricted-codex.js";
import { qualifiedCodexCliVersions } from "../../../src/actors/codex/qualified-versions.js";
import type { RestrictedCodexRequest } from "../../../src/actors/codex/restricted-policy.js";
import {
  createRestrictedCodexSession,
  detectRestrictedCodexCliVersion,
  type RestrictedCodexSessionOptions,
} from "../../../src/actors/codex/restricted-session.js";
import type { RestrictedCodexSpawn } from "../../../src/actors/codex/restricted-transport.js";

const fake = fileURLToPath(
  new URL("../../fixtures/restricted-codex/fake-process.mjs", import.meta.url),
);
const directories: string[] = [];
const request: RestrictedCodexRequest = {
  model: "gpt-6-astra",
  instructions: "Review supplied synthetic evidence only.",
  evidence: "Synthetic study evidence.",
  images: [],
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["observedCode"],
    properties: { observedCode: { type: "string" } },
  },
  maxOutputTokens: null,
  // A hang guard, not a budget under test: it covers real process spawns, so it sits above the
  // test timeout. Tests of the deadline pass their own timeoutMs on a fake clock.
  timeoutMs: 60_000,
};

type Trace = Record<string, unknown>;

// Captured before any test fakes timers, so polling the fake process keeps real time.
const realSetTimeout = globalThis.setTimeout;
// vi.waitFor gives up after 1 s by default. These waits follow a real child spawn, which alone can
// take longer under load; the test timeout still bounds a hang.
const AFTER_SPAWN = { timeout: 15_000 };
async function untilTraced(
  entries: () => Promise<Trace[]>,
  predicate: (entry: Trace) => boolean,
): Promise<void> {
  while (!(await entries()).some(predicate))
    await new Promise((resolve) => realSetTimeout(resolve, 5));
}
/**
 * Waits until the launcher has handled a line the fake process wrote. The check runs on a timer
 * tick, after the `data` event that delivered the line and the microtasks it queued, so the
 * launcher's transport has handled that line by then.
 */
async function untilDelivered(delivered: readonly string[], line: string): Promise<void> {
  do await new Promise((resolve) => realSetTimeout(resolve, 5));
  while (!delivered.includes(line));
}
async function fixture(scenario = "success") {
  const directory = await mkdtemp(path.join(tmpdir(), "humanish-codex-test-"));
  directories.push(directory);
  const authHome = path.join(directory, "auth"),
    tempRoot = path.join(directory, "temp"),
    trace = path.join(directory, "calls.jsonl");
  await mkdir(authHome);
  await mkdir(tempRoot);
  await writeFile(path.join(authHome, "auth.json"), "synthetic-original-login", { mode: 0o600 });
  await writeFile(path.join(authHome, "config.toml"), "SYNTHETIC_HOST_CONFIG_MUST_NOT_BE_IMPORTED");
  const spawns: { args: string[]; env: NodeJS.ProcessEnv; cwd: string; detached: boolean }[] = [];
  // What the fake process wrote to the launcher, one entry per complete line: a notification's
  // method, or "turn/start reply" for the response that carries the turn id.
  const delivered: string[] = [];
  const spawnFn: RestrictedCodexSpawn = (_file, args, settings) => {
    spawns.push({
      args,
      env: settings.env ?? {},
      cwd: String(settings.cwd),
      detached: settings.detached,
    });
    const child = spawn(process.execPath, [fake, scenario, trace, ...args], settings);
    const decoder = new StringDecoder("utf8");
    let partial = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const lines = (partial + decoder.write(chunk)).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as Trace;
          if (typeof message.method === "string") delivered.push(message.method);
          else if (typeof (message.result as Trace | undefined)?.turn === "object")
            delivered.push("turn/start reply");
        } catch {
          // Not a protocol line.
        }
      }
    });
    return child;
  };
  const options: RestrictedCodexSessionOptions = {
    executable: process.execPath,
    authHome,
    tempRoot,
    spawnFn,
    env: {
      HOME: directory,
      CODEX_HOME: authHome,
      PATH: process.env.PATH,
      XDG_CACHE_HOME: path.join(directory, "cache"),
      OPENAI_API_KEY: "synthetic-api-key",
      E2B_API_KEY: "synthetic-desktop-key",
      AGENTMAIL_API_KEY: "synthetic-mail-key",
      NODE_OPTIONS: "--invalid-option-must-not-reach-child",
      OPENAI_BASE_URL: "https://example.invalid",
    },
  };
  const entries = async (): Promise<Trace[]> =>
    readFile(trace, "utf8").then(
      (text) =>
        text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Trace),
      () => [],
    );
  return {
    directory,
    authHome,
    tempRoot,
    trace,
    options,
    spawns,
    entries,
    delivered,
    run: createRestrictedCodexAnalysisProvider(options),
  };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("restricted Codex analyst session", () => {
  it("uses a separate native child, isolated config/auth home, and one strict image/text turn", async () => {
    const f = await fixture();
    const result = await f.run({
      ...request,
      images: [{ evidenceId: "e-image-1", dataUrl: "data:image/png;base64,c3ludGhldGlj" }],
    });
    expect(result).toMatchObject({
      status: "completed",
      dispatched: true,
      errorCode: null,
      output: { observedCode: "BLUE-4821", observedColor: "blue" },
      usage: { input: 2957, output: 41, cachedInput: 0, cacheWriteInput: 0 },
      usageComplete: true,
    });
    expect(f.spawns.map((item) => item.args)).toEqual([
      ["--version"],
      ["app-server", "--strict-config"],
    ]);
    for (const child of f.spawns) {
      expect(child.detached).toBe(false);
      expect(Object.keys(child.env).sort()).toEqual(["CODEX_HOME", "HOME", "PATH", "TMPDIR"]);
      expect(child.env.HOME).not.toBe(f.directory);
      expect(child.cwd).not.toBe(process.cwd());
    }
    const entries = await f.entries(),
      methods = entries.filter((entry) => entry.method).map((entry) => entry.method);
    expect(methods.indexOf("config/read")).toBeLessThan(methods.indexOf("thread/start"));
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
    const thread = entries.find((entry) => entry.method === "thread/start")!.params;
    expect(thread).toMatchObject({
      ephemeral: true,
      experimentalRawEvents: true,
      environments: [],
      runtimeWorkspaceRoots: [],
      dynamicTools: [],
      allowProviderModelFallback: false,
      model: "gpt-6-astra",
      modelProvider: "openai",
      config: {
        "agents.enabled": false,
        "features.code_mode_host": false,
        "features.skip_host_skill_discovery": true,
        "skills.bundled.enabled": false,
      },
    });
    expect(entries.find((entry) => entry.method === "turn/start")!.params).toMatchObject({
      model: "gpt-6-astra",
      effort: "low",
      outputSchema: request.schema,
      environments: [],
      runtimeWorkspaceRoots: [],
      sandboxPolicy: { type: "readOnly" },
    });
    expect(entries.find((entry) => entry.imageCount)?.imageFiles).toEqual([
      expect.objectContaining({ exists: true, mode: 0o600 }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("synthetic-api-key");
    expect(await readdir(f.tempRoot)).toEqual([]);
    expect(await readFile(path.join(f.authHome, "auth.json"), "utf8")).toBe(
      "synthetic-original-login",
    );
  });

  it("readiness checks auth/config/thread without a model turn or report", async () => {
    const f = await fixture();
    expect(await checkRestrictedCodexAnalysisReadiness({}, f.options)).toEqual({
      ready: true,
      errorCode: null,
    });
    expect((await f.entries()).some((entry) => entry.method === "turn/start")).toBe(false);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("admits a large captured-shape raw image echo without dropping evidence or relaxing final-output bounds", async () => {
    const f = await fixture("large-input-echo");
    const dataUrl = `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024).toString("base64")}`;
    expect(await f.run({ ...request, images: [{ evidenceId: "e-large", dataUrl }] })).toMatchObject(
      { status: "completed" },
    );
    expect((await f.entries()).find((entry) => entry.imageCount)?.imageCount).toBe(1);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("accepts an ordinary structured answer streamed through more than 1,000 text deltas", async () => {
    const f = await fixture("many-deltas");
    expect(await f.run(request)).toMatchObject({
      status: "completed",
      output: { observedCode: "BLUE-4821", summary: "Synthetic finding. ".repeat(1200) },
    });
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("caps aggregate generated UTF-8 bytes independently of a larger admitted image wire budget", async () => {
    const f = await fixture("aggregate-delta-overflow");
    const dataUrl = `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024).toString("base64")}`;
    expect(await f.run({ ...request, images: [{ evidenceId: "e-large", dataUrl }] })).toMatchObject(
      {
        status: "failed",
        errorCode: "response_too_large",
        output: null,
        dispatched: true,
        usageComplete: false,
      },
    );
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("admits each release qualified on Linux x64 and records the one that ran", async () => {
    for (const version of qualifiedCodexCliVersions("linux", "x64")) {
      const f = await fixture(`version-${version}`);
      const session = createRestrictedCodexSession({
        ...f.options,
        platform: "linux",
        arch: "x64",
      });
      expect(await session.run(request), version).toMatchObject({ status: "completed" });
      expect(session.cliVersion).toBe(version);
      expect(await session.close()).toBe(true);
    }
  });

  it("refuses a release other than the one an analysis identity recorded", async () => {
    const bound = await fixture("success");
    expect(
      await createRestrictedCodexAnalysisProvider({ ...bound.options, cliVersion: "0.154.0" })(
        request,
      ),
    ).toMatchObject({ errorCode: "codex_unsupported_version", dispatched: false });
    expect(bound.spawns.map((entry) => entry.args[0])).toEqual(["--version"]);
  });

  it("admits only the releases a qualification run names through its seam", async () => {
    const candidate = await fixture("version-0.158.0");
    expect(
      await createRestrictedCodexAnalysisProvider({
        ...candidate.options,
        cliVersions: ["0.158.0"],
      })(request),
    ).toMatchObject({ status: "completed" });
    const current = await fixture("success");
    expect(
      await createRestrictedCodexAnalysisProvider({ ...current.options, cliVersions: ["0.158.0"] })(
        request,
      ),
    ).toMatchObject({ errorCode: "codex_unsupported_version" });
  });

  it("detects the installed release without app-server and removes its temporary home", async () => {
    const qualified = await fixture("version-0.154.0");
    expect(
      await detectRestrictedCodexCliVersion(
        {},
        { ...qualified.options, platform: "linux", arch: "x64" },
      ),
    ).toEqual({ cliVersion: "0.154.0", errorCode: null });
    expect(qualified.spawns.map((entry) => entry.args)).toEqual([["--version"]]);
    expect(await readdir(qualified.tempRoot)).toEqual([]);
    const unqualified = await fixture("version-0.158.0");
    expect(
      await detectRestrictedCodexCliVersion(
        {},
        { ...unqualified.options, platform: "linux", arch: "x64" },
      ),
    ).toEqual({
      cliVersion: null,
      errorCode: "codex_unsupported_version",
      detectedVersion: "0.158.0",
    });
    expect(
      await detectRestrictedCodexCliVersion(
        {},
        { ...qualified.options, platform: "linux", arch: "arm64" },
      ),
    ).toEqual({ cliVersion: null, errorCode: "codex_unsupported_platform" });
  });

  it.each([
    ["wrong-version", "codex_unsupported_version"],
    ["version-0.158.0", "codex_unsupported_version"],
    ["initialize-version-mismatch", "codex_unsupported_version"],
    ["thread-version-mismatch", "codex_unsafe_configuration"],
    ["api-key-auth", "codex_unsupported_auth"],
    ["signed-out", "codex_login_required"],
    ["system-config", "codex_unsafe_configuration"],
    ["mcp-config", "codex_unsafe_configuration"],
    ["instructions-config", "codex_unsafe_configuration"],
    ["agents-enabled", "codex_unsafe_configuration"],
    ["code-host-enabled", "codex_unsafe_configuration"],
    ["provider-config", "codex_unsafe_configuration"],
    ["model-mismatch", "codex_unsafe_configuration"],
    ["inherited-instructions", "codex_unsafe_configuration"],
    ["environment-enabled", "codex_unsafe_configuration"],
    ["active-mcp", "codex_unsafe_configuration"],
  ])("rejects %s before model dispatch", async (scenario, code) => {
    const f = await fixture(scenario);
    expect(await f.run(request)).toMatchObject({
      status: "failed",
      output: null,
      dispatched: false,
      errorCode: code,
      usageComplete: false,
    });
    expect((await f.entries()).some((entry) => entry.method === "turn/start")).toBe(false);
    if (
      [
        "system-config",
        "mcp-config",
        "instructions-config",
        "agents-enabled",
        "code-host-enabled",
        "provider-config",
      ].includes(scenario)
    )
      expect((await f.entries()).some((entry) => entry.method === "thread/start")).toBe(false);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("refuses missing file login, unsupported platform/model and numeric token caps without model dispatch", async () => {
    const f = await fixture();
    for (const overrides of [{ maxOutputTokens: 1000 }, { model: "unqualified-model" }]) {
      const result = await f.run({ ...request, ...overrides });
      expect(result.dispatched).toBe(false);
      expect(result.status).toBe("failed");
    }
    expect(
      await createRestrictedCodexAnalysisProvider({ ...f.options, platform: "win32", arch: "x64" })(
        request,
      ),
    ).toMatchObject({ errorCode: "codex_unsupported_platform" });
    expect(
      await createRestrictedCodexAnalysisProvider({
        ...f.options,
        platform: "linux",
        arch: "arm64",
      })(request),
    ).toMatchObject({ errorCode: "codex_unsupported_platform" });
    expect(f.spawns).toHaveLength(0);
    await rm(path.join(f.authHome, "auth.json"));
    expect(await f.run(request)).toMatchObject({
      errorCode: "codex_login_required",
      dispatched: false,
    });
    expect(f.spawns).toHaveLength(1);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it.each([
    ["malformed", "codex_protocol_error"],
    ["server-request", "codex_tool_call"],
    ["provider-error", "codex_protocol_error"],
    ["wrong-thread", "codex_protocol_error"],
    ["wrong-turn", "codex_protocol_error"],
    ["raw-tool", "codex_tool_call"],
    // A native command item under a method humanish does not know, before an ordinary answer.
    ["unknown-item-notification", "codex_tool_call"],
    // A native command item in turn/completed's items, after an ordinary answer.
    ["nested-turn-item", "codex_tool_call"],
    ["async-question", "codex_tool_call"],
    ["invalid-json", "invalid_response"],
    ["multiple-answers", "invalid_response"],
    ["missing-answer", "invalid_response"],
    ["stdout-large", "response_too_large"],
    ["stderr-large", "response_too_large"],
    ["event-overflow", "response_too_large"],
    ["exit-after-dispatch", "codex_process_failed"],
    ...[
      "missing-item-thread",
      "missing-item-turn",
      "missing-usage-thread",
      "missing-usage-turn",
      "missing-completion-thread",
      "missing-completion-id",
    ].map((scenario) => [scenario, "codex_protocol_error"]),
  ])("fails closed on %s with a safe fixed error and no report", async (scenario, errorCode) => {
    const f = await fixture(scenario),
      result = await f.run(request);
    expect(result).toMatchObject({ output: null, errorCode, usageComplete: false });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_ERROR_PAYLOAD");
    expect(JSON.stringify(result)).not.toContain(f.directory);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("refuses a disallowed item that arrives during the handshake, before any dispatch", async () => {
    const f = await fixture("handshake-item");
    expect(await f.run(request)).toMatchObject({
      status: "failed",
      errorCode: "codex_tool_call",
      dispatched: false,
      output: null,
    });
    expect((await f.entries()).some((entry) => entry.method === "turn/start")).toBe(false);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("records an unknown progress notification without an item and completes", async () => {
    const f = await fixture("unknown-progress");
    expect(await f.run(request)).toMatchObject({
      status: "completed",
      errorCode: null,
      output: { observedCode: "BLUE-4821" },
      unknownNotifications: { "thread/futureProgress/updated": 2 },
    });
  });

  it("handles notifications before the turn acknowledgment, without losing the answer", async () => {
    const f = await fixture("early-events");
    expect(await f.run(request)).toMatchObject({
      status: "completed",
      usageComplete: true,
      output: { observedCode: "BLUE-4821" },
    });
  });

  it.each(["missing-usage", "invalid-usage"])(
    "keeps %s unknown on an otherwise completed answer",
    async (scenario) => {
      const f = await fixture(scenario);
      expect(await f.run(request)).toMatchObject({
        status: "completed",
        usage: null,
        usageComplete: false,
      });
    },
  );

  it.each(["interrupted", "partial-usage"])(
    "retains partial usage after %s without accepting the answer",
    async (scenario) => {
      const f = await fixture(scenario);
      expect(await f.run(request)).toMatchObject({
        status: scenario === "interrupted" ? "cancelled" : "failed",
        output: null,
        usage: { input: 2957, output: 41 },
        usageComplete: false,
        dispatched: true,
      });
    },
  );

  it("pre-abort allocates nothing and does not start a process", async () => {
    const f = await fixture();
    expect(await f.run({ ...request, signal: AbortSignal.abort() })).toMatchObject({
      status: "cancelled",
      dispatched: false,
    });
    expect(f.spawns).toHaveLength(0);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it.each([
    ["hang-version", "startup", (entry: Trace) => entry.operation === "--version"],
    ["hang-initialize", "initialize", (entry: Trace) => entry.method === "initialize"],
    ["hang-thread-start", "thread/start", (entry: Trace) => entry.method === "thread/start"],
    ["hang-turn-start", "turn/start", (entry: Trace) => entry.method === "turn/start"],
  ])("bounds %s and identifies the timed-out phase", async (scenario, failurePhase, hanging) => {
    const f = await fixture(scenario);
    // Only the deadline's clock is fake, and it moves once the fake process is hanging in the
    // phase under test, so spawning under load spends none of the 600 ms budget.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const start = performance.now();
      const pending = f.run({ ...request, timeoutMs: 600 });
      await untilTraced(f.entries, hanging);
      vi.advanceTimersByTime(600);
      expect(await pending).toMatchObject({
        status: "timed_out",
        errorCode: "timeout",
        failurePhase,
        dispatched: scenario === "hang-turn-start",
      });
      // Cleanup waited on the child, not on a timer: the run ended on 600 ms of clock time.
      expect(performance.now() - start).toBe(600);
    } finally {
      vi.useRealTimers();
    }
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it.each(["hang-turn", "lost-turn-ack", "ignore-term"])(
    "interrupts %s and closes the owned native child",
    async (scenario) => {
      const f = await fixture(scenario),
        controller = new AbortController();
      const pending = f.run({ ...request, signal: controller.signal });
      // The launcher can interrupt only once it holds the turn id: from the turn/start reply, or
      // from turn/started when that reply never comes. Aborting as soon as the fake logged
      // turn/start raced that delivery under load.
      await untilDelivered(
        f.delivered,
        scenario === "lost-turn-ack" ? "turn/started" : "turn/start reply",
      );
      const start = performance.now();
      controller.abort();
      expect(await pending).toMatchObject({
        status: "cancelled",
        errorCode: "cancelled",
        dispatched: true,
        output: null,
      });
      expect(performance.now() - start).toBeLessThan(4000);
      const entries = await f.entries();
      expect(entries.some((entry) => entry.method === "turn/interrupt")).toBe(true);
      for (const entry of entries.filter((entry) => typeof entry.pid === "number"))
        expect(() => process.kill(entry.pid as number, 0)).toThrow();
      expect(await readdir(f.tempRoot)).toEqual([]);
    },
  );

  it("isolates simultaneous sessions and readiness calls sharing a login", async () => {
    const first = await fixture("hang-turn"),
      second = await fixture(),
      controller = new AbortController();
    second.options.authHome = first.authHome;
    const pending = first.run({ ...request, signal: controller.signal });
    await vi.waitFor(
      async () =>
        expect((await first.entries()).some((entry) => entry.method === "turn/start")).toBe(true),
      AFTER_SPAWN,
    );
    expect(await second.run(request)).toMatchObject({ status: "completed", dispatched: true });
    expect(await checkRestrictedCodexAnalysisReadiness({}, second.options)).toEqual({
      ready: true,
      errorCode: null,
    });
    expect(second.spawns[0]!.env.CODEX_HOME).not.toBe(first.spawns[0]!.env.CODEX_HOME);
    controller.abort();
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(await readFile(path.join(first.authHome, "auth.json"), "utf8")).toBe(
      "synthetic-original-login",
    );
    expect(await readdir(first.tempRoot)).toEqual([]);
    expect(await readdir(second.tempRoot)).toEqual([]);
  });

  it("preserves an unexpected auth replacement, original login, and names-only private recovery marker", async () => {
    const f = await fixture("replace-auth");
    const result = await f.run({
      ...request,
      images: [{ evidenceId: "e1", dataUrl: "data:image/png;base64,c3ludGhldGlj" }],
    });
    expect(result).toMatchObject({
      status: "failed",
      output: null,
      dispatched: true,
      errorCode: "codex_cleanup_failed",
      usageComplete: false,
    });
    expect(await readFile(path.join(f.authHome, "auth.json"), "utf8")).toBe(
      "synthetic-original-login",
    );
    const tasks = await readdir(f.tempRoot);
    expect(tasks).toHaveLength(1);
    const retained = path.join(f.tempRoot, tasks[0]!);
    expect(await readdir(retained)).toEqual(["home"]);
    expect(await readdir(path.join(retained, "home"))).toEqual(["auth.json"]);
    expect(await readFile(path.join(retained, "home", "auth.json"), "utf8")).toBe(
      "synthetic-rotated-login",
    );
    expect((await stat(retained)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(retained, "home", "auth.json"))).mode & 0o777).toBe(0o600);
    const marker = await readFile(
      path.join(f.directory, "cache", "humanish", "codex-analysis-recovery", `${tasks[0]}.json`),
      "utf8",
    );
    expect(JSON.parse(marker)).toMatchObject({
      taskDirectoryName: tasks[0],
      authFileName: "auth.json",
    });
    expect(marker).not.toContain(f.directory);
    expect(marker).not.toContain("synthetic-rotated-login");
    expect(JSON.stringify(result)).not.toContain(retained);
    expect(JSON.stringify(result)).not.toContain("synthetic-rotated-login");
    for (const entry of (await f.entries()).filter((entry) => typeof entry.pid === "number"))
      expect(() => process.kill(entry.pid as number, 0)).toThrow();
  });

  it.each(["version", "app-server"])(
    "retains ownership and blocks new work until an unkillable %s child actually closes",
    async (stage) => {
      const f = await fixture(stage === "version" ? "hang-version" : "ignore-term"),
        next = await fixture();
      const spawnOriginal = f.options.spawnFn!;
      let heldChild: ChildProcessWithoutNullStreams | undefined;
      let originalKill: ChildProcessWithoutNullStreams["kill"] | undefined;
      let closed: Promise<void> | undefined;
      f.options.spawnFn = (file, args, settings) => {
        const child = spawnOriginal(file, args, settings);
        if (args[0] === (stage === "version" ? "--version" : "app-server")) {
          heldChild = child;
          originalKill = child.kill.bind(child);
          closed = new Promise((resolve) => child.once("close", () => resolve()));
          child.kill = () => false; // deterministic failure to deliver a signal, not a fake exit
        }
        return child;
      };
      const controller = new AbortController();
      const pending = createRestrictedCodexAnalysisProvider(f.options)({
        ...request,
        signal: controller.signal,
      });
      try {
        await vi.waitFor(
          async () =>
            expect(
              stage === "version"
                ? heldChild !== undefined
                : (await f.entries()).some((entry) => entry.method === "turn/start"),
            ).toBe(true),
          AFTER_SPAWN,
        );
        controller.abort();
        expect(await pending).toMatchObject({ errorCode: "codex_cleanup_failed", output: null });
        const tasks = await readdir(f.tempRoot);
        expect(tasks).toHaveLength(1);
        expect(await stat(path.join(f.tempRoot, tasks[0]!, "home"))).toBeDefined();
        expect(await next.run(request)).toMatchObject({
          errorCode: "codex_busy",
          dispatched: false,
        });
        expect(await checkRestrictedCodexAnalysisReadiness({}, next.options)).toEqual({
          ready: false,
          errorCode: "codex_busy",
        });
        expect(next.spawns).toHaveLength(0);
        expect(await readFile(path.join(f.authHome, "auth.json"), "utf8")).toBe(
          "synthetic-original-login",
        );
      } finally {
        originalKill?.("SIGKILL");
        await closed;
        await pending;
      }
      expect(await next.run(request)).toMatchObject({ status: "completed" });
    },
  );
});

describe("continuing restricted Codex conversation", () => {
  it("keeps one home/process/thread beyond eight turns, with fresh images and per-turn usage", async () => {
    const f = await fixture("continuing"),
      session = createRestrictedCodexSession(f.options);
    try {
      for (let index = 0; index < 12; index++) {
        const result = await session.run({
          ...request,
          evidence: `Observation ${index}`,
          images: [{ evidenceId: `frame-${index}`, dataUrl: "data:image/png;base64,c3ludGhldGlj" }],
        });
        expect(result).toMatchObject({
          status: "completed",
          usage: { input: 2957, output: 41 },
          usageComplete: true,
        });
      }
      const entries = await f.entries();
      for (const method of ["initialize", "account/read", "thread/start"])
        expect(entries.filter((entry) => entry.method === method)).toHaveLength(1);
      const turns = entries
        .filter((entry) => entry.method === "turn/start")
        .map((entry) => entry.params as Record<string, unknown>);
      expect(turns).toHaveLength(12);
      expect(new Set(turns.map((turn) => turn.threadId)).size).toBe(1);
      expect(turns.at(-1)!.input).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: "Observation 11" })]),
      );
      expect(f.spawns).toHaveLength(2); // version + app-server, not per turn
      expect(await readdir(f.tempRoot)).toHaveLength(1);
    } finally {
      expect(await session.close()).toBe(true);
    }
    expect(await readdir(f.tempRoot)).toEqual([]);
    expect(await session.close()).toBe(true);
    expect(await session.run(request)).toMatchObject({
      errorCode: "invalid_request",
      dispatched: false,
    });
  });

  it("continues through captured native compaction while reporting its token counts as partial", async () => {
    const f = await fixture("continuing-compaction"),
      session = createRestrictedCodexSession(f.options);
    try {
      expect(await session.run(request)).toMatchObject({
        status: "completed",
        usageComplete: true,
      });
      expect(await session.run(request)).toMatchObject({
        status: "completed",
        usageComplete: false,
        usage: { input: 2957, output: 41 },
      });
      expect(await session.run(request)).toMatchObject({
        status: "completed",
        usageComplete: true,
        usage: { input: 2957, output: 41 },
      });
      expect((await f.entries()).filter((entry) => entry.method === "thread/start")).toHaveLength(
        1,
      );
    } finally {
      expect(await session.close()).toBe(true);
    }
  });

  it("has a fresh request deadline after time spent between completed turns", async () => {
    const f = await fixture("continuing"),
      session = createRestrictedCodexSession(f.options);
    // Only the deadline's clock is fake: startup under load spends none of the first 500 ms, and
    // the 550 ms between turns passes on the clock the deadline reads.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      for (const idleMs of [0, 550]) {
        vi.advanceTimersByTime(idleMs);
        const result = await session.run({ ...request, timeoutMs: 500 });
        expect(result).toMatchObject({ status: "completed" });
      }
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  it("rejects changed identity without replacing the conversation", async () => {
    const f = await fixture("continuing"),
      session = createRestrictedCodexSession(f.options);
    try {
      expect(await session.run(request)).toMatchObject({ status: "completed" });
      expect(await session.run({ ...request, instructions: "A different persona" })).toMatchObject({
        errorCode: "invalid_request",
        dispatched: false,
      });
      expect(await session.run(request)).toMatchObject({ status: "completed" });
      expect((await f.entries()).filter((entry) => entry.method === "thread/start")).toHaveLength(
        1,
      );
    } finally {
      await session.close();
    }
  });

  it("close cancels an active continuation and confirms process cleanup", async () => {
    const f = await fixture("continuing-hang"),
      session = createRestrictedCodexSession(f.options);
    expect(await session.run(request)).toMatchObject({ status: "completed" });
    const pending = session.run(request);
    await vi.waitFor(
      async () =>
        expect((await f.entries()).filter((entry) => entry.method === "turn/start")).toHaveLength(
          2,
        ),
      AFTER_SPAWN,
    );
    expect(await session.run(request)).toMatchObject({
      errorCode: "codex_busy",
      dispatched: false,
    });
    const closing = session.close();
    expect(await pending).toMatchObject({ status: "cancelled", dispatched: true });
    expect(await closing).toBe(true);
    expect(await readdir(f.tempRoot)).toEqual([]);
    for (const entry of (await f.entries()).filter((entry) => typeof entry.pid === "number"))
      expect(() => process.kill(entry.pid as number, 0)).toThrow();
  });

  it("rejects an earlier turn's output instead of accepting it as the current observation", async () => {
    const f = await fixture("continuing-stale"),
      session = createRestrictedCodexSession(f.options);
    expect(await session.run(request)).toMatchObject({ status: "completed" });
    expect(await session.run(request)).toMatchObject({
      errorCode: "codex_protocol_error",
      dispatched: true,
    });
    expect(await session.close()).toBe(true);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("does not restart a failed idle process with an empty memory", async () => {
    const f = await fixture("continuing"),
      session = createRestrictedCodexSession(f.options);
    expect(await session.run(request)).toMatchObject({ status: "completed" });
    const entry = (await f.entries()).find((entry) => entry.operation === "app-server")!;
    process.kill(entry.pid as number, "SIGTERM");
    await vi.waitFor(
      () => expect(() => process.kill(entry.pid as number, 0)).toThrow(),
      AFTER_SPAWN,
    );
    expect(await session.run(request)).toMatchObject({
      errorCode: "codex_process_failed",
      dispatched: false,
    });
    expect(f.spawns).toHaveLength(2);
    expect(await session.close()).toBe(true);
  });
});

describe("restricted Codex Code Mode participant session", () => {
  it("inherits the operator model, preserves hosted auth, and pauses its deadline while the declared tool runs", async () => {
    const f = await fixture("participant-success"),
      calls: unknown[] = [];
    f.options.env = {
      ...f.options.env,
      HOME: f.directory,
      CODEX_HOME: f.authHome,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic-keyring",
      OPENAI_API_KEY: "synthetic-hosted-key",
      NODE_OPTIONS: undefined,
    };
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      tool: {
        name: "humanish_ui",
        description: "Observe or act on the assigned synthetic desktop.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "observe" } },
        },
        call: async (args) => {
          calls.push(args);
          // The tool runs for 900 ms on the deadline's clock, past the 800 ms budget.
          vi.advanceTimersByTime(900);
          return JSON.stringify({
            acknowledgments: [],
            imageUrl: "data:image/png;base64,c3ludGhldGlj",
          });
        },
      },
    };
    const session = createRestrictedCodexSession(f.options);
    try {
      // Only the deadline's clock is fake, and only the tool call advances it, so process startup
      // under load spends none of the budget.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const start = performance.now();
      const [result, elapsed] = await session
        .run({ ...request, model: undefined, timeoutMs: 800 })
        .then((value) => [value, performance.now() - start] as const)
        .finally(() => vi.useRealTimers());
      expect(result).toMatchObject({
        status: "completed",
        output: { observedCode: "BLUE-4821" },
        errorCode: null,
      });
      expect(elapsed).toBe(900);
      expect(calls).toEqual([{ kind: "observe" }]);
      const appServer = f.spawns.find((entry) => entry.args[0] === "app-server")!;
      expect(appServer.env).toMatchObject({
        HOME: f.directory,
        CODEX_HOME: f.authHome,
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic-keyring",
        OPENAI_API_KEY: "synthetic-hosted-key",
      });
      expect(appServer.args.some((arg) => arg.startsWith("model="))).toBe(false);
      const entries = await f.entries();
      const thread = entries.find((entry) => entry.method === "thread/start")!.params as Record<
        string,
        unknown
      >;
      expect(thread).toMatchObject({
        model: "operator-configured-model",
        dynamicTools: [{ type: "function", name: "humanish_ui" }],
        config: {
          "features.code_mode": true,
          "features.code_mode_host": true,
          "features.code_mode_only": true,
          "mcp_servers.inherited_synthetic.enabled": false,
        },
      });
      expect(session.resolvedModel).toBe("operator-configured-model");
      expect(session.authentication).toBe("chatgpt-account");
      expect(entries.find((entry) => entry.method === "turn/start")!.params).toMatchObject({
        model: "operator-configured-model",
        effort: "high",
      });
      expect(entries.find((entry) => entry.toolResponse)?.toolResponse).toEqual({
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              acknowledgments: [],
              imageUrl: "data:image/png;base64,c3ludGhldGlj",
            }),
          },
        ],
      });
    } finally {
      expect(await session.close()).toBe(true);
    }
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("reports admitted API-key authentication without exposing credentials", async () => {
    const f = await fixture("participant-api-key-auth");
    delete f.options.env!.NODE_OPTIONS;
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      tool: {
        name: "humanish_ui",
        description: "Synthetic UI.",
        inputSchema: { type: "object" },
        call: async () => JSON.stringify({ ok: true }),
      },
    };
    const session = createRestrictedCodexSession(f.options);
    expect(await session.run({ ...request, model: undefined }, true)).toMatchObject({
      status: "completed",
      dispatched: false,
    });
    expect(session.resolvedModel).toBe("operator-configured-model");
    expect(session.authentication).toBe("api-key");
    expect(await session.close()).toBe(true);
  });

  it("lets Codex resolve an unconfigured operator default model, then exposes the resolved identity", async () => {
    const f = await fixture("participant-default-model");
    delete f.options.env!.NODE_OPTIONS;
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      tool: {
        name: "humanish_ui",
        description: "Synthetic UI.",
        inputSchema: { type: "object" },
        call: async () => JSON.stringify({ ok: true }),
      },
    };
    const session = createRestrictedCodexSession(f.options);
    expect(await session.run({ ...request, model: undefined }, true)).toMatchObject({
      status: "completed",
      dispatched: false,
    });
    expect(session.resolvedModel).toBe("operator-configured-model");
    const threadParams = (await f.entries()).find((entry) => entry.method === "thread/start")!
      .params as Record<string, unknown>;
    expect(threadParams).not.toHaveProperty("model");
    expect(await session.close()).toBe(true);
  });

  it("rejects inherited MCP names that cannot be addressed by a dotted override", async () => {
    const f = await fixture("participant-unsafe-mcp-name");
    delete f.options.env!.NODE_OPTIONS;
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      tool: {
        name: "humanish_ui",
        description: "Synthetic UI.",
        inputSchema: { type: "object" },
        call: async () => JSON.stringify({ ok: true }),
      },
    };
    const session = createRestrictedCodexSession(f.options);
    expect(await session.run({ ...request, model: undefined }, true)).toMatchObject({
      status: "failed",
      errorCode: "codex_unsafe_configuration",
      dispatched: false,
    });
    expect(await session.close()).toBe(true);
  });

  it("fails closed and cleans up when the host's tool getter throws after admission", async () => {
    const f = await fixture("participant-success");
    delete f.options.env!.NODE_OPTIONS;
    const tool = {
      name: "humanish_ui",
      description: "Synthetic UI.",
      inputSchema: { type: "object" },
      call: async () => JSON.stringify({ ok: true }),
    };
    let reads = 0;
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      // run() admits the participant on the first read; the launch reads it again for thread/start.
      get tool() {
        if (++reads > 1) throw new Error("synthetic host getter failure");
        return tool;
      },
    };
    const session = createRestrictedCodexSession(f.options);
    expect(await session.run({ ...request, model: undefined })).toMatchObject({
      status: "failed",
      errorCode: "codex_process_failed",
      failurePhase: "thread/start",
      dispatched: false,
    });
    expect(await session.close()).toBe(true);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it.each([
    "participant-wrong-tool",
    "participant-wrong-namespace",
    "participant-wrong-thread",
    "participant-duplicate-call",
    "participant-raw-wrong-function",
  ])("rejects undeclared callback authority in %s", async (scenario) => {
    const f = await fixture(scenario);
    delete f.options.env!.NODE_OPTIONS;
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      tool: {
        name: "humanish_ui",
        description: "Synthetic UI.",
        inputSchema: { type: "object" },
        call: async () => JSON.stringify({ ok: true }),
      },
    };
    const session = createRestrictedCodexSession(f.options);
    try {
      expect(await session.run({ ...request, model: undefined })).toMatchObject({
        status: "failed",
        errorCode: "codex_tool_call",
        dispatched: true,
      });
    } finally {
      await session.close();
    }
  });

  // One case per toolPolicyViolation rule. Each offending event arrives after the turn/start
  // reply, where the session used to repeat the check; onNotification is now the only one.
  it.each([
    ["a raw item type the profile does not allow", "analyst-raw-exec", false],
    ["a custom tool other than exec", "participant-raw-wrong-custom-tool", true],
    ["a function other than wait", "participant-raw-wrong-function", true],
    ["an asynchronous agent message", "async-question", false],
    ["an agent message that asks a question", "questions-without-async", false],
  ] as const)(
    "refuses %s through the single tool-policy check",
    async (_rule, scenario, participant) => {
      const f = await fixture(scenario);
      if (participant) {
        delete f.options.env!.NODE_OPTIONS;
        f.options.participant = {
          authMode: "operator",
          reasoningEffort: "high",
          tool: {
            name: "humanish_ui",
            description: "Synthetic UI.",
            inputSchema: { type: "object" },
            call: async () => JSON.stringify({ ok: true }),
          },
        };
      }
      const session = createRestrictedCodexSession(f.options);
      try {
        expect(
          await session.run(participant ? { ...request, model: undefined } : request),
        ).toMatchObject({
          status: "failed",
          errorCode: "codex_tool_call",
          dispatched: true,
        });
      } finally {
        await session.close();
      }
    },
  );

  it("cancels while a host callback is pending without waiting for that callback", async () => {
    const f = await fixture("participant-success"),
      controller = new AbortController();
    delete f.options.env!.NODE_OPTIONS;
    let markCalled!: () => void;
    const called = new Promise<void>((resolve) => {
      markCalled = resolve;
    });
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      tool: {
        name: "humanish_ui",
        description: "Synthetic UI.",
        inputSchema: { type: "object" },
        call: () => {
          markCalled();
          return new Promise<string>(() => undefined);
        },
      },
    };
    const session = createRestrictedCodexSession(f.options);
    const pending = session.run({ ...request, model: undefined, signal: controller.signal });
    await called;
    controller.abort();
    expect(await pending).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
      dispatched: true,
    });
    expect(await session.close()).toBe(true);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("exposes active-turn usage once and clears it before the terminal result resolves", async () => {
    const f = await fixture("participant-usage-before-tool");
    delete f.options.env!.NODE_OPTIONS;
    let finishTool!: (value: string) => void;
    const waitingTool = new Promise<string>((resolve) => {
      finishTool = resolve;
    });
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      tool: {
        name: "humanish_ui",
        description: "Synthetic UI.",
        inputSchema: { type: "object" },
        call: () => waitingTool,
      },
    };
    const session = createRestrictedCodexSession(f.options);
    const pending = session.run({ ...request, model: undefined });
    await vi.waitFor(
      () =>
        expect(session.pendingUsage).toEqual({
          input: 2957,
          output: 41,
          cachedInput: 0,
          cacheWriteInput: 0,
        }),
      AFTER_SPAWN,
    );
    finishTool(
      JSON.stringify({ acknowledgments: [], imageUrl: "data:image/png;base64,c3ludGhldGlj" }),
    );
    expect(await pending).toMatchObject({
      status: "completed",
      usage: { input: 2957, output: 41 },
    });
    expect(session.pendingUsage).toBeUndefined();
    expect(await session.close()).toBe(true);
  });

  it("keeps each native inference separate while retaining the cumulative turn usage", async () => {
    const f = await fixture("participant-multi-usage");
    delete f.options.env!.NODE_OPTIONS;
    let finishTool!: (value: string) => void;
    const waitingTool = new Promise<string>((resolve) => {
      finishTool = resolve;
    });
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      tool: {
        name: "humanish_ui",
        description: "Synthetic UI.",
        inputSchema: { type: "object" },
        call: () => waitingTool,
      },
    };
    const session = createRestrictedCodexSession(f.options),
      pending = session.run({ ...request, model: undefined });
    const perInference = [
      { input: 150000, output: 100, cachedInput: 0, cacheWriteInput: 0 },
      { input: 150000, output: 100, cachedInput: 0, cacheWriteInput: 0 },
    ];
    await vi.waitFor(
      () => expect(session.pendingInferenceUsage).toEqual(perInference),
      AFTER_SPAWN,
    );
    expect(session.pendingUsage).toEqual({
      input: 300000,
      output: 200,
      cachedInput: 0,
      cacheWriteInput: 0,
    });
    finishTool(
      JSON.stringify({ acknowledgments: [], imageUrl: "data:image/png;base64,c3ludGhldGlj" }),
    );
    expect(await pending).toMatchObject({
      status: "completed",
      usage: { input: 300000, output: 200 },
      inferenceUsage: perInference,
    });
    expect(session.pendingInferenceUsage).toBeUndefined();
    expect(await session.close()).toBe(true);
  });

  it("rejects turn completion while a host tool response is still outstanding", async () => {
    const f = await fixture("participant-premature-completion");
    delete f.options.env!.NODE_OPTIONS;
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      tool: {
        name: "humanish_ui",
        description: "Synthetic UI.",
        inputSchema: { type: "object" },
        call: () => new Promise<string>(() => undefined),
      },
    };
    const session = createRestrictedCodexSession(f.options);
    expect(await session.run({ ...request, model: undefined })).toMatchObject({
      status: "failed",
      errorCode: "codex_protocol_error",
      dispatched: true,
    });
    expect(await session.close()).toBe(true);
  });

  // Only the deadline's clock is fake. The fake app-server waits for a gate file before the tool
  // request and before completing, so model time is exactly what the test advances: 600 ms before
  // the tool call and `afterToolMs` after it, against a 700 ms deadline.
  async function runAcrossToolResponse(afterToolMs: number) {
    const f = await fixture("participant-deadline-reset");
    delete f.options.env!.NODE_OPTIONS;
    f.options.participant = {
      authMode: "operator",
      reasoningEffort: "high",
      tool: {
        name: "humanish_ui",
        description: "Synthetic UI.",
        inputSchema: { type: "object" },
        call: async () =>
          JSON.stringify({
            acknowledgments: [],
            imageUrl: "data:image/png;base64,c3ludGhldGlj",
          }),
      },
    };
    const session = createRestrictedCodexSession(f.options);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const pending = session.run({ ...request, model: undefined, timeoutMs: 700 });
      await untilTraced(f.entries, (entry) => entry.method === "turn/start");
      vi.advanceTimersByTime(600);
      await writeFile(`${f.trace}.request-tool`, "");
      await untilTraced(f.entries, (entry) => "toolResponse" in entry);
      vi.advanceTimersByTime(afterToolMs);
      await writeFile(`${f.trace}.finish`, "");
      return { session, result: await pending };
    } finally {
      vi.useRealTimers();
    }
  }

  it("starts a fresh inference deadline after a successful host tool response", async () => {
    const { session, result } = await runAcrossToolResponse(600);
    expect(result).toMatchObject({ status: "completed", errorCode: null });
    expect(await session.close()).toBe(true);
  });

  it("still enforces the fresh deadline after a host tool response", async () => {
    const { session, result } = await runAcrossToolResponse(700);
    expect(result).toMatchObject({ status: "timed_out", errorCode: "timeout" });
    expect(await session.close()).toBe(true);
  });
});

// An in-memory app-server that answers from the captures, so a test decides exactly when each line
// reaches the transport: a whole chunk is handed to the stdout listener synchronously.
/** Where the stop lands: before the chunk that carries the completion, or on the task after it. */
type StopTiming = "before the chunk" | "after the chunk";

async function memorySession(stop: StopTiming) {
  const directory = await mkdtemp(path.join(tmpdir(), "humanish-codex-memory-"));
  directories.push(directory);
  const authHome = path.join(directory, "auth"),
    tempRoot = path.join(directory, "temp");
  await mkdir(authHome);
  await mkdir(tempRoot);
  await writeFile(path.join(authHome, "auth.json"), "synthetic-original-login", { mode: 0o600 });
  const fixtures = path.dirname(fake);
  const capture = async (name: string): Promise<Trace> =>
    JSON.parse(await readFile(path.join(fixtures, name), "utf8")) as Trace;
  const [init, config, account, thread, turn, mcp, events] = await Promise.all(
    [
      "initialize.json",
      "effective-config.json",
      "account-read-projection.json",
      "thread-start.json",
      "turn-start.json",
      "mcp-status.json",
      "completed-turn-and-usage.json",
    ].map(capture),
  );
  const controller = new AbortController();
  const spawnFn: RestrictedCodexSpawn = (_file, args, settings) => {
    const stdout = new PassThrough();
    const deliver = (lines: unknown[]) =>
      stdout.emit("data", Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")));
    const closed = () =>
      setImmediate(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
    const home = String(settings.env?.HOME),
      cwd = String(settings.cwd);
    const map = (value: unknown): Trace =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll("/private/probe/home", home)
          .replaceAll("/private/probe/cwd", cwd),
      ) as Trace;
    const answer = (message: Trace): void => {
      const reply = (result: unknown) => setImmediate(() => deliver([{ id: message.id, result }]));
      if (message.method === "initialize")
        reply({
          ...init,
          codexHome: home,
          platformOs: process.platform === "darwin" ? "macos" : "linux",
        });
      else if (message.method === "config/read") reply(map(config));
      else if (message.method === "account/read") reply(account);
      else if (message.method === "thread/start") reply(map(thread));
      else if (message.method === "mcpServerStatus/list") reply(mcp);
      else if (message.method === "turn/interrupt") reply({});
      else if (message.method === "turn/start")
        setImmediate(() => {
          // The acknowledgment, final answer, usage and completion arrive in one chunk.
          const find = (method: string) =>
            map((events as unknown as Trace[]).find((event) => event.method === method));
          if (stop === "before the chunk") controller.abort();
          deliver([
            { id: message.id, result: map(turn) },
            find("item/completed"),
            find("thread/tokenUsage/updated"),
            find("turn/completed"),
          ]);
          if (stop === "after the chunk") setImmediate(() => controller.abort());
        });
    };
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean))
          answer(JSON.parse(line) as Trace);
        callback();
      },
      final(callback) {
        closed();
        callback();
      },
    });
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      pid: 424242,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: () => {
        closed();
        return true;
      },
    });
    if (args[0] === "--version")
      setImmediate(() => {
        stdout.emit("data", Buffer.from("codex-cli 0.157.1\n"));
        closed();
      });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const session = createRestrictedCodexSession({
    executable: process.execPath,
    authHome,
    tempRoot,
    spawnFn,
    env: { HOME: directory, CODEX_HOME: authHome, PATH: process.env.PATH },
  });
  return { session, signal: controller.signal };
}

describe("restricted Codex session scheduling", () => {
  // The acknowledgment, final answer, usage and completion arrive in one chunk (Codex's
  // reproduction from the #1132 review). What a caller relies on is which side of that chunk a
  // stop lands, not how many microtasks after it.
  it("keeps the answer when the stop comes on the task after the chunk that completed the turn", async () => {
    const { session, signal } = await memorySession("after the chunk");
    try {
      expect(await session.run({ ...request, signal })).toMatchObject({
        status: "completed",
        errorCode: null,
        dispatched: true,
        usageComplete: true,
      });
    } finally {
      await session.close();
    }
  });

  it("cancels the turn when the stop comes before the chunk that would complete it", async () => {
    const { session, signal } = await memorySession("before the chunk");
    try {
      expect(await session.run({ ...request, signal })).toMatchObject({
        status: "cancelled",
        dispatched: true,
      });
    } finally {
      await session.close();
    }
  });
});

// Paths the session split (restricted-launch.ts) moved that no earlier test pinned. Each case
// fails if the refusal, receipt or teardown it names changes.
describe("restricted Codex session launch and teardown receipts", () => {
  /** The fixture's spawn, recording each child so a test can see whether teardown closed it. */
  function recordingSpawn(base: RestrictedCodexSpawn, children: ChildProcessWithoutNullStreams[]) {
    const spawnFn: RestrictedCodexSpawn = (file, args, settings) => {
      const child = base(file, args, settings);
      children.push(child);
      return child;
    };
    return spawnFn;
  }

  it("refuses a relative auth home as unsupported auth, before any login check", async () => {
    const f = await fixture();
    const session = createRestrictedCodexSession({ ...f.options, authHome: "relative-auth-home" });
    expect(await session.run(request)).toMatchObject({
      errorCode: "codex_unsupported_auth",
      dispatched: false,
    });
    expect(await session.close()).toBe(true);
  });

  it("closes the app-server when initialize is refused, and refuses every later request", async () => {
    const f = await fixture("initialize-version-mismatch");
    const children: ChildProcessWithoutNullStreams[] = [];
    const session = createRestrictedCodexSession({
      ...f.options,
      spawnFn: recordingSpawn(f.options.spawnFn!, children),
    });
    expect(await session.run(request)).toMatchObject({
      errorCode: "codex_unsupported_version",
      failurePhase: "initialize",
    });
    const appServer = children.at(-1)!;
    await vi.waitFor(
      () => expect(appServer.exitCode !== null || appServer.signalCode !== null).toBe(true),
      AFTER_SPAWN,
    );
    // Teardown closed the session: no second launch.
    expect(await session.run(request)).toMatchObject({ errorCode: "invalid_request" });
    expect(children).toHaveLength(2); // the version check and the one app-server
    expect(await session.close()).toBe(true);
  });

  it("names config/read as the phase of a refused configuration", async () => {
    const f = await fixture("system-config");
    expect(await f.run(request)).toMatchObject({
      errorCode: "codex_unsafe_configuration",
      failurePhase: "config/read",
    });
  });

  it("reports the deadline's cancellation over a plain error thrown after the stop", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const base = f.options.spawnFn!;
    const session = createRestrictedCodexSession({
      ...f.options,
      spawnFn: (file, args, settings) => {
        if (args[0] !== "app-server") return base(file, args, settings);
        controller.abort();
        throw new Error("synthetic spawn failure");
      },
    });
    expect(await session.run({ ...request, signal: controller.signal })).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
    });
    expect(await session.close()).toBe(true);
  });

  it("reports cleanup_failed in the cleanup phase when a failed request cannot be torn down", async () => {
    const f = await fixture("initialize-version-mismatch");
    const base = f.options.spawnFn!;
    const session = createRestrictedCodexSession({
      ...f.options,
      spawnFn: (file, args, settings) => {
        if (args[0] === "app-server") {
          // Replace the private home's auth link with a file, as an unexpected login rotation does.
          const link = path.join(String(settings.env?.HOME), "auth.json");
          rmSync(link);
          writeFileSync(link, "synthetic-rotated-login", { mode: 0o600 });
        }
        return base(file, args, settings);
      },
    });
    expect(await session.run(request)).toMatchObject({
      errorCode: "codex_cleanup_failed",
      failurePhase: "cleanup",
    });
    expect(await session.close()).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps a task directory it could not remove and writes a recovery marker for it",
    async () => {
      const f = await fixture("initialize-version-mismatch");
      const base = f.options.spawnFn!;
      const session = createRestrictedCodexSession({
        ...f.options,
        spawnFn: (file, args, settings) => {
          // The task directory can no longer be removed from its parent.
          if (args[0] === "app-server") chmodSync(f.tempRoot, 0o500);
          return base(file, args, settings);
        },
      });
      try {
        expect(await session.run(request)).toMatchObject({
          errorCode: "codex_cleanup_failed",
          failurePhase: "cleanup",
        });
        const markers = path.join(f.directory, "cache", "humanish", "codex-analysis-recovery");
        const [marker] = await readdir(markers);
        expect(JSON.parse(await readFile(path.join(markers, marker!), "utf8"))).toMatchObject({
          schema: "humanish.codex-auth-recovery.v1",
          reason: "process_cleanup_unconfirmed",
        });
      } finally {
        chmodSync(f.tempRoot, 0o700);
      }
    },
  );
});

// Reads of host-supplied objects keep their old order and timing. The Codex equivalence review of
// the session split found each of these changed by an earlier draft of it.
describe("restricted Codex session host reads", () => {
  const tool = {
    name: "humanish_ui",
    description: "Synthetic participant tool.",
    inputSchema: { type: "object", properties: {} },
    call: async () => "ok",
  };
  const participantRequest = { ...request, model: undefined };
  /** A participant-mode session on the fake app-server, whose tool comes from `getTool`. */
  async function participantSession(getTool: () => typeof tool) {
    const f = await fixture("participant-success");
    const session = createRestrictedCodexSession({
      ...f.options,
      env: { ...f.options.env, HOME: f.directory, CODEX_HOME: f.authHome, NODE_OPTIONS: undefined },
      participant: {
        authMode: "operator",
        reasoningEffort: "high",
        get tool() {
          return getTool();
        },
      },
    });
    return { f, session };
  }

  it("checks busy when admission reaches it, after the participant's tool is read", async () => {
    let started = false,
      nested: Promise<unknown> | undefined;
    // A tool getter that starts a request of its own while the first is being admitted.
    const { session } = await participantSession(() => {
      if (!started) {
        started = true;
        nested = session.run(participantRequest, true);
      }
      return tool;
    });
    expect(await session.run(participantRequest, true)).toMatchObject({
      errorCode: "codex_busy",
    });
    expect(await nested).toMatchObject({ status: "completed", errorCode: null });
    await session.close();
  });
});

describe("restricted Codex notifications outside a turn", () => {
  it("refuses the next request after a disallowed item arrives between requests", async () => {
    const f = await fixture("continuing-idle-item"),
      session = createRestrictedCodexSession(f.options);
    expect(await session.run(request)).toMatchObject({ status: "completed" });
    expect(session.unreportedRefusal).toBeUndefined();
    await writeFile(`${f.trace}.idle-item`, "");
    await vi.waitFor(() => expect(session.unreportedRefusal).toBe("codex_tool_call"), AFTER_SPAWN);
    expect(await session.run(request)).toMatchObject({
      errorCode: "codex_tool_call",
      dispatched: false,
    });
    expect(session.unreportedRefusal).toBeUndefined();
    expect((await f.entries()).filter((entry) => entry.method === "turn/start")).toHaveLength(1);
    expect(await session.close()).toBe(true);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("keeps a refusal between requests when the next request's cleanup fails", async () => {
    const f = await fixture("continuing-idle-item");
    const base = f.options.spawnFn!;
    let home: string | undefined;
    const session = createRestrictedCodexSession({
      ...f.options,
      spawnFn: (file, args, settings) => {
        if (args[0] === "app-server") home = String(settings.env?.HOME);
        return base(file, args, settings);
      },
    });
    expect(await session.run(request)).toMatchObject({ status: "completed" });
    await writeFile(`${f.trace}.idle-item`, "");
    await vi.waitFor(() => expect(session.unreportedRefusal).toBe("codex_tool_call"), AFTER_SPAWN);
    // An unexpected login rotation makes the teardown after the refused request fail.
    rmSync(path.join(home!, "auth.json"));
    writeFileSync(path.join(home!, "auth.json"), "synthetic-rotated-login", { mode: 0o600 });
    expect(await session.run(request)).toMatchObject({ errorCode: "codex_cleanup_failed" });
    expect(session.unreportedRefusal).toBe("codex_tool_call");
  });

  it("records a server request between requests, and the next request reports it", async () => {
    const f = await fixture("continuing-idle-request"),
      session = createRestrictedCodexSession(f.options);
    expect(await session.run(request)).toMatchObject({ status: "completed" });
    await writeFile(`${f.trace}.idle-request`, "");
    await vi.waitFor(() => expect(session.unreportedRefusal).toBe("codex_tool_call"), AFTER_SPAWN);
    expect(await session.run(request)).toMatchObject({
      errorCode: "codex_tool_call",
      dispatched: false,
    });
    expect(session.unreportedRefusal).toBeUndefined();
    expect(await session.close()).toBe(true);
  });

  it("fails a completed one-shot request when a disallowed item arrives during close", async () => {
    const f = await fixture("close-item-after-answer");
    expect(await f.run(request)).toMatchObject({
      status: "failed",
      errorCode: "codex_tool_call",
      dispatched: true,
      output: null,
    });
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("records a disallowed item that arrives while the session closes", async () => {
    const f = await fixture("close-item"),
      session = createRestrictedCodexSession(f.options);
    const pending = session.run(request);
    await vi.waitFor(
      async () => expect((await f.entries()).some((e) => e.method === "turn/start")).toBe(true),
      AFTER_SPAWN,
    );
    expect(await session.close()).toBe(true);
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect((await f.entries()).some((entry) => entry.method === "turn/interrupt")).toBe(true);
    expect(session.unreportedRefusal).toBe("codex_tool_call");
    expect(await readdir(f.tempRoot)).toEqual([]);
  });
});
