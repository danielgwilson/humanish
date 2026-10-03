import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { V2_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { parseStudy } from "../../../src/study/config.js";
import { runTerminalProductLab } from "../../../src/routes/terminal/route.js";
import type { TerminalTestInputs } from "../../helpers/terminal-live-fake.js";
import type { E2BDesktopModule } from "../../../src/substrates/e2b/sdk.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { estimateAllocatedDesktopCost } from "../../../src/run/pricing.js";
import { DEFAULT_OPENAI_CU_MODEL } from "../../../src/actors/computer-use/openai-provider.js";

// Slice 3 deterministic proof ($0, no live E2B): the cost/spend ledger + the null-vs-zero-vs-absent
// discipline + the no-spend proof derived from the ledger + full caps enforcement (fail-closed).
// Reuses the slice-2 fake-E2B-module + mock-CLI pattern; the slice-3 cost signal is injected via the
// costProbe DI seam (the route has no real product-spend signal yet).

const FAKE_RUNTIME_KEY = "FAKEKEY-terminal-slice3-do-not-leak-1234567890";

function makeFakeModule(opts: {
  codexBehavior: (cmd: string) => { exitCode: number; stdout?: string };
  killed: string[];
  /** The size an instance getInfo() reports; absent means the sandbox has no getInfo. */
  size?: { cpuCount: number; memoryMB: number };
  /** Sandbox.kill(id) throws, so teardown cannot be proven. */
  killThrows?: boolean;
}): E2BDesktopModule {
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
              if (command.endsWith(" --version"))
                return { exitCode: 0, stdout: "codex-cli 0.153.3\n" };
              if (command.includes("codex")) {
                const behavior = opts.codexBehavior(command);
                if (behavior.stdout && runOptions?.onStdout) runOptions.onStdout(behavior.stdout);
                return { exitCode: behavior.exitCode };
              }
              if (runOptions?.onStdout) runOptions.onStdout("HUMANISH_SHELL_READY\n");
              return { exitCode: 0, stdout: "HUMANISH_SHELL_READY\n" };
            },
          },
          files: {
            async write() {
              return undefined;
            },
          },
          async launch() {
            return undefined;
          },
          async wait() {
            return undefined;
          },
          async screenshot() {
            return new Uint8Array();
          },
          ...(opts.size === undefined ? {} : { getInfo: async () => ({ ...opts.size }) }),
          stream: {
            getAuthKey: () => "fake-auth",
            getUrl: () => "https://fake-stream",
            async start() {
              return undefined;
            },
          },
        };
      },
      async kill(sandboxId: string) {
        opts.killed.push(sandboxId);
        if (opts.killThrows) throw new Error("synthetic kill failure");
        return true; // real-SDK-accurate: kill(id) resolves true ("found and killed")
      },
      // No Sandbox.getInfo/list on this fake: exercises the noGetInfo fallback in
      // teardownSandbox, where kill(id)'s own boolean is the by-id proof. This route's cleanup
      // proof is not what these slice 3 cost-ledger tests are about; see
      // tests/routes/terminal/lab.test.ts for the by-id cleanup coverage.
    },
  } as unknown as E2BDesktopModule;
}

function nonceFrom(command: string): string {
  const m = /HUMANISH_ACTOR_NONCE=([A-Za-z0-9-]+)/.exec(command);
  return m?.[1] ?? "unknown-nonce";
}

function liveConfig(caps: Record<string, number>): StudyConfig {
  const raw: Record<string, unknown> = {
    schema: V2_SCHEMA,
    id: "terminal-cost-proof",
    title: "Terminal cost-ledger proof",
    subject: {
      source: "terminal-product",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] },
    },
    actors: [
      {
        type: "codex-exec",
        persona: "autonomous-creative-agent",
        mission: "Discover widgetsmith-cli from public surfaces.",
      },
    ],
    execution: {
      target: "e2b-terminal",
      runtimeAuth: "openai-env",
      timeoutMs: 600_000,
      terminal: { transport: "exec-stream", stdin: "disabled" },
    },
    scenario: { mode: "live", caps },
    policies: {
      allowPrivateRepoAccess: false,
      allowProviderCredentials: false,
      allowPaymentCredentials: false,
      allowGitHubMutation: false,
    },
  };
  const parsed = parseStudy(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function baseEnv(): Record<string, string | undefined> {
  return { OPENAI_API_KEY: FAKE_RUNTIME_KEY, E2B_API_KEY: "FAKE-E2B-KEY-0987654321" };
}

function passingCodex() {
  return (cmd: string) => ({
    exitCode: 0,
    stdout: `done\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`,
  });
}

describe("terminal-product cost ledger + no-spend proof + caps enforcement (deterministic, $0)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-cost-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("(a) a no-spend run produces a verified no-spend proof derived from the ledger", async () => {
    const killed: string[] = [];
    const inputs: TerminalTestInputs = {
      env: baseEnv(),
      deps: {
        now: () => 1_000,
        desktopModule: async () => makeFakeModule({ killed, codexBehavior: passingCodex() }),
      },
    };
    const result = await runTerminalProductLab({
      cwd,
      config: liveConfig({ maxUsd: 0, maxJobs: 0, maxMinutes: 10 }),
      dryRun: false,
      open: false,
      ...inputs,
    });

    expect(result.ok).toBe(true);
    expect(result.session?.status).toBe("passed");
    // The no-spend proof is surfaced on the result.
    expect(result.noSpend?.satisfied).toBe(true);
    expect(result.noSpend?.maxUsd).toBe(0);
    // Provider unmeasured this run (no tokenUsage); product/media/payment are not measured yet.
    expect(result.noSpend?.unmeasuredLines.sort()).toEqual([
      "media",
      "payment",
      "product",
      "provider",
    ]);
    expect(result.noSpend?.knownZeroLines).toEqual([]);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.cost.schema).toBe("humanish.terminal-cost-ledger.v1");
    expect(ledgers.noSpendProof.schema).toBe("humanish.terminal-no-spend-proof.v1");
    expect(ledgers.noSpendProof.satisfied).toBe(true);
    expect(ledgers.cost.knownTotalUsd).toBe(0);
    expect(ledgers.cost.fullyMeasured).toBe(false); // all four lines are null = unmeasured

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(true);
  });

  it("(a2) counted-but-unpriced provider tokens are reported as such, never as no signal", async () => {
    const killed: string[] = [];
    // A codex stream that emits real turn.completed usage records, the shape a live run produces.
    const codexWithUsage = (cmd: string) => ({
      exitCode: 0,
      stdout:
        '{"type":"turn.completed","usage":{"input_tokens":201536,"cached_input_tokens":170558,' +
        '"cache_write_input_tokens":30951,"output_tokens":2283}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":141536,"cached_input_tokens":106256,' +
        '"output_tokens":1409}}\n' +
        `done\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}`,
    });
    const inputs: TerminalTestInputs = {
      env: baseEnv(),
      deps: {
        now: () => 1_000,
        desktopModule: async () => makeFakeModule({ killed, codexBehavior: codexWithUsage }),
      },
    };
    const result = await runTerminalProductLab({
      cwd,
      config: liveConfig({ maxUsd: 0, maxJobs: 0, maxMinutes: 10 }),
      dryRun: false,
      open: false,
      ...inputs,
    });

    expect(result.ok).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));

    // usd stays null: tokens are the measured fact, the rate is the unknown, and a guessed
    // dollar figure would be worse than none.
    expect(ledgers.cost.lines.provider.usd).toBeNull();
    expect(ledgers.cost.lines.provider.source).toBe("unpriced-token-usage");
    expect(ledgers.cost.lines.provider.note).toContain("343,072 input");
    expect(ledgers.cost.lines.provider.note).toContain("276,814 of them cached");
    expect(ledgers.cost.lines.provider.note).toContain("3,692 output");
    expect(ledgers.cost.lines.provider.note).not.toContain("NOT MEASURED");

    // `satisfied` keeps its contract meaning (no known line over the cap). The statement and the
    // lifecycle line must not read as a proven $0: nothing was measured, and the provider tokens
    // were consumed but unpriced, with their counts.
    expect(ledgers.noSpendProof.satisfied).toBe(true);
    const statement: string = ledgers.noSpendProof.statement;
    expect(statement).not.toMatch(/SATISFIED/);
    expect(statement).toMatch(
      /^No-spend proof not established for maxUsd=0: no spend line was measured\./,
    );
    expect(statement).toMatch(/Provider tokens were consumed \(343,072 input[^)]*3,692 output/);
    expect(statement).toMatch(/Not measured \(null, not claimed zero\): product, media, payment\./);
    const costEvent = ledgers.lifecycle.find(
      (entry: { event: string }) => entry.event === "terminal-lab.cost.measured",
    );
    expect(costEvent.message).not.toMatch(/No-spend proof satisfied/);
    expect(costEvent.message).toMatch(
      /No-spend proof not established for maxUsd=0: no spend line was measured\.$/,
    );
    expect(costEvent.message).toMatch(/Provider tokens were consumed .* unpriced, not zero/);
    const review = JSON.parse(await readFile(path.join(runDir, "review.json"), "utf8"));
    expect(review.gaps).toContainEqual(
      expect.stringMatching(
        /^No-spend proof not established for maxUsd=0: no spend line was measured\./,
      ),
    );

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("(b) null-for-unknown vs 0-for-known-zero vs the absence distinction are persisted crisply", async () => {
    const killed: string[] = [];
    const inputs: TerminalTestInputs = {
      env: baseEnv(),
      deps: {
        now: () => 1_000,
        desktopModule: async () => makeFakeModule({ killed, codexBehavior: passingCodex() }),
        costProbe: () => ({
          product: {
            usd: 0,
            count: 0,
            source: "no-spend-signal",
            note: "metered product spend: zero billable jobs",
          },
        }),
      },
    };
    const result = await runTerminalProductLab({
      cwd,
      config: liveConfig({ maxUsd: 0, maxJobs: 0, maxMinutes: 10 }),
      dryRun: false,
      open: false,
      ...inputs,
    });
    expect(result.ok).toBe(true);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));

    // Known zero: the injected product line is a literal 0 (not null).
    expect(ledgers.cost.lines.product.usd).toBe(0);
    // Not measured: media/payment/provider are literal null (not 0, not omitted).
    expect(ledgers.cost.lines.media.usd).toBeNull();
    expect(ledgers.cost.lines.payment.usd).toBeNull();
    expect(ledgers.cost.lines.provider.usd).toBeNull();
    // The serialized JSON must carry an explicit `null` (the distinction survives persistence) and
    // never silently drop the usd key.
    const raw = await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8");
    expect(raw).toContain('"usd": null');
    expect(raw).toContain('"usd": 0');

    // The no-spend proof reflects the distinction: product is a known-zero line it vouches for, the
    // other three are unmeasured and explicitly not claimed zero.
    expect(ledgers.noSpendProof.statement).toMatch(/satisfied for maxUsd=0 on the measured lines/);
    expect(ledgers.noSpendProof.statement).toMatch(/Measured: product 0 USD\./);
    expect(ledgers.noSpendProof.statement).toMatch(/Not measured[^:]*: media, payment, provider\./);
    const review = JSON.parse(await readFile(path.join(runDir, "review.json"), "utf8"));
    expect(review.gaps).toContainEqual(
      expect.stringMatching(/^No-spend proof is partial\. Measured: product 0 USD\./),
    );
    expect(ledgers.noSpendProof.knownZeroLines).toEqual(["product"]);
    expect(ledgers.noSpendProof.unmeasuredLines.sort()).toEqual(["media", "payment", "provider"]);
    expect(ledgers.noSpendProof.satisfied).toBe(true);
    // "absent / n/a" is reserved: all four applicable lines are present on this route, so none is
    // omitted.
    expect(Object.keys(ledgers.cost.lines).sort()).toEqual([
      "media",
      "payment",
      "product",
      "provider",
    ]);

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("(c) a ledger showing known spend > maxUsd fails the run closed and keeps the agent's verdict", async () => {
    const killed: string[] = [];
    const inputs: TerminalTestInputs = {
      env: baseEnv(),
      deps: {
        now: () => 1_000,
        desktopModule: async () => makeFakeModule({ killed, codexBehavior: passingCodex() }),
        costProbe: () => ({
          provider: {
            usd: 2.5,
            source: "provider-token-usage",
            note: "metered provider spend (injected for the cap test)",
          },
        }),
      },
    };
    const result = await runTerminalProductLab({
      cwd,
      config: liveConfig({ maxUsd: 1, maxJobs: 0, maxMinutes: 10 }),
      dryRun: false,
      open: false,
      ...inputs,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_CAPS_EXCEEDED");
    // The sandbox was still torn down (cleanup runs in finally before the cap evaluation).
    expect(killed.length).toBe(1);
    // A blown cap is an execution failure: the agent's own status stays the verdict, the result
    // fails closed, and the review and status.json both name the cap. Verify fails closed on known
    // spend over the declared cap, so the Observer does not render either.
    expect(result.session?.status).toBe("passed");
    expect(result.noSpend?.satisfied).toBe(false);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8"));
    expect(bundle.review.verdict).toBe("pass");
    expect(
      bundle.review.gaps.some((gap: string) => gap.includes("passed scenario.caps.maxUsd=1")),
    ).toBe(true);
    expect(status.outcome.ok).toBe(false);
    expect(
      status.outcome.execution.failures.map((failure: { kind: string }) => failure.kind),
    ).toEqual(["cap", "evidence"]);

    // The bundle records the breach, and verify also fails closed (known spend > declared cap).
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(false);
  });

  it("(d) a no-spend proof that claims zero on a null (unmeasured) line fails verify", async () => {
    const killed: string[] = [];
    const inputs: TerminalTestInputs = {
      env: baseEnv(),
      deps: {
        now: () => 1_000,
        desktopModule: async () => makeFakeModule({ killed, codexBehavior: passingCodex() }),
      },
    };
    const result = await runTerminalProductLab({
      cwd,
      config: liveConfig({ maxUsd: 0, maxJobs: 0, maxMinutes: 10 }),
      dryRun: false,
      open: false,
      ...inputs,
    });
    expect(result.ok).toBe(true);

    // Tamper the persisted proof to claim zero on a line the ledger marks null: the proof now claims
    // more than the ledger measured. verify must fail closed.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const ledgersPath = path.join(runDir, "terminal-ledgers.json");
    const ledgers = JSON.parse(await readFile(ledgersPath, "utf8"));
    expect(ledgers.cost.lines.provider.usd).toBeNull(); // provider is null (unmeasured)
    ledgers.noSpendProof.knownZeroLines = ["provider"]; // lie: claim it is a proven zero
    ledgers.noSpendProof.unmeasuredLines = ["product", "media", "payment"];
    await (
      await import("node:fs/promises")
    ).writeFile(ledgersPath, `${JSON.stringify(ledgers, null, 2)}\n`, "utf8");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
    const finding = verified.checks.find((c) => c.name === "terminal-product evidence");
    expect(finding?.ok).toBe(false);
    expect(finding?.message).toContain('claims zero on line "provider"');
  });

  it("(e) a positive maxUsd without a costProbe is refused before any sandbox or key use", async () => {
    let moduleLoads = 0;
    const killed: string[] = [];
    const result = await runTerminalProductLab({
      cwd,
      config: liveConfig({ maxUsd: 2, maxJobs: 0, maxMinutes: 10 }),
      dryRun: false,
      open: false,
      env: baseEnv(),
      deps: {
        now: () => 1_000,
        desktopModule: async () => {
          moduleLoads += 1;
          return makeFakeModule({ killed, codexBehavior: passingCodex() });
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_UNPRICED_CAP");
    expect(result.error?.message).toMatch(/scenario\.caps\.maxMinutes/);
    expect(result.error?.message).not.toContain(FAKE_RUNTIME_KEY);
    expect(result.runId).toBe("not-created");
    expect(moduleLoads).toBe(0);
    expect(killed).toEqual([]);
    await expect(readFile(path.join(cwd, ".humanish", "runs"), "utf8")).rejects.toThrow();
  });

  it("(f) a positive maxUsd with a costProbe runs, and the cap is checked against its lines", async () => {
    const killed: string[] = [];
    const result = await runTerminalProductLab({
      cwd,
      config: liveConfig({ maxUsd: 2, maxJobs: 0, maxMinutes: 10 }),
      dryRun: false,
      open: false,
      env: baseEnv(),
      deps: {
        now: () => 1_000,
        desktopModule: async () => makeFakeModule({ killed, codexBehavior: passingCodex() }),
        costProbe: () => ({
          product: { usd: 0.5, source: "no-spend-signal", note: "metered product spend" },
        }),
      },
    });

    // Within the $2 cap, so the run passes; the no-spend proof is not satisfied because a
    // measured line is non-zero.
    expect(result.ok).toBe(true);
    expect(result.noSpend?.satisfied).toBe(false);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.cost.knownTotalUsd).toBe(0.5);
    expect(result.warnings.some((w) => /costProbe measures/.test(w))).toBe(true);
    expect(killed).toHaveLength(1);
  });
});

describe("the terminal sandbox's compute time in the run cost summary", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-sandbox-cost-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // One turn of Codex usage. The lab declares no model, so the route passes the participant
  // default and prices the turn at its base rates.
  const codexWithUsage = (cmd: string) => ({
    exitCode: 0,
    stdout:
      '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":100}}\n' +
      `done\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}`,
  });

  async function run(size?: { cpuCount: number; memoryMB: number }, killThrows = false) {
    const killed: string[] = [];
    let clock = 1_000_000;
    const result = await runTerminalProductLab({
      cwd,
      config: liveConfig({ maxUsd: 0, maxJobs: 0, maxMinutes: 10 }),
      dryRun: false,
      open: false,
      env: baseEnv(),
      deps: {
        now: () => (clock += 1_000),
        desktopModule: async () =>
          makeFakeModule({
            killed,
            codexBehavior: codexWithUsage,
            ...(size === undefined ? {} : { size }),
            killThrows,
          }),
      },
    });
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    return { result, cost: bundle.cost, ledgers };
  }

  it("prices a sized sandbox's span and the Codex tokens from the model it passed", async () => {
    const { result, cost, ledgers } = await run({ cpuCount: 2, memoryMB: 2048 });
    expect(result.ok).toBe(true);
    const desktop = cost.breakdown.find(
      (line: { kind: string }) => line.kind === "desktop-minutes",
    );
    expect(desktop.desktop).toMatchObject({
      durationBasis: "host-acquired-to-cleanup",
      resources: { cpuCount: 2, memoryMiB: 2048 },
      resourceSource: "e2b.getInfo",
    });
    expect(desktop.desktop.minutes).toBeGreaterThan(0);
    const expected = estimateAllocatedDesktopCost(desktop.desktop.minutes, {
      cpuCount: 2,
      memoryMiB: 2048,
    });
    expect(desktop.estimatedCostUsd).toBe(expected.estimatedCostUsd);
    expect(desktop.estimatedCostUsd).toBeGreaterThan(0);
    const tokens = cost.breakdown.find((line: { kind: string }) => line.kind === "model-tokens");
    expect(tokens).toMatchObject({
      modelId: DEFAULT_OPENAI_CU_MODEL,
      basis: "aggregated_turns_base_rate",
      ratesAsOf: expect.any(String),
      source: expect.any(String),
    });
    expect(tokens.estimatedCostUsd).toBeGreaterThan(0);
    expect(cost.estimatedTotalUsd).toBeCloseTo(
      desktop.estimatedCostUsd + tokens.estimatedCostUsd,
      6,
    );
    expect(cost.fullyEstimated).toBe(true);
    // The sandbox line is not part of the cap ledger: a maxUsd 0 run still passes its cap.
    expect(Object.keys(ledgers.cost.lines).sort()).toEqual([
      "media",
      "payment",
      "product",
      "provider",
    ]);
    expect(ledgers.noSpendProof.satisfied).toBe(true);
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.checks.find((c) => c.name === "cost estimate labeling")?.ok).toBe(true);
  });

  it("adds an unpriced remainder line when the sandbox's teardown is not proven", async () => {
    const { result, cost } = await run({ cpuCount: 2, memoryMB: 2048 }, true);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_CLEANUP_UNPROVEN");
    // The span up to the failed cleanup is priced; what ran after it is unknown.
    expect(cost.breakdown).toContainEqual({
      kind: "desktop-minutes",
      estimatedCostUsd: null,
      reason: "desktop_lifetime_incomplete",
      ratesAsOf: null,
    });
    expect(cost.fullyEstimated).toBe(false);
  });

  it("records an unsized sandbox's span as unpriced and says why", async () => {
    const { result, cost } = await run();
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(
      "Sandbox resource size unavailable (metadata_unavailable); its compute cost remains unpriced.",
    );
    const desktop = cost.breakdown.find(
      (line: { kind: string }) => line.kind === "desktop-minutes",
    );
    expect(desktop).toMatchObject({
      estimatedCostUsd: null,
      reason: "no_desktop_resources",
      desktop: { resourceUnavailableReason: "metadata_unavailable" },
    });
    // Only the sandbox line is unpriced, so the total is the token estimate, as a lower bound.
    const tokens = cost.breakdown.find((line: { kind: string }) => line.kind === "model-tokens");
    expect(cost.estimatedTotalUsd).toBe(tokens.estimatedCostUsd);
    expect(cost.fullyEstimated).toBe(false);
  });
});
