import { CommanderError } from "commander";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TERMINAL_AGENT_CAPABILITIES } from "../src/actor-contract.js";
import { actorRegistry, isTerminalActorDescriptor } from "../src/actor-registry.js";
import {
  LAB_CONFIG_SCHEMA,
  parseLabConfig,
  routesToComputerUse,
  routesToScriptedBrowser,
  routesToTerminalProduct,
  type LabConfig
} from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import { createProgram } from "../src/program.js";
import { verifyRun } from "../src/run.js";
import { runTerminalProductLab } from "../src/e2b-terminal-lab.js";
import { TERMINAL_AGENT_NOT_IMPLEMENTED_CODE } from "../src/terminal-agent-actor.js";

const ROOT = process.cwd();

function terminalConfig(overrides?: {
  actorType?: string;
  mission?: string;
  mode?: "dry-run" | "live";
  target?: "e2b-terminal" | undefined;
  publicSurfaces?: string[];
  caps?: Record<string, number>;
}): unknown {
  return {
    schema: LAB_CONFIG_SCHEMA,
    id: "terminal-routing-proof",
    title: "Terminal routing proof",
    subject: {
      source: "terminal-product",
      product: {
        name: "widgetsmith-cli",
        publicSurfaces: overrides?.publicSurfaces ?? ["https://example.com/widgetsmith", "https://example.com/widgetsmith/llms.txt"]
      }
    },
    actors: [{
      type: overrides?.actorType ?? "codex-exec",
      persona: "autonomous-creative-agent",
      mission: overrides?.mission ?? "Discover widgetsmith-cli from public surfaces and stay within no-spend caps."
    }],
    execution: {
      ...(overrides && "target" in overrides ? (overrides.target ? { target: overrides.target } : {}) : { target: "e2b-terminal" }),
      runtimeAuth: "openai-env",
      timeoutMs: 600_000,
      terminal: { transport: "exec-stream", stdin: "disabled" }
    },
    scenario: { mode: overrides?.mode ?? "dry-run", caps: overrides?.caps ?? { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } },
    policies: {
      allowPrivateRepoAccess: false,
      allowProviderCredentials: false,
      allowPaymentCredentials: false,
      allowGitHubMutation: false
    }
  };
}

function parsedTerminalConfig(overrides?: Parameters<typeof terminalConfig>[0]): LabConfig {
  const parsed = parseLabConfig(terminalConfig(overrides));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

// ---------------------------------------------------------------------------
// Registry + capability declaration (SLICE 1 honest metadata)
// ---------------------------------------------------------------------------

describe("terminal actor registration + keyPlacement metadata", () => {
  it("codex-exec is a registered terminal actor with in-sandbox-command-scoped keyPlacement", () => {
    const descriptor = actorRegistry["codex-exec"];
    expect(descriptor).toBeDefined();
    expect(isTerminalActorDescriptor(descriptor)).toBe(true);
    expect(descriptor.capabilities.lanes).toContain("terminal");
    // DECLARED metadata this slice (the engine enforcement is SLICE 2).
    expect(TERMINAL_AGENT_CAPABILITIES.keyPlacement).toBe("in-sandbox-command-scoped");
    expect(descriptor.capabilities.keyPlacement).toBe("in-sandbox-command-scoped");
    expect(TERMINAL_AGENT_CAPABILITIES.byoModel).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parse matrix (fail-closed cross-validation, invariant 6)
// ---------------------------------------------------------------------------

describe("terminal-product parse matrix", () => {
  it("terminal-product + terminal actor parses, consumes product/caps/mission/runtimeAuth (no inert warnings), routes to terminal", () => {
    const parsed = parseLabConfig(terminalConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The terminal route CONSUMES product/caps/mission/persona/runtimeAuth — none flagged inert.
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config.subject.product).toEqual({
      name: "widgetsmith-cli",
      publicSurfaces: ["https://example.com/widgetsmith", "https://example.com/widgetsmith/llms.txt"]
    });
    expect(parsed.config.execution?.runtimeAuth).toBe("openai-env");
    expect(parsed.config.execution?.terminal).toEqual({ transport: "exec-stream", stdin: "disabled" });
    expect(parsed.config.scenario?.caps).toEqual({ maxUsd: 0, maxJobs: 0, maxMinutes: 10 });
    expect(routesToTerminalProduct(parsed.config)).toBe(true);
    expect(selectLabBackend(parsed.config)).toBe("terminal");
  });

  it("target absent defaults to terminal (e2b-terminal is implied)", () => {
    const config = parsedTerminalConfig({ target: undefined });
    expect(config.execution?.target).toBeUndefined();
    expect(selectLabBackend(config)).toBe("terminal");
  });

  it("rejects terminal-product + a NON-terminal actor", () => {
    // A computer-use actor on a terminal-product subject hits the terminal-product block's guard.
    const cua = parseLabConfig(terminalConfig({ actorType: "openai-computer-use" }));
    expect(cua.ok).toBe(false);
    if (cua.ok) return;
    expect(cua.error.message).toContain("must be a registered terminal actor");
    // A free-form (non-registered) label also fails closed on the terminal-product route.
    expect(parseLabConfig(terminalConfig({ actorType: "not-a-real-actor" })).ok).toBe(false);
  });

  it("rejects clone-only fields (serve/clone/state/repos) on a terminal-product subject", () => {
    for (const field of [
      { serve: { start: "node x", url: "http://127.0.0.1:3000" } },
      { clone: { depth: 1 } },
      { state: { external: ["DATABASE_URL"] } },
      { repos: ["owner/repo"] }
    ]) {
      const raw = terminalConfig() as { subject: Record<string, unknown> };
      Object.assign(raw.subject, field);
      const parsed = parseLabConfig(raw);
      expect(parsed.ok, JSON.stringify(field)).toBe(false);
    }
  });

  it("rejects e2b-terminal target with a non-terminal-product subject (the substrate is terminal-only)", () => {
    // app-url block rejects it first (e2b-terminal != e2b-desktop) — still fail-closed.
    const viaAppUrl = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "wrong-substrate-appurl",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use" }],
      execution: { target: "e2b-terminal" }
    });
    expect(viaAppUrl.ok).toBe(false);
    // A clone subject hits the dedicated terminal-substrate guard.
    const viaClone = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "wrong-substrate-clone",
      subject: { source: "clone", repos: ["owner/repo"] },
      actors: [{ type: "mimetic-setup" }],
      execution: { target: "e2b-terminal" }
    });
    expect(viaClone.ok).toBe(false);
    if (viaClone.ok) return;
    expect(viaClone.error.message).toContain("requires `subject.source: terminal-product`");
  });

  it("rejects a terminal actor on a non-terminal-product subject", () => {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "wrong-subject",
      subject: { source: "this-repo" },
      actors: [{ type: "codex-exec" }]
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("terminal actors require `subject.source: terminal-product`");
  });

  it("rejects a non-e2b-terminal target on a terminal-product subject", () => {
    const parsed = parseLabConfig(terminalConfig({ target: "e2b-desktop" as unknown as "e2b-terminal" }));
    expect(parsed.ok).toBe(false);
  });

  it("rejects subject.appUrl on a terminal-product subject (it drives public surfaces, not one app)", () => {
    const raw = terminalConfig() as { subject: Record<string, unknown> };
    raw.subject.appUrl = "http://127.0.0.1:3000/";
    const parsed = parseLabConfig(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("subject.appUrl` does not apply to terminal-product");
  });

  it("validates publicSurfaces are http(s) URLs and product.name is a public-safe token", () => {
    expect(parseLabConfig(terminalConfig({ publicSurfaces: ["not-a-url"] })).ok).toBe(false);
    const badName = terminalConfig() as { subject: { product: { name: string } } };
    badName.subject.product.name = "-bad name";
    expect(parseLabConfig(badName).ok).toBe(false);
  });

  it("validates caps are non-negative numbers; rejects a negative cap", () => {
    const parsed = parseLabConfig(terminalConfig({ caps: { maxUsd: -1 } }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("non-negative number");
  });

  it("rejects an interactive PTY transport label and assisted stdin (honest-label + safety contract)", () => {
    const ptyRaw = terminalConfig() as { execution: { terminal: { transport: string } } };
    ptyRaw.execution.terminal.transport = "pty";
    expect(parseLabConfig(ptyRaw).ok).toBe(false);
    const stdinRaw = terminalConfig() as { execution: { terminal: { stdin: string } } };
    stdinRaw.execution.terminal.stdin = "sent";
    expect(parseLabConfig(stdinRaw).ok).toBe(false);
  });

  it("FORWARD-DECLARED: caps/product/runtimeAuth set on a NON-terminal route fire inert warnings", () => {
    // A this-repo subject that (illegally for that route) carries caps/runtimeAuth — these cannot
    // act there, so they must warn (invariant 6). product cannot be set on this-repo at all (it is
    // a parse error), so we exercise caps + runtimeAuth here; product is covered by the
    // never-falsely-flagged assertion below.
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "inert-fields",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona" }],
      scenario: { caps: { maxUsd: 0 } },
      execution: { runtimeAuth: "openai-env" }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const warned = parsed.warnings.join(" ");
    expect(warned).toContain("scenario.caps");
    expect(warned).toContain("execution.runtimeAuth");
  });

  it("FORWARD-DECLARED: on the terminal route, product/caps/runtimeAuth/mission are NOT falsely flagged inert", () => {
    const parsed = parseLabConfig(terminalConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const warned = parsed.warnings.join(" ");
    expect(warned).not.toContain("subject.product");
    expect(warned).not.toContain("scenario.caps");
    expect(warned).not.toContain("execution.runtimeAuth");
    expect(warned).not.toContain("actors[0].mission");
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: the other routes' warnings + routing still work
// ---------------------------------------------------------------------------

describe("REGRESSION: cua/scripted/local-app/synthetic/meta routing + warnings untouched", () => {
  it("routes the four prior backends as before, and the route predicates stay disjoint for terminal", () => {
    const cua = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use" }],
      execution: { target: "e2b-desktop" }
    });
    const scripted = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "scripted",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:5173/" },
      actors: [{ type: "scripted-browser", count: 2 }],
      scenario: { ref: "scripted-first-run" }
    });
    const synthetic = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "s",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona" }]
    });
    const meta = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "m",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "codex-app-server" }],
      execution: { target: "e2b-desktop" }
    });
    if (!cua.ok || !scripted.ok || !synthetic.ok || !meta.ok) throw new Error("fixture configs must parse");
    expect(selectLabBackend(cua.config)).toBe("cua");
    expect(selectLabBackend(scripted.config)).toBe("scripted");
    expect(selectLabBackend(synthetic.config)).toBe("synthetic");
    expect(selectLabBackend(meta.config)).toBe("meta");
    // Terminal predicate is false for every non-terminal config; cua/scripted predicates false for terminal.
    expect(routesToTerminalProduct(cua.config)).toBe(false);
    expect(routesToTerminalProduct(scripted.config)).toBe(false);
    const terminal = parsedTerminalConfig();
    expect(routesToComputerUse(terminal)).toBe(false);
    expect(routesToScriptedBrowser(terminal)).toBe(false);
  });

  it("scripted-browser mission inert warning still fires (regression on the warning branch)", () => {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "scripted-warn",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:5173/" },
      actors: [{ type: "scripted-browser", mission: "this cannot act here" }],
      scenario: { ref: "scripted-first-run" }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.join(" ")).toContain("actors[0].mission (the scripted-browser actor runs no model)");
  });
});

// ---------------------------------------------------------------------------
// Dry-run contract bundle (verified, honest, UNPINNED)
// ---------------------------------------------------------------------------

describe("runTerminalProductLab (dry-run)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-terminal-lab-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("dry-run produces a VERIFIED contract bundle: terminal stream, UNPINNED subject, caps/policies/auth declared", async () => {
    const outcome = await runLab(parsedTerminalConfig(), { cwd, dryRun: true });
    expect(outcome.backend).toBe("terminal");
    if (outcome.backend !== "terminal") return;
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.actor).toBe("codex-exec");
    expect(result.product).toBe("widgetsmith-cli");
    expect(result.observer?.ok).toBe(true);

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.schema).toBe("mimetic.run-bundle.v1");
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.cwd).toBe("[target-cwd]");
    expect(bundle.simulations[0].status).toBe("contract_proof_only");
    expect(bundle.simulations[0].streamKind).toBe("terminal");
    // The terminal stream is an honest CONTRACT placeholder: stdin disabled, empty tail, NOT pty.
    const stream = bundle.streams[0];
    expect(stream.kind).toBe("terminal");
    expect(stream.transport).toBe("snapshot");
    expect(stream.transport).not.toBe("pty");
    expect(stream.terminal.stdin).toBe("disabled");
    expect(stream.terminal.tail).toBe("");
    expect(stream.actor).toBeUndefined(); // no session ran (mirrors cua/scripted dry-run honesty)
    expect(bundle.review.verdict).toBe("contract_proof_only");

    // Invariant 5: UNPINNED subject provenance, declared explicitly; public surfaces recorded.
    const subjectEvent = bundle.events.find((e: { type: string }) => e.type === "terminal-lab.subject.declared");
    expect(subjectEvent.message).toContain("UNPINNED");
    expect(subjectEvent.message).toContain("widgetsmith-cli");
    // Deny-by-default credential posture + runtime-auth names-only declaration recorded.
    const credEvent = bundle.events.find((e: { type: string }) => e.type === "terminal-lab.credentials.declared");
    expect(credEvent.message).toContain("allowPrivateRepoAccess=false");
    expect(credEvent.message).toContain("openai-env");
    const capsEvent = bundle.events.find((e: { type: string }) => e.type === "terminal-lab.caps.declared");
    expect(capsEvent.message).toContain("maxUsd=0");
    // Mission recorded plaintext (public-safe author text); composed prompt bound by digest.
    expect(bundle.scenario.goal).toContain("widgetsmith-cli");
    expect(bundle.persona.sourceDigest).toMatch(/^[0-9a-f]{12}$/);

    // The dry-run bundle passes the EXISTING verifyRun (no terminal-specific checks yet — SLICE 2).
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);

    // latest.json points at THIS run so `verify --run latest` stays honest.
    const pointer = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", "latest.json"), "utf8"));
    expect(pointer.runId).toBe(result.runId);

    // Public safety: no absolute machine paths in any text artifact.
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(cwd);
      expect(text, file).not.toContain(tmpdir());
    }
  });

  it("a LIVE (non-dry-run) call returns the structured not-yet-implemented failure (not a crash) and writes no run", async () => {
    const outcome = await runLab(parsedTerminalConfig({ mode: "live" }), { cwd });
    expect(outcome.backend).toBe("terminal");
    if (outcome.backend !== "terminal") return;
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.error?.code).toBe(TERMINAL_AGENT_NOT_IMPLEMENTED_CODE);
    expect(result.error?.message).toContain("SLICE 2");
    expect(result.runId).toBe("not-created");
    // No sandbox, no spend, no artifacts.
    await expect(readdir(path.join(cwd, ".mimetic", "runs"))).rejects.toThrow();
  });

  it("rejects a non-terminal actor at the engine even if a config bypasses the parser", async () => {
    const tampered = { ...parsedTerminalConfig(), actors: [{ type: "codex-app-server" }] } as LabConfig;
    const result = await runTerminalProductLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_TERMINAL_LAB_ACTOR_UNSUPPORTED");
    expect(result.runId).toBe("not-created");
  });
});

// ---------------------------------------------------------------------------
// CLI: the committed terminal-product-demo lab through `lab run`, JSON + human
// ---------------------------------------------------------------------------

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    }
  });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "mimetic", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError && (error.code === "commander.helpDisplayed" || error.code === "commander.version"))) {
      throw error;
    }
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("mimetic lab run terminal-product-demo (CLI)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-terminal-cli-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture-app" }, null, 2));
    const lab = await readFile(path.join(ROOT, "mimetic", "labs", "terminal-product-demo.yaml"), "utf8");
    await mkdir(path.join(cwd, "mimetic", "labs"), { recursive: true });
    await writeFile(path.join(cwd, "mimetic", "labs", "terminal-product-demo.yaml"), lab, "utf8");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("dry-run --json emits the structured terminal lab result and verifies", async () => {
    const result = await runCli(["lab", "run", "terminal-product-demo", "--cwd", cwd, "--dry-run", "--json", "--no-open", "--run-id", "terminal-cli-json"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as { schema: string; ok: boolean; dryRun: boolean; actor: string; product: string; labId: string; runId: string };
    expect(envelope.schema).toBe("mimetic.terminal-lab-result.v1");
    expect(envelope.ok).toBe(true);
    expect(envelope.dryRun).toBe(true);
    expect(envelope.actor).toBe("codex-exec");
    expect(envelope.product).toBe("widgetsmith-cli");
    expect(envelope.labId).toBe("terminal-product-demo");
    expect(envelope.runId).toBe("terminal-cli-json");

    const verified = await verifyRun(cwd, "terminal-cli-json");
    expect(verified.ok).toBe(true);
  });

  it("dry-run human output names run/lab/actor/product", async () => {
    const result = await runCli(["lab", "run", "terminal-product-demo", "--cwd", cwd, "--dry-run", "--no-open", "--run-id", "terminal-cli-human"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mimetic lab terminal dry-run");
    expect(result.stdout).toContain("run: terminal-cli-human");
    expect(result.stdout).toContain("lab: terminal-product-demo");
    expect(result.stdout).toContain("actor: codex-exec");
    expect(result.stdout).toContain("product: widgetsmith-cli");
  });
});
