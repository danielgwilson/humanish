import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// SLICE 4 conformance proof (deterministic, $0, NO live E2B): the layer-6 product-adapter EXTENSION
// SEAM (issue #154 acceptance #8 — "product-adapter hooks WITHOUT forking core"). A THIN in-repo
// EXAMPLE adapter (below, ~40 lines, simulating what a real adopter would write in ITS own repo)
// registers a terminal-product scorer + feedback strategy via the TerminalProductLabHooks DI seam,
// attaches ADAPTER-NAMESPACED product nouns to a feedback candidate, and the produced bundle
// VERIFIES — proving the seam closes the fork-forcing gap WITHOUT a fork.
//
// THE LOAD-BEARING PROOF: the example adapter imports ONLY from the public package barrel
// ("../src/index.js" — the exact surface published as humanish), never a deep `src/` module. If
// the contract types it needs (RunFeedbackCandidate / RunAdapterScore / TerminalProductScoringContext
// / TerminalLedgers / ActorTrace) were not exported, this file would not type-check — which IS the
// fork-forcing gap acceptance #8 names.
import {
  type ActorTrace,
  type RunAdapterScore,
  type RunBundle,
  type RunFeedbackCandidate,
  type TerminalLedgers,
  type TerminalProductLabHooks,
  type TerminalProductScoringContext
} from "../src/index.js";

// Reuse the SLICE-2/3 fake-E2B-module + mock-CLI pattern. (parseLabConfig + runTerminalProductLab +
// verifyRun are public package surface too; imported via the deeper modules only to drive the
// harness in-test — the ADAPTER itself uses the barrel exclusively, asserted below.)
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runTerminalProductLab } from "../src/e2b-terminal-lab.js";
import type { E2BDesktopModule } from "../src/e2b-desktop-launch.js";
import { verifyRun } from "../src/run.js";

// =============================================================================================
// THE THIN EXAMPLE ADAPTER — this is the ~40-line extension an adopter would write in ITS repo.
// It types ONLY against humanish's PUBLIC barrel; it knows nothing of core internals. It scores
// the product attempt with ITS OWN (off-core) rubric and records ITS product nouns (public CLI
// command observed, hosted success/blocker, feedback id, media/job ids, no-media-spend, friction
// risk) under an ADAPTER-NAMESPACED block — never as core enums. NEUTRAL fictional product name.
// =============================================================================================
const ADAPTER_NAMESPACE = "pixelforge-studio";

function exampleAdapterScore(ctx: TerminalProductScoringContext): RunAdapterScore {
  // The adopter's own rubric, summarized into the generic status/score; the product-specific
  // breakdown rides under `data` (core never reads it).
  const usedProduct = ctx.trace.status === "passed";
  return {
    schema: "humanish.adapter-score.v1",
    namespace: ADAPTER_NAMESPACE,
    status: usedProduct ? "pass" : "partial",
    score: usedProduct ? 88 : 40,
    summary: `Pixelforge CLI study scored by the adopter's product rubric (${ctx.product}).`,
    data: {
      productRubric: { discovery: 1, firstImage: usedProduct ? 1 : 0, durableUrl: usedProduct ? 1 : 0 },
      hostedProductSucceeded: usedProduct
    }
  };
}

function exampleAdapterFeedback(ctx: TerminalProductScoringContext): RunFeedbackCandidate[] {
  return [{
    schema: "humanish.feedback-candidate.v1",
    id: `pixelforge-attempt-${ctx.runId}`,
    run_id: ctx.runId,
    stream_id: ctx.bundle.streams[0]?.id ?? "stream-001",
    adapter_id: ADAPTER_NAMESPACE,
    scenario_id: `terminal-${ctx.labId}`,
    persona_id: ctx.trace.persona.id,
    actor: "codex-exec",
    substrate: "e2b-terminal", // SLICE-4 substrate enum addition.
    failure_owner: ctx.trace.status === "passed" ? "harness" : "actor",
    summary: "Autonomous agent attempted a durable Pixelforge image task from public surfaces.",
    expected: "The agent discovers Pixelforge CLI from public surfaces and produces a durable image URL within the no-spend cap.",
    actual: ctx.trace.reason,
    evidence: [{ path: "terminal-ledgers.json", kind: "log", note: "Substrate/cost/no-spend ledgers." }],
    redaction: { status: "passed", notes: "Adapter feedback references local public-safe artifacts only." },
    idempotency_key: `${ADAPTER_NAMESPACE}:${ctx.runId}:attempt`,
    proposed_next_state: "watch",
    acceptance_proof: [`pnpm humanish -- verify --run ${ctx.runId} --json`],
    // THE NON-CORE PRODUCT NOUNS (issue #154's "record product-specific concepts as NON-core nouns"
    // list) — namespaced so core schemas stay product-agnostic and an inert-field audit never misfires.
    adapter: {
      namespace: ADAPTER_NAMESPACE,
      data: {
        publicCommandObserved: "pixelforge generate --prompt '...'",
        hostedProductOutcome: ctx.trace.status === "passed" ? "success" : "blocker",
        feedbackId: null,
        mediaJobIds: [] as string[],
        assetIds: [] as string[],
        noMediaSpendProof: { mediaUsd: ctx.ledgers.cost.lines.media.usd, providerUsd: ctx.ledgers.cost.lines.provider.usd },
        defectionFrictionRisk: ctx.trace.status === "passed" ? "low" : "high"
      }
    }
  }];
}
// =============================================================================================

const FAKE_RUNTIME_KEY = "FAKEKEY-terminal-slice4-do-not-leak-1234567890";

function makeFakeModule(opts: { codexBehavior: (cmd: string) => { exitCode: number; stdout?: string }; killed: string[] }): E2BDesktopModule {
  let counter = 0;
  return {
    Sandbox: {
      async create() {
        counter += 1;
        const sandboxId = `fake-sandbox-${counter}`;
        return {
          sandboxId,
          commands: {
            async run(command: string, runOptions?: { onStdout?: (d: string) => void }) {
              if (command.includes("codex")) {
                const behavior = opts.codexBehavior(command);
                if (behavior.stdout && runOptions?.onStdout) runOptions.onStdout(behavior.stdout);
                return { exitCode: behavior.exitCode };
              }
              if (runOptions?.onStdout) runOptions.onStdout("HUMANISH_SHELL_READY\n");
              return { exitCode: 0, stdout: "HUMANISH_SHELL_READY\n" };
            }
          },
          files: { async write() { return undefined; } },
          async launch() { return undefined; },
          async wait() { return undefined; },
          async screenshot() { return new Uint8Array(); },
          stream: { getAuthKey: () => "fake-auth", getUrl: () => "https://fake-stream", async start() { return undefined; } }
        };
      },
      async kill(sandboxId: string) { opts.killed.push(sandboxId); return true; }
    }
  } as unknown as E2BDesktopModule;
}

function nonceFrom(command: string): string {
  return /HUMANISH_ACTOR_NONCE=([A-Za-z0-9-]+)/.exec(command)?.[1] ?? "unknown-nonce";
}

function liveConfig(): LabConfig {
  const raw: Record<string, unknown> = {
    schema: LAB_CONFIG_SCHEMA,
    id: "terminal-adapter-seam-proof",
    title: "Terminal adapter-seam proof",
    subject: { source: "terminal-product", product: { name: "pixelforge-cli", publicSurfaces: ["https://example.com/pixelforge"] } },
    actors: [{ type: "codex-exec", persona: "autonomous-creative-agent", mission: "Discover pixelforge-cli from public surfaces." }],
    execution: { target: "e2b-terminal", runtimeAuth: "openai-env", timeoutMs: 600_000, terminal: { transport: "exec-stream", stdin: "disabled" } },
    scenario: { mode: "live", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } },
    policies: { allowPrivateRepoAccess: false, allowProviderCredentials: false, allowPaymentCredentials: false, allowGitHubMutation: false }
  };
  const parsed = parseLabConfig(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function baseEnv(): Record<string, string | undefined> {
  return { OPENAI_API_KEY: FAKE_RUNTIME_KEY, E2B_API_KEY: "FAKE-E2B-KEY-also-do-not-leak-0987654321" };
}

function passingHooks(extra: Partial<TerminalProductLabHooks>): TerminalProductLabHooks {
  const killed: string[] = [];
  return {
    env: baseEnv(),
    now: () => 4_000,
    loadModule: async () => makeFakeModule({ killed, codexBehavior: (cmd) => ({ exitCode: 0, stdout: `created a durable image\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` }) }),
    ...extra
  };
}

describe("terminal-product extension seam (SLICE 4 conformance — thin adapter, not a fork)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-seam-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("runs the adapter scorer + feedback strategy, attaches NAMESPACED nouns, and the bundle VERIFIES", async () => {
    const hooks = passingHooks({ score: exampleAdapterScore, deriveFeedback: exampleAdapterFeedback });
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;

    // (1) The scorer hook RAN and its namespaced score is in the bundle.
    expect(bundle.adapterScore).toBeDefined();
    expect(bundle.adapterScore?.schema).toBe("humanish.adapter-score.v1");
    expect(bundle.adapterScore?.namespace).toBe(ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("pass");
    // The adopter's product breakdown rides under `data` (core never read it).
    expect((bundle.adapterScore?.data as Record<string, unknown>).hostedProductSucceeded).toBe(true);

    // (2) The derived feedback candidate is in the bundle, and its product nouns are NAMESPACED.
    expect(bundle.feedbackCandidates.length).toBe(1);
    const candidate = bundle.feedbackCandidates[0]!;
    expect(candidate.substrate).toBe("e2b-terminal"); // SLICE-4 substrate enum addition.
    expect(candidate.adapter?.namespace).toBe(ADAPTER_NAMESPACE);
    // The product nouns are ALL under the namespaced block — NONE are core top-level fields.
    expect(candidate.adapter?.data).toMatchObject({
      publicCommandObserved: expect.any(String),
      hostedProductOutcome: "success",
      defectionFrictionRisk: "low"
    });

    // (3) CORE STAYED PRODUCT-AGNOSTIC: no adopter noun leaked into a core enum/field. The core
    // feedback-candidate keys are exactly the documented core set + the single namespaced `adapter`.
    const coreKeys = new Set(Object.keys(candidate).filter((k) => k !== "adapter"));
    expect(coreKeys.has("publicCommandObserved")).toBe(false);
    expect(coreKeys.has("hostedProductOutcome")).toBe(false);
    expect(coreKeys.has("mediaJobIds")).toBe(false);

    // (4) THE BUNDLE VERIFIES (verifyRun ok) — the seam closed the gap WITHOUT a fork.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(true);

    // The persisted bundle never leaked the runtime key (the adapter payload passed the same scrub).
    const runJson = await readFile(path.join(runDir, "run.json"), "utf8");
    expect(runJson).not.toContain(FAKE_RUNTIME_KEY);
  });

  it("DEFAULT behavior is UNCHANGED when no scorer/feedback hook is given", async () => {
    const hooks = passingHooks({}); // no score, no deriveFeedback
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    // No adapter score, no derived feedback — the mission-based verdict stands alone.
    expect(bundle.adapterScore).toBeUndefined();
    expect(bundle.feedbackCandidates.length).toBe(0);
    expect(bundle.review.verdict).toBe("pass"); // unchanged mission-based verdict (nonce-verified)

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("fails CLOSED on a malformed adapter score/candidate — a bad extension never poisons a verifiable bundle", async () => {
    const hooks = passingHooks({
      // A malformed score (missing namespace) and a malformed candidate (empty summary) — both dropped.
      score: () => ({ schema: "humanish.adapter-score.v1", namespace: "", status: "pass", score: 1, summary: "x" }) as RunAdapterScore,
      deriveFeedback: () => ([{ schema: "humanish.feedback-candidate.v1", id: "bad", summary: "   ", evidence: [], redaction: { status: "passed" } }] as unknown as RunFeedbackCandidate[])
    });
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore).toBeUndefined(); // malformed score dropped
    expect(bundle.feedbackCandidates.length).toBe(0); // malformed candidate dropped
    expect(result.warnings.some((w) => w.includes("adapter-score.v1") || w.includes("feedback-candidate.v1"))).toBe(true);

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true); // the bundle still verifies — the seam stayed fail-closed
  });

  it("drops an adapter candidate with an escaping evidence path and leaves outside files unchanged", async () => {
    const outsideSentinel = path.join(cwd, "outside-sentinel.txt");
    const original = "outside must stay unchanged\n";
    await writeFile(outsideSentinel, original, "utf8");
    const hooks = passingHooks({
      deriveFeedback: (ctx) => {
        const [candidate] = exampleAdapterFeedback(ctx);
        if (!candidate) return [];
        return [{
          ...candidate,
          evidence: [{ path: "../../outside-sentinel.txt", kind: "log", note: "must be rejected" }]
        }];
      }
    });

    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;

    expect(bundle.feedbackCandidates).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.includes("feedback-candidate.v1"))).toBe(true);
    expect(await readFile(outsideSentinel, "utf8")).toBe(original);

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "local evidence artifacts exist")?.ok).toBe(true);
  });

  it("fails before finalization when an adapter hook retargets the prepared run root", async () => {
    const runId = "terminal-hook-root-retarget";
    const runRoot = path.join(cwd, ".humanish", "runs", runId);
    const capturedRunRoot = path.join(cwd, ".humanish", "runs", `${runId}-captured`);
    const outsideRoot = path.join(cwd, "outside-retarget");
    const outsideSentinel = path.join(outsideRoot, "sentinel.txt");
    const original = "outside target must stay unchanged\n";
    await mkdir(outsideRoot);
    await writeFile(outsideSentinel, original, "utf8");
    let hookRan = false;
    const hooks = passingHooks({
      score: async (ctx) => {
        hookRan = true;
        await rename(runRoot, capturedRunRoot);
        await symlink(outsideRoot, runRoot, "dir");
        return exampleAdapterScore(ctx);
      }
    });

    await expect(runTerminalProductLab({
      cwd,
      config: liveConfig(),
      dryRun: false,
      hooks,
      open: false,
      runId
    })).rejects.toThrow(/changed physical destination|identity changed/i);

    expect(hookRan).toBe(true);
    expect(await readFile(outsideSentinel, "utf8")).toBe(original);
    await expect(stat(path.join(outsideRoot, "run.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(cwd, ".humanish", "runs", "latest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(capturedRunRoot, "run.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // The contract types the adapter needs ARE exported (ActorTrace / TerminalLedgers used via the
  // context above); this no-op assertion makes the "adapter typed only against the public barrel"
  // claim explicit and load-bearing in CI — if any export disappeared this would fail to type-check.
  it("the adapter contract types are all reachable from the public package barrel", () => {
    const _typecheck: (ctx: TerminalProductScoringContext) => { score: RunAdapterScore; feedback: RunFeedbackCandidate[]; trace: ActorTrace; ledgers: TerminalLedgers } =
      (ctx) => ({ score: exampleAdapterScore(ctx), feedback: exampleAdapterFeedback(ctx), trace: ctx.trace, ledgers: ctx.ledgers });
    expect(typeof _typecheck).toBe("function");
  });
});
