import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// #316 CLI-loadable adopter scorer. The loader itself is CLI-internal (declared via review.scorer.ref
// / --scorer), so tests reach it through the deep module; the adopter-facing TYPES ship on the barrel.
import { loadAdapterScorer } from "../src/adapter-scorer-loader.js";
import type { AdapterScorerModule, AdapterScoringContext } from "../src/index.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runTerminalProductLab, type TerminalProductLabHooks } from "../src/e2b-terminal-lab.js";
import { applyBrowserAdapterHooks } from "../src/adapter-extension.js";
import type { E2BDesktopModule } from "../src/e2b-desktop-launch.js";
import { verifyRun } from "../src/run.js";
import type { BrowserLabScoringContext, RunAdapterScore, RunBundle } from "../src/index.js";

// ---------------------------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------------------------

const PASS_SCORER = `export function score(ctx) {
  return { schema: "humanish.adapter-score.v1", namespace: "example-ns", status: "pass", score: 90, summary: "adopter rubric ok" };
}
`;

async function writeScorer(cwd: string, relPath: string, contents: string): Promise<string> {
  const abs = path.join(cwd, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, contents, "utf8");
  return relPath;
}

// A compact fake @e2b/desktop module + mock codex CLI (mirrors the terminal-product-adapter-seam
// pattern) so the LIVE terminal orchestration runs deterministically at $0.
const FAKE_RUNTIME_KEY = "FAKEKEY-scorer-loader-do-not-leak-1234567890";

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

function terminalConfig(extra?: Record<string, unknown>): LabConfig {
  const raw: Record<string, unknown> = {
    schema: LAB_CONFIG_SCHEMA,
    id: "terminal-scorer-proof",
    title: "Terminal scorer proof",
    subject: { source: "terminal-product", product: { name: "widget-cli", publicSurfaces: ["https://example.com/widget"] } },
    actors: [{ type: "codex-exec", persona: "autonomous-creative-agent", mission: "Discover widget-cli from public surfaces." }],
    execution: { target: "e2b-terminal", runtimeAuth: "openai-env", timeoutMs: 600_000, terminal: { transport: "exec-stream", stdin: "disabled" } },
    scenario: { mode: "live", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } },
    policies: { allowPrivateRepoAccess: false, allowProviderCredentials: false, allowPaymentCredentials: false, allowGitHubMutation: false },
    ...extra
  };
  const parsed = parseLabConfig(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function passingHooks(extra: Partial<TerminalProductLabHooks>): TerminalProductLabHooks {
  const killed: string[] = [];
  return {
    env: { OPENAI_API_KEY: FAKE_RUNTIME_KEY, E2B_API_KEY: "FAKE-E2B-KEY-also-do-not-leak-0987654321" },
    now: () => 4_000,
    loadModule: async () => makeFakeModule({ killed, codexBehavior: (cmd) => ({ exitCode: 0, stdout: `made a durable widget\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` }) }),
    ...extra
  };
}

async function readBundle(cwd: string, runId: string): Promise<RunBundle> {
  return JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8")) as RunBundle;
}

// ---------------------------------------------------------------------------------------------

describe("adopter-scorer contract types are reachable from the public barrel", () => {
  it("an AdapterScorerModule types against `import(\"humanish\")` alone", () => {
    // This would not COMPILE if AdapterScorerModule / AdapterScoringContext were not exported.
    const mod: AdapterScorerModule = {
      score: (ctx: AdapterScoringContext): RunAdapterScore =>
        ({ schema: "humanish.adapter-score.v1", namespace: "ns", status: "pass", score: 1, summary: `ok ${"product" in ctx}` })
    };
    expect(typeof mod.score).toBe("function");
  });
});

describe("loadAdapterScorer — resolution", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-scorer-res-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("accepts a repo-relative ./s.mjs and records repo-relative provenance", async () => {
    await writeScorer(cwd, "scorer.mjs", PASS_SCORER);
    const result = await loadAdapterScorer({ cwd, ref: "./scorer.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.ref).toBe("scorer.mjs");
    expect(result.provenance.exports).toEqual(["score"]);
    expect(result.provenance.digest).toMatch(/^[a-f0-9]{12}$/);
    expect(typeof result.hooks.score).toBe("function");
  });

  it("accepts a nested scorers/s.js", async () => {
    await writeScorer(cwd, "scorers/s.js", PASS_SCORER);
    const result = await loadAdapterScorer({ cwd, ref: "scorers/s.js", backend: "cua", source: "manifest" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.ref).toBe("scorers/s.js");
  });

  it("rejects an escaping ../evil.mjs (BAD_REF)", async () => {
    const result = await loadAdapterScorer({ cwd, ref: "../evil.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_BAD_REF");
  });

  it("rejects a cwd-parent node_modules ref (security regression)", async () => {
    const result = await loadAdapterScorer({ cwd, ref: "../node_modules/evil.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_BAD_REF");
  });

  it("rejects an absolute path (BAD_REF)", async () => {
    const abs = path.join(cwd, "scorer.mjs");
    await writeScorer(cwd, "scorer.mjs", PASS_SCORER);
    const result = await loadAdapterScorer({ cwd, ref: abs, backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_BAD_REF");
  });

  it("rejects a .ts ref (no shipped TypeScript loader)", async () => {
    await writeScorer(cwd, "scorer.ts", "export function score(){}");
    const result = await loadAdapterScorer({ cwd, ref: "scorer.ts", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_BAD_REF");
    expect(result.error.message).toContain(".ts");
  });

  it("rejects an id-style ref with no path extension (BAD_REF)", async () => {
    const result = await loadAdapterScorer({ cwd, ref: "myscorer", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_BAD_REF");
  });

  it("rejects a symlink entry (NOT_FOUND — fail-closed containment)", async () => {
    await writeScorer(cwd, "real.mjs", PASS_SCORER);
    await symlink(path.join(cwd, "real.mjs"), path.join(cwd, "s-link.mjs"));
    const result = await loadAdapterScorer({ cwd, ref: "s-link.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_NOT_FOUND");
  });

  it("rejects a hardlinked entry (nlink>1 — fail-closed containment)", async () => {
    await writeScorer(cwd, "orig.mjs", PASS_SCORER);
    await link(path.join(cwd, "orig.mjs"), path.join(cwd, "hard.mjs"));
    const result = await loadAdapterScorer({ cwd, ref: "hard.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_NOT_FOUND");
  });

  it("two distinct module bytes produce two distinct digests", async () => {
    await writeScorer(cwd, "a.mjs", PASS_SCORER);
    await writeScorer(cwd, "b.mjs", PASS_SCORER + "// different bytes\n");
    const a = await loadAdapterScorer({ cwd, ref: "a.mjs", backend: "terminal", source: "manifest" });
    const b = await loadAdapterScorer({ cwd, ref: "b.mjs", backend: "terminal", source: "manifest" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.provenance.digest).not.toBe(b.provenance.digest);
  });
});

describe("loadAdapterScorer — load + whitelist", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-scorer-load-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("loads a named-export module", async () => {
    await writeScorer(cwd, "named.mjs", PASS_SCORER);
    const result = await loadAdapterScorer({ cwd, ref: "named.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.hooks.score).toBe("function");
  });

  it("loads a default-object module (mod.default ?? mod)", async () => {
    await writeScorer(cwd, "def.mjs", `export default { score(ctx) { return { schema: "humanish.adapter-score.v1", namespace: "ns", status: "pass", score: 80, summary: "ok" }; } };\n`);
    const result = await loadAdapterScorer({ cwd, ref: "def.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.hooks.score).toBe("function");
    expect(result.provenance.exports).toEqual(["score"]);
  });

  it("maps a transitive ERR_MODULE_NOT_FOUND to LOAD_FAILED", async () => {
    await writeScorer(cwd, "broken-import.mjs", `import "./this-module-does-not-exist.mjs";\nexport function score(){}\n`);
    const result = await loadAdapterScorer({ cwd, ref: "broken-import.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_LOAD_FAILED");
  });

  it("maps a SyntaxError to LOAD_FAILED with an actionable hint", async () => {
    await writeScorer(cwd, "syntax.mjs", `export default {\n`); // unterminated object literal
    const result = await loadAdapterScorer({ cwd, ref: "syntax.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_LOAD_FAILED");
  });

  it("hard-errors when a module exports none of the hooks (NO_HOOKS)", async () => {
    await writeScorer(cwd, "empty.mjs", `export function helper() { return 1; }\n`);
    const result = await loadAdapterScorer({ cwd, ref: "empty.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_NO_HOOKS");
  });

  it("on the terminal route, a module exporting ONLY browser-only deriveArtifacts fails closed (never a silent no-op)", async () => {
    await writeScorer(cwd, "artifacts-only.mjs", `export function deriveArtifacts() { return []; }\n`);
    const result = await loadAdapterScorer({ cwd, ref: "artifacts-only.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_NO_HOOKS");
    expect(result.error.message).toContain("deriveArtifacts");
  });

  it("on a browser route, deriveArtifacts IS wired + recorded", async () => {
    await writeScorer(cwd, "artifacts.mjs", `export function deriveArtifacts() { return []; }\n`);
    const result = await loadAdapterScorer({ cwd, ref: "artifacts.mjs", backend: "cua", source: "manifest" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.exports).toEqual(["deriveArtifacts"]);
    expect(typeof result.hooks.deriveArtifacts).toBe("function");
  });

  it("does NOT wire costProbe / executor / env — only the whitelist", async () => {
    await writeScorer(cwd, "extra.mjs", `${PASS_SCORER}
export function costProbe() { return { provider: { usd: 0, source: "adapter-supplied", note: "forged" } }; }
export const executor = {};
export const env = {};
`);
    const result = await loadAdapterScorer({ cwd, ref: "extra.mjs", backend: "terminal", source: "manifest" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.exports).toEqual(["score"]);
    const keys = Object.keys(result.hooks as AdapterScorerModule);
    expect(keys).toEqual(["score"]);
    expect((result.hooks as Record<string, unknown>).costProbe).toBeUndefined();
    expect((result.hooks as Record<string, unknown>).executor).toBeUndefined();
  });
});

describe("loadAdapterScorer — route guards (declared gate that cannot run must ABORT)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-scorer-route-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it.each(["scripted", "synthetic", "meta", "smoke"] as const)("fails closed on the %s backend (UNSUPPORTED_BACKEND)", async (backend) => {
    await writeScorer(cwd, "scorer.mjs", PASS_SCORER);
    const result = await loadAdapterScorer({ cwd, ref: "scorer.mjs", backend, source: "manifest" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_LAB_SCORER_UNSUPPORTED_BACKEND");
  });
});

describe("wiring + provenance inheritance (terminal, live fake, $0)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-scorer-wire-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("attaches the loaded score AND records scorerProvenance {ref,digest,source,exports}; the bundle verifies", async () => {
    const ref = await writeScorer(cwd, "scorers/product.mjs", PASS_SCORER);
    const loaded = await loadAdapterScorer({ cwd, ref, backend: "terminal", source: "cli-flag" });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const hooks = passingHooks({ ...(loaded.hooks.score ? { score: loaded.hooks.score } : {}) });
    const result = await runTerminalProductLab({ cwd, config: terminalConfig(), dryRun: false, open: false, hooks, scorerProvenance: loaded.provenance });

    const bundle = await readBundle(cwd, result.runId);
    expect(bundle.adapterScore?.namespace).toBe("example-ns");
    expect(bundle.scorerProvenance).toEqual({
      schema: "humanish.scorer-provenance.v1",
      ref: "scorers/product.mjs",
      digest: loaded.provenance.digest,
      source: "cli-flag",
      exports: ["score"]
    });

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("re-load is byte-identical (same digest); an edited module changes the digest", async () => {
    await writeScorer(cwd, "s.mjs", PASS_SCORER);
    const first = await loadAdapterScorer({ cwd, ref: "s.mjs", backend: "terminal", source: "manifest" });
    const second = await loadAdapterScorer({ cwd, ref: "s.mjs", backend: "terminal", source: "manifest" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.provenance.digest).toBe(second.provenance.digest);

    await writeScorer(cwd, "s.mjs", PASS_SCORER + "// edited\n");
    const edited = await loadAdapterScorer({ cwd, ref: "s.mjs", backend: "terminal", source: "manifest" });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.provenance.digest).not.toBe(first.provenance.digest);
  });
});

describe("terminal verdict — §5 decision is FLIP for CONFIG-DECLARED scorers", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-scorer-flip-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  const failScore = (): RunAdapterScore =>
    ({ schema: "humanish.adapter-score.v1", namespace: "example-ns", status: "fail", score: 10, summary: "product gate failed" });

  const provenance = {
    schema: "humanish.scorer-provenance.v1" as const,
    ref: "scorers/product.mjs",
    digest: "abcdef012345",
    source: "manifest" as const,
    exports: ["score"] as ("score" | "deriveFeedback" | "deriveArtifacts")[]
  };

  it("a CONFIG-DECLARED terminal scorer returning fail FLIPS review.verdict to fail", async () => {
    const hooks = passingHooks({ score: () => failScore() });
    const result = await runTerminalProductLab({ cwd, config: terminalConfig(), dryRun: false, open: false, hooks, scorerProvenance: provenance });

    const bundle = await readBundle(cwd, result.runId);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.review.verdict).toBe("fail"); // FLIPPED — the declared product rubric owns the verdict
    expect(result.ok).toBe(false); // the declared gate fails the RUN RESULT (exit code), not just the persisted verdict
    expect(bundle.scorerProvenance?.ref).toBe("scorers/product.mjs");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("a LIBRARY caller (no scorerProvenance) keeps the additive no-flip behavior", async () => {
    const hooks = passingHooks({ score: () => failScore() });
    const result = await runTerminalProductLab({ cwd, config: terminalConfig(), dryRun: false, open: false, hooks });

    const bundle = await readBundle(cwd, result.runId);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.review.verdict).toBe("pass"); // UNCHANGED mission verdict — back-compat preserved
    expect(result.ok).toBe(true); // additive: a library score never fails the run
    expect(bundle.scorerProvenance).toBeUndefined();
  });

  it("a DECLARED scorer that THROWS becomes a visible review.gaps entry (never a silent pass)", async () => {
    const hooks = passingHooks({ score: () => { throw new Error("scorer boom"); } });
    const result = await runTerminalProductLab({ cwd, config: terminalConfig(), dryRun: false, open: false, hooks, scorerProvenance: provenance });

    const bundle = await readBundle(cwd, result.runId);
    expect(bundle.adapterScore).toBeUndefined();
    expect(bundle.review.gaps.some((gap) => gap.includes("Declared product scorer threw"))).toBe(true);
    expect(bundle.review.verdict).toBe("fail");
    expect(result.ok).toBe(false); // a crashed declared gate fails the run, not just the bundle
    expect(result.warnings.some((w) => w.includes("threw"))).toBe(true);
  });

  it("a DECLARED terminal scorer returning a MALFORMED value fails the run (never a silent green)", async () => {
    // status/score/summary present but namespace empty → fails isAdapterScoreShape. A scorer that MEANT
    // to fail but mis-shaped its return must not silent-green (red-team finding #1).
    const hooks = passingHooks({ score: () => ({ schema: "humanish.adapter-score.v1", namespace: "", status: "fail", score: 3, summary: "gate" }) });
    const result = await runTerminalProductLab({ cwd, config: terminalConfig(), dryRun: false, open: false, hooks, scorerProvenance: provenance });

    const bundle = await readBundle(cwd, result.runId);
    expect(bundle.adapterScore).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("malformed"))).toBe(true);
  });
});

describe("browser routes flip AND stamp provenance", () => {
  const provenance = {
    schema: "humanish.scorer-provenance.v1" as const,
    ref: "scorers/browser.mjs",
    digest: "0123456789ab",
    source: "manifest" as const,
    exports: ["score"] as ("score" | "deriveFeedback" | "deriveArtifacts")[]
  };

  const freshBundle = (): RunBundle =>
    ({ review: { verdict: "pass", summary: "ok", gaps: [] as string[] }, feedbackCandidates: [], noSpend: { satisfied: false } } as unknown as RunBundle);
  const ctxFor = (bundle: RunBundle): BrowserLabScoringContext =>
    ({ bundle, runDir: "/ignored/runDir", labId: "lab", runId: "run", actor: "openai-computer-use", backend: "cua", dryRun: true, laneCount: 1 });

  it("a DECLARED fail score flips the verdict, stamps provenance, and signals a run failure", async () => {
    const bundle = freshBundle();
    const res = await applyBrowserAdapterHooks({
      hooks: { score: () => ({ schema: "humanish.adapter-score.v1", namespace: "example-ns", status: "fail", score: 12, summary: "browser gate failed" }) },
      context: ctxFor(bundle), bundle, sanitize: (t) => t, warnings: [], hookLabel: "cuaHooks", scorerProvenance: provenance
    });
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.scorerProvenance).toEqual(provenance);
    expect(res.declaredVerdictFailure).toBeDefined();
  });

  it("a DECLARED browser scorer that THROWS fails the run (red-team finding #2 — was a silent green)", async () => {
    const bundle = freshBundle();
    const res = await applyBrowserAdapterHooks({
      hooks: { score: () => { throw new Error("browser boom"); } },
      context: ctxFor(bundle), bundle, sanitize: (t) => t, warnings: [], hookLabel: "cuaHooks", scorerProvenance: provenance
    });
    expect(res.declaredVerdictFailure).toBeDefined();
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((g) => g.includes("threw"))).toBe(true);
  });

  it("a DECLARED browser scorer returning a MALFORMED value fails the run (red-team finding #1)", async () => {
    const bundle = freshBundle();
    const res = await applyBrowserAdapterHooks({
      hooks: { score: () => ({ schema: "humanish.adapter-score.v1", namespace: "", status: "fail", score: 1, summary: "x" }) },
      context: ctxFor(bundle), bundle, sanitize: (t) => t, warnings: [], hookLabel: "cuaHooks", scorerProvenance: provenance
    });
    expect(res.declaredVerdictFailure).toBeDefined();
    expect(bundle.adapterScore).toBeUndefined();
    expect(bundle.review.verdict).toBe("fail");
  });

  it("a LIBRARY browser scorer that throws does NOT flip and signals no failure (back-compat)", async () => {
    const bundle = freshBundle();
    const res = await applyBrowserAdapterHooks({
      hooks: { score: () => { throw new Error("boom"); } },
      context: ctxFor(bundle), bundle, sanitize: (t) => t, warnings: [], hookLabel: "cuaHooks"
      // no scorerProvenance → library caller, additive
    });
    expect(res.declaredVerdictFailure).toBeUndefined();
    expect(bundle.review.verdict).toBe("pass");
  });

  it("a DECLARED scorer cannot mutate the bundle in place — the frozen view protects noSpend/review (finding #3)", async () => {
    const bundle = freshBundle();
    const res = await applyBrowserAdapterHooks({
      hooks: { score: (ctx) => {
        (ctx.bundle as unknown as { noSpend: { satisfied: boolean } }).noSpend.satisfied = true; // tamper on the frozen view → throws
        return { schema: "humanish.adapter-score.v1", namespace: "ns", status: "pass", score: 100, summary: "laundered" };
      } },
      context: ctxFor(bundle), bundle, sanitize: (t) => t, warnings: [], hookLabel: "cuaHooks", scorerProvenance: provenance
    });
    // The REAL bundle was never mutated by the scorer (it saw a frozen clone).
    expect((bundle as unknown as { noSpend: { satisfied: boolean } }).noSpend.satisfied).toBe(false);
    // The tamper is caught and treated as a declared-gate failure — no laundered pass.
    expect(res.declaredVerdictFailure).toBeDefined();
    expect(bundle.review.verdict).toBe("fail");
  });
});

describe("provenance verify (tolerated-absent, rejected-when-malformed)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-scorer-verify-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("a pre-#316 / library-caller bundle (no scorerProvenance) still verifies", async () => {
    const hooks = passingHooks({});
    const result = await runTerminalProductLab({ cwd, config: terminalConfig(), dryRun: false, open: false, hooks });
    const bundle = await readBundle(cwd, result.runId);
    expect(bundle.scorerProvenance).toBeUndefined();
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("a bundle with a MALFORMED scorerProvenance digest fails verification (fail-closed guard)", async () => {
    const ref = await writeScorer(cwd, "s.mjs", PASS_SCORER);
    const loaded = await loadAdapterScorer({ cwd, ref, backend: "terminal", source: "manifest" });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const hooks = passingHooks({ ...(loaded.hooks.score ? { score: loaded.hooks.score } : {}) });
    const result = await runTerminalProductLab({ cwd, config: terminalConfig(), dryRun: false, open: false, hooks, scorerProvenance: loaded.provenance });

    // Corrupt the persisted provenance and re-verify: isRunScorerProvenance must reject it.
    const bundlePath = path.join(cwd, ".humanish", "runs", result.runId, "run.json");
    const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as RunBundle;
    (bundle.scorerProvenance as { digest: string }).digest = "NOT-HEX";
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
  });
});

describe("parser — review.scorer consumed on scorer-capable routes, typos rejected", () => {
  it("a terminal lab declaring review.scorer emits NO 'not yet consumed' warning for scorer", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "terminal-scorer",
      subject: { source: "terminal-product", product: { name: "widget-cli", publicSurfaces: ["https://example.com/widget"] } },
      actors: [{ type: "codex-exec", persona: "autonomous-creative-agent", mission: "Discover widget-cli." }],
      execution: { target: "e2b-terminal", runtimeAuth: "openai-env", terminal: { transport: "exec-stream", stdin: "disabled" } },
      scenario: { mode: "live", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } },
      review: { scorer: { ref: "scorers/product.mjs" } }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.review?.scorer?.ref).toBe("scorers/product.mjs");
    expect(result.warnings.some((w) => w.includes("review.scorer"))).toBe(false);
  });

  it("a scripted lab declaring review.scorer WARNS inert (the scripted actor has no scorer seam)", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "scripted-scorer",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:5173/" },
      actors: [{ type: "scripted-browser", persona: "synthetic-new-user", count: 2 }],
      scenario: { ref: "scripted-first-run" },
      execution: { target: "local", timeoutMs: 60000 },
      review: { scorer: { ref: "scorers/product.mjs" } }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes("review.scorer"))).toBe(true);
  });

  it("a typo'd review.scorrer is rejected (a declared gate must not vanish silently)", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "typo-scorer",
      subject: { source: "terminal-product", product: { name: "widget-cli", publicSurfaces: ["https://example.com/widget"] } },
      actors: [{ type: "codex-exec", persona: "autonomous-creative-agent", mission: "Discover widget-cli." }],
      execution: { target: "e2b-terminal", runtimeAuth: "openai-env", terminal: { transport: "exec-stream", stdin: "disabled" } },
      scenario: { mode: "live", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } },
      review: { scorrer: { ref: "scorers/product.mjs" } }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("scorrer");
  });
});
