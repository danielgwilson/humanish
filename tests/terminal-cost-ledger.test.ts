import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runTerminalProductLab, type TerminalProductLabHooks } from "../src/e2b-terminal-lab.js";
import type { E2BDesktopModule } from "../src/e2b-desktop-launch.js";
import { verifyRun } from "../src/run.js";

// SLICE 3 deterministic proof ($0, NO live E2B): the cost/spend ledger + the null-vs-zero-vs-absent
// discipline + the no-spend proof DERIVED from the ledger + FULL caps enforcement (fail-closed).
// Reuses the SLICE-2 fake-E2B-module + mock-CLI pattern; the SLICE-3 cost signal is injected via the
// costProbe DI seam (the lane has no real product-spend signal yet — that is SLICE 4).

const FAKE_RUNTIME_KEY = "FAKEKEY-terminal-slice3-do-not-leak-1234567890";

function makeFakeModule(opts: {
  codexBehavior: (cmd: string) => { exitCode: number; stdout?: string };
  killed: string[];
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
              if (command.includes("codex")) {
                const behavior = opts.codexBehavior(command);
                if (behavior.stdout && runOptions?.onStdout) runOptions.onStdout(behavior.stdout);
                return { exitCode: behavior.exitCode };
              }
              if (runOptions?.onStdout) runOptions.onStdout("MIMETIC_SHELL_READY\n");
              return { exitCode: 0, stdout: "MIMETIC_SHELL_READY\n" };
            }
          },
          files: { async write() { return undefined; } },
          async launch() { return undefined; },
          async wait() { return undefined; },
          async screenshot() { return new Uint8Array(); },
          stream: {
            getAuthKey: () => "fake-auth",
            getUrl: () => "https://fake-stream",
            async start() { return undefined; }
          }
        };
      },
      async kill(sandboxId: string) {
        opts.killed.push(sandboxId);
        return undefined;
      },
      list() {
        const paginator = {
          hasNext: true,
          async nextItems() {
            paginator.hasNext = false;
            return [{ sandboxId: "unrelated-other-run", state: "running" as const }];
          }
        };
        return paginator;
      }
    }
  } as unknown as E2BDesktopModule;
}

function nonceFrom(command: string): string {
  const m = /MIMETIC_ACTOR_NONCE=([A-Za-z0-9-]+)/.exec(command);
  return m?.[1] ?? "unknown-nonce";
}

function liveConfig(caps: Record<string, number>): LabConfig {
  const raw: Record<string, unknown> = {
    schema: LAB_CONFIG_SCHEMA,
    id: "terminal-cost-proof",
    title: "Terminal cost-ledger proof",
    subject: {
      source: "terminal-product",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] }
    },
    actors: [{ type: "codex-exec", persona: "autonomous-creative-agent", mission: "Discover widgetsmith-cli from public surfaces." }],
    execution: { target: "e2b-terminal", runtimeAuth: "openai-env", timeoutMs: 600_000, terminal: { transport: "exec-stream", stdin: "disabled" } },
    scenario: { mode: "live", caps },
    policies: { allowPrivateRepoAccess: false, allowProviderCredentials: false, allowPaymentCredentials: false, allowGitHubMutation: false }
  };
  const parsed = parseLabConfig(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function baseEnv(): Record<string, string | undefined> {
  return { OPENAI_API_KEY: FAKE_RUNTIME_KEY, E2B_API_KEY: "FAKE-E2B-KEY-0987654321" };
}

function passingCodex() {
  return (cmd: string) => ({ exitCode: 0, stdout: `done\nMIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=${nonceFrom(cmd)}\n` });
}

describe("terminal-product cost ledger + no-spend proof + caps enforcement (deterministic, $0)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "mimetic-tp-cost-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("(a) a no-spend run produces a VERIFIED no-spend proof derived from the ledger", async () => {
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 1_000,
      loadModule: async () => makeFakeModule({ killed, codexBehavior: passingCodex() })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig({ maxUsd: 0, maxJobs: 0, maxMinutes: 10 }), dryRun: false, open: false, hooks });

    expect(result.ok).toBe(true);
    expect(result.session?.status).toBe("passed");
    // The no-spend proof is surfaced on the result.
    expect(result.noSpend?.satisfied).toBe(true);
    expect(result.noSpend?.maxUsd).toBe(0);
    // Provider unmeasured this run (no tokenUsage), product/media/payment unmeasured this slice.
    expect(result.noSpend?.unmeasuredLines.sort()).toEqual(["media", "payment", "product", "provider"]);
    expect(result.noSpend?.knownZeroLines).toEqual([]);

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.cost.schema).toBe("mimetic.terminal-cost-ledger.v1");
    expect(ledgers.noSpendProof.schema).toBe("mimetic.terminal-no-spend-proof.v1");
    expect(ledgers.noSpendProof.satisfied).toBe(true);
    expect(ledgers.cost.knownTotalUsd).toBe(0);
    expect(ledgers.cost.fullyMeasured).toBe(false); // all four lines are null = unmeasured

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(true);
  });

  it("(b) null-for-unknown vs 0-for-known-zero vs the absence distinction are persisted crisply", async () => {
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 1_000,
      loadModule: async () => makeFakeModule({ killed, codexBehavior: passingCodex() }),
      // Inject a KNOWN-ZERO product line (metered, billed nothing) while media/payment/provider stay
      // null (unmeasured). This is the load-bearing distinction: 0 != null.
      costProbe: () => ({
        product: { usd: 0, count: 0, source: "no-spend-signal", note: "metered product spend: zero billable jobs" }
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig({ maxUsd: 0, maxJobs: 0, maxMinutes: 10 }), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));

    // KNOWN ZERO: the injected product line is a literal 0 (not null).
    expect(ledgers.cost.lines.product.usd).toBe(0);
    // NOT MEASURED: media/payment/provider are literal null (not 0, not omitted).
    expect(ledgers.cost.lines.media.usd).toBeNull();
    expect(ledgers.cost.lines.payment.usd).toBeNull();
    expect(ledgers.cost.lines.provider.usd).toBeNull();
    // The serialized JSON must carry an explicit `null` (the distinction survives persistence) and
    // never silently drop the usd key.
    const raw = await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8");
    expect(raw).toContain("\"usd\": null");
    expect(raw).toContain("\"usd\": 0");

    // The no-spend proof reflects the distinction: product is a known-zero line it vouches for, the
    // other three are unmeasured and explicitly NOT claimed zero.
    expect(ledgers.noSpendProof.knownZeroLines).toEqual(["product"]);
    expect(ledgers.noSpendProof.unmeasuredLines.sort()).toEqual(["media", "payment", "provider"]);
    expect(ledgers.noSpendProof.satisfied).toBe(true);
    // "absent / n/a" is reserved: all four applicable lines are present this lane, so none is omitted.
    expect(Object.keys(ledgers.cost.lines).sort()).toEqual(["media", "payment", "product", "provider"]);

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("(c) a ledger showing KNOWN spend > maxUsd trips fail-closed (no green pass)", async () => {
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 1_000,
      loadModule: async () => makeFakeModule({ killed, codexBehavior: passingCodex() }),
      // A KNOWN provider spend of $2.50 that exceeds the maxUsd:1 cap — the run must fail closed even
      // though the agent itself reported a passing verdict.
      costProbe: () => ({
        provider: { usd: 2.5, source: "provider-token-usage", note: "metered provider spend (injected for the cap test)" }
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig({ maxUsd: 1, maxJobs: 0, maxMinutes: 10 }), dryRun: false, open: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_TERMINAL_LAB_CAPS_EXCEEDED");
    // The sandbox was still torn down (cleanup runs in finally before the cap evaluation).
    expect(killed.length).toBe(1);
    // The agent's own verdict does NOT survive as a green pass — the cap blew the run.
    expect(result.session?.status).toBe("failed");
    expect(result.noSpend?.satisfied).toBe(false);

    // The bundle records the breach, and verify ALSO fails closed (known spend > declared cap).
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(false);
  });

  it("(d) a no-spend proof that claims zero on a null (unmeasured) line FAILS verify", async () => {
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 1_000,
      loadModule: async () => makeFakeModule({ killed, codexBehavior: passingCodex() })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig({ maxUsd: 0, maxJobs: 0, maxMinutes: 10 }), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);

    // Tamper the persisted proof to claim zero on a line the ledger marks null — the proof now claims
    // MORE than the ledger measured. verify must fail closed.
    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const ledgersPath = path.join(runDir, "terminal-ledgers.json");
    const ledgers = JSON.parse(await readFile(ledgersPath, "utf8"));
    expect(ledgers.cost.lines.provider.usd).toBeNull(); // provider IS null (unmeasured)
    ledgers.noSpendProof.knownZeroLines = ["provider"]; // lie: claim it is a proven zero
    ledgers.noSpendProof.unmeasuredLines = ["product", "media", "payment"];
    await (await import("node:fs/promises")).writeFile(ledgersPath, `${JSON.stringify(ledgers, null, 2)}\n`, "utf8");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
    const finding = verified.checks.find((c) => c.name === "terminal-product evidence");
    expect(finding?.ok).toBe(false);
    expect(finding?.message).toContain("claims zero on line \"provider\"");
  });
});
