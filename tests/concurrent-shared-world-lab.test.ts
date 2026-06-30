import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorCompletionReason, type ActorStatus, type ActorTrace } from "../src/actor-contract.js";
import type { CuaActorSessionOptions } from "../src/computer-use-actor.js";
import type { CuaLoopResult } from "../src/computer-use.js";
import type { E2BDesktopCreateOptions, E2BDesktopModule, E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";
import { concurrentSharedWorldValidationReason, LAB_CONFIG_SCHEMA, parseLabConfig, routesToConcurrentSharedWorld, type LabConfig } from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import { runConcurrentSharedWorld } from "../src/concurrent-shared-world-lab.js";
import type { SharedWorldLabHooks } from "../src/shared-world-lab.js";
import type { BrowserLabScoringContext, RunAdapterScore, RunBundle } from "../src/index.js";
import { verifyRun } from "../src/run.js";
import { serveObserver, type ObserverResult, type ObserverServer } from "../src/observer.js";

// ---------------------------------------------------------------------------
// Fakes for the N+1 substrate. The module records create/kill BY id and exposes
// NO `list` (enumerate-and-kill is impossible by construction). Each fake sandbox
// has getHost(port) → a BARE tokenless host keyed on its id (no scheme, exactly as
// the real @e2b SDK returns it — the orchestrator normalizes it to https://). The command handler drives
// the detached primitive (provisioning + checkpoints) and returns STATEFUL
// checkpoint output (a shared worldVersion the fake runSession bumps per turn).
//
// FIX-1: overlap is PRODUCED, not injected. The fake runSession blocks on a
// RENDEZVOUS LATCH until all N actors have entered, so N lane fns are genuinely
// in-flight while the REAL orchestrator clock (Date.now — NOT overridden) measures
// the wrapped [start,end] laneWindows. The windows therefore overlap for real.
// ---------------------------------------------------------------------------

interface FakeSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
}

function browserTargetFromCalls(calls: Array<[string, ...unknown[]]>): string | undefined {
  for (const call of calls) {
    if (call[0] === "open") return String(call[1]);
    if (call[0] !== "commands.run") continue;
    const target = String(call[1]).match(/^target_url='([^']+)'$/m)?.[1];
    if (target) return target;
  }
  return undefined;
}

function makeFakeSandbox(id: string, commandHandler: (command: string) => { stdout?: string } | undefined): FakeSandbox {
  const calls: Array<[string, ...unknown[]]> = [];
  const sandbox = {
    calls,
    sandboxId: id,
    commands: {
      run: async (command: string) => {
        calls.push(["commands.run", command]);
        return commandHandler(command) ?? { exitCode: 0, stdout: "" };
      }
    },
    files: {
      write: async (filePath: string, data: string | ArrayBuffer) => {
        calls.push(["files.write", filePath, String(data)]);
        return undefined;
      }
    },
    launch: async (application: string, uri?: string) => { calls.push(["launch", application, uri]); },
    open: async (fileOrUrl: string) => { calls.push(["open", fileOrUrl]); },
    getHost: (port: number) => `${port}-${id}.e2b.app`, // BARE host (no scheme) — matches the real @e2b SDK
    async screenshot() { return new Uint8Array([1, 2, 3, 4]); },
    async wait(ms: number) { calls.push(["wait", ms]); },
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async (options?: unknown) => { calls.push(["stream.start", options]); }
    }
  };
  return sandbox as unknown as FakeSandbox;
}

function makeFakeModule(commandHandler: (command: string) => { stdout?: string } | undefined): {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
  sandboxes: FakeSandbox[];
} {
  const created: E2BDesktopCreateOptions[] = [];
  // Parallel to `created`: the custom template each create() got — subject AND every actor sandbox.
  // undefined == called with NO template arg (the byte-stable default).
  const templates: (string | undefined)[] = [];
  const killed: string[] = [];
  const sandboxes: FakeSandbox[] = [];
  let n = 0;
  const module: E2BDesktopModule = {
    Sandbox: {
      // Mirror the real @e2b/desktop overload: create(opts) OR create(template, opts).
      create: async (templateOrOptions: string | E2BDesktopCreateOptions, maybeOptions?: E2BDesktopCreateOptions) => {
        const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
        const createOptions = typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
        n += 1;
        const sandbox = makeFakeSandbox(`fake-sandbox-${String(n).padStart(3, "0")}`, commandHandler);
        templates.push(template);
        created.push(createOptions);
        sandboxes.push(sandbox);
        return sandbox;
      },
      kill: async (sandboxId) => { killed.push(sandboxId); return undefined; }
      // NOTE: NO `list` method.
    }
  };
  return { module, created, templates, killed, sandboxes };
}

function makeCommandHandler(state: { worldVersion: number }): (command: string) => { stdout?: string } | undefined {
  return (command: string): { stdout?: string } | undefined => {
    if (command.includes("/status")) return { stdout: "0" };
    if (command.includes("rev-parse")) return { stdout: "abc123def4567890abc1\n" };
    if (command.includes("curl")) return { stdout: "READY" };
    if (command.includes("checkpoint-") && command.includes("tail -c")) return { stdout: `world=${state.worldVersion}\n` };
    if (command.includes("find_chrome_window")) return { stdout: "WINDOW_ID=424242\n" };
    if (command.includes("tail -c")) return { stdout: "" };
    return undefined;
  };
}

/** A rendezvous latch: the returned fn blocks until `count` callers have entered, then releases
 *  them all — so `count` lane fns are genuinely in-flight at once (real overlap). */
function makeRendezvous(count: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    await gate;
  };
}

async function waitForCondition(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeTrace(args: { persona: { id: string; traitsApplied: string[]; promptDigest: string }; status: ActorStatus; completionReason: ActorCompletionReason; actions: number; messages: number; reason?: string }): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "fake-cua",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: args.persona,
    redaction: { status: "passed", screenshots: "n/a", notes: "fake trace (no frames captured)" },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    status: args.status,
    completionReason: args.completionReason,
    reason: args.reason ?? `${args.status} (${args.completionReason})`,
    ids: {},
    counts: { actions: args.actions, messages: args.messages, screenshots: 0 },
    items: [
      ...(args.messages > 0 ? [{ id: "i-msg", kind: "message" as const, lifecycle: "completed" as const, title: "message", text: "did my task" }] : []),
      ...(args.actions > 0 ? [{ id: "i-act", kind: "ui_action" as const, lifecycle: "completed" as const, title: "click" }] : [])
    ],
    capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: true, byoModel: false, preGrantableApprovals: false, inProcessTools: false, license: "proprietary" }
  };
}

/** A runSession fake: rendezvous (real overlap) → bump the shared world → engaged passed trace,
 *  unless a per-call override (harness throw / mission failure) applies. */
function makeRunSession(
  state: { worldVersion: number },
  rendezvous: () => Promise<void>,
  override?: (index: number) => { throwMessage?: string; status?: ActorStatus; completionReason?: ActorCompletionReason; reason?: string } | undefined
): (options: CuaActorSessionOptions) => Promise<CuaLoopResult> {
  let index = -1;
  return async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
    index += 1;
    const myIndex = index;
    await rendezvous(); // all actors are in-flight here → their windows overlap on the real clock
    // All lanes were released together; hold them concurrently for a measurable interval so the
    // REAL orchestrator clock records overlapping [start,end] windows (Date.now is ms-resolution —
    // without this the instant fake collapses every window to a zero-width point). The overlap is
    // genuinely produced (all lanes are in this delay at once), not injected.
    await new Promise<void>((resolve) => { setTimeout(resolve, 15); });
    state.worldVersion += 1; // each actor's turn mutates the shared world
    const o = override?.(myIndex);
    if (o?.throwMessage) {
      throw new Error(o.throwMessage);
    }
    const status = o?.status ?? "passed";
    const completionReason = o?.completionReason ?? "goal_satisfied";
    const trace = makeTrace({ persona: options.persona, status, completionReason, actions: 1, messages: 1, ...(o?.reason === undefined ? {} : { reason: o.reason }) });
    return { status, completionReason, reason: trace.reason, trace };
  };
}

function concurrentConfig(roleCount = 3, concurrency = 3, template?: string): LabConfig {
  const lanes = Array.from({ length: roleCount }, (_unused, i) => ({
    id: `persona-${String(i + 1).padStart(2, "0")}`,
    actorType: i === 0 ? "initiator" : "collaborator",
    surface: i === 0 ? "intake" : "review",
    caseGroup: "case-001",
    persona: `persona-${i + 1}`,
    entry: `/seat-${i + 1}`
  }));
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "concurrent-shared-world-proof",
    title: "Concurrent shared-world proof",
    subject: {
      source: "clone",
      topology: "shared-world",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: { install: "pnpm install", start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [
          { name: "notes-count", command: "psql query notes" },
          { name: "reviews-count", command: "psql query reviews" }
        ]
      }
    },
    actors: [{ type: "openai-computer-use", mission: "Use the shared app.", lanes }],
    execution: {
      target: "e2b-desktop",
      timeoutMs: 60_000,
      concurrency,
      ...(template === undefined ? {} : { desktop: { template } })
    },
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function baseHooks(state: { worldVersion: number }, rendezvous: () => Promise<void>, override?: Parameters<typeof makeRunSession>[2]): {
  hooks: SharedWorldLabHooks;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
  sandboxes: FakeSandbox[];
} {
  const { module, created, templates, killed, sandboxes } = makeFakeModule(makeCommandHandler(state));
  const hooks: SharedWorldLabHooks = {
    env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key", DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" },
    loadDesktopModule: async () => module,
    runSession: makeRunSession(state, rendezvous, override),
    detachedTimers: { now: () => 0, sleep: async () => {} },
    proberCadenceMs: 100_000 // large: no periodic snapshot fires in the fast test (baseline+final carry the gate)
  };
  return { hooks, created, templates, killed, sandboxes };
}

const CONCURRENT_ADAPTER_NAMESPACE = "concurrent-browser-adapter-proof";

function concurrentFailScore(ctx: BrowserLabScoringContext): RunAdapterScore {
  return {
    schema: "mimetic.adapter-score.v1",
    namespace: CONCURRENT_ADAPTER_NAMESPACE,
    status: "fail",
    score: 20,
    summary: `${ctx.backend} adapter found no product-level concurrent success evidence.`,
    data: {
      backend: ctx.backend,
      laneCount: ctx.laneCount
    }
  };
}

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "mimetic-concurrent-sw-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("runConcurrentSharedWorld (the heart: real orchestration + rendezvous latch, $0)", () => {
  it("dry-run produces a verified contract bundle (concurrent shape + attributionClass + limits), no sandboxes", async () => {
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(), dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.subjectSandbox).toBeUndefined();
    expect(result.topologyMode).toBe("concurrent");
    expect(result.roleCount).toBe(3);
    expect(result.concurrency).toBe(3);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.attributionClass).toBe("shared-world");
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.timeline).toBeUndefined();
    expect(bundle.sharedWorld.attributionLimits).toEqual(
      expect.arrayContaining(["concurrent", "best-effort-causal-attribution", "non-deterministic-shared-state", "window-and-snapshot-granularity", "contention-observed-not-proven-safe", "state-change-not-isolated-to-actors"])
    );
    expect(bundle.sharedWorld.attributionLimits).not.toContain("sequential-only");

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("execution.desktop.template: BOTH the subject AND every actor sandbox launch on the template; bundle records it; absent stays byte-stable", async () => {
    // With a custom template: all N+1 creates (subject + N actors) get it.
    const withState = { worldVersion: 0 };
    const withTemplate = baseHooks(withState, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3, "acme-desktop-with-runtimes"), dryRun: false, hooks: withTemplate.hooks });
    expect(result.ok).toBe(true);
    expect(withTemplate.created).toHaveLength(4); // 1 subject + 3 actors
    expect(withTemplate.templates).toHaveLength(4);
    expect(withTemplate.templates.every((t) => t === "acme-desktop-with-runtimes")).toBe(true);
    const withBundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(withBundle.desktopTemplate).toBe("acme-desktop-with-runtimes");

    // Byte-stable default: NO template → every create called with NO template arg, bundle omits it.
    const noState = { worldVersion: 0 };
    const noTemplate = baseHooks(noState, makeRendezvous(3));
    const result2 = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks: noTemplate.hooks });
    expect(result2.ok).toBe(true);
    expect(noTemplate.templates).toHaveLength(4);
    expect(noTemplate.templates.every((t) => t === undefined)).toBe(true);
    const noBundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result2.runId, "run.json"), "utf8"));
    expect(noBundle.desktopTemplate).toBeUndefined();
  });

  it("GOOD run: ONE subject + N actors all torn down BY id (killed==created, N+1), same getHost URL, REAL overlap, state delta, verify ok", async () => {
    const state = { worldVersion: 0 };
    const { hooks, created, killed, sandboxes } = baseHooks(state, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // ONE subject sandbox + 3 actor sandboxes = 4 created; ALL torn down BY exact id (no list).
    expect(created).toHaveLength(4);
    expect(sandboxes).toHaveLength(4);
    expect(created[0]?.metadata?.role).toBe("subject");
    expect(created[0]?.metadata?.topologyMode).toBe("concurrent");
    const createdIds = sandboxes.map((s) => s.sandboxId).sort();
    expect([...killed].sort()).toEqual(createdIds); // killed-set == created-set (N+1)
    expect(result.subjectSandbox).toEqual({ sandboxId: "fake-sandbox-001", killed: true });

    // Subject creds entered ONLY the subject sandbox (FIX-10): actor creates carry no envs.
    expect(created[0]?.envs).toEqual({ DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" });
    for (const createOpts of created.slice(1)) {
      expect(createOpts.envs).toBeUndefined();
    }

    // provisionCloneSubject ran EXACTLY once, on the SUBJECT sandbox only (one git clone written).
    const cloneWrites = sandboxes.flatMap((s) => s.calls).filter(([name, , data]) => name === "files.write" && String(data).includes("git clone"));
    expect(cloneWrites).toHaveLength(1);

    // Every actor ACTUALLY opened the SAME harness-minted getHost URL (FIX-2): one shared plane.
    // (The raw URL appears only in the in-memory fake's recorded calls — never in the bundle.)
    const getHostUrl = `https://3000-fake-sandbox-001.e2b.app`;
    const actorSandboxes = sandboxes.slice(1);
    expect(actorSandboxes).toHaveLength(3);
    for (const actor of actorSandboxes) {
      const opened = browserTargetFromCalls(actor.calls);
      expect(opened, "each actor opens a seat URL").toBeTruthy();
      expect(new URL(opened!).origin).toBe(new URL(getHostUrl).origin);
    }
    // The published bundle records the host as a DIGEST (public-safe), never the raw e2b URL; the
    // raw tokenless URL is surfaced only on the ephemeral result.
    expect(result.host).toBe(getHostUrl);
    const runText = await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8");
    expect(runText).not.toContain("e2b.app");

    const bundle = JSON.parse(runText);
    expect(bundle.simulations.map((sim: { progress: number }) => sim.progress)).toEqual([100, 100, 100]);
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.plane.hostDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.sharedWorld.plane.exposure).toBe("synthetic");

    // PROVEN CONCURRENCY (FIX-1): the laneWindows the REAL clock measured overlap (≥2 in flight).
    const windows = bundle.sharedWorld.laneWindows as Array<{ startedAt: number; endedAt: number; routeHostDigest: string; actorType?: string; surface?: string; caseGroup?: string }>;
    expect(windows).toHaveLength(3);
    expect(windows.map((w) => [w.actorType, w.surface, w.caseGroup])).toEqual([
      ["initiator", "intake", "case-001"],
      ["collaborator", "review", "case-001"],
      ["collaborator", "review", "case-001"]
    ]);
    const overlapping = windows.some((a, i) => windows.some((b, j) => i !== j && a.startedAt < b.endedAt && b.startedAt < a.endedAt));
    expect(overlapping).toBe(true);
    expect(result.overlapProven).toBe(true);
    // Every actor drove EXACTLY the harness-minted host (FIX-2): routeHostDigest == plane.hostDigest.
    for (const w of windows) {
      expect(w.routeHostDigest).toBe(bundle.sharedWorld.plane.hostDigest);
    }

    // A stateSeries delta occurred under load (the world changed; FIX-6).
    const series = bundle.sharedWorld.stateSeries as Array<{ timestamp: number; digest: string }>;
    expect(series.length).toBeGreaterThanOrEqual(2);
    expect(series.some((s, i) => i > 0 && s.digest !== series[i - 1]!.digest)).toBe(true);

    // Per-persona outcomes recorded (the "M of N" headline).
    expect(bundle.sharedWorld.outcomes).toHaveLength(3);
    expect((bundle.sharedWorld.outcomes as Array<{ actorType?: string; surface?: string; caseGroup?: string }>).map((o) => [o.actorType, o.surface, o.caseGroup])).toEqual([
      ["initiator", "intake", "case-001"],
      ["collaborator", "review", "case-001"],
      ["collaborator", "review", "case-001"]
    ]);
    expect((bundle.sharedWorld.outcomes as Array<{ ok: boolean }>).every((o) => o.ok)).toBe(true);

    // verifyRun ok on the GOOD concurrent bundle (incl. the concurrency-on-pass gate).
    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);

    const observerData = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "observer", "observer-data.json"), "utf8"));
    expect(observerData.laneGroups).toEqual([
      expect.objectContaining({ roleId: "persona-01", actorType: "initiator", surface: "intake", caseGroup: "case-001", status: "passed" }),
      expect.objectContaining({ roleId: "persona-02", actorType: "collaborator", surface: "review", caseGroup: "case-001", status: "passed" }),
      expect.objectContaining({ roleId: "persona-03", actorType: "collaborator", surface: "review", caseGroup: "case-001", status: "passed" })
    ]);
    expect(observerData.streams.map((stream: { label: string }) => stream.label).join("\n")).toContain("type:initiator / surface:intake / case:case-001");

    // Per-actor traces written.
    const actorsDir = await readdir(path.join(cwd, ".mimetic", "runs", result.runId, "actors"));
    expect(actorsDir.sort()).toEqual(["stream-001.json", "stream-002.json", "stream-003.json"]);
  });

  it("publishes an attached live Observer while concurrent actors are still running", async () => {
    const state = { worldVersion: 0 };
    const { hooks, sandboxes } = baseHooks(state, async () => {});
    const runId = "concurrent-shared-world-live-observer";
    const runRoot = path.join(cwd, ".mimetic", "runs", runId);
    let actorSessionsStarted = 0;
    let resolveActorsStarted: () => void = () => {};
    const actorsStarted = new Promise<void>((resolve) => { resolveActorsStarted = resolve; });
    let releaseActors: () => void = () => {};
    const actorsReleased = new Promise<void>((resolve) => { releaseActors = resolve; });
    let readyObserver: (ObserverResult & { ok: true }) | undefined;
    let observerServer: ObserverServer | undefined;

    hooks.runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      actorSessionsStarted += 1;
      if (actorSessionsStarted >= 3) {
        resolveActorsStarted();
      }
      await actorsReleased;
      state.worldVersion += 1;
      const trace = makeTrace({ persona: options.persona, status: "passed", completionReason: "goal_satisfied", actions: 1, messages: 1 });
      return { status: "passed", completionReason: "goal_satisfied", reason: trace.reason, trace };
    };

    const runPromise = runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      hooks,
      onObserverReady: async (observer) => {
        readyObserver = observer;
        observerServer = await serveObserver(observer, { port: 0 });
      },
      runId
    });

    try {
      await waitForCondition("observer server", () => observerServer !== undefined);
      await actorsStarted;
      await waitForCondition("all actor sessions started", () => actorSessionsStarted === 3);
      const streamStarts = sandboxes.flatMap((sandbox) =>
        sandbox.calls.filter(([name]) => name === "stream.start")
      );
      expect(streamStarts).toHaveLength(3);
      expect(streamStarts.every(([, options]) => (options as { windowId?: string }).windowId === "424242")).toBe(true);

      const persistedRunText = await readFile(path.join(runRoot, "run.json"), "utf8");
      expect(persistedRunText).not.toContain("fake-auth-key");
      expect(persistedRunText).not.toContain("stream.invalid");

      const persistedObserverDataText = await readFile(path.join(runRoot, "observer", "observer-data.json"), "utf8");
      expect(persistedObserverDataText).not.toContain("fake-auth-key");
      expect(persistedObserverDataText).not.toContain("stream.invalid");
      const persistedObserverData = JSON.parse(persistedObserverDataText) as {
        events: Array<{ type: string }>;
        streams: Array<{ status: string }>;
        summary: { active: number };
      };
      expect(persistedObserverData.summary.active).toBe(3);
      expect(persistedObserverData.streams.map((stream) => stream.status)).toEqual(["running", "running", "running"]);
      expect(persistedObserverData.events.filter((event) => event.type === "actor.running")).toHaveLength(3);

      expect(readyObserver).toBeTruthy();
      expect(observerServer).toBeTruthy();
      const served = await fetch(new URL("observer-data.json", observerServer!.url));
      const servedObserverData = await served.json() as {
        streams: Array<{ embed?: { kind: string; url?: string }; transport: string; url?: string }>;
      };
      expect(servedObserverData.streams).toHaveLength(3);
      expect(servedObserverData.streams.every((stream) => stream.transport === "sse")).toBe(true);
      expect(servedObserverData.streams.every((stream) => stream.embed?.kind === "iframe")).toBe(true);
      expect(servedObserverData.streams.every((stream) => stream.url === "https://stream.invalid/fake-auth-key")).toBe(true);

      releaseActors();
      const result = await runPromise;
      expect(result.ok).toBe(true);

      const finalObserverData = JSON.parse(await readFile(path.join(runRoot, "observer", "observer-data.json"), "utf8")) as {
        summary: { active: number };
        streams: Array<{ status: string }>;
      };
      expect(finalObserverData.summary.active).toBe(0);
      expect(finalObserverData.streams.map((stream) => stream.status)).toEqual(["passed", "passed", "passed"]);
      const finalRunText = await readFile(path.join(runRoot, "run.json"), "utf8");
      expect(finalRunText).not.toContain("fake-auth-key");
      expect(finalRunText).not.toContain("stream.invalid");
    } finally {
      releaseActors();
      await observerServer?.close();
      await runPromise.catch(() => undefined);
    }
  });

  it("threads actor-default and lane-level stopWhen guards into concurrent shared-world actors", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3));
    const config = concurrentConfig(3, 3);
    const actorDefault = { any: [{ id: "actor-done", textIncludes: "Saved" }] };
    const laneOverride = { any: [{ id: "second-done", urlIncludes: "/done" }] };
    config.actors[0]!.stopWhen = actorDefault;
    config.actors[0]!.lanes![1]!.stopWhen = laneOverride;

    const seen: Array<CuaActorSessionOptions["stopWhen"]> = [];
    const runSession = hooks.runSession!;
    hooks.runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      seen.push(options.stopWhen);
      return runSession(options);
    };

    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(3);
    expect(seen).toEqual([actorDefault, laneOverride, actorDefault]);
  });

  it("adapter fail score turns a coherent concurrent shared-world run red while keeping evidence verifiable", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3));
    hooks.score = concurrentFailScore;
    hooks.deriveArtifacts = async (ctx) => {
      await mkdir(path.join(ctx.runDir, "adapter"), { recursive: true });
      await writeFile(
        path.join(ctx.runDir, "adapter", "concurrent-readback.json"),
        `${JSON.stringify({
          schema: "example.concurrent-readback.v1",
          status: "review-required",
          backend: ctx.backend,
          laneCount: ctx.laneCount
        }, null, 2)}\n`,
        "utf8"
      );
      return [{
        schema: "mimetic.adapter-artifact.v1",
        namespace: CONCURRENT_ADAPTER_NAMESPACE,
        label: "Concurrent adapter readback",
        path: "adapter/concurrent-readback.json",
        kind: "state",
        note: "Adapter-owned concurrent shared-world readback."
      }];
    };
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Adapter scorer failed the run");
    expect(result.overlapProven).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore?.namespace).toBe(CONCURRENT_ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.adapterScore?.data?.backend).toBe("concurrent-shared-world");
    expect(bundle.adapterArtifacts?.[0]?.path).toBe("adapter/concurrent-readback.json");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("Adapter scorer failed the run"))).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("fails review when a lane returns a terminal failed actor trace", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3), (index) => (
      index === 1 ? { status: "failed", completionReason: "actor_error" } : undefined
    ));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("2/3 actor(s) reached a terminal, engaged passed session");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("2/3 reached their goal");
    expect(bundle.review.gaps.some((gap) => gap.includes("persona-02"))).toBe(true);
    expect(bundle.sharedWorld?.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roleId: "persona-02", status: "failed", completionReason: "actor_error", ok: false })
      ])
    );
  });

  it("fails review when a lane self-reports a blocker while claiming goal_satisfied", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3), (index) => (
      index === 0
        ? {
            status: "passed",
            completionReason: "goal_satisfied",
            reason: "I cannot complete the approval because the app shows an error: APP_USER_ID is not set."
          }
        : undefined
    ));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.roles[0]?.ok).toBe(false);
    expect(result.roles[0]?.error?.message).toContain("not a credible pass");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("APP_USER_ID is not set"))).toBe(true);
    expect(bundle.events.some((event) =>
      event.level === "warn" && event.message.includes("NOT counted as a pass")
    )).toBe(true);
  });

  it("routes through runLab(sharedWorldHooks) to the concurrent backend", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3));
    const config = concurrentConfig(3, 3);
    expect(selectLabBackend(config)).toBe("concurrent-shared-world");
    const outcome = await runLab(config, { cwd, dryRun: false, sharedWorldHooks: hooks });
    expect(outcome.backend).toBe("concurrent-shared-world");
    if (outcome.backend !== "concurrent-shared-world") return;
    expect(outcome.result.ok).toBe(true);
  });

  it("INDEPENDENT actors (FIX-11): one actor's harness error does NOT block the swarm or suppress overlap", async () => {
    const state = { worldVersion: 0 };
    // Actor index 1 throws AFTER entering the rendezvous (so all 3 windows still overlap).
    const { hooks } = baseHooks(state, makeRendezvous(3), (index) => (index === 1 ? { throwMessage: "boom in actor 1" } : undefined));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

    // The swarm did not run fully coherently → ok false, but the other actors STILL ran (no gate).
    expect(result.ok).toBe(false);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    // All 3 windows + outcomes intact (no pipeline-gate / fail-fast corrupting the "M of N").
    expect(bundle.sharedWorld.laneWindows).toHaveLength(3);
    expect(bundle.sharedWorld.outcomes).toHaveLength(3);
    const windows = bundle.sharedWorld.laneWindows as Array<{ startedAt: number; endedAt: number }>;
    expect(windows.some((a, i) => windows.some((b, j) => i !== j && a.startedAt < b.endedAt && b.startedAt < a.endedAt))).toBe(true);
    // 2 of 3 reached their goal; the failed one is recorded as data, not a swarm-blocker.
    const okCount = (bundle.sharedWorld.outcomes as Array<{ ok: boolean }>).filter((o) => o.ok).length;
    expect(okCount).toBe(2);
  });

  it("literal-scrubs a provisioned value injected into a forced error before persist", async () => {
    const state = { worldVersion: 0 };
    const secret = "opaque-pw-7f3a9c2e-do-not-leak";
    const { hooks } = baseHooks(state, makeRendezvous(3), (index) => (index === 0 ? { throwMessage: `connection failed using ${secret}` } : undefined));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });
    expect(result.ok).toBe(false);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(cwd, ".mimetic", "runs", result.runId, file), "utf8");
      expect(text, file).not.toContain(secret);
    }
  });
});

describe("verifyRun fails closed on each injected concurrent overclaim", () => {
  async function goodBundlePath(): Promise<{ runId: string; bundlePath: string }> {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });
    expect(result.ok).toBe(true);
    const baseline = await verifyRun(cwd, result.runId);
    expect(baseline.ok).toBe(true); // the un-mutated bundle MUST verify (so a failure is attributable)
    return { runId: result.runId, bundlePath: path.join(cwd, ".mimetic", "runs", result.runId, "run.json") };
  }

  async function mutateAndVerify(mutate: (bundle: Record<string, unknown>) => void): Promise<boolean> {
    const { runId, bundlePath } = await goodBundlePath();
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    mutate(bundle);
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    return (await verifyRun(cwd, runId)).ok;
  }

  it("(a) a 'concurrent' bundle whose laneWindows do NOT overlap", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { laneWindows: Array<{ startedAt: number; endedAt: number }> };
      sw.laneWindows.forEach((w, i) => { w.startedAt = i * 1000; w.endedAt = i * 1000 + 10; }); // sequential, no overlap
    });
    expect(ok).toBe(false);
  });

  it("(b) missing best-effort-causal-attribution", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { attributionLimits: string[] };
      sw.attributionLimits = sw.attributionLimits.filter((l) => l !== "best-effort-causal-attribution");
    });
    expect(ok).toBe(false);
  });

  it("(b2) a FORBIDDEN limit present (sequential-only)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { attributionLimits: string[] };
      sw.attributionLimits = [...sw.attributionLimits, "sequential-only"];
    });
    expect(ok).toBe(false);
  });

  it("(c) a value-shaped stateSeries field (allowed-keys tripwire)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { stateSeries: Array<Record<string, unknown>> };
      sw.stateSeries[0]!.rawCount = "42"; // a non-allowed field; the series is digest-only
    });
    expect(ok).toBe(false);
  });

  it("(d) divergent plane provenance across laneWindows", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { laneWindows: Array<Record<string, unknown>> };
      sw.laneWindows[0]!.commit = "deadbeefdeadbeef0000";
    });
    expect(ok).toBe(false);
  });

  it("(e) a PASSED run with no stateSeries delta", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { stateSeries: Array<{ digest: string }> };
      const d = sw.stateSeries[0]!.digest;
      for (const s of sw.stateSeries) s.digest = d; // flatten → no delta
    });
    expect(ok).toBe(false);
  });

  it("(f) a persona with goal_satisfied + zero engagement", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const streams = bundle.streams as Array<{ actor?: { completionReason?: string; counts?: Record<string, number>; items?: unknown[] } }>;
      const stream = streams.find((s) => s.actor)!;
      stream.actor!.completionReason = "goal_satisfied";
      stream.actor!.counts = { actions: 0, messages: 0, screenshots: 0 };
      stream.actor!.items = [];
    });
    expect(ok).toBe(false);
  });

  it("(g) the topologyMode discriminator is enforced (sequential timeline smuggled onto a concurrent bundle)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as Record<string, unknown>;
      sw.timeline = [{ kind: "checkpoint", name: "cp-baseline", digest: "abc123def4567890", deltaFromPrev: false }];
    });
    expect(ok).toBe(false);
  });

  it("(h) an actor that drove a host OTHER than the harness-minted plane (FIX-2 / invariant 2)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { laneWindows: Array<{ routeHostDigest: string }> };
      sw.laneWindows[0]!.routeHostDigest = "ffffffffffffffff"; // a different host than plane.hostDigest
    });
    expect(ok).toBe(false);
  });
});

// --- The committed live-fixture lab: deterministic $0 wiring proof (#164) ----------------------
// Proves the live rung's lab + synthetic fixture are wired correctly BEFORE any spend: the
// committed mimetic/labs/shared-world-concurrent-live.yaml parses, routes to the concurrent
// backend, passes the synthetic/seeded/0.0.0.0 validations, dry-runs to a verified bundle, AND
// drives the REAL orchestrator on the fake N+1 substrate at $0.
describe("committed live-fixture lab (deterministic $0 wiring proof)", () => {
  function loadLiveLab(): LabConfig {
    const raw = parse(readFileSync(path.join(process.cwd(), "mimetic/labs/shared-world-concurrent-live.yaml"), "utf8"));
    const parsed = parseLabConfig(raw);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  it("is well-formed: parses, routes to concurrent, and passes the synthetic/seeded/0.0.0.0 validations", () => {
    const config = loadLiveLab();
    expect(routesToConcurrentSharedWorld(config)).toBe(true);
    expect(selectLabBackend(config)).toBe("concurrent-shared-world");
    expect(concurrentSharedWorldValidationReason(config)).toBeNull();
    expect(config.subject.exposure).toBe("synthetic");
    expect(config.subject.serve?.start).toContain("0.0.0.0");
    expect(config.subject.serve?.start).toContain("mimetic/fixtures/shared-world-app/server.py");
    expect(config.subject.repos).toEqual(["danielgwilson/mimetic-cli"]);
    expect((config.subject.state?.seed ?? []).length).toBeGreaterThan(0);
    expect((config.subject.state?.checkpoint ?? []).length).toBeGreaterThan(0);
    expect(config.actors[0]?.lanes).toHaveLength(3);
    expect(config.actors[0]?.lanes?.map((lane) => [lane.actorType, lane.surface, lane.caseGroup])).toEqual([
      ["planner", "task-board", "board-001"],
      ["coordinator", "task-board", "board-001"],
      ["contributor", "task-board", "board-001"]
    ]);
    expect(config.execution?.concurrency).toBe(3);
  });

  it("dry-runs this exact committed config to a verified concurrent shared-world bundle at $0", async () => {
    const outcome = await runLab(loadLiveLab(), { cwd, dryRun: true });
    expect(outcome.backend).toBe("concurrent-shared-world");
    if (outcome.backend !== "concurrent-shared-world") return;
    expect(outcome.result.ok).toBe(true);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.attributionClass).toBe("shared-world");
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.laneWindows.map((lane: { actorType?: string; surface?: string; caseGroup?: string }) => [lane.actorType, lane.surface, lane.caseGroup])).toEqual([
      ["planner", "task-board", "board-001"],
      ["coordinator", "task-board", "board-001"],
      ["contributor", "task-board", "board-001"]
    ]);
    const observerData = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", outcome.result.runId, "observer", "observer-data.json"), "utf8"));
    expect(observerData.laneGroups.map((lane: { actorType?: string; surface?: string; caseGroup?: string }) => [lane.actorType, lane.surface, lane.caseGroup])).toEqual([
      ["planner", "task-board", "board-001"],
      ["coordinator", "task-board", "board-001"],
      ["contributor", "task-board", "board-001"]
    ]);
    const verify = await verifyRun(cwd, outcome.result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("drives this exact committed config through the REAL orchestrator on a fake N+1 substrate ($0): one plane, real overlap, a state delta, verify ok", async () => {
    const state = { worldVersion: 0 };
    const { hooks, created, killed, sandboxes } = baseHooks(state, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config: loadLiveLab(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    // ONE subject sandbox + 3 actor sandboxes, ALL torn down BY id (N+1).
    expect(created).toHaveLength(4);
    expect([...killed].sort()).toEqual(sandboxes.map((s) => s.sandboxId).sort());
    expect(result.subjectSandbox?.killed).toBe(true);
    expect(result.overlapProven).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.outcomes).toHaveLength(3);
    const series = bundle.sharedWorld.stateSeries as Array<{ digest: string }>;
    expect(series.some((s, i) => i > 0 && s.digest !== series[i - 1]!.digest)).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });
});
