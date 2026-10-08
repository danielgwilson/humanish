import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { beginRunSignalPhase } from "../../../src/cli/commands/run-signals.js";
import { runStudyWith } from "../../../src/run-study.js";
import { registerActiveRun } from "../../../src/run/active-runs.js";
import { resolveRunPath } from "../../../src/run/locate.js";
import { runIdOf } from "../../../src/run/paths.js";
import { reclaimRunSandboxes } from "../../../src/run/reclaim.js";
import { appendSandboxReceipt } from "../../../src/run/sandbox-receipts.js";
import { parseStudy } from "../../../src/study/config.js";
import { STUDY_SCHEMA } from "../../../src/study/types.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../../src/substrates/e2b/sdk.js";
import { inertDesktopInput } from "../../helpers/inert-desktop-input.js";
import { makeTestTempDir } from "../../helpers/temp-dir.js";

// The E2B SDK names an account by the API key and domain each call carries, and reads
// E2B_API_KEY and E2B_DOMAIN from process.env for a call that carries none. A library caller can
// hold its key only in the run options, so every call after the create has to carry the key the
// create used. A fake @e2b/desktop module stands in for the SDK and records what each call got.

const RUN_KEY = "synthetic-run-account-key";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A fake SDK whose one desktop answers every provisioning step, recording each call's options. */
function recordingSdk() {
  const frame = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  const noop = async (): Promise<void> => {};
  const desktop = {
    sandboxId: "fake-sb-library",
    ...inertDesktopInput(),
    getInfo: async () => ({ cpuCount: 8, memoryMB: 8192 }),
    commands: { run: async () => ({ exitCode: 0, stdout: "" }) },
    files: { write: noop },
    launch: noop,
    open: noop,
    wait: noop,
    screenshot: async () => frame,
    stream: { getAuthKey: () => "k", getUrl: () => "https://stream.invalid/k", start: noop },
  } as unknown as E2BDesktopSandbox;
  const created: E2BDesktopCreateOptions[] = [];
  const kills: { sandboxId: string; options: unknown }[] = [];
  const checks: { sandboxId: string; options: unknown }[] = [];
  const module: E2BDesktopModule = {
    Sandbox: {
      create: async (first: string | E2BDesktopCreateOptions, second?: E2BDesktopCreateOptions) => {
        created.push(typeof first === "string" ? second! : first);
        return desktop;
      },
      kill: async (sandboxId: string, options?: unknown) => {
        kills.push({ sandboxId, options });
        return true;
      },
      getInfo: async (sandboxId: string, options?: unknown) => {
        checks.push({ sandboxId, options });
        throw Object.assign(new Error("sandbox is gone"), { name: "SandboxNotFoundError" });
      },
    },
  };
  return { module, created, kills, checks };
}

function liveStudy() {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "library-key",
    route: "computer-use",
    mode: "live",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actor: { type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore." },
    execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { resolution: [1280, 800] } },
    review: { analysis: false },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function terminalStudy() {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "library-key-terminal",
    route: "terminal",
    mode: "live",
    subject: {
      source: "terminal-product",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] },
    },
    actor: { type: "codex-exec", persona: "autonomous-creative-agent", mission: "Explore." },
    caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 },
    execution: {
      target: "e2b-terminal",
      terminal: { transport: "exec-stream", stdin: "disabled" },
    },
    review: { analysis: false },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/**
 * A library run whose key is only in its options, finished in a new directory: its participant
 * fails after the desktop started, so the route releases the sandbox.
 */
async function finishedRun() {
  const cwd = await makeTestTempDir("humanish-e2b-connection-");
  const sdk = recordingSdk();
  await runStudyWith(
    liveStudy(),
    { cwd, env: { OPENAI_API_KEY: "synthetic-openai", E2B_API_KEY: RUN_KEY } },
    {
      desktopModule: async () => sdk.module,
      runSession: async () => {
        throw new Error("synthetic session failure after the desktop started");
      },
    },
  );
  return { cwd, sdk };
}

describe("a library run's E2B calls", () => {
  it.each([
    ["holds no E2B key", undefined],
    ["holds another account's key", "synthetic-other-account-key"],
  ])(
    "kill the sandbox with the key from the run options when process.env %s",
    async (_case, processKey) => {
      vi.stubEnv("E2B_API_KEY", processKey);
      vi.stubEnv("E2B_DOMAIN", undefined);
      const { sdk } = await finishedRun();
      expect(sdk.created.map((options) => options.apiKey)).toEqual([RUN_KEY]);
      expect(sdk.kills).toEqual([
        { sandboxId: "fake-sb-library", options: expect.objectContaining({ apiKey: RUN_KEY }) },
      ]);
    },
  );

  it.each([
    ["holds no E2B key", undefined],
    ["holds another account's key", "synthetic-other-account-key"],
  ])(
    "check a terminal sandbox after its kill with the key from the run options when process.env %s",
    async (_case, processKey) => {
      vi.stubEnv("E2B_API_KEY", processKey);
      vi.stubEnv("E2B_DOMAIN", undefined);
      const cwd = await makeTestTempDir("humanish-e2b-connection-terminal-");
      const sdk = recordingSdk();
      // The fake shell never prints the readiness marker, so the session stops after the create
      // and the route tears the sandbox down.
      await runStudyWith(
        terminalStudy(),
        { cwd, env: { OPENAI_API_KEY: "synthetic-openai", E2B_API_KEY: RUN_KEY } },
        { desktopModule: async () => sdk.module },
      );
      expect(sdk.created.map((options) => options.apiKey)).toEqual([RUN_KEY]);
      expect(sdk.checks).toEqual([
        { sandboxId: "fake-sb-library", options: expect.objectContaining({ apiKey: RUN_KEY }) },
      ]);
    },
  );
});

describe("reclaim's E2B calls", () => {
  const RUN_DOMAIN = "sandboxes.example.test";

  /** A fake SDK for reclaim that records the options of every list, kill and getInfo. */
  function reclaimSdk() {
    const calls: { method: string; options: unknown }[] = [];
    const module = {
      Sandbox: {
        create: async () => {
          throw new Error("reclaim never creates sandboxes");
        },
        kill: async (_sandboxId: string, options?: unknown) => {
          calls.push({ method: "kill", options });
          return false;
        },
        getInfo: async (_sandboxId: string, options?: unknown) => {
          calls.push({ method: "getInfo", options });
          throw Object.assign(new Error("sandbox is gone"), { name: "SandboxNotFoundError" });
        },
        list: (options?: unknown) => {
          calls.push({ method: "list", options });
          let read = false;
          return {
            get hasNext() {
              return !read;
            },
            nextItems: async () => {
              read = true;
              return [];
            },
          };
        },
      },
    } as unknown as E2BDesktopModule;
    return { module, calls };
  }

  it.each([
    [false, ["kill", "list"]],
    [true, ["getInfo", "list"]],
  ])("carry the key and domain of the env reclaim is given (check=%s)", async (check, methods) => {
    const { cwd } = await finishedRun();
    vi.stubEnv("E2B_API_KEY", undefined);
    vi.stubEnv("E2B_DOMAIN", undefined);
    const sdk = reclaimSdk();
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => sdk.module,
      check,
      env: { E2B_API_KEY: RUN_KEY, E2B_DOMAIN: RUN_DOMAIN },
    });
    expect(result.state).toBe("clean");
    expect(sdk.calls.map((call) => call.method).sort()).toEqual(methods);
    for (const call of sdk.calls)
      expect(call.options).toMatchObject({ apiKey: RUN_KEY, domain: RUN_DOMAIN });
  });

  it("carry the key from process.env, trimmed as the routes trim it, when given no env", async () => {
    const { cwd } = await finishedRun();
    vi.stubEnv("E2B_API_KEY", ` ${RUN_KEY}\n`);
    vi.stubEnv("E2B_DOMAIN", "");
    const sdk = reclaimSdk();
    await reclaimRunSandboxes(cwd, "latest", { loadModule: async () => sdk.module });
    expect(sdk.calls.map((call) => call.method).sort()).toEqual(["kill", "list"]);
    for (const call of sdk.calls) {
      expect(call.options).toMatchObject({ apiKey: RUN_KEY });
      expect(call.options).not.toHaveProperty("domain");
    }
  });

  it("carry the key from process.env when the run command's signal handler stops a run", async () => {
    const { cwd } = await finishedRun();
    const paths = await resolveRunPath(cwd, "latest");
    if (paths === null) throw new Error("the run left no directory");
    // The route released its own sandbox; this one stands for a sandbox the signal cut short.
    await appendSandboxReceipt(paths, { at: "t1", laneId: "lane-01", sandboxId: "fake-sb-cut" });
    vi.stubEnv("E2B_API_KEY", RUN_KEY);
    vi.stubEnv("E2B_DOMAIN", RUN_DOMAIN);
    const sdk = reclaimSdk();
    onTestFinished(
      registerActiveRun({
        cwd,
        runId: runIdOf(paths),
        paths,
        status: { interrupt: async () => true },
      }),
    );
    const signals = new EventEmitter();
    const exit = vi.fn();
    const phase = beginRunSignalPhase(
      { writeErr: () => undefined },
      { signalTarget: signals, exit, reclaim: { loadModule: async () => sdk.module } },
    );
    onTestFinished(phase.end);
    signals.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(sdk.calls.map((call) => call.method).sort()).toEqual(["kill", "list"]);
    for (const call of sdk.calls)
      expect(call.options).toMatchObject({ apiKey: RUN_KEY, domain: RUN_DOMAIN });
  });
});

// The fakes above show what humanish hands the SDK. This shows the installed SDK sends it: a local
// server stands in for the E2B API (E2B_API_URL), and reclaim loads the real @e2b/desktop.
describe("the installed E2B SDK under reclaim", () => {
  async function e2bApiStandIn() {
    const requests: { method: string; path: string; key: string | undefined }[] = [];
    const server = createServer((request, response) => {
      const key = request.headers["x-api-key"];
      requests.push({
        method: request.method ?? "",
        path: (request.url ?? "").split("?")[0] ?? "",
        key: typeof key === "string" ? key : undefined,
      });
      // The kill answers 204 No Content, and the list one page with no sandbox on it.
      if (request.method === "DELETE") response.writeHead(204).end();
      else response.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, requests };
  }

  it("sends the key from reclaim's env on the kill and the list while process.env holds none", async () => {
    const { cwd } = await finishedRun();
    const api = await e2bApiStandIn();
    vi.stubEnv("E2B_API_URL", api.url);
    vi.stubEnv("E2B_API_KEY", undefined);
    vi.stubEnv("E2B_DEBUG", undefined);
    const result = await reclaimRunSandboxes(cwd, "latest", { env: { E2B_API_KEY: RUN_KEY } });
    expect(result.state).toBe("clean");
    expect(result.outcomes.map((outcome) => outcome.state)).toEqual(["killed"]);
    expect(api.requests.sort((a, b) => a.method.localeCompare(b.method))).toEqual([
      { method: "DELETE", path: "/sandboxes/fake-sb-library", key: RUN_KEY },
      { method: "GET", path: "/v2/sandboxes", key: RUN_KEY },
    ]);
  });
});
