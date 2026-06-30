import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LAB_CONFIG_SCHEMA,
  parseLabConfig,
  type LabConfig
} from "../src/lab-config.js";
import { runTerminalProductLab, type TerminalProductLabHooks } from "../src/e2b-terminal-lab.js";
import { verifyRun } from "../src/run.js";

// SLICE 2 deterministic safety net: drive the REAL live orchestration (dryRun:false) against a
// FAKE E2B module + a MOCK codex CLI at zero spend. The load-bearing assertions are the
// credential-boundary ones — the runtime key reaches ONLY the per-command envs, never
// Sandbox.create envs / metadata / the persisted bundle — because that is the inversion this
// lane introduces and the single most dangerous surface in the project.

// A fake key VALUE the test controls. Deliberately NOT secret-SHAPED (no sk-/ghp_ prefix) so it
// would NOT be caught by pattern redaction alone — only the literal scrub of known provisioned
// values catches it. If it survives into the bundle, the scrub failed.
const FAKE_RUNTIME_KEY = "FAKEKEY-terminal-slice2-do-not-leak-1234567890";

interface RecordedCreate {
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
}
interface RecordedRun {
  command: string;
  envs?: Record<string, string>;
}

function makeFakeModule(opts: {
  codexBehavior: (cmd: string, run: RecordedRun) => { exitCode: number; stdout?: string; emit?: (onStdout: (d: string) => void) => void };
  creates: RecordedCreate[];
  runs: RecordedRun[];
  killed: string[];
  listRemaining?: () => number; // sandboxes still listed after kill (default 0 = proven reclaimed)
}) {
  let counter = 0;
  return {
    Sandbox: {
      // Mirror the real @e2b/desktop overload: create(opts) OR create(template, opts). The terminal
      // route never passes a template, but the fake must accept the overload to type-check.
      async create(
        templateOrOptions: string | { envs?: Record<string, string>; metadata?: Record<string, string> },
        maybeOptions?: { envs?: Record<string, string>; metadata?: Record<string, string> }
      ) {
        const options = typeof templateOrOptions === "string" ? (maybeOptions ?? {}) : templateOrOptions;
        counter += 1;
        opts.creates.push({ ...(options.envs ? { envs: options.envs } : {}), ...(options.metadata ? { metadata: options.metadata } : {}) });
        const sandboxId = `fake-sandbox-${counter}`;
        return {
          sandboxId,
          commands: {
            async run(command: string, runOptions?: { envs?: Record<string, string>; onStdout?: (d: string) => void }) {
              const rec: RecordedRun = { command, ...(runOptions?.envs ? { envs: runOptions.envs } : {}) };
              opts.runs.push(rec);
              if (command.includes("codex")) {
                const behavior = opts.codexBehavior(command, rec);
                if (behavior.emit && runOptions?.onStdout) behavior.emit(runOptions.onStdout);
                else if (behavior.stdout && runOptions?.onStdout) runOptions.onStdout(behavior.stdout);
                return { exitCode: behavior.exitCode };
              }
              // readiness probe
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
      list(_options: unknown) {
        const remaining = opts.listRemaining ? opts.listRemaining() : 0;
        const paginator = {
          // When the test simulates an unproven teardown, OUR sandbox is still listed as running
          // (plus an unrelated one, to prove the filter ignores other sandboxes). When 0, the list
          // returns only an unrelated sandbox — which must NOT count as this run's teardown failing.
          hasNext: true,
          async nextItems() {
            paginator.hasNext = false; // single page, then exhausted (mirrors a real cursor advancing)
            const unrelated = { sandboxId: "unrelated-other-run", state: "running" as const };
            if (remaining > 0) return [{ sandboxId: `fake-sandbox-${counter}`, state: "running" as const }, unrelated];
            return [unrelated];
          }
        };
        return paginator;
      }
    }
  };
}

// Extract the per-run verdict nonce the lab embedded in the codex command, so the mock can echo
// a NONCE-VERIFIED marker exactly as a real agent would (the scorer rejects a bare marker).
function nonceFrom(command: string): string {
  const m = /MIMETIC_ACTOR_NONCE=([A-Za-z0-9-]+)/.exec(command);
  return m?.[1] ?? "unknown-nonce";
}

function liveConfig(overrides?: { caps?: Record<string, number> | null }): LabConfig {
  const raw: Record<string, unknown> = {
    schema: LAB_CONFIG_SCHEMA,
    id: "terminal-live-proof",
    title: "Terminal live proof",
    subject: {
      source: "terminal-product",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] }
    },
    actors: [{ type: "codex-exec", persona: "autonomous-creative-agent", mission: "Discover widgetsmith-cli from public surfaces." }],
    execution: { target: "e2b-terminal", runtimeAuth: "openai-env", timeoutMs: 600_000, terminal: { transport: "exec-stream", stdin: "disabled" } },
    scenario: { mode: "live", ...(overrides && "caps" in overrides ? (overrides.caps ? { caps: overrides.caps } : {}) : { caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } }) },
    policies: { allowPrivateRepoAccess: false, allowProviderCredentials: false, allowPaymentCredentials: false, allowGitHubMutation: false }
  };
  const parsed = parseLabConfig(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function baseEnv(): Record<string, string | undefined> {
  return {
    OPENAI_API_KEY: FAKE_RUNTIME_KEY,
    E2B_API_KEY: "FAKE-E2B-KEY-also-do-not-leak-0987654321",
    // Banned credentials present in the operator env — must NOT be forwarded into the sandbox.
    GITHUB_TOKEN: "FAKE-github-token-name-present-not-forwarded",
    DATABASE_URL: "FAKE-database-url-name-present-not-forwarded",
    STRIPE_SECRET_KEY: "FAKE-stripe-key"
  };
}

describe("runTerminalProductLab (live path, deterministic, no spend)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "mimetic-tp-live-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("injects the runtime key ONLY command-scoped, never into Sandbox.create or metadata or the bundle", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 1_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        codexBehavior: (cmd) => ({
          exitCode: 0,
          // A real agent echoes the nonce-verified verdict AND some output — INCLUDING the key value
          // (simulating an agent that transcribed its key into output). The scrub must catch it.
          stdout: `working on it... key seen: ${FAKE_RUNTIME_KEY}\nMIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=${nonceFrom(cmd)}\n`
        })
      })
    };

    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });

    // Sandbox created + killed; cleanup proven.
    expect(creates.length).toBe(1);
    expect(killed.length).toBe(1);
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);

    // CREDENTIAL BOUNDARY: Sandbox.create carried NO envs (key never sandbox-global) and no key in metadata.
    expect(creates[0]?.envs).toBeUndefined();
    expect(JSON.stringify(creates[0]?.metadata ?? {})).not.toContain(FAKE_RUNTIME_KEY);

    // The codex command run carried the key in its OWN envs (command-scoped) — and ONLY the runtime key.
    const codexRun = runs.find((r) => r.command.includes("codex"));
    expect(codexRun?.envs?.OPENAI_API_KEY).toBe(FAKE_RUNTIME_KEY);
    expect(Object.keys(codexRun?.envs ?? {})).toEqual(["OPENAI_API_KEY"]);
    // Deny-by-default: no banned credential reached the command envs.
    expect(codexRun?.envs).not.toHaveProperty("GITHUB_TOKEN");
    expect(codexRun?.envs).not.toHaveProperty("DATABASE_URL");
    expect(codexRun?.envs).not.toHaveProperty("STRIPE_SECRET_KEY");

    // The planted key value must be SCRUBBED out of every persisted artifact.
    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.simulations[0]?.progress).toBe(100);
    for (const file of ["run.json", "terminal-events.ndjson", "terminal-transcript.txt", "terminal-ledgers.json", "actor.json", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text).not.toContain(FAKE_RUNTIME_KEY);
      expect(text).not.toContain("FAKE-github-token-name-present-not-forwarded");
    }
    // The event stream actually captured output (scrubbed): the sentinel marker is gone, the
    // redaction placeholder is present.
    const events = await readFile(path.join(runDir, "terminal-events.ndjson"), "utf8");
    expect(events).toContain("[REDACTED_SECRET]");

    // The bundle verifies independently, including the new terminal-product evidence check.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(true);

    // Agent verdict surfaced as evidence; interventions ledger present + empty.
    expect(result.session?.status).toBe("passed");
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    expect(Array.isArray(ledgers.interventions)).toBe(true);
    expect(ledgers.interventions.length).toBe(0);
    expect(ledgers.cleanup.killed).toBe(true);
  });

  it("fails closed BEFORE creating a sandbox when no fail-closed cap is in force", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: () => ({ exitCode: 0 }) })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig({ caps: null }), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_TERMINAL_LAB_CAPS_MISSING");
    expect(creates.length).toBe(0); // the live key is never exercised without a cap
  });

  it("keeps a BLOCKED agent run (no verified verdict) structurally verifiable", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 2_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        // Exits 0 but emits NO nonce-verified verdict marker -> blocked evidence, not a hollow pass.
        codexBehavior: () => ({ exitCode: 0, stdout: "I could not find the product docs.\n" })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.session?.status).toBe("blocked");
    expect(killed.length).toBe(1);
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true); // the failure is the evidence; ledgers + cleanup present
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(true);
  });

  it("fails closed when teardown cannot be proven (sandbox still listed after kill)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        listRemaining: () => 1, // a sandbox is STILL listed after kill -> teardown not proven
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `MIMETIC_ACTOR_VERDICT=passed MIMETIC_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_TERMINAL_LAB_CLEANUP_UNPROVEN");
  });
});
