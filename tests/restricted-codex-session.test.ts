import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRestrictedCodexAnalysisReadiness, createRestrictedCodexAnalysisProvider } from "../src/restricted-codex-analysis.js";
import type { RestrictedCodexRequest } from "../src/restricted-codex-policy.js";
import { createRestrictedCodexSession, type RestrictedCodexSessionOptions } from "../src/restricted-codex-session.js";
import type { RestrictedCodexSpawn } from "../src/restricted-codex-transport.js";

const fake = fileURLToPath(new URL("./fixtures/restricted-codex/fake-process.mjs", import.meta.url));
const directories: string[] = [];
const request: RestrictedCodexRequest = {
  model: "gpt-6-astra", instructions: "Review supplied synthetic evidence only.", evidence: "Synthetic study evidence.", images: [],
  schema: { type: "object", additionalProperties: false, required: ["observedCode"], properties: { observedCode: { type: "string" } } },
  maxOutputTokens: null, timeoutMs: 5000
};

type Trace = Record<string, unknown>;
async function fixture(scenario = "success") {
  const directory = await mkdtemp(path.join(tmpdir(), "humanish-codex-test-")); directories.push(directory);
  const authHome = path.join(directory, "auth"), tempRoot = path.join(directory, "temp"), trace = path.join(directory, "calls.jsonl");
  await mkdir(authHome); await mkdir(tempRoot);
  await writeFile(path.join(authHome, "auth.json"), "synthetic-original-login", { mode: 0o600 });
  await writeFile(path.join(authHome, "config.toml"), "SYNTHETIC_HOST_CONFIG_MUST_NOT_BE_IMPORTED");
  const spawns: { args: string[]; env: NodeJS.ProcessEnv; cwd: string; detached: boolean }[] = [];
  const spawnFn: RestrictedCodexSpawn = (_file, args, settings) => {
    spawns.push({ args, env: settings.env ?? {}, cwd: String(settings.cwd), detached: settings.detached });
    return spawn(process.execPath, [fake, scenario, trace, ...args], settings);
  };
  const options: RestrictedCodexSessionOptions = { executable: process.execPath, authHome, tempRoot, spawnFn,
    env: { HOME: directory, CODEX_HOME: authHome, PATH: process.env.PATH, XDG_CACHE_HOME: path.join(directory, "cache"),
      OPENAI_API_KEY: "synthetic-api-key", E2B_API_KEY: "synthetic-desktop-key", AGENTMAIL_API_KEY: "synthetic-mail-key",
      NODE_OPTIONS: "--invalid-option-must-not-reach-child", OPENAI_BASE_URL: "https://example.invalid" } };
  const entries = async (): Promise<Trace[]> => readFile(trace, "utf8").then(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Trace), () => []);
  return { directory, authHome, tempRoot, trace, options, spawns, entries, run: createRestrictedCodexAnalysisProvider(options) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("restricted Codex analyst session", () => {
  it("uses a separate native child, isolated config/auth home, and one strict image/text turn", async () => {
    const f = await fixture();
    const result = await f.run({ ...request, images: [{ evidenceId: "e-image-1", dataUrl: "data:image/png;base64,c3ludGhldGlj" }] });
    expect(result).toMatchObject({ status: "completed", dispatched: true, errorCode: null,
      output: { observedCode: "BLUE-4821", observedColor: "blue" }, usage: { input: 2957, output: 41, cachedInput: 0, cacheWriteInput: 0 }, usageComplete: true });
    expect(f.spawns.map(item => item.args)).toEqual([["--version"], ["app-server", "--strict-config"]]);
    for (const child of f.spawns) {
      expect(child.detached).toBe(false);
      expect(Object.keys(child.env).sort()).toEqual(["CODEX_HOME", "HOME", "PATH", "TMPDIR"]);
      expect(child.env.HOME).not.toBe(f.directory);
      expect(child.cwd).not.toBe(process.cwd());
    }
    const entries = await f.entries(), methods = entries.filter(entry => entry.method).map(entry => entry.method);
    expect(methods.indexOf("config/read")).toBeLessThan(methods.indexOf("thread/start"));
    expect(methods.filter(method => method === "turn/start")).toHaveLength(1);
    const thread = entries.find(entry => entry.method === "thread/start")!.params;
    expect(thread).toMatchObject({ ephemeral: true, experimentalRawEvents: true, environments: [], runtimeWorkspaceRoots: [], dynamicTools: [],
      allowProviderModelFallback: false, model: "gpt-6-astra", modelProvider: "openai", config: {
        "agents.enabled": false, "features.code_mode_host": false, "features.skip_host_skill_discovery": true, "skills.bundled.enabled": false
      } });
    expect(entries.find(entry => entry.method === "turn/start")!.params).toMatchObject({ model: "gpt-6-astra", effort: "low",
      outputSchema: request.schema, environments: [], runtimeWorkspaceRoots: [], sandboxPolicy: { type: "readOnly" } });
    expect(entries.find(entry => entry.imageCount)?.imageFiles).toEqual([expect.objectContaining({ exists: true, mode: 0o600 })]);
    expect(JSON.stringify(entries)).not.toContain("synthetic-api-key");
    expect(await readdir(f.tempRoot)).toEqual([]);
    expect(await readFile(path.join(f.authHome, "auth.json"), "utf8")).toBe("synthetic-original-login");
  });

  it("readiness checks auth/config/thread without a model turn or report", async () => {
    const f = await fixture();
    expect(await checkRestrictedCodexAnalysisReadiness({}, f.options)).toEqual({ ready: true, errorCode: null });
    expect((await f.entries()).some(entry => entry.method === "turn/start")).toBe(false);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("admits a large captured-shape raw image echo without dropping evidence or relaxing final-output bounds", async () => {
    const f = await fixture("large-input-echo");
    const dataUrl = `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024).toString("base64")}`;
    expect(await f.run({ ...request, images: [{ evidenceId: "e-large", dataUrl }] })).toMatchObject({ status: "completed" });
    expect((await f.entries()).find(entry => entry.imageCount)?.imageCount).toBe(1);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("accepts an ordinary structured answer streamed through more than 1,000 text deltas", async () => {
    const f = await fixture("many-deltas");
    expect(await f.run(request)).toMatchObject({ status: "completed", output: { observedCode: "BLUE-4821", summary: "Synthetic finding. ".repeat(1200) } });
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("caps aggregate generated UTF-8 bytes independently of a larger admitted image wire budget", async () => {
    const f = await fixture("aggregate-delta-overflow");
    const dataUrl = `data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024).toString("base64")}`;
    expect(await f.run({ ...request, images: [{ evidenceId: "e-large", dataUrl }] })).toMatchObject({
      status: "failed", errorCode: "response_too_large", output: null, dispatched: true, usageComplete: false
    });
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it.each([
    ["wrong-version", "codex_unsupported_version"], ["api-key-auth", "codex_unsupported_auth"], ["signed-out", "codex_login_required"],
    ["system-config", "codex_unsafe_configuration"], ["mcp-config", "codex_unsafe_configuration"], ["instructions-config", "codex_unsafe_configuration"],
    ["agents-enabled", "codex_unsafe_configuration"], ["code-host-enabled", "codex_unsafe_configuration"], ["provider-config", "codex_unsafe_configuration"],
    ["model-mismatch", "codex_unsafe_configuration"], ["inherited-instructions", "codex_unsafe_configuration"], ["environment-enabled", "codex_unsafe_configuration"],
    ["active-mcp", "codex_unsafe_configuration"]
  ])("rejects %s before model dispatch", async (scenario, code) => {
    const f = await fixture(scenario);
    expect(await f.run(request)).toMatchObject({ status: "failed", output: null, dispatched: false, errorCode: code, usageComplete: false });
    expect((await f.entries()).some(entry => entry.method === "turn/start")).toBe(false);
    if (["system-config", "mcp-config", "instructions-config", "agents-enabled", "code-host-enabled", "provider-config"].includes(scenario))
      expect((await f.entries()).some(entry => entry.method === "thread/start")).toBe(false);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("refuses missing file login, unsupported platform/model and numeric token caps without model dispatch", async () => {
    const f = await fixture();
    for (const overrides of [{ maxOutputTokens: 1000 }, { model: "unqualified-model" }]) {
      const result = await f.run({ ...request, ...overrides });
      expect(result.dispatched).toBe(false); expect(result.status).toBe("failed");
    }
    expect(await createRestrictedCodexAnalysisProvider({ ...f.options, platform: "win32", arch: "x64" })(request)).toMatchObject({ errorCode: "codex_unsupported_platform" });
    expect(await createRestrictedCodexAnalysisProvider({ ...f.options, platform: "linux", arch: "arm64" })(request)).toMatchObject({ errorCode: "codex_unsupported_platform" });
    expect(f.spawns).toHaveLength(0);
    await rm(path.join(f.authHome, "auth.json"));
    expect(await f.run(request)).toMatchObject({ errorCode: "codex_login_required", dispatched: false });
    expect(f.spawns).toHaveLength(1);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it.each([
    ["malformed", "codex_protocol_error"], ["server-request", "codex_tool_call"], ["provider-error", "codex_protocol_error"],
    ["wrong-thread", "codex_protocol_error"], ["wrong-turn", "codex_protocol_error"], ["raw-tool", "codex_tool_call"],
    ["async-question", "codex_tool_call"], ["invalid-json", "invalid_response"], ["multiple-answers", "invalid_response"],
    ["missing-answer", "invalid_response"], ["stdout-large", "response_too_large"], ["stderr-large", "response_too_large"],
    ["event-overflow", "response_too_large"], ["exit-after-dispatch", "codex_process_failed"]
    , ...["missing-item-thread", "missing-item-turn", "missing-usage-thread", "missing-usage-turn", "missing-completion-thread", "missing-completion-id"]
      .map(scenario => [scenario, "codex_protocol_error"])
  ])("fails closed on %s with a safe fixed error and no report", async (scenario, errorCode) => {
    const f = await fixture(scenario), result = await f.run(request);
    expect(result).toMatchObject({ output: null, errorCode, usageComplete: false });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_ERROR_PAYLOAD");
    expect(JSON.stringify(result)).not.toContain(f.directory);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("handles notifications before the turn acknowledgment, without losing the answer", async () => {
    const f = await fixture("early-events");
    expect(await f.run(request)).toMatchObject({ status: "completed", usageComplete: true, output: { observedCode: "BLUE-4821" } });
  });

  it.each(["missing-usage", "invalid-usage"])("keeps %s unknown on an otherwise completed answer", async scenario => {
    const f = await fixture(scenario);
    expect(await f.run(request)).toMatchObject({ status: "completed", usage: null, usageComplete: false });
  });

  it.each(["interrupted", "partial-usage"])("retains partial usage after %s without accepting the answer", async scenario => {
    const f = await fixture(scenario);
    expect(await f.run(request)).toMatchObject({ status: scenario === "interrupted" ? "cancelled" : "failed", output: null,
      usage: { input: 2957, output: 41 }, usageComplete: false, dispatched: true });
  });

  it("pre-abort allocates nothing and does not start a process", async () => {
    const f = await fixture();
    expect(await f.run({ ...request, signal: AbortSignal.abort() })).toMatchObject({ status: "cancelled", dispatched: false });
    expect(f.spawns).toHaveLength(0); expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it.each([["hang-version", "startup"], ["hang-initialize", "initialize"], ["hang-thread-start", "thread/start"],
    ["hang-turn-start", "turn/start"]])("bounds %s and identifies the timed-out phase", async (scenario, failurePhase) => {
    const f = await fixture(scenario), start = performance.now();
    const result = await f.run({ ...request, timeoutMs: 600 });
    expect(result).toMatchObject({ status: "timed_out", errorCode: "timeout", failurePhase, dispatched: scenario === "hang-turn-start" });
    expect(performance.now() - start).toBeLessThan(4000);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it.each(["hang-turn", "lost-turn-ack", "ignore-term"])("interrupts %s and closes the owned native child", async scenario => {
    const f = await fixture(scenario), controller = new AbortController();
    const pending = f.run({ ...request, signal: controller.signal });
    await vi.waitFor(async () => expect((await f.entries()).some(entry => entry.method === "turn/start")).toBe(true));
    const start = performance.now(); controller.abort();
    expect(await pending).toMatchObject({ status: "cancelled", errorCode: "cancelled", dispatched: true, output: null });
    expect(performance.now() - start).toBeLessThan(4000);
    const entries = await f.entries();
    if (scenario === "lost-turn-ack") expect(entries.some(entry => entry.method === "turn/interrupt")).toBe(true);
    for (const entry of entries.filter(entry => typeof entry.pid === "number"))
      expect(() => process.kill(entry.pid as number, 0)).toThrow();
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("isolates simultaneous sessions and readiness calls sharing a login", async () => {
    const first = await fixture("hang-turn"), second = await fixture(), controller = new AbortController();
    second.options.authHome = first.authHome;
    const pending = first.run({ ...request, signal: controller.signal });
    await vi.waitFor(async () => expect((await first.entries()).some(entry => entry.method === "turn/start")).toBe(true));
    expect(await second.run(request)).toMatchObject({ status: "completed", dispatched: true });
    expect(await checkRestrictedCodexAnalysisReadiness({}, second.options)).toEqual({ ready: true, errorCode: null });
    expect(second.spawns[0]!.env.CODEX_HOME).not.toBe(first.spawns[0]!.env.CODEX_HOME);
    controller.abort();
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(await readFile(path.join(first.authHome, "auth.json"), "utf8")).toBe("synthetic-original-login");
    expect(await readdir(first.tempRoot)).toEqual([]);
    expect(await readdir(second.tempRoot)).toEqual([]);
  });

  it("preserves an unexpected auth replacement, original login, and names-only private recovery marker", async () => {
    const f = await fixture("replace-auth");
    const result = await f.run({ ...request, images: [{ evidenceId: "e1", dataUrl: "data:image/png;base64,c3ludGhldGlj" }] });
    expect(result).toMatchObject({ status: "failed", output: null, dispatched: true, errorCode: "codex_cleanup_failed", usageComplete: false });
    expect(await readFile(path.join(f.authHome, "auth.json"), "utf8")).toBe("synthetic-original-login");
    const tasks = await readdir(f.tempRoot); expect(tasks).toHaveLength(1);
    const retained = path.join(f.tempRoot, tasks[0]!);
    expect(await readdir(retained)).toEqual(["home"]);
    expect(await readdir(path.join(retained, "home"))).toEqual(["auth.json"]);
    expect(await readFile(path.join(retained, "home", "auth.json"), "utf8")).toBe("synthetic-rotated-login");
    expect((await stat(retained)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(retained, "home", "auth.json"))).mode & 0o777).toBe(0o600);
    const marker = await readFile(path.join(f.directory, "cache", "humanish", "codex-analysis-recovery", `${tasks[0]}.json`), "utf8");
    expect(JSON.parse(marker)).toMatchObject({ taskDirectoryName: tasks[0], authFileName: "auth.json" });
    expect(marker).not.toContain(f.directory); expect(marker).not.toContain("synthetic-rotated-login");
    expect(JSON.stringify(result)).not.toContain(retained); expect(JSON.stringify(result)).not.toContain("synthetic-rotated-login");
    for (const entry of (await f.entries()).filter(entry => typeof entry.pid === "number"))
      expect(() => process.kill(entry.pid as number, 0)).toThrow();
  });

  it.each(["version", "app-server"])("retains ownership and blocks new work until an unkillable %s child actually closes", async stage => {
    const f = await fixture(stage === "version" ? "hang-version" : "ignore-term"), next = await fixture();
    const spawnOriginal = f.options.spawnFn!;
    let heldChild: ChildProcessWithoutNullStreams | undefined;
    let originalKill: ChildProcessWithoutNullStreams["kill"] | undefined;
    let closed: Promise<void> | undefined;
    f.options.spawnFn = (file, args, settings) => {
      const child = spawnOriginal(file, args, settings);
      if (args[0] === (stage === "version" ? "--version" : "app-server")) {
        heldChild = child; originalKill = child.kill.bind(child);
        closed = new Promise(resolve => child.once("close", () => resolve()));
        child.kill = () => false; // deterministic failure to deliver a signal, not a fake exit
      }
      return child;
    };
    const controller = new AbortController();
    const pending = createRestrictedCodexAnalysisProvider(f.options)({ ...request, signal: controller.signal });
    try {
      await vi.waitFor(async () => expect(stage === "version" ? heldChild !== undefined
        : (await f.entries()).some(entry => entry.method === "turn/start")).toBe(true));
      controller.abort();
      expect(await pending).toMatchObject({ errorCode: "codex_cleanup_failed", output: null });
      const tasks = await readdir(f.tempRoot); expect(tasks).toHaveLength(1);
      expect(await stat(path.join(f.tempRoot, tasks[0]!, "home"))).toBeDefined();
      expect(await next.run(request)).toMatchObject({ errorCode: "codex_busy", dispatched: false });
      expect(await checkRestrictedCodexAnalysisReadiness({}, next.options)).toEqual({ ready: false, errorCode: "codex_busy" });
      expect(next.spawns).toHaveLength(0);
      expect(await readFile(path.join(f.authHome, "auth.json"), "utf8")).toBe("synthetic-original-login");
    } finally {
      originalKill?.("SIGKILL");
      await closed;
      await pending;
    }
    expect(await next.run(request)).toMatchObject({ status: "completed" });
  });
});


describe("continuing restricted Codex conversation", () => {
  it("keeps one home/process/thread beyond eight turns, with fresh images and per-turn usage", async () => {
    const f = await fixture("continuing"), session = createRestrictedCodexSession(f.options);
    try {
      for (let index = 0; index < 12; index++) {
        const result = await session.run({ ...request, evidence: `Observation ${index}`,
          images: [{ evidenceId: `frame-${index}`, dataUrl: "data:image/png;base64,c3ludGhldGlj" }] });
        expect(result).toMatchObject({ status: "completed", usage: { input: 2957, output: 41 }, usageComplete: true });
      }
      const entries = await f.entries();
      for (const method of ["initialize", "account/read", "thread/start"])
        expect(entries.filter(entry => entry.method === method)).toHaveLength(1);
      const turns = entries.filter(entry => entry.method === "turn/start").map(entry => entry.params as Record<string, unknown>);
      expect(turns).toHaveLength(12);
      expect(new Set(turns.map(turn => turn.threadId)).size).toBe(1);
      expect(turns.at(-1)!.input).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Observation 11" })]));
      expect(f.spawns).toHaveLength(2); // version + app-server, not per turn
      expect(await readdir(f.tempRoot)).toHaveLength(1);
    } finally { expect(await session.close()).toBe(true); }
    expect(await readdir(f.tempRoot)).toEqual([]);
    expect(await session.close()).toBe(true);
    expect(await session.run(request)).toMatchObject({ errorCode: "invalid_request", dispatched: false });
  });

  it("continues through captured native compaction while reporting its token counts as partial", async () => {
    const f = await fixture("continuing-compaction"), session = createRestrictedCodexSession(f.options);
    try {
      expect(await session.run(request)).toMatchObject({ status: "completed", usageComplete: true });
      expect(await session.run(request)).toMatchObject({ status: "completed", usageComplete: false,
        usage: { input: 2957, output: 41 } });
      expect(await session.run(request)).toMatchObject({ status: "completed", usageComplete: true,
        usage: { input: 2957, output: 41 } });
      expect((await f.entries()).filter(entry => entry.method === "thread/start")).toHaveLength(1);
    } finally { expect(await session.close()).toBe(true); }
  });

  it("has a fresh request deadline after time spent between completed turns", async () => {
    const f = await fixture("continuing"), session = createRestrictedCodexSession(f.options);
    try {
      expect(await session.run({ ...request, timeoutMs: 500 })).toMatchObject({ status: "completed" });
      await new Promise(resolve => setTimeout(resolve, 550));
      expect(await session.run(request)).toMatchObject({ status: "completed" });
    } finally { await session.close(); }
  });

  it("rejects changed identity without replacing the conversation", async () => {
    const f = await fixture("continuing"), session = createRestrictedCodexSession(f.options);
    try {
      expect(await session.run(request)).toMatchObject({ status: "completed" });
      expect(await session.run({ ...request, instructions: "A different persona" })).toMatchObject({ errorCode: "invalid_request", dispatched: false });
      expect(await session.run(request)).toMatchObject({ status: "completed" });
      expect((await f.entries()).filter(entry => entry.method === "thread/start")).toHaveLength(1);
    } finally { await session.close(); }
  });

  it("close cancels an active continuation and confirms process cleanup", async () => {
    const f = await fixture("continuing-hang"), session = createRestrictedCodexSession(f.options);
    expect(await session.run(request)).toMatchObject({ status: "completed" });
    const pending = session.run(request);
    await vi.waitFor(async () => expect((await f.entries()).filter(entry => entry.method === "turn/start")).toHaveLength(2));
    expect(await session.run(request)).toMatchObject({ errorCode: "codex_busy", dispatched: false });
    const closing = session.close();
    expect(await pending).toMatchObject({ status: "cancelled", dispatched: true });
    expect(await closing).toBe(true);
    expect(await readdir(f.tempRoot)).toEqual([]);
    for (const entry of (await f.entries()).filter(entry => typeof entry.pid === "number"))
      expect(() => process.kill(entry.pid as number, 0)).toThrow();
  });

  it("rejects an earlier turn's output instead of accepting it as the current observation", async () => {
    const f = await fixture("continuing-stale"), session = createRestrictedCodexSession(f.options);
    expect(await session.run(request)).toMatchObject({ status: "completed" });
    expect(await session.run(request)).toMatchObject({ errorCode: "codex_protocol_error", dispatched: true });
    expect(await session.close()).toBe(true);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("does not restart a failed idle process with an empty memory", async () => {
    const f = await fixture("continuing"), session = createRestrictedCodexSession(f.options);
    expect(await session.run(request)).toMatchObject({ status: "completed" });
    const entry = (await f.entries()).find(entry => entry.operation === "app-server")!;
    process.kill(entry.pid as number, "SIGTERM");
    await vi.waitFor(() => expect(() => process.kill(entry.pid as number, 0)).toThrow());
    expect(await session.run(request)).toMatchObject({ errorCode: "codex_process_failed", dispatched: false });
    expect(f.spawns).toHaveLength(2);
    expect(await session.close()).toBe(true);
  });
});

describe("restricted Codex Code Mode participant session", () => {
  it("inherits the operator model, preserves hosted auth, and pauses its deadline while the declared tool runs", async () => {
    const f = await fixture("participant-success"), calls: unknown[] = [];
    f.options.env = { ...f.options.env, HOME: f.directory, CODEX_HOME: f.authHome,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic-keyring", OPENAI_API_KEY: "synthetic-hosted-key", NODE_OPTIONS: undefined };
    f.options.participant = { authMode: "operator", reasoningEffort: "high", tool: {
      name: "humanish_ui", description: "Observe or act on the assigned synthetic desktop.",
      inputSchema: { type: "object", additionalProperties: false, properties: { kind: { const: "observe" } } },
      call: async args => {
        calls.push(args);
        await new Promise(resolve => setTimeout(resolve, 900));
        return JSON.stringify({ acknowledgments: [], imageUrl: "data:image/png;base64,c3ludGhldGlj" });
      }
    } };
    const session = createRestrictedCodexSession(f.options), start = performance.now();
    try {
      const result = await session.run({ ...request, model: undefined, timeoutMs: 800 });
      expect(result).toMatchObject({ status: "completed", output: { observedCode: "BLUE-4821" }, errorCode: null });
      expect(performance.now() - start).toBeGreaterThanOrEqual(850);
      expect(calls).toEqual([{ kind: "observe" }]);
      const appServer = f.spawns.find(entry => entry.args[0] === "app-server")!;
      expect(appServer.env).toMatchObject({ HOME: f.directory, CODEX_HOME: f.authHome,
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic-keyring", OPENAI_API_KEY: "synthetic-hosted-key" });
      expect(appServer.args.some(arg => arg.startsWith("model="))).toBe(false);
      const entries = await f.entries();
      const thread = entries.find(entry => entry.method === "thread/start")!.params as Record<string, unknown>;
      expect(thread).toMatchObject({ model: "operator-configured-model", dynamicTools: [{ type: "function", name: "humanish_ui" }],
        config: { "features.code_mode": true, "features.code_mode_host": true, "features.code_mode_only": true,
          "mcp_servers.\"inherited_synthetic\".enabled": false } });
      expect(entries.find(entry => entry.method === "turn/start")!.params).toMatchObject({ model: "operator-configured-model", effort: "high" });
      expect(entries.find(entry => entry.toolResponse)?.toolResponse).toEqual({ success: true, contentItems: [{ type: "inputText",
        text: JSON.stringify({ acknowledgments: [], imageUrl: "data:image/png;base64,c3ludGhldGlj" }) }] });
    } finally { expect(await session.close()).toBe(true); }
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it.each(["participant-wrong-tool", "participant-wrong-namespace", "participant-wrong-thread", "participant-duplicate-call",
    "participant-raw-wrong-function"])(
    "rejects undeclared callback authority in %s", async scenario => {
      const f = await fixture(scenario);
      delete f.options.env!.NODE_OPTIONS;
      f.options.participant = { authMode: "operator", reasoningEffort: "high", tool: { name: "humanish_ui", description: "Synthetic UI.",
        inputSchema: { type: "object" }, call: async () => JSON.stringify({ ok: true }) } };
      const session = createRestrictedCodexSession(f.options);
      try {
        expect(await session.run({ ...request, model: undefined })).toMatchObject({ status: "failed", errorCode: "codex_tool_call", dispatched: true });
      } finally { await session.close(); }
    });

  it("cancels while a host callback is pending without waiting for that callback", async () => {
    const f = await fixture("participant-success"), controller = new AbortController();
    delete f.options.env!.NODE_OPTIONS;
    let markCalled!: () => void;
    const called = new Promise<void>(resolve => { markCalled = resolve; });
    f.options.participant = { authMode: "operator", reasoningEffort: "high", tool: { name: "humanish_ui", description: "Synthetic UI.",
      inputSchema: { type: "object" }, call: () => { markCalled(); return new Promise<string>(() => undefined); } } };
    const session = createRestrictedCodexSession(f.options);
    const pending = session.run({ ...request, model: undefined, signal: controller.signal });
    await called;
    controller.abort();
    expect(await pending).toMatchObject({ status: "cancelled", errorCode: "cancelled", dispatched: true });
    expect(await session.close()).toBe(true);
    expect(await readdir(f.tempRoot)).toEqual([]);
  });

  it("exposes active-turn usage once and clears it before the terminal result resolves", async () => {
    const f = await fixture("participant-usage-before-tool");
    delete f.options.env!.NODE_OPTIONS;
    let finishTool!: (value: string) => void;
    const waitingTool = new Promise<string>(resolve => { finishTool = resolve; });
    f.options.participant = { authMode: "operator", reasoningEffort: "high", tool: { name: "humanish_ui", description: "Synthetic UI.",
      inputSchema: { type: "object" }, call: () => waitingTool } };
    const session = createRestrictedCodexSession(f.options);
    const pending = session.run({ ...request, model: undefined });
    await vi.waitFor(() => expect(session.pendingUsage).toEqual({ input: 2957, output: 41, cachedInput: 0, cacheWriteInput: 0 }));
    finishTool(JSON.stringify({ acknowledgments: [], imageUrl: "data:image/png;base64,c3ludGhldGlj" }));
    expect(await pending).toMatchObject({ status: "completed", usage: { input: 2957, output: 41 } });
    expect(session.pendingUsage).toBeUndefined();
    expect(await session.close()).toBe(true);
  });

  it("rejects turn completion while a host tool response is still outstanding", async () => {
    const f = await fixture("participant-premature-completion");
    delete f.options.env!.NODE_OPTIONS;
    f.options.participant = { authMode: "operator", reasoningEffort: "high", tool: { name: "humanish_ui", description: "Synthetic UI.",
      inputSchema: { type: "object" }, call: () => new Promise<string>(() => undefined) } };
    const session = createRestrictedCodexSession(f.options);
    expect(await session.run({ ...request, model: undefined })).toMatchObject({ status: "failed",
      errorCode: "codex_protocol_error", dispatched: true });
    expect(await session.close()).toBe(true);
  });

  it("starts a fresh inference deadline after a successful host tool response", async () => {
    const f = await fixture("participant-deadline-reset");
    delete f.options.env!.NODE_OPTIONS;
    f.options.participant = { authMode: "operator", reasoningEffort: "high", tool: { name: "humanish_ui", description: "Synthetic UI.",
      inputSchema: { type: "object" }, call: async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return JSON.stringify({ acknowledgments: [], imageUrl: "data:image/png;base64,c3ludGhldGlj" });
      } } };
    const session = createRestrictedCodexSession(f.options);
    expect(await session.run({ ...request, model: undefined, timeoutMs: 700 })).toMatchObject({ status: "completed", errorCode: null });
    expect(await session.close()).toBe(true);
  });
});
