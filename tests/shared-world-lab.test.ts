import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorCompletionReason, type ActorStatus, type ActorTrace } from "../src/actor-contract.js";
import type { CuaActorSessionOptions } from "../src/computer-use-actor.js";
import type { CuaLoopResult } from "../src/computer-use.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox
} from "../src/e2b-desktop-launch.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig, type LabDesktopBrowser } from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import { runSharedWorldLab, type SharedWorldLabHooks } from "../src/shared-world-lab.js";
import type { BrowserLabScoringContext, RunAdapterScore, RunBundle } from "../src/index.js";
import { verifyRun } from "../src/run.js";

// ---------------------------------------------------------------------------
// Fakes. The desktop module records create/kill BY id and exposes NO `list`
// method — so enumerate-and-kill is impossible by construction (the 2026-06-16
// prod-incident rail). The command handler drives the detached primitive
// (provisioning + checkpoints) and returns STATEFUL checkpoint output: a shared
// `worldVersion` is bumped by each runSession (a turn mutates state), so the
// checkpoint digest changes across snapshots and deltaFromPrev becomes true.
// ---------------------------------------------------------------------------

interface FakeSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
}

function makeFakeSandbox(commandHandler: (command: string) => { stdout?: string; exitCode?: number } | undefined): FakeSandbox {
  const calls: Array<[string, ...unknown[]]> = [];
  const sandbox = {
    calls,
    sandboxId: "fake-shared-world-sandbox-001",
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
    launch: async () => undefined,
    open: async () => undefined,
    async screenshot() {
      return new Uint8Array([1, 2, 3, 4]);
    },
    async wait(ms: number) {
      calls.push(["wait", ms]);
    },
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async () => undefined
    }
  };
  return sandbox as unknown as FakeSandbox;
}

function makeFakeModule(sandbox: FakeSandbox): { module: E2BDesktopModule; created: E2BDesktopCreateOptions[]; templates: (string | undefined)[]; killed: string[] } {
  const created: E2BDesktopCreateOptions[] = [];
  // Parallel to `created`: the custom template each create() got (undefined == byte-stable default).
  const templates: (string | undefined)[] = [];
  const killed: string[] = [];
  const module: E2BDesktopModule = {
    Sandbox: {
      // Mirror the real @e2b/desktop overload: create(opts) OR create(template, opts).
      create: async (templateOrOptions: string | E2BDesktopCreateOptions, maybeOptions?: E2BDesktopCreateOptions) => {
        const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
        const createOptions = typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
        templates.push(template);
        created.push(createOptions);
        return sandbox;
      },
      kill: async (sandboxId) => {
        killed.push(sandboxId);
        return undefined;
      }
      // NOTE: NO `list` method — enumerate-and-kill is impossible here by construction.
    }
  };
  return { module, created, templates, killed };
}

/** A scripted command handler whose checkpoint output reflects the shared world version. */
function makeCommandHandler(state: { worldVersion: number }): (command: string) => { stdout?: string; exitCode?: number } | undefined {
  return (command: string): { stdout?: string; exitCode?: number } | undefined => {
    if (command.includes("browser_preference='firefox'")) return { stdout: "MIMETIC_BROWSER_RESOLVED=firefox\n", exitCode: 0 };
    if (command.includes("browser_preference='chrome'")) return { stdout: "MIMETIC_BROWSER_RESOLVED=google-chrome\n", exitCode: 0 };
    if (command.includes("browser_preference='chromium'")) return { stdout: "MIMETIC_BROWSER_RESOLVED=chromium\n", exitCode: 0 };
    if (command.includes("browser_preference='default'")) return { stdout: "MIMETIC_BROWSER_RESOLVED=google-chrome\n", exitCode: 0 };
    if (command.includes("/status")) return { stdout: "0" }; // every detached step exits 0
    if (command.includes("rev-parse")) return { stdout: "abc123def4567890abc1\n" }; // commit SHA
    if (command.includes("curl")) return { stdout: "READY" }; // readiness probe
    if (command.includes("checkpoint-") && command.includes("tail -c")) {
      // The shared-state probe output changes as roles mutate the world → digests diverge.
      return { stdout: `world=${state.worldVersion}\n` };
    }
    if (command.includes("tail -c")) return { stdout: "" }; // other detached logs
    return undefined;
  };
}

function makeTrace(args: {
  persona: { id: string; traitsApplied: string[]; promptDigest: string };
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  actions: number;
  messages: number;
}): ActorTrace {
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
    reason: `${args.status} (${args.completionReason})`,
    ids: {},
    counts: { actions: args.actions, messages: args.messages, screenshots: 0 },
    items: [
      ...(args.messages > 0 ? [{ id: "i-msg", kind: "message" as const, lifecycle: "completed" as const, title: "message", text: "did my role's task" }] : []),
      ...(args.actions > 0 ? [{ id: "i-act", kind: "ui_action" as const, lifecycle: "completed" as const, title: "click" }] : [])
    ],
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: false,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "proprietary"
    }
  };
}

/** A runSession fake that bumps the world version (a turn mutates state) and returns a passed,
 *  engaged trace — unless a per-call override (harness error / mission failure / throw) applies. */
function makeRunSession(
  state: { worldVersion: number },
  override?: (index: number, options: CuaActorSessionOptions) => { throwMessage?: string; status?: ActorStatus; completionReason?: ActorCompletionReason; actions?: number; messages?: number } | undefined
): (options: CuaActorSessionOptions) => Promise<CuaLoopResult> {
  let index = -1;
  return async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
    index += 1;
    state.worldVersion += 1; // each role's turn mutates the shared world
    const o = override?.(index, options);
    if (o?.throwMessage) {
      throw new Error(o.throwMessage);
    }
    const status = o?.status ?? "passed";
    const completionReason = o?.completionReason ?? "goal_satisfied";
    const trace = makeTrace({
      persona: options.persona,
      status,
      completionReason,
      actions: o?.actions ?? 1,
      messages: o?.messages ?? 1
    });
    return { status, completionReason, reason: trace.reason, trace };
  };
}

function sharedWorldConfig(overrides?: { browser?: LabDesktopBrowser; env?: string[]; template?: string }): LabConfig {
  const desktop = {
    ...(overrides?.browser === undefined ? {} : { browser: overrides.browser }),
    ...(overrides?.template === undefined ? {} : { template: overrides.template })
  };
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "shared-world-proof",
    title: "Shared-world proof",
    subject: {
      source: "clone",
      topology: "shared-world",
      repos: ["example-org/collab-app"],
      env: overrides?.env ?? ["DATABASE_URL"],
      serve: { install: "pnpm install", start: "pnpm start", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [
          { name: "notes-count", command: "psql query notes" },
          { name: "reviews-count", command: "psql query reviews" }
        ]
      }
    },
    actors: [
      {
        type: "openai-computer-use",
        mission: "Use the shared app.",
        lanes: [
          { id: "role-author", persona: "author", entry: "/compose", instruction: "Create a note." },
          { id: "role-reviewer", persona: "reviewer", entry: "/inbox", instruction: "Review the note." }
        ]
      }
    ],
    execution: {
      target: "e2b-desktop",
      timeoutMs: 60_000,
      ...(Object.keys(desktop).length === 0 ? {} : { desktop })
    },
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function baseHooks(state: { worldVersion: number }): { hooks: SharedWorldLabHooks; created: E2BDesktopCreateOptions[]; templates: (string | undefined)[]; killed: string[]; sandbox: FakeSandbox } {
  const sandbox = makeFakeSandbox(makeCommandHandler(state));
  const { module, created, templates, killed } = makeFakeModule(sandbox);
  const hooks: SharedWorldLabHooks = {
    env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key", DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" },
    loadDesktopModule: async () => module,
    runSession: makeRunSession(state),
    detachedTimers: { now: () => 0, sleep: async () => {} }
  };
  return { hooks, created, templates, killed, sandbox };
}

const SHARED_WORLD_ADAPTER_NAMESPACE = "shared-world-adapter-proof";

function sharedWorldFailScore(ctx: BrowserLabScoringContext): RunAdapterScore {
  return {
    schema: "mimetic.adapter-score.v1",
    namespace: SHARED_WORLD_ADAPTER_NAMESPACE,
    status: "fail",
    score: 18,
    summary: `${ctx.backend} adapter found no product-level shared-world success evidence.`,
    data: {
      backend: ctx.backend,
      laneCount: ctx.laneCount
    }
  };
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "mimetic-shared-world-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("runSharedWorldLab (the heart: real orchestration vs fakes, $0)", () => {
  it("dry-run produces a verified contract bundle with the sharedWorld block + attributionClass + limits, no sandbox", async () => {
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.sandbox).toBeUndefined();
    expect(result.topology).toBe("shared-world");
    expect(result.roleCount).toBe(2);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.attributionClass).toBe("shared-world");
    expect(bundle.sharedWorld.schema).toBe("mimetic.shared-world.v1");
    expect(bundle.sharedWorld.attributionLimits).toEqual(
      expect.arrayContaining(["sequential-only", "no-concurrent-races", "delta-attributed-to-turn-not-action"])
    );
    expect(bundle.mode).toBe("dry-run");

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("execution.desktop.template: the ONE shared-plane Sandbox.create gets the template; bundle records it; absent stays byte-stable", async () => {
    // With a custom template configured.
    const withState = { worldVersion: 0 };
    const withTemplate = baseHooks(withState);
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig({ template: "acme-desktop-with-runtimes" }), dryRun: false, hooks: withTemplate.hooks });
    expect(result.ok).toBe(true);
    expect(withTemplate.created).toHaveLength(1);
    expect(withTemplate.templates).toEqual(["acme-desktop-with-runtimes"]);
    const withBundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(withBundle.desktopTemplate).toBe("acme-desktop-with-runtimes");

    // Byte-stable default: NO template → create called with NO template arg, bundle omits the field.
    const noState = { worldVersion: 0 };
    const noTemplate = baseHooks(noState);
    const result2 = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks: noTemplate.hooks });
    expect(result2.ok).toBe(true);
    expect(noTemplate.templates).toEqual([undefined]);
    const noBundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result2.runId, "run.json"), "utf8"));
    expect(noBundle.desktopTemplate).toBeUndefined();
  });

  it("execution.desktop.browser: sequential shared-world seats honor explicit browser preference and record provenance", async () => {
    const state = { worldVersion: 0 };
    const { hooks, sandbox } = baseHooks(state);
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig({ browser: "firefox" }), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    const seatLaunches = sandbox.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call[0] === "commands.run" && String(call[1]).includes("browser_preference="));
    expect(seatLaunches).toHaveLength(2);
    expect(String(seatLaunches[0]!.call[1])).toContain("browser_preference='firefox'");
    expect(String(seatLaunches[0]!.call[1])).toContain("launch_firefox");
    expect(String(seatLaunches[0]!.call[1])).not.toContain("setsid -f google-chrome");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.desktopBrowser).toEqual({ requested: "firefox", resolved: "firefox" });

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });

  it("GOOD run: ONE sandbox by-id, plane provisioned ONCE, sequential distinct profiles, interaction proof, verify ok", async () => {
    const state = { worldVersion: 0 };
    const { hooks, created, killed, sandbox } = baseHooks(state);
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // ONE sandbox created + torn down BY its exact id (killed-set == {createdId}).
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata?.topology).toBe("shared-world");
    expect(created[0]?.metadata?.roleCount).toBe("2");
    expect(killed).toEqual([sandbox.sandboxId]);
    expect(result.sandbox).toEqual({ sandboxId: sandbox.sandboxId, killed: true });

    // The ACTOR key never entered the sandbox; the SUBJECT env was provisioned by name.
    expect(created[0]?.envs).toEqual({ DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" });

    // provisionCloneSubject ran EXACTLY once (one plane, not N): one `git clone` script written.
    const cloneWrites = sandbox.calls.filter(([name, , data]) => name === "files.write" && String(data).includes("git clone"));
    expect(cloneWrites).toHaveLength(1);

    // Seats are sequential with DISTINCT --user-data-dir per role, in declared order.
    const seatLaunches = sandbox.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call[0] === "commands.run" && String(call[1]).includes("--user-data-dir="));
    expect(seatLaunches).toHaveLength(2);
    expect(String(seatLaunches[0]!.call[1])).toContain("profile_dir='/tmp/seat-role-author'");
    expect(String(seatLaunches[1]!.call[1])).toContain("profile_dir='/tmp/seat-role-reviewer'");
    expect(seatLaunches[0]!.index).toBeLessThan(seatLaunches[1]!.index); // author's seat before reviewer's

    // A checkpoint at baseline + after each turn → timeline = cp, turn, cp, turn, cp.
    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    const timeline = bundle.sharedWorld.timeline as Array<{ kind: string; name?: string; deltaFromPrev?: boolean; roleId?: string }>;
    expect(timeline.map((e) => e.kind)).toEqual(["checkpoint", "turn", "checkpoint", "turn", "checkpoint"]);
    expect(timeline[0]!.name).toBe("cp-baseline");
    expect(bundle.sharedWorld.sequence).toEqual(["role-author", "role-reviewer"]);
    expect(bundle.sharedWorld.roleCount).toBe(2);
    expect(bundle.desktopBrowser).toBeUndefined();

    // THE INTERACTION PROOF: the checkpoint after role-author carries deltaFromPrev == true AND
    // appears strictly BEFORE role-reviewer's turn in the one harness clock.
    const cpAfterAuthorIndex = timeline.findIndex((e) => e.kind === "checkpoint" && e.name === "cp-after-role-author");
    const reviewerTurnIndex = timeline.findIndex((e) => e.kind === "turn" && e.roleId === "role-reviewer");
    expect(cpAfterAuthorIndex).toBeGreaterThanOrEqual(0);
    expect(timeline[cpAfterAuthorIndex]!.deltaFromPrev).toBe(true);
    expect(cpAfterAuthorIndex).toBeLessThan(reviewerTurnIndex);

    // Single-plane provenance: every turn shares the one commit + seedDigest.
    const turns = timeline.filter((e) => e.kind === "turn") as Array<{ commit?: string; seedDigest?: string }>;
    expect(new Set(turns.map((t) => `${t.commit}:${t.seedDigest}`)).size).toBe(1);
    expect(bundle.sharedWorld.plane.commit).toBe("abc123def4567890abc1");

    // verifyRun ok on the GOOD bundle.
    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);

    // Per-role actor traces written.
    const actorsDir = await readdir(path.join(cwd, ".mimetic", "runs", result.runId, "actors"));
    expect(actorsDir.sort()).toEqual(["stream-001.json", "stream-002.json"]);
  });

  it("adapter fail score turns a coherent shared-world run red while keeping shared-world evidence verifiable", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    hooks.score = sharedWorldFailScore;
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Adapter scorer failed the run");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore?.namespace).toBe(SHARED_WORLD_ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.adapterScore?.data?.backend).toBe("shared-world");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("Adapter scorer failed the run"))).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("routes through runLab(sharedWorldHooks) to the shared-world backend", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    const config = sharedWorldConfig();
    expect(selectLabBackend(config)).toBe("shared-world");
    const outcome = await runLab(config, { cwd, dryRun: false, sharedWorldHooks: hooks });
    expect(outcome.backend).toBe("shared-world");
    if (outcome.backend !== "shared-world") return;
    expect(outcome.result.ok).toBe(true);
  });

  it("HARNESS error on role 1 ⇒ remaining roles blocked + pinned reason (fail-fast); fail-fast event recorded", async () => {
    const state = { worldVersion: 0 };
    const sandbox = makeFakeSandbox(makeCommandHandler(state));
    const { module, killed } = makeFakeModule(sandbox);
    const hooks: SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k2", DATABASE_URL: "v" },
      loadDesktopModule: async () => module,
      runSession: makeRunSession(state, (index) => (index === 0 ? { status: "failed", completionReason: "harness_error" } : undefined)),
      detachedTimers: { now: () => 0, sleep: async () => {} }
    };
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.roles[0]?.id).toBe("role-author");
    expect(result.roles[1]?.status).toBe("blocked");
    expect(result.roles[1]?.skippedReason).toContain("fail-fast");
    // Only role-author took a turn (the premise broke); reviewer never ran a session.
    expect(result.sequence).toEqual(["role-author"]);
    // Still ONE sandbox, still killed by id.
    expect(killed).toEqual([sandbox.sandboxId]);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.events.some((e: { type: string }) => e.type === "shared-world.fail-fast")).toBe(true);
  });

  it("MISSION failure (non-harness) is DATA, never trips fail-fast: every role still runs", async () => {
    const state = { worldVersion: 0 };
    const sandbox = makeFakeSandbox(makeCommandHandler(state));
    const { module } = makeFakeModule(sandbox);
    const hooks: SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k2", DATABASE_URL: "v" },
      loadDesktopModule: async () => module,
      runSession: makeRunSession(state, (index) => (index === 0 ? { status: "failed", completionReason: "gave_up" } : undefined)),
      detachedTimers: { now: () => 0, sleep: async () => {} }
    };
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    // role-author failed its MISSION but did NOT trip fail-fast: role-reviewer still took its turn.
    expect(result.ok).toBe(false);
    expect(result.roles[0]?.status).toBe("failed");
    expect(result.roles[0]?.ok).toBe(false);
    expect(result.roles[1]?.status).not.toBe("blocked");
    expect(result.sequence).toEqual(["role-author", "role-reviewer"]);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("1/2 role(s)");
    expect(bundle.review.gaps[0]).toContain("failed (gave_up)");
  });

  it("literal-scrubs a provisioned value injected into a forced error before persist", async () => {
    const state = { worldVersion: 0 };
    const sandbox = makeFakeSandbox(makeCommandHandler(state));
    const { module } = makeFakeModule(sandbox);
    const secret = "opaque-pw-7f3a9c2e-do-not-leak"; // an opaque value pattern-redaction would MISS
    const hooks: SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k2", DATABASE_URL: secret },
      loadDesktopModule: async () => module,
      runSession: makeRunSession(state, (index) => (index === 0 ? { throwMessage: `connection failed using ${secret}` } : undefined)),
      detachedTimers: { now: () => 0, sleep: async () => {} }
    };
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });
    expect(result.ok).toBe(false);

    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(cwd, ".mimetic", "runs", result.runId, file), "utf8");
      expect(text, file).not.toContain(secret);
    }
  });
});

describe("verifyRun fails closed on each injected shared-world overclaim", () => {
  async function goodBundlePath(): Promise<{ runId: string; bundlePath: string }> {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });
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
    const verify = await verifyRun(cwd, runId);
    return verify.ok;
  }

  it("(a) attributionLimits missing no-concurrent-races", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { attributionLimits: string[] };
      sw.attributionLimits = sw.attributionLimits.filter((limit) => limit !== "no-concurrent-races");
    });
    expect(ok).toBe(false);
  });

  it("(b) a value-shaped (non-digest) checkpoint field", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { timeline: Array<Record<string, unknown>> };
      const checkpoint = sw.timeline.find((entry) => entry.kind === "checkpoint")!;
      checkpoint.rawValue = "notes=42"; // a value-shaped field; checkpoints persist digest-only
    });
    expect(ok).toBe(false);
  });

  it("(c) divergent plane provenance across turns", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { timeline: Array<Record<string, unknown>> };
      const turn = sw.timeline.find((entry) => entry.kind === "turn")!;
      turn.commit = "deadbeefdeadbeef0000"; // diverges from the single plane
    });
    expect(ok).toBe(false);
  });

  it("(d) a phantom/dropped role (sequence length != roleCount)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { sequence: string[] };
      sw.sequence = sw.sequence.slice(0, 1); // drop a role
    });
    expect(ok).toBe(false);
  });

  it("(e) a PASSED run with no checkpoint delta (hollow interaction)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { timeline: Array<Record<string, unknown>> };
      for (const entry of sw.timeline) {
        if (entry.kind === "checkpoint") entry.deltaFromPrev = false;
      }
    });
    expect(ok).toBe(false);
  });

  it("(f) a role with goal_satisfied + zero engagement", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const streams = bundle.streams as Array<{ actor?: { completionReason?: string; counts?: Record<string, number>; items?: unknown[] } }>;
      const stream = streams.find((s) => s.actor)!;
      stream.actor!.completionReason = "goal_satisfied";
      stream.actor!.counts = { actions: 0, messages: 0, screenshots: 0 };
      stream.actor!.items = [];
    });
    expect(ok).toBe(false);
  });
});
