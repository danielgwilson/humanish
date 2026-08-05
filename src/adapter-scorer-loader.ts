// #316 — CLI-loadable adopter scorer. Resolve `review.scorer.ref` / `--scorer` to an out-of-tree
// scorer module, load it fail-closed (typed error + exit 2, PRE-SPEND), and pick off ONLY the
// whitelisted read-model hooks {score, deriveFeedback, deriveArtifacts}. `costProbe` is deliberately
// NOT loadable — an injected provider cost line overwrites the core-measured one and can forge a
// satisfied no-spend proof, so it stays library-only.
//
// TRUST MODEL (stated plainly, no overclaims): the party who writes `review.scorer.ref` is the party
// who runs `humanish lab run` in their own checkout — identical trust to humanish.lab.yml or a
// package.json script. #316 adds ZERO new execution capability; it relocates WHERE the reference is
// declared. Containment is ENTRY-FILE-ONLY: `readContainedRegularFile` blocks abs/`..`/symlink/
// hardlink/realpath-escape/TOCTOU on the entry module, but `import()` then executes the transitive
// graph + npm deps with no clamp, and `import()` runs top-level module code before any whitelist
// check. The whitelist bounds the WIRED HOOK SURFACE, not arbitrary import-time code; the
// trusted-in-process boundary is the actual safety carrier. The seam's output re-scrub is a
// best-effort denylist, NOT containment. `review.scorer.ref` entries are executable code — review a
// PR that adds one as code, not config.

import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserLabScoringContext } from "./adapter-extension.js";
import type { TerminalProductScoringContext } from "./e2b-terminal-lab.js";
import type { LabBackend } from "./lab-engine.js";
import { digestText, redactText } from "./redaction.js";
import type {
  RunAdapterArtifact,
  RunAdapterScore,
  RunFeedbackCandidate,
  RunScorerProvenance
} from "./run.js";
import {
  prepareSelectedOutputDirectory,
  readContainedRegularFile
} from "./selected-output-paths.js";

/** The read-model context a loaded scorer sees — the terminal or browser scoring context. The module
 *  narrows it at runtime (`"product" in ctx` ⇒ terminal; `"backend" in ctx` ⇒ browser). */
export type AdapterScoringContext = TerminalProductScoringContext | BrowserLabScoringContext;

/**
 * The adopter-facing scorer module contract (#316). Export any subset of these from a `.mjs` (or a
 * `.js`/`.cjs` whose package.json type matches) — named exports OR a single default object. The
 * loader wires ONLY these three; an exported `executor`/`env`/`provisionSubject`/`costProbe` is never
 * picked up (the whitelist is the scope guard). A module exporting NONE of them is a hard load error.
 */
export interface AdapterScorerModule {
  score?: (ctx: AdapterScoringContext) => RunAdapterScore | Promise<RunAdapterScore>;
  deriveFeedback?: (ctx: AdapterScoringContext) => RunFeedbackCandidate[] | Promise<RunFeedbackCandidate[]>;
  /** Browser-route only; inert on the terminal route (TerminalProductLabHooks carries no artifacts seam). */
  deriveArtifacts?: (ctx: BrowserLabScoringContext) => RunAdapterArtifact[] | Promise<RunAdapterArtifact[]>;
  // NOTE: costProbe is deliberately NOT loadable via config/flag — see the trust model above.
}

export type AdapterScorerLoadErrorCode =
  | "HUMANISH_LAB_SCORER_BAD_REF"
  | "HUMANISH_LAB_SCORER_NOT_FOUND"
  | "HUMANISH_LAB_SCORER_LOAD_FAILED"
  | "HUMANISH_LAB_SCORER_NO_HOOKS"
  | "HUMANISH_LAB_SCORER_UNSUPPORTED_BACKEND";

export type AdapterScorerLoadResult =
  | { ok: true; hooks: AdapterScorerModule; provenance: RunScorerProvenance }
  | { ok: false; error: { code: AdapterScorerLoadErrorCode; message: string } };

/** The backends whose hooks bag can carry the loaded scorer. A declared scorer on ANY other backend
 *  (scripted / synthetic / meta / smoke) aborts at load — a gate that cannot run must never green-pass. */
const SCORER_CAPABLE_BACKENDS: ReadonlySet<LabBackend> = new Set<LabBackend>([
  "terminal",
  "cua",
  "shared-world",
  "concurrent-shared-world"
]);

/** `.mjs` is required-canonical; `.js`/`.cjs` accepted but the module system is the adopter repo's
 *  package.json `type`. `.ts` is rejected — the compiled `dist/` CLI ships no TypeScript loader. */
const SCORER_EXTENSIONS: ReadonlySet<string> = new Set([".mjs", ".js", ".cjs"]);

/**
 * Resolve + load a config-declared scorer module. Resolution clones scenario.ref exactly
 * (prepareSelectedOutputDirectory → cwd-clamp → readContainedRegularFile), then `import()`s the
 * entry file in a BROAD try/catch. The digest is over the readContainedRegularFile ENTRY bytes.
 */
export async function loadAdapterScorer(args: {
  cwd: string;
  ref: string;
  backend: LabBackend;
  source: "manifest" | "cli-flag";
}): Promise<AdapterScorerLoadResult> {
  const { backend, source } = args;
  const fail = (code: AdapterScorerLoadErrorCode, message: string): AdapterScorerLoadResult =>
    ({ ok: false, error: { code, message } });

  // A declared gate that cannot run on this backend must ABORT (never silently green-pass).
  if (!SCORER_CAPABLE_BACKENDS.has(backend)) {
    return fail(
      "HUMANISH_LAB_SCORER_UNSUPPORTED_BACKEND",
      `review.scorer.ref is declared but this lab resolves to the ${backend} backend, which has no adopter-scorer seam. A declared scorer that cannot run must fail closed rather than pass silently — declare it on a terminal, cua, shared-world, or concurrent-shared-world lab.`
    );
  }

  const trimmed = args.ref.trim();
  if (!trimmed) {
    return fail("HUMANISH_LAB_SCORER_BAD_REF", "review.scorer.ref must be a non-empty repo-relative path ending in .mjs (recommended), .js, or .cjs.");
  }
  // Provenance is recorded repo-relative — an absolute ref (even one that happens to land inside cwd)
  // is rejected up front rather than silently rewritten to its in-tree relative form.
  if (path.isAbsolute(trimmed)) {
    return fail("HUMANISH_LAB_SCORER_BAD_REF", `review.scorer.ref "${trimmed}" must be a repo-relative path, not absolute — provenance is recorded repo-relative.`);
  }
  const ext = path.extname(trimmed).toLowerCase();
  if (ext === ".ts") {
    return fail("HUMANISH_LAB_SCORER_BAD_REF", `review.scorer.ref "${trimmed}" ends in .ts, but the shipped CLI runs compiled JS with no TypeScript loader. Precompile to .mjs (recommended) or .js/.cjs.`);
  }
  if (!SCORER_EXTENSIONS.has(ext)) {
    return fail("HUMANISH_LAB_SCORER_BAD_REF", `review.scorer.ref "${trimmed}" must be a repo-relative PATH ending in .mjs (recommended), .js, or .cjs — an id-style ref is not supported.`);
  }

  // Root token: realpath(cwd) → prepareSelectedOutputDirectory(dirname, cwd). Mirrors scenario.ref.
  const physicalCwd = await realpath(path.resolve(args.cwd));
  const root = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);

  // Clamp verbatim from the scripted scenario.ref branch: resolve → relative → reject escape/absolute.
  const absolutePath = path.resolve(root.physicalPath, trimmed);
  const relative = path.relative(root.physicalPath, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return fail(
      "HUMANISH_LAB_SCORER_BAD_REF",
      `review.scorer.ref "${trimmed}" must stay inside the target cwd — provenance is recorded repo-relative and an escaping/absolute path (a cwd parent, node_modules above cwd, an absolute path) cannot be.`
    );
  }
  const relPosix = relative.split(path.sep).join("/");

  // Fail-closed containment gate on the ENTRY file only: rejects symlink, nlink>1, realpath-escape,
  // TOCTOU. Its returned bytes are the digest input.
  const bytes = await readContainedRegularFile(root, relPosix);
  if (!bytes) {
    return fail(
      "HUMANISH_LAB_SCORER_NOT_FOUND",
      `review.scorer.ref "${trimmed}" could not be read as a contained regular file (${relPosix}). A scorer must be a regular file inside the target cwd — no symlink, no hardlink, no realpath escape.`
    );
  }
  const digest = digestText(bytes.toString("utf8"));

  // Import the entry module in a BROAD try/catch (ERR_MODULE_NOT_FOUND / SyntaxError / ERR_REQUIRE_ESM
  // / top-level throw). import() executes the transitive graph — the cwd clamp guards only the ENTRY
  // file; out-of-tree/transitive code is acceptable only because of the trust boundary above.
  let mod: Record<string, unknown>;
  try {
    const url = pathToFileURL(path.join(root.physicalPath, relPosix)).href;
    mod = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = /ERR_REQUIRE_ESM|import statement outside a module|Cannot use import statement|Unexpected (?:token|identifier)|SyntaxError/i.test(detail)
      ? " Use a .mjs entry file, or set \"type\": \"module\" in the nearest package.json."
      : "";
    return fail(
      "HUMANISH_LAB_SCORER_LOAD_FAILED",
      `review.scorer.ref "${trimmed}" failed to load: ${redactText(detail)}.${hint}`
    );
  }

  // mod.default ?? mod, then pick off ONLY the whitelist. An exported executor/env/costProbe is never
  // wired — the whitelist is the scope guard. `exports` records the hooks ACTUALLY WIRED for this
  // backend: deriveArtifacts is browser-only, so on the terminal route it is neither wired nor
  // recorded (a scorer that exported ONLY deriveArtifacts there wires nothing and fails closed below,
  // never a silent no-op).
  const picked = (mod.default ?? mod) as Record<string, unknown>;
  const terminalRoute = backend === "terminal";
  const hooks: AdapterScorerModule = {};
  const exports: RunScorerProvenance["exports"] = [];
  if (typeof picked.score === "function") {
    hooks.score = picked.score as NonNullable<AdapterScorerModule["score"]>;
    exports.push("score");
  }
  if (typeof picked.deriveFeedback === "function") {
    hooks.deriveFeedback = picked.deriveFeedback as NonNullable<AdapterScorerModule["deriveFeedback"]>;
    exports.push("deriveFeedback");
  }
  if (!terminalRoute && typeof picked.deriveArtifacts === "function") {
    hooks.deriveArtifacts = picked.deriveArtifacts as NonNullable<AdapterScorerModule["deriveArtifacts"]>;
    exports.push("deriveArtifacts");
  }

  if (exports.length === 0) {
    const artifactsOnly = terminalRoute && typeof picked.deriveArtifacts === "function";
    return fail(
      "HUMANISH_LAB_SCORER_NO_HOOKS",
      artifactsOnly
        ? `review.scorer.ref "${trimmed}" exported only deriveArtifacts, which is browser-only and inert on the terminal route. Export score and/or deriveFeedback for a terminal-product scorer.`
        : `review.scorer.ref "${trimmed}" loaded but exported none of the adopter-scorer hooks (score, deriveFeedback, deriveArtifacts). Export at least one (named, or on a single default object). costProbe is intentionally NOT loadable.`
    );
  }

  const provenance: RunScorerProvenance = {
    schema: "humanish.scorer-provenance.v1",
    ref: relPosix,
    digest,
    source,
    exports
  };
  return { ok: true, hooks, provenance };
}
