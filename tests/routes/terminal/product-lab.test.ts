import { CommanderError } from "commander";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TERMINAL_AGENT_CAPABILITIES } from "../../../src/actors/contract.js";
import { actorRegistry, isTerminalActorDescriptor } from "../../../src/actors/registry.js";
import { V2_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { parseStudy } from "../../../src/study/config.js";
import {
  isComputerUseComposition,
  isScriptedBrowserComposition,
  isTerminalProductComposition,
} from "../../../src/study/routing.js";
import { runStudyWith } from "../../../src/run-study.js";
import { routeOf } from "../../../src/study/plan.js";
import { createProgram } from "../../../src/cli/program.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { runTerminalPlan, runTerminalProductStudy } from "../../../src/routes/terminal/route.js";
import { planTerminalStudy } from "../../../src/routes/terminal/plan.js";

const ROOT = process.cwd();

function terminalConfig(overrides?: {
  actorType?: string;
  mission?: string;
  mode?: "dry-run" | "live";
  target?: "e2b-terminal" | undefined;
  publicSurfaces?: string[];
  caps?: Record<string, number>;
  runtimeAuth?: string;
}): unknown {
  return {
    schema: V2_SCHEMA,
    id: "terminal-routing-proof",
    title: "Terminal routing proof",
    subject: {
      source: "terminal-product",
      product: {
        name: "widgetsmith-cli",
        publicSurfaces: overrides?.publicSurfaces ?? [
          "https://example.com/widgetsmith",
          "https://example.com/widgetsmith/llms.txt",
        ],
      },
    },
    actors: [
      {
        type: overrides?.actorType ?? "codex-exec",
        persona: "autonomous-creative-agent",
        mission:
          overrides?.mission ??
          "Discover widgetsmith-cli from public surfaces and stay within no-spend caps.",
      },
    ],
    execution: {
      ...(overrides && "target" in overrides
        ? overrides.target
          ? { target: overrides.target }
          : {}
        : { target: "e2b-terminal" }),
      runtimeAuth: overrides?.runtimeAuth ?? "openai-env",
      timeoutMs: 600_000,
      terminal: { transport: "exec-stream", stdin: "disabled" },
    },
    scenario: {
      mode: overrides?.mode ?? "dry-run",
      caps: overrides?.caps ?? { maxUsd: 0, maxJobs: 0, maxMinutes: 10 },
    },
    policies: {
      allowPrivateRepoAccess: false,
      allowProviderCredentials: false,
      allowPaymentCredentials: false,
      allowGitHubMutation: false,
    },
  };
}

function parsedTerminalConfig(overrides?: Parameters<typeof terminalConfig>[0]): StudyConfig {
  const parsed = parseStudy(terminalConfig(overrides));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

// ---------------------------------------------------------------------------
// Registry + capability declaration
// ---------------------------------------------------------------------------

describe("terminal actor registration + keyPlacement metadata", () => {
  it("codex-exec is a registered terminal actor with in-sandbox-command-scoped keyPlacement", () => {
    const descriptor = actorRegistry["codex-exec"];
    expect(descriptor).toBeDefined();
    expect(isTerminalActorDescriptor(descriptor)).toBe(true);
    expect(descriptor.capabilities.lanes).toContain("terminal");
    expect(TERMINAL_AGENT_CAPABILITIES.keyPlacement).toBe("in-sandbox-command-scoped");
    expect(descriptor.capabilities.keyPlacement).toBe("in-sandbox-command-scoped");
    expect(TERMINAL_AGENT_CAPABILITIES.byoModel).toBe(false);
    // It runs only inside runTerminalProductStudy, so the registry gives it no session entry.
    expect("runSession" in descriptor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parse matrix (fail-closed cross-validation)
// ---------------------------------------------------------------------------

describe("terminal-product parse matrix", () => {
  it("accepts exact runtime versions and rejects ranges, tags, and misspelled runtime fields", () => {
    const base = terminalConfig() as Record<string, unknown> & {
      execution: Record<string, unknown>;
    };
    for (const runtime of [
      { version: "latest" },
      { version: "^0.153.3" },
      { version: "0.153.3; echo no" },
      { version: "0.153.3", package: "other" },
      {},
      "0.153.3",
    ]) {
      expect(parseStudy({ ...base, execution: { ...base.execution, runtime } }).ok).toBe(false);
    }
    const result = parseStudy({
      ...base,
      execution: { ...base.execution, runtime: { version: "0.153.3" } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.execution?.runtime).toEqual({ version: "0.153.3" });
      expect(result.warnings.join(" ")).not.toContain("execution.runtime");
    }
  });
  it("accepts opt-in openai-egress and rejects unknown runtime auth modes", () => {
    const parsed = parseStudy(terminalConfig({ runtimeAuth: "openai-egress" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.execution?.runtimeAuth).toBe("openai-egress");
    const invalid = parseStudy(terminalConfig({ runtimeAuth: "custom-proxy" }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.message).toContain("openai-env or openai-egress");
  });

  it("terminal-product + terminal actor parses, consumes product/caps/mission/runtimeAuth (no inert warnings), routes to terminal", () => {
    const parsed = parseStudy(terminalConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The terminal route consumes product/caps/mission/persona/runtimeAuth: none flagged inert.
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config.subject.product).toEqual({
      name: "widgetsmith-cli",
      publicSurfaces: [
        "https://example.com/widgetsmith",
        "https://example.com/widgetsmith/llms.txt",
      ],
    });
    expect(parsed.config.execution?.runtimeAuth).toBe("openai-env");
    expect(parsed.config.execution?.terminal).toEqual({
      transport: "exec-stream",
      stdin: "disabled",
    });
    expect(parsed.config.scenario?.caps).toEqual({ maxUsd: 0, maxJobs: 0, maxMinutes: 10 });
    expect(isTerminalProductComposition(parsed.config)).toBe(true);
    expect(routeOf(parsed.config)).toBe("terminal");
  });

  it("target absent defaults to terminal (e2b-terminal is implied)", () => {
    const config = parsedTerminalConfig({ target: undefined });
    expect(config.execution?.target).toBeUndefined();
    expect(routeOf(config)).toBe("terminal");
  });

  it("rejects terminal-product + a non-terminal actor", () => {
    // A computer-use actor on a terminal-product subject hits the terminal-product block's guard.
    const cua = parseStudy(terminalConfig({ actorType: "openai-computer-use" }));
    expect(cua.ok).toBe(false);
    if (cua.ok) return;
    expect(cua.error.message).toContain("must be a registered terminal actor");
    // A free-form (non-registered) label also fails closed on the terminal-product route.
    expect(parseStudy(terminalConfig({ actorType: "not-a-real-actor" })).ok).toBe(false);
  });

  it("rejects clone-only fields (serve/clone/state/repos) on a terminal-product subject", () => {
    for (const field of [
      { serve: { start: "node x", url: "http://127.0.0.1:3000" } },
      { clone: { depth: 1 } },
      { state: { external: ["DATABASE_URL"] } },
      { repos: ["owner/repo"] },
    ]) {
      const raw = terminalConfig() as { subject: Record<string, unknown> };
      Object.assign(raw.subject, field);
      const parsed = parseStudy(raw);
      expect(parsed.ok, JSON.stringify(field)).toBe(false);
    }
  });

  it("rejects e2b-terminal target with a non-terminal-product subject (the substrate is terminal-only)", () => {
    // app-url block rejects it first (e2b-terminal != e2b-desktop): still fail-closed.
    const viaAppUrl = parseStudy({
      schema: V2_SCHEMA,
      id: "wrong-substrate-appurl",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use" }],
      execution: { target: "e2b-terminal" },
    });
    expect(viaAppUrl.ok).toBe(false);
    // A clone subject is refused by the clone target guard, which names the target it needs.
    const viaClone = parseStudy({
      schema: V2_SCHEMA,
      id: "wrong-substrate-clone",
      subject: { source: "clone", repos: ["owner/repo"] },
      actors: [{ type: "humanish-setup" }],
      execution: { target: "e2b-terminal" },
    });
    expect(viaClone.ok).toBe(false);
    if (viaClone.ok) return;
    expect(viaClone.error.message).toContain(
      "clone subjects require `execution.target: e2b-desktop`",
    );
  });

  it("rejects a terminal actor on a non-terminal-product subject", () => {
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "wrong-subject",
      subject: { source: "this-repo" },
      actors: [{ type: "codex-exec" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain(
      "terminal actors require `subject.source: terminal-product`",
    );
  });

  it("rejects a non-e2b-terminal target on a terminal-product subject", () => {
    const parsed = parseStudy(
      terminalConfig({ target: "e2b-desktop" as unknown as "e2b-terminal" }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects subject.appUrl on a terminal-product subject (it drives public surfaces, not one app)", () => {
    const raw = terminalConfig() as { subject: Record<string, unknown> };
    raw.subject.appUrl = "http://127.0.0.1:3000/";
    const parsed = parseStudy(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain(
      "subject.appUrl` does not apply to a terminal-product subject",
    );
  });

  it("validates publicSurfaces are http(s) URLs and product.name is a public-safe token", () => {
    expect(parseStudy(terminalConfig({ publicSurfaces: ["not-a-url"] })).ok).toBe(false);
    const badName = terminalConfig() as { subject: { product: { name: string } } };
    badName.subject.product.name = "-bad name";
    expect(parseStudy(badName).ok).toBe(false);
  });

  it("validates caps are non-negative numbers; rejects a negative cap", () => {
    const parsed = parseStudy(terminalConfig({ caps: { maxUsd: -1 } }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("non-negative number");
  });

  it("rejects an interactive PTY transport label and assisted stdin (protocol-label + safety contract)", () => {
    const ptyRaw = terminalConfig() as { execution: { terminal: { transport: string } } };
    ptyRaw.execution.terminal.transport = "pty";
    expect(parseStudy(ptyRaw).ok).toBe(false);
    const stdinRaw = terminalConfig() as { execution: { terminal: { stdin: string } } };
    stdinRaw.execution.terminal.stdin = "sent";
    expect(parseStudy(stdinRaw).ok).toBe(false);
  });

  it("forward-declared: caps/product/runtimeAuth set on a non-terminal route fire inert warnings", () => {
    // A this-repo subject that (illegally for that route) carries caps/runtimeAuth: these cannot
    // act there, so they must warn. product cannot be set on this-repo at all (it is
    // a parse error), so we exercise caps + runtimeAuth here; product is covered by the
    // never-falsely-flagged assertion below.
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "inert-fields",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona" }],
      scenario: { caps: { maxUsd: 0 } },
      execution: { runtimeAuth: "openai-env" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const warned = parsed.warnings.join(" ");
    expect(warned).toContain("scenario.caps");
    expect(warned).toContain("execution.runtimeAuth");
  });

  it("forward-declared: on the terminal route, product/caps/runtimeAuth/mission are not falsely flagged inert", () => {
    const parsed = parseStudy(terminalConfig());
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
// The other routes' warnings and routing still work
// ---------------------------------------------------------------------------

describe("cua/scripted/local-app/synthetic/meta routing + warnings untouched", () => {
  it("routes the four prior backends as before, and the route predicates stay disjoint for terminal", () => {
    const cua = parseStudy({
      schema: V2_SCHEMA,
      id: "cua",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use" }],
      execution: { target: "e2b-desktop" },
    });
    const scripted = parseStudy({
      schema: V2_SCHEMA,
      id: "scripted",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:5173/" },
      actors: [{ type: "scripted-browser", count: 2 }],
      scenario: { ref: "scripted-first-run" },
    });
    const synthetic = parseStudy({
      schema: V2_SCHEMA,
      id: "s",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona" }],
    });
    if (!cua.ok || !scripted.ok || !synthetic.ok) throw new Error("fixture configs must parse");
    expect(routeOf(cua.config)).toBe("computer-use");
    expect(routeOf(scripted.config)).toBe("scripted");
    expect(routeOf(synthetic.config)).toBe("preview");
    // Terminal predicate is false for every non-terminal config; cua/scripted predicates false for terminal.
    expect(isTerminalProductComposition(cua.config)).toBe(false);
    expect(isTerminalProductComposition(scripted.config)).toBe(false);
    const terminal = parsedTerminalConfig();
    expect(isComputerUseComposition(terminal)).toBe(false);
    expect(isScriptedBrowserComposition(terminal)).toBe(false);
  });

  it("scripted-browser mission inert warning still fires", () => {
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "scripted-warn",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:5173/" },
      actors: [{ type: "scripted-browser", mission: "this cannot act here" }],
      scenario: { ref: "scripted-first-run" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.join(" ")).toContain(
      "actors[0].mission (the scripted-browser actor runs no model)",
    );
  });
});

// ---------------------------------------------------------------------------
// Dry-run contract bundle (verified, unpinned)
// ---------------------------------------------------------------------------

describe("runTerminalProductLab (dry-run)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-terminal-lab-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("refuses a run id already in use and names the actor", async () => {
    const config = parsedTerminalConfig();
    const first = await runTerminalProductStudy({ cwd, config, dryRun: true, runId: "taken" });
    expect(first.ok).toBe(true);
    const second = await runTerminalProductStudy({ cwd, config, dryRun: true, runId: "taken" });
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("HUMANISH_RUN_ID_IN_USE");
    expect(second.actor).toBe("codex-exec");
  });

  it("runs a plan alone: the bundle records the plan's title, mission, stdin and runtime auth", async () => {
    const planned = planTerminalStudy(parsedTerminalConfig(), { dryRun: true });
    if (!planned.ok || !planned.plan.dryRun) throw new Error("expected a dry terminal plan");
    const plan = {
      ...planned.plan,
      title: "Planned title",
      mission: "Planned mission.",
      stdin: "planned" as const,
      runtime: { ...planned.plan.runtime, auth: "openai-egress" as const },
    };
    const result = await runTerminalPlan(plan, { cwd });
    expect(result.ok).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.scenario.title).toBe("Planned title");
    expect(bundle.streams[0].assignment).toEqual({ mission: "Planned mission." });
    expect(bundle.streams[0].terminal.stdin).toBe("planned");
    const credentials = bundle.events.find(
      (event: { type: string }) => event.type === "terminal-lab.credentials.declared",
    );
    expect(credentials.message).toContain("openai-egress");
  });

  it.each(["OPENAI_API_KEY", "CODEX_API_KEY", "E2B_API_KEY"])(
    "redacts a known %s value from dry-run assignment and study context",
    async (keyName) => {
      const secret = "synthetic-opaque-terminal-secret";
      const config = parsedTerminalConfig({ mission: `Discover the product using ${secret}.` });
      const result = await runTerminalProductStudy({
        cwd,
        config,
        dryRun: true,
        env: { [keyName]: secret },
      });
      expect(result.ok).toBe(true);
      const runDir = path.join(cwd, ".humanish", "runs", result.runId);
      for (const file of ["run.json", "observer/observer-data.json"]) {
        const text = await readFile(path.join(runDir, file), "utf8");
        expect(text).not.toContain(secret);
        expect(JSON.parse(text).streams[0].assignment).toEqual({
          mission: "Discover the product using [REDACTED_SECRET].",
        });
      }
      expect(config.actors[0]!.mission).toContain(secret);
      expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
    },
  );

  it("dry-run produces a verified contract bundle: terminal stream, unpinned subject, caps/policies/auth declared", async () => {
    const outcome = await runStudyWith(parsedTerminalConfig(), { cwd, dryRun: true });
    expect(outcome.route).toBe("terminal");
    if (outcome.route !== "terminal") return;
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.actor).toBe("codex-exec");
    expect(result.product).toBe("widgetsmith-cli");
    expect(result.observer?.ok).toBe(true);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.schema).toBe("humanish.run-bundle.v1");
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.cwd).toBe("[target-cwd]");
    expect(bundle.simulations[0].status).toBe("contract_proof_only");
    expect(bundle.simulations[0].streamKind).toBe("terminal");
    // The terminal stream is a contract placeholder: stdin disabled, empty tail, not pty.
    const stream = bundle.streams[0];
    expect(stream.assignment).toEqual({
      mission: "Discover widgetsmith-cli from public surfaces and stay within no-spend caps.",
    });
    expect(stream.kind).toBe("terminal");
    expect(stream.transport).toBe("snapshot");
    expect(stream.transport).not.toBe("pty");
    expect(stream.terminal.stdin).toBe("disabled");
    expect(stream.terminal.tail).toBe("");
    expect(stream.actor).toBeUndefined(); // no session ran, so no actor trace
    expect(bundle.review.verdict).toBe("contract_proof_only");
    const publicTruth = JSON.stringify({
      currentStep: bundle.simulations[0].currentStep,
      events: bundle.events,
      review: bundle.review,
      redaction: bundle.redaction,
    });
    expect(publicTruth).toContain("did not execute an agent or prove live behavior");
    expect(publicTruth).toContain(
      "checks the evidence shape only, not live behavior, scale, or adoption",
    );
    expect(publicTruth).not.toContain("receipt");
    expect(publicTruth).not.toContain("SLICE 2");

    // Unpinned subject provenance, declared explicitly; public surfaces recorded.
    const subjectEvent = bundle.events.find(
      (e: { type: string }) => e.type === "terminal-lab.subject.declared",
    );
    expect(subjectEvent.message).toContain("unpinned");
    expect(subjectEvent.message).toContain("widgetsmith-cli");
    // Deny-by-default credential posture + runtime-auth names-only declaration recorded.
    const credEvent = bundle.events.find(
      (e: { type: string }) => e.type === "terminal-lab.credentials.declared",
    );
    expect(credEvent.message).toContain("allowPrivateRepoAccess=false");
    expect(credEvent.message).toContain("openai-env");
    const capsEvent = bundle.events.find(
      (e: { type: string }) => e.type === "terminal-lab.caps.declared",
    );
    expect(capsEvent.message).toContain("maxUsd=0");
    // Mission recorded plaintext (public-safe author text); composed prompt bound by digest.
    expect(bundle.scenario.goal).toContain("widgetsmith-cli");
    expect(bundle.persona.sourceDigest).toMatch(/^[0-9a-f]{12}$/);

    // The dry-run bundle passes verifyRun without pretending that live artifacts exist.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);

    // latest.json points at this run so `verify --run latest` verifies it.
    const pointer = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", "latest.json"), "utf8"),
    );
    expect(pointer.runId).toBe(result.runId);

    // Public safety: no absolute machine paths in any text artifact.
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(cwd);
      expect(text, file).not.toContain(tmpdir());
    }
  });

  it("a live (non-dry-run) call with no runtime key fails closed before any sandbox", async () => {
    // Without a runtime key in the (empty) env, the shipped live backend fails closed at the
    // credential-resolution step: no sandbox, no spend, no artifacts. (The full
    // live path + credential boundary is covered deterministically in e2b-terminal-lab.test.ts.)
    const outcome = await runStudyWith(parsedTerminalConfig({ mode: "live" }), {
      cwd,
      env: {},
    });
    expect(outcome.route).toBe("terminal");
    if (outcome.route !== "terminal") return;
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.dryRun).toBe(false);
    // It is no longer the not-implemented stub: the live path is wired and fails closed on the
    // missing runtime key (never reaching sandbox creation).
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_RUNTIME_AUTH_MISSING");
    expect(result.runId).toBe("not-created");
    // No sandbox, no spend, no artifacts.
    await expect(readdir(path.join(cwd, ".humanish", "runs"))).rejects.toThrow();
  });

  it("rejects a non-terminal actor at the engine even if a config bypasses the parser", async () => {
    const tampered = {
      ...parsedTerminalConfig(),
      actors: [{ type: "codex-app-server" }],
    } as StudyConfig;
    const result = await runTerminalProductStudy({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_ACTOR_UNSUPPORTED");
    expect(result.runId).toBe("not-created");
  });
});

// ---------------------------------------------------------------------------
// CLI: the committed terminal-product-demo lab through `lab run`, JSON + human
// ---------------------------------------------------------------------------

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (
      !(
        error instanceof CommanderError &&
        (error.code === "commander.helpDisplayed" || error.code === "commander.version")
      )
    ) {
      throw error;
    }
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("humanish lab run terminal-product-demo (CLI)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-terminal-cli-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "fixture-app" }, null, 2),
    );
    const lab = await readFile(
      path.join(ROOT, "humanish", "studies", "terminal-product-demo.yaml"),
      "utf8",
    );
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
    await writeFile(path.join(cwd, "humanish", "labs", "terminal-product-demo.yaml"), lab, "utf8");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps the committed demo accurate about the shipped live route and its dry-run fixture scope", async () => {
    const lab = await readFile(
      path.join(ROOT, "humanish", "studies", "terminal-product-demo.yaml"),
      "utf8",
    );
    expect(lab).toMatch(
      /does not exercise the live terminal-product route or its\s+command-scoped\s+credential\s+boundary/,
    );
    expect(lab).toMatch(
      /fictional\s+mock\s+CLI\s+is\s+not\s+evidence\s+of\s+a\s+live\s+or\s+adopter\s+run/,
    );
    expect(lab).not.toMatch(/SLICE\s+[12]/);
  });

  it("dry-run --json emits the structured terminal lab result and verifies", async () => {
    const result = await runCli([
      "lab",
      "run",
      "terminal-product-demo",
      "--cwd",
      cwd,
      "--dry-run",
      "--json",
      "--no-open",
      "--run-id",
      "terminal-cli-json",
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      schema: string;
      ok: boolean;
      dryRun: boolean;
      actor: string;
      product: string;
      labId: string;
      runId: string;
    };
    expect(envelope.schema).toBe("humanish.study-result.v1");
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
    const result = await runCli([
      "lab",
      "run",
      "terminal-product-demo",
      "--cwd",
      cwd,
      "--dry-run",
      "--no-open",
      "--run-id",
      "terminal-cli-human",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("humanish run terminal-product-demo: dry run finished");
    expect(result.stdout).toContain("route: terminal");
    expect(result.stdout).toContain("run: terminal-cli-human");
    expect(result.stdout).toContain("actor: codex-exec");
    expect(result.stdout).toContain("product: widgetsmith-cli");
  });
});
