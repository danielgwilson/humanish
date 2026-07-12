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
  timeoutMs?: number;
}

function makeFakeModule(opts: {
  codexBehavior: (cmd: string, run: RecordedRun) => { exitCode: number; stdout?: string; emit?: (onStdout: (d: string) => void) => void };
  creates: RecordedCreate[];
  runs: RecordedRun[];
  killed: string[];
  /** Records every Sandbox.list(id) call. Teardown must NEVER call it (by-id proof only, never
   *  a re-list); tests assert this array stays empty after a run. */
  listCalls?: string[];
  /** When set, Sandbox.kill(id) THROWS instead of resolving (the "kill itself failed" case ->
   *  fail-closed remaining=-1). */
  killThrows?: (sandboxId: string) => { message?: string } | undefined;
  /** Sandbox.kill(id)'s own resolved boolean ("found and killed", per the real SDK) when it does
   *  not throw. Defaults to true. */
  killResult?: boolean;
  /**
   * Controls Sandbox.getInfo(id): "not-found" throws a SandboxNotFoundError-shaped error (the
   * by-id CONFIRMED-reclaimed case, remaining=0 -- this is the default, matching a genuinely
   * reclaimed sandbox); "running"/"paused" returns a live SandboxInfo (NOT confirmed reclaimed,
   * remaining=1).
   */
  getInfoState?: "not-found" | "running" | "paused";
  /** Omit Sandbox.getInfo entirely, simulating an older SDK (kill(id)'s own boolean becomes the
   *  sole by-id proof). */
  noGetInfo?: boolean;
  /**
   * Throws a CommandExitError-shaped error (real-SDK-accurate: the real @e2b/desktop Sandbox
   * throws on any non-zero exit rather than returning one) for the runtime-bootstrap command.
   * Mirrors tests/cua-actor-lab.test.ts's makeFakeSandbox convention, so the bootstrap-failure
   * path is covered by the THROWING shape, not just a structural non-zero return.
   */
  bootstrapThrow?: (command: string) => { exitCode?: number; stderr?: string; message?: string } | undefined;
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
            async run(
              command: string,
              runOptions?: { envs?: Record<string, string>; timeoutMs?: number; onStdout?: (d: string) => void }
            ) {
              const rec: RecordedRun = {
                command,
                ...(runOptions?.envs ? { envs: runOptions.envs } : {}),
                ...(runOptions?.timeoutMs === undefined ? {} : { timeoutMs: runOptions.timeoutMs })
              };
              opts.runs.push(rec);
              if (command.includes("codex")) {
                const behavior = opts.codexBehavior(command, rec);
                if (behavior.emit && runOptions?.onStdout) behavior.emit(runOptions.onStdout);
                else if (behavior.stdout && runOptions?.onStdout) runOptions.onStdout(behavior.stdout);
                return { exitCode: behavior.exitCode };
              }
              if (command.includes("nodesource.com")) {
                // The UNKEYED runtime-bootstrap command (ensure Node/npm before the keyed exec).
                const thrown = opts.bootstrapThrow?.(command);
                if (thrown) {
                  throw Object.assign(new Error(thrown.message ?? `exit status ${thrown.exitCode ?? 1}`), {
                    name: "CommandExitError",
                    ...(thrown.exitCode === undefined ? {} : { exitCode: thrown.exitCode }),
                    ...(thrown.stderr === undefined ? {} : { stderr: thrown.stderr })
                  });
                }
                return { exitCode: 0, stdout: "" };
              }
              // readiness probe
              if (runOptions?.onStdout) runOptions.onStdout("HUMANISH_SHELL_READY\n");
              return { exitCode: 0, stdout: "HUMANISH_SHELL_READY\n" };
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
        const thrown = opts.killThrows?.(sandboxId);
        if (thrown) {
          throw Object.assign(new Error(thrown.message ?? "kill failed"), { name: "Error" });
        }
        return opts.killResult ?? true;
      },
      ...(opts.noGetInfo
        ? {}
        : {
            async getInfo(sandboxId: string) {
              const state = opts.getInfoState ?? "not-found";
              if (state === "not-found") {
                // A real reclaimed sandbox: the SDK throws SandboxNotFoundError, detected by
                // `.name` (see isSandboxNotFoundError in src/e2b-desktop-launch.ts).
                throw Object.assign(new Error(`Sandbox ${sandboxId} not found`), { name: "SandboxNotFoundError" });
              }
              return { sandboxId, state };
            }
          }),
      // Kept only for structural parity with the real SDK (older callers, e.g. lab-preflight.ts,
      // still use it for their own purposes). Teardown must NEVER call this -- see listCalls.
      list(_options: unknown) {
        opts.listCalls?.push("called");
        const paginator = {
          hasNext: false,
          async nextItems() { return []; }
        };
        return paginator;
      }
    }
  };
}

// Extract the per-run verdict nonce the lab embedded in the codex command, so the mock can echo
// a NONCE-VERIFIED marker exactly as a real agent would (the scorer rejects a bare marker).
function nonceFrom(command: string): string {
  const m = /HUMANISH_ACTOR_NONCE=([A-Za-z0-9-]+)/.exec(command);
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
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-live-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("injects the runtime key ONLY command-scoped, never into Sandbox.create or metadata or the bundle", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 1_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        codexBehavior: (cmd) => ({
          exitCode: 0,
          // A real agent echoes the nonce-verified verdict AND some output — INCLUDING the key value
          // (simulating an agent that transcribed its key into output). The scrub must catch it.
          stdout: `working on it... key seen: ${FAKE_RUNTIME_KEY}\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`
        })
      })
    };

    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });

    // Sandbox created + killed; cleanup proven BY EXACT ID (getInfo(id) confirms
    // SandboxNotFoundError). Sandbox.list is NEVER called on the teardown path.
    expect(creates.length).toBe(1);
    expect(killed.length).toBe(1);
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(listCalls.length).toBe(0);

    // CREDENTIAL BOUNDARY: Sandbox.create carried NO envs (key never sandbox-global) and no key in metadata.
    expect(creates[0]?.envs).toBeUndefined();
    expect(JSON.stringify(creates[0]?.metadata ?? {})).not.toContain(FAKE_RUNTIME_KEY);

    // The codex command run carried the key in its OWN envs (command-scoped) — and ONLY the runtime key.
    const codexRun = runs.find((r) => r.command.includes("codex"));
    // Pinned via npx, never an ambient/preinstalled `codex` binary (issue #159).
    expect(codexRun?.command).toContain("npx -y @openai/codex@latest exec");
    expect(codexRun?.command).not.toContain("codex exec"); // never the bare ambient-binary form
    // codex's inner sandbox is bypassed: the E2B sandbox is the trust boundary.
    expect(codexRun?.command).toContain("--dangerously-bypass-approvals-and-sandbox");
    // Preference order: only OPENAI_API_KEY was set, so its value is injected under BOTH names,
    // so codex exec's documented single-invocation auth channel (CODEX_API_KEY) is populated too.
    expect(codexRun?.envs?.OPENAI_API_KEY).toBe(FAKE_RUNTIME_KEY);
    expect(codexRun?.envs?.CODEX_API_KEY).toBe(FAKE_RUNTIME_KEY);
    expect(Object.keys(codexRun?.envs ?? {}).slice().sort()).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
    // Deny-by-default: no banned credential reached the command envs.
    expect(codexRun?.envs).not.toHaveProperty("GITHUB_TOKEN");
    expect(codexRun?.envs).not.toHaveProperty("DATABASE_URL");
    expect(codexRun?.envs).not.toHaveProperty("STRIPE_SECRET_KEY");

    // The planted key value must be SCRUBBED out of every persisted artifact.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
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
    // The recorded env-name metadata lists exactly the names actually injected.
    const codexEntry = ledgers.commandLog.find((entry: { label: string }) => entry.label === "codex-exec");
    expect(codexEntry?.envNames.slice().sort()).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
  });

  it("runs the runtime bootstrap UNKEYED, before the keyed codex exec, with an explicit generous timeout", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 4_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });

    const readinessIndex = runs.findIndex((r) => r.command.includes("HUMANISH_SHELL_READY"));
    const bootstrapIndex = runs.findIndex((r) => r.command.includes("nodesource.com"));
    const codexIndex = runs.findIndex((r) => r.command.includes("codex"));
    expect(readinessIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThan(readinessIndex);
    expect(codexIndex).toBeGreaterThan(bootstrapIndex);

    // UNKEYED: the runtime-bootstrap command carries no envs at all (no runtime key touches it).
    expect(runs[bootstrapIndex]?.envs).toBeUndefined();
    // Explicit generous timeout: the SDK's commands.run default (60s) is far too short for an apt install.
    expect(runs[bootstrapIndex]?.timeoutMs).toBe(300_000);

    expect(result.session?.status).toBe("passed");
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    const bootstrapEvent = ledgers.lifecycle.find((entry: { event: string }) => entry.event === "terminal-lab.runtime.bootstrapped");
    expect(bootstrapEvent).toBeDefined();
    expect(String(bootstrapEvent?.message)).not.toMatch(/FAILED/);
  });

  it("fails the lane closed via a structured error (not a raw throw) when the runtime bootstrap command throws a CommandExitError", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 5_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        // If this ever runs, the lane failed to fail closed on the bootstrap error first.
        codexBehavior: () => ({ exitCode: 0, stdout: "HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=should-not-run\n" }),
        // Real-SDK-accurate: the real @e2b/desktop Sandbox THROWS a CommandExitError on a
        // non-zero exit rather than returning one; cover the THROWING shape, not just a
        // structural non-zero return.
        bootstrapThrow: () => ({ exitCode: 1, stderr: "sudo: a password is required" })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });

    // The keyed exec is NEVER attempted once the runtime bootstrap has failed.
    expect(runs.some((r) => r.command.includes("codex"))).toBe(false);

    // Fails closed as a structured lane result: the run completes (no unhandled throw escapes
    // the lane), is recorded as a harness error, and cleanup still runs.
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_LAB_FAILED");
    expect(result.session?.status).toBe("failed");
    expect(result.session?.completionReason).toBe("harness_error");
    expect(killed.length).toBe(1);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    const bootstrapEvent = ledgers.lifecycle.find((entry: { event: string }) => entry.event === "terminal-lab.runtime.bootstrapped");
    expect(bootstrapEvent).toBeDefined();
    expect(String(bootstrapEvent?.message)).toMatch(/FAILED/);
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
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_LAB_CAPS_MISSING");
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

  it("fails closed when teardown cannot be proven by id (Sandbox.getInfo(id) still reports the sandbox running)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        // kill(id) resolves, but getInfo(id) STILL reports the sandbox running -> not confirmed
        // reclaimed by id. Never a re-list.
        getInfoState: "running",
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN");
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining).toBe(1);
    expect(killed.length).toBe(1);
    expect(listCalls.length).toBe(0);
  });

  it("fails closed when Sandbox.kill(id) itself throws (remaining=-1, never a re-list)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_500,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        killThrows: () => ({ message: "provider timeout killing sandbox" }),
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN");
    expect(result.sandbox?.killed).toBe(false);
    expect(result.sandbox?.remaining).toBe(-1);
    expect(listCalls.length).toBe(0);
  });

  it("confirms reclamation by id when Sandbox.getInfo(id) throws SandboxNotFoundError (remaining=0, never a re-list)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_700,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        getInfoState: "not-found", // the exact sandbox no longer exists -> confirmed reclaimed
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(listCalls.length).toBe(0);
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.cleanup.reason).toMatch(/SandboxNotFoundError/);
  });

  it("falls back to kill(id)'s own boolean as proof when the installed SDK has no Sandbox.getInfo (never a re-list)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_900,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        noGetInfo: true, // an older SDK: kill(id) returning true is the sole by-id proof
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(listCalls.length).toBe(0);
  });

  it("treats kill(id) returning false (404: exact id already gone) as confirmed reclaimed, no getInfo (never a re-list)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_950,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        noGetInfo: true,
        // The server-side kill-on-timeout raced ahead: the exact sandbox is already gone, so
        // kill(id) returns false (404). That is proof of absence, not an unproven teardown.
        killResult: false,
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(listCalls.length).toBe(0);
  });

  it("treats kill(id)=false confirmed by getInfo SandboxNotFoundError as reclaimed (remaining=0)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_960,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        killResult: false,
        getInfoState: "not-found",
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(listCalls.length).toBe(0);
  });
});

describe("runtime-auth key allowlist preference (CODEX_API_KEY over OPENAI_API_KEY)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-live-authorder-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("injects CODEX_API_KEY alone when only CODEX_API_KEY is set", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const env = baseEnv();
    delete env.OPENAI_API_KEY;
    env.CODEX_API_KEY = FAKE_RUNTIME_KEY;
    const hooks: TerminalProductLabHooks = {
      env,
      now: () => 6_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    const codexRun = runs.find((r) => r.command.includes("codex"));
    expect(codexRun?.envs).toEqual({ CODEX_API_KEY: FAKE_RUNTIME_KEY });
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.commandLog[0]?.envNames).toEqual(["CODEX_API_KEY"]);
  });

  it("injects the value under BOTH CODEX_API_KEY and OPENAI_API_KEY when only OPENAI_API_KEY is set", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(), // OPENAI_API_KEY only, no CODEX_API_KEY
      now: () => 7_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    const codexRun = runs.find((r) => r.command.includes("codex"));
    expect(codexRun?.envs).toEqual({ CODEX_API_KEY: FAKE_RUNTIME_KEY, OPENAI_API_KEY: FAKE_RUNTIME_KEY });
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.commandLog[0]?.envNames.slice().sort()).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
  });

  it("prefers CODEX_API_KEY's value when both CODEX_API_KEY and OPENAI_API_KEY are set", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const env = baseEnv();
    env.CODEX_API_KEY = "FAKEKEY-codex-wins-0000000000000000";
    const hooks: TerminalProductLabHooks = {
      env,
      now: () => 8_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    const codexRun = runs.find((r) => r.command.includes("codex"));
    expect(codexRun?.envs).toEqual({ CODEX_API_KEY: "FAKEKEY-codex-wins-0000000000000000" });
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.commandLog[0]?.envNames).toEqual(["CODEX_API_KEY"]);
  });
});
