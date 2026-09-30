import { normalizeExtraExcludeEntry } from "../run/source-archive.js";
import { containsSensitive } from "../evidence/redaction.js";
import { ENV_NAME_PATTERN, invalid, isRecord, posInt, str, strList } from "./parse-values.js";
import type {
  LabConfigParseFailure,
  LabStateStepWhen,
  LabSubject,
  LabSubjectClone,
  LabSubjectLocalTree,
  LabSubjectProduct,
  LabSubjectServe,
  LabSubjectState,
} from "./types.js";

export function parseSubject(
  raw: unknown,
): { ok: true; value: LabSubject } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid("Lab `subject` is required and must be an object.");
  }
  const source = str(raw.source);
  if (
    source !== "this-repo" &&
    source !== "clone" &&
    source !== "app-url" &&
    source !== "local-app" &&
    source !== "desktop-cli" &&
    source !== "terminal-product" &&
    source !== "local-tree"
  ) {
    return invalid(
      "`subject.source` must be one of: this-repo, clone, app-url, local-app, terminal-product, desktop-cli, local-tree.",
    );
  }
  const subject: LabSubject = { source };

  // topology is enum-validated everywhere; its SEMANTICS (shared-world requires clone × e2b-desktop
  // × a ≥2 roster) are enforced in the shared-world cross-validation below, and a set-but-unconsumed
  // topology warns as inert off the shared-world route (invariant 6).
  if (raw.topology !== undefined) {
    const topology = str(raw.topology);
    if (topology !== "per-lane-worlds" && topology !== "shared-world") {
      return invalid("`subject.topology` must be per-lane-worlds (the default) or shared-world.");
    }
    subject.topology = topology;
  }
  // exposure is enum-validated everywhere; it is REQUIRED on the concurrent shared-world route (the
  // getHost synthetic-subject attestation) and warns inert elsewhere.
  if (raw.exposure !== undefined) {
    const exposure = str(raw.exposure);
    if (exposure !== "synthetic") {
      return invalid(
        "`subject.exposure` must be `synthetic` (the author attestation that the getHost-exposed subject is synthetic seeded data).",
      );
    }
    subject.exposure = exposure;
  }

  // `product` is terminal-product-only; reject it elsewhere (invariant 6: a field that cannot act
  // on this route is an honest parse error, not silently dropped).
  if (source !== "terminal-product" && source !== "desktop-cli" && raw.product !== undefined) {
    return invalid(
      "`subject.product` applies only to terminal-product and desktop-cli subjects (the CLI a participant studies from public surfaces).",
    );
  }
  // appUrl is app-url/local-app-only; a terminal-product subject drives PUBLIC surfaces, not a
  // single loopback app — reject appUrl on it.
  if (source === "terminal-product" && raw.appUrl !== undefined) {
    return invalid(
      "`subject.appUrl` does not apply to terminal-product subjects — declare `subject.product.publicSurfaces` (the agent works from public surfaces, not one loopback app).",
    );
  }

  // serve/env/state are shared between clone (cloned app) and local-tree (packed working
  // tree): both routes serve a subject in-sandbox with the same install/build/start/url +
  // env-name + seed/external/checkpoint shapes.
  if (source !== "clone" && source !== "local-tree" && raw.serve !== undefined) {
    return invalid(
      "`subject.serve` applies only to clone subjects or local-tree subjects (the lab serves the cloned/packed app in-sandbox).",
    );
  }
  if (source !== "clone" && source !== "local-tree" && raw.env !== undefined) {
    return invalid(
      "`subject.env` applies only to clone subjects or local-tree subjects (the served app's environment channel).",
    );
  }
  if (source !== "clone" && source !== "local-tree" && raw.state !== undefined) {
    return invalid(
      "`subject.state` applies only to clone subjects or local-tree subjects (the lab seeds the state it serves).",
    );
  }
  // repos/clone are clone-ONLY (a fresh-clone subject's git inputs). local-tree packs the
  // resolution cwd itself, so it has no repo slug to clone and gets its own precise reasons
  // rather than falling through to the generic clone-only message below.
  if (source === "local-tree" && raw.repos !== undefined) {
    return invalid(
      "`subject.repos` does not apply to local-tree subjects. The local-tree route packs the lab resolution cwd itself; there is no owner/repo slug to clone.",
    );
  }
  if (source === "local-tree" && raw.clone !== undefined) {
    return invalid(
      "`subject.clone` does not apply to local-tree subjects. Declare `subject.localTree` instead (keep/exclude/maxArchiveBytes).",
    );
  }
  // Rejected, never silently dropped, on app-url/local-app/this-repo/terminal-product subjects
  // too (invariant 6: a field that cannot act on this route is an honest parse error).
  if (source !== "clone" && raw.repos !== undefined) {
    return invalid(
      "`subject.repos` applies only to clone subjects (the owner/repo slugs to clone).",
    );
  }
  if (source !== "clone" && raw.clone !== undefined) {
    return invalid("`subject.clone` applies only to clone subjects (clone depth/fanout/keep).");
  }
  // localTree is local-tree-ONLY (pack/upload knobs for the packed working tree).
  if (source !== "local-tree" && raw.localTree !== undefined) {
    return invalid(
      "`subject.localTree` applies only to local-tree subjects (keep/exclude/maxArchiveBytes for packing the working tree).",
    );
  }
  // publicTarget is app-url-ONLY (the external-public shared-world ownership attestation). It is
  // meaningless without a real public deployment as the plane — reject it elsewhere (invariant 6).
  if (source !== "app-url" && raw.publicTarget !== undefined) {
    return invalid(
      "`subject.publicTarget` applies only to app-url subjects on the external-public shared-world route (the operator's ownership attestation for a real public deployment used directly as the shared plane).",
    );
  }

  if (source === "clone") {
    const repos = strList(raw.repos);
    if (!repos || repos.length === 0) {
      return invalid(
        "`subject.repos` must list at least one owner/repo slug when source is clone.",
      );
    }
    subject.repos = repos;
    const clone = parseClone(raw.clone);
    if (clone) {
      subject.clone = clone;
    }
    const serveResult = parseServe(raw.serve);
    if (!serveResult.ok) {
      return serveResult;
    }
    if (serveResult.value) subject.serve = serveResult.value;
    if (raw.env !== undefined) {
      const env = strList(raw.env);
      if (!env || env.length === 0) {
        return invalid("`subject.env` must be a non-empty list of env var NAMES when set.");
      }
      const badName = env.find((name) => !ENV_NAME_PATTERN.test(name));
      if (badName) {
        return invalid(
          `subject.env entries must be env var NAMES like DATABASE_URL (got "${badName}"); values come from the caller's environment and are never persisted.`,
        );
      }
      subject.env = env;
    }
    const envValuesResult = parseEnvValues(raw.envValues);
    if (!envValuesResult.ok) return envValuesResult;
    if (envValuesResult.value) subject.envValues = envValuesResult.value;
    const stateResult = parseState(raw.state);
    if (!stateResult.ok) {
      return stateResult;
    }
    if (stateResult.value) {
      // Semantic validation is shared with the engine (runCuaActorLab re-enforces it for
      // configs that arrive through the library API without the parser).
      const reason = subjectStateInvalidReason(stateResult.value, subject.env);
      if (reason) {
        return invalid(reason);
      }
      subject.state = stateResult.value;
    }
  }

  if (source === "local-tree") {
    // A local-tree subject exists to be packed and served; there is no other way to boot it, so
    // serve is REQUIRED here. Clone subjects get the same requirement from each route's checks in
    // parseLabConfig.
    if (raw.serve === undefined) {
      return invalid(
        "`subject.serve` is required when source is local-tree: a local-tree subject exists to be packed and served, so declare install/build/start/url exactly like the clone route.",
      );
    }
    const serveResult = parseServe(raw.serve);
    if (!serveResult.ok) {
      return serveResult;
    }
    if (serveResult.value) subject.serve = serveResult.value;
    if (raw.env !== undefined) {
      const env = strList(raw.env);
      if (!env || env.length === 0) {
        return invalid("`subject.env` must be a non-empty list of env var NAMES when set.");
      }
      const badName = env.find((name) => !ENV_NAME_PATTERN.test(name));
      if (badName) {
        return invalid(
          `subject.env entries must be env var NAMES like DATABASE_URL (got "${badName}"); values come from the caller's environment and are never persisted.`,
        );
      }
      subject.env = env;
    }
    const envValuesResult = parseEnvValues(raw.envValues);
    if (!envValuesResult.ok) return envValuesResult;
    if (envValuesResult.value) subject.envValues = envValuesResult.value;
    const stateResult = parseState(raw.state);
    if (!stateResult.ok) {
      return stateResult;
    }
    if (stateResult.value) {
      // Semantic validation is shared with the engine (same helper the clone route uses).
      const reason = subjectStateInvalidReason(stateResult.value, subject.env);
      if (reason) {
        return invalid(reason);
      }
      subject.state = stateResult.value;
    }
    const localTreeResult = parseLocalTree(raw.localTree);
    if (!localTreeResult.ok) {
      return localTreeResult;
    }
    if (localTreeResult.value) {
      subject.localTree = localTreeResult.value;
    }
  }

  if (source === "app-url" || source === "local-app") {
    const appUrl = str(raw.appUrl);
    if (!appUrl) {
      return invalid(`\`subject.appUrl\` is required when source is ${source}.`);
    }
    // app-url: shape-only here; the loopback-vs-public-target gate is applied in the
    // cross-validation block below, where policies.allowPublicTargets is available.
    // local-app: an in-process local dev server — ALWAYS loopback (no public-target option),
    // so the loopback wall is enforced right here at parse.
    if (source === "local-app") {
      if (!isLoopbackUrl(appUrl)) {
        return invalid(
          "`subject.appUrl` must be a loopback URL (127.0.0.1/localhost) on a local-app subject — it drives an already-running LOCAL dev server in-process; public targets are not supported on this route.",
        );
      }
    } else if (!isHttpUrl(appUrl)) {
      return invalid("`subject.appUrl` must be an http(s) URL.");
    }
    subject.appUrl = appUrl;
    // publicTarget (external-public shared-world ownership attestation) is app-url-only. Shape it
    // here; its REQUIRED-on-that-route semantics live in externalPublicSharedWorldValidationReason.
    if (source === "app-url" && raw.publicTarget !== undefined) {
      const publicTargetResult = parsePublicTarget(raw.publicTarget);
      if (!publicTargetResult.ok) {
        return publicTargetResult;
      }
      subject.publicTarget = publicTargetResult.value;
    }
  }

  if (source === "terminal-product" || source === "desktop-cli") {
    const productResult = parseProduct(raw.product);
    if (!productResult.ok) {
      return productResult;
    }
    subject.product = productResult.value;
  }

  return { ok: true, value: subject };
}

// The publicTarget.owner is a public-safe operator/repo label surfaced in evidence (e.g.
// "example-operator/lobby-trivia" or a bare org name). Slash allowed for the owner/repo convention.
const PUBLIC_TARGET_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;

/** Parse the external-public shared-world ownership attestation ({ owner, authorized: true }). The
 *  harness cannot verify ownership — this is author-trust, surfaced honestly in the evidence class. */
function parsePublicTarget(
  raw: unknown,
): { ok: true; value: { owner: string; authorized: boolean } } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid(
      "`subject.publicTarget` must be an object ({ owner, authorized: true }) — the operator's ownership attestation for the external-public shared plane.",
    );
  }
  const owner = str(raw.owner);
  if (!owner || !PUBLIC_TARGET_OWNER_PATTERN.test(owner)) {
    return invalid(
      "`subject.publicTarget.owner` must be a public-safe operator/repo label (e.g. owner/repo); it is recorded in evidence, so it must carry no secret.",
    );
  }
  if (raw.authorized !== true) {
    return invalid(
      "`subject.publicTarget.authorized` must be true — you must attest you own/operate the public deployment used as the shared plane (author-trust; the harness cannot verify ownership).",
    );
  }
  return { ok: true, value: { owner, authorized: true } };
}

// The product name interpolates into evidence labels and the composed prompt; the public-safe
// token shape is the same load-bearing constraint as a lab id.
const PRODUCT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function parseProduct(
  raw: unknown,
): { ok: true; value: LabSubjectProduct } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid(
      "`subject.product` is required on terminal-product subjects and must be an object ({ name, publicSurfaces }).",
    );
  }
  const name = str(raw.name);
  if (!name || !PRODUCT_NAME_PATTERN.test(name)) {
    return invalid(
      "`subject.product.name` must be a public-safe token starting with a letter or digit (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).",
    );
  }
  const workdir = str(raw.workdir);
  if (raw.workdir !== undefined && (workdir === undefined || !/^[A-Za-z0-9_./-]+$/.test(workdir))) {
    return invalid(
      "`subject.product.workdir` must be a plain path (it interpolates into an in-sandbox command).",
    );
  }
  const upload = str(raw.upload);
  if (raw.upload !== undefined) {
    if (upload === undefined || upload.trim().length === 0) {
      return invalid(
        "`subject.product.upload` must be a non-empty project-relative path when set.",
      );
    }
    if (
      upload.startsWith("/") ||
      /^[A-Za-z]:/.test(upload) ||
      upload.split(/[\\/]/).includes("..")
    ) {
      return invalid(
        "`subject.product.upload` must stay inside the project — no absolute paths and no `..` segments.",
      );
    }
  }
  const install = str(raw.install);
  if (raw.install !== undefined && (install === undefined || install.trim().length === 0)) {
    return invalid("`subject.product.install` must be a non-empty command string when set.");
  }
  const publicSurfaces = strList(raw.publicSurfaces);
  if (!publicSurfaces || publicSurfaces.length === 0) {
    return invalid("`subject.product.publicSurfaces` must list at least one public surface URL.");
  }
  const badSurface = publicSurfaces.find((surface) => !isHttpUrl(surface));
  if (badSurface) {
    return invalid(
      `subject.product.publicSurfaces entries must be http(s) URLs (got "${badSurface}").`,
    );
  }
  return {
    ok: true,
    value: {
      name,
      publicSurfaces,
      ...(install === undefined ? {} : { install }),
      ...(workdir === undefined ? {} : { workdir }),
      ...(upload === undefined ? {} : { upload }),
    },
  };
}

// Public-safe stance: a computer-use actor's ENTRY URL is always an app the lab owner runs on
// loopback (inside the sandbox), never an arbitrary public site. (The constraint binds the
// entry point; a navigation watchdog for mid-session escapes is a later slice.) Exported so
// the engine re-enforces the same boundary on configs that arrive through the library API.
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** A well-formed http(s) URL (any host). Shape gate before the loopback/public-target policy. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseServe(
  raw: unknown,
): { ok: true; value: LabSubjectServe | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid(
      "`subject.serve` must be an object ({ install?, build?, start, url, readyTimeoutMs? }).",
    );
  }
  const start = str(raw.start);
  if (!start) {
    return invalid(
      "`subject.serve.start` is required when serve is set (the long-lived command that serves the app).",
    );
  }
  const url = str(raw.url);
  if (!url || !isLoopbackUrl(url)) {
    return invalid(
      "`subject.serve.url` must be a loopback http(s) URL (127.0.0.1 or localhost) — the app is served INSIDE the sandbox.",
    );
  }
  const serve: LabSubjectServe = { start, url };
  const install = str(raw.install);
  if (install) serve.install = install;
  const build = str(raw.build);
  if (build) serve.build = build;
  const readyTimeoutMs = posInt(raw.readyTimeoutMs);
  if (readyTimeoutMs !== undefined) serve.readyTimeoutMs = readyTimeoutMs;
  const installTimeoutMs = posInt(raw.installTimeoutMs);
  if (installTimeoutMs !== undefined) serve.installTimeoutMs = installTimeoutMs;
  const buildTimeoutMs = posInt(raw.buildTimeoutMs);
  if (buildTimeoutMs !== undefined) serve.buildTimeoutMs = buildTimeoutMs;
  return { ok: true, value: serve };
}

/**
 * LITERAL non-secret subject env. Real apps need configuration before they will boot — a public base
 * URL, a transport selector, a feature flag — and none of that is secret. Routing it through
 * `subject.env` would force an adopter to carry a private env file just to reproduce a public study.
 *
 * These values ARE recorded in evidence (they are part of how the subject was configured), so a
 * value that looks like a credential is refused here rather than committed to a public repo.
 */
function parseEnvValues(
  raw: unknown,
): { ok: true; value?: Record<string, string> } | LabConfigParseFailure {
  if (raw === undefined) return { ok: true };
  if (!isRecord(raw)) {
    return invalid(
      "`subject.envValues` must be a mapping of env var NAME to a literal non-secret value.",
    );
  }
  const envValues: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(raw)) {
    if (!ENV_NAME_PATTERN.test(name)) {
      return invalid(
        `subject.envValues keys must be env var NAMES like NEXT_PUBLIC_APP_URL (got "${name}").`,
      );
    }
    const value =
      typeof rawValue === "number" || typeof rawValue === "boolean"
        ? String(rawValue)
        : str(rawValue);
    if (value === undefined) {
      return invalid(`\`subject.envValues.${name}\` must be a string, number, or boolean.`);
    }
    // Reuse the redaction module's own detector rather than inventing a second opinion about what
    // a secret looks like — the two must never disagree about the same string.
    if (containsSensitive(value)) {
      return invalid(
        `\`subject.envValues.${name}\` looks like a secret or a local path, and these values are committed with the lab and recorded in evidence. Declare the NAME in \`subject.env\` instead — those values come from the caller's environment and never persist.`,
      );
    }
    envValues[name] = value;
  }
  return { ok: true, value: envValues };
}

/**
 * Structural parse of `subject.state` into a candidate LabSubjectState. Deliberately keeps
 * unrecognized `when`/`timeoutMs` values in the candidate (instead of silently dropping
 * them) so subjectStateInvalidReason rejects them — a state declaration that silently does
 * less than it says would violate invariant 6.
 */
function parseState(
  raw: unknown,
): { ok: true; value: LabSubjectState | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`subject.state` must be an object ({ seed?, external? }).");
  }
  const state: LabSubjectState = {};
  if (raw.seed !== undefined) {
    if (!Array.isArray(raw.seed) || !raw.seed.every(isRecord)) {
      return invalid(
        "`subject.state.seed` must be an array of step objects ({ name, command, when?, timeoutMs? }).",
      );
    }
    state.seed = raw.seed.map((entry) => ({
      name: typeof entry.name === "string" ? entry.name.trim() : "",
      command: typeof entry.command === "string" ? entry.command.trim() : "",
      ...(entry.when === undefined ? {} : { when: entry.when as LabStateStepWhen }),
      ...(entry.timeoutMs === undefined
        ? {}
        : { timeoutMs: (posInt(entry.timeoutMs) ?? entry.timeoutMs) as number }),
    }));
  }
  if (raw.external !== undefined) {
    const external = strList(raw.external);
    if (!external) {
      return invalid(
        "`subject.state.external` must be a non-empty list of env var NAMES when set.",
      );
    }
    state.external = external;
  }
  if (raw.checkpoint !== undefined) {
    if (!Array.isArray(raw.checkpoint) || !raw.checkpoint.every(isRecord)) {
      return invalid(
        "`subject.state.checkpoint` must be an array of probe objects ({ name, command, redact? }).",
      );
    }
    state.checkpoint = raw.checkpoint.map((probe) => ({
      name: typeof probe.name === "string" ? probe.name.trim() : "",
      command: typeof probe.command === "string" ? probe.command.trim() : "",
      // Preserve the redact list verbatim (literal secret values may contain commas, so do NOT
      // run it through the comma-splitting strList); subjectStateInvalidReason validates the shape.
      ...(probe.redact === undefined ? {} : { redact: probe.redact as string[] }),
    }));
  }
  return { ok: true, value: state };
}

// The step name interpolates into in-sandbox script/status/log paths (`subject-state-<name>`);
// the strict shape is load-bearing, exactly like the repo slug.
const STATE_STEP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const STATE_STEP_NAME_MAX_CHARS = 40;

const STATE_STEP_WHENS: readonly LabStateStepWhen[] = [
  "before-build",
  "before-start",
  "after-ready",
];

/**
 * Semantic validation for `subject.state`, shared by parseLabConfig and the engine
 * (runCuaActorLab re-enforces it on configs that arrive through the library API). Returns
 * the failure message, or null when the declaration is valid. Reads the candidate
 * defensively — library callers can hand the engine arbitrarily-shaped objects.
 */
export function subjectStateInvalidReason(
  state: LabSubjectState,
  env: readonly string[] | undefined,
): string | null {
  const seed = state.seed;
  const external = state.external;
  const checkpoint = state.checkpoint;
  if (
    (seed === undefined || seed.length === 0) &&
    (external === undefined || external.length === 0) &&
    (checkpoint === undefined || checkpoint.length === 0)
  ) {
    return "`subject.state` must declare seed steps, external env names, and/or checkpoints (an empty state block would be inert).";
  }
  if (seed !== undefined) {
    if (!Array.isArray(seed) || seed.length === 0) {
      return "`subject.state.seed` must be a non-empty array of steps when set.";
    }
    const names = new Set<string>();
    for (const [index, step] of seed.entries()) {
      const name = typeof step?.name === "string" ? step.name : "";
      if (!STATE_STEP_NAME_PATTERN.test(name) || name.length > STATE_STEP_NAME_MAX_CHARS) {
        return `subject.state.seed[${index}].name must match ${STATE_STEP_NAME_PATTERN} and be at most ${STATE_STEP_NAME_MAX_CHARS} chars (it names in-sandbox file paths); got "${name}".`;
      }
      if (names.has(name)) {
        return `subject.state.seed step names must be unique (duplicate "${name}").`;
      }
      names.add(name);
      if (typeof step.command !== "string" || step.command.trim().length === 0) {
        return `subject.state.seed[${index}].command is required (the in-sandbox shell command that seeds the state).`;
      }
      if (step.when !== undefined && !STATE_STEP_WHENS.includes(step.when)) {
        return `subject.state.seed[${index}].when must be one of: ${STATE_STEP_WHENS.join(", ")}.`;
      }
      if (
        step.timeoutMs !== undefined &&
        !(
          typeof step.timeoutMs === "number" &&
          Number.isSafeInteger(step.timeoutMs) &&
          step.timeoutMs >= 1
        )
      ) {
        return `subject.state.seed[${index}].timeoutMs must be a positive integer.`;
      }
    }
  }
  if (external !== undefined) {
    if (!Array.isArray(external) || external.length === 0) {
      return "`subject.state.external` must be a non-empty list of env var NAMES when set.";
    }
    for (const name of external) {
      if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
        return "subject.state.external entries must be env var NAMES like DATABASE_URL; values come from the caller's environment and are never persisted.";
      }
      if (!env?.includes(name)) {
        return "subject.state.external names must also be declared in subject.env (the declaration must name a provisioned channel).";
      }
    }
  }
  if (checkpoint !== undefined) {
    if (!Array.isArray(checkpoint) || checkpoint.length === 0) {
      return "`subject.state.checkpoint` must be a non-empty array of probes when set.";
    }
    const names = new Set<string>();
    for (const [index, probe] of checkpoint.entries()) {
      const name = typeof probe?.name === "string" ? probe.name : "";
      if (!STATE_STEP_NAME_PATTERN.test(name) || name.length > STATE_STEP_NAME_MAX_CHARS) {
        return `subject.state.checkpoint[${index}].name must match ${STATE_STEP_NAME_PATTERN} and be at most ${STATE_STEP_NAME_MAX_CHARS} chars (it names in-sandbox file paths); got "${name}".`;
      }
      if (names.has(name)) {
        return `subject.state.checkpoint names must be unique (duplicate "${name}").`;
      }
      names.add(name);
      if (typeof probe.command !== "string" || probe.command.trim().length === 0) {
        return `subject.state.checkpoint[${index}].command is required (the read-only digest probe command).`;
      }
      if (probe.redact !== undefined) {
        if (
          !Array.isArray(probe.redact) ||
          !probe.redact.every((value) => typeof value === "string" && value.length > 0)
        ) {
          return `subject.state.checkpoint[${index}].redact must be a list of non-empty literal strings when set.`;
        }
      }
    }
  }
  return null;
}

function parseClone(raw: unknown): LabSubjectClone | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const clone: LabSubjectClone = {};
  const depth = posInt(raw.depth);
  if (depth !== undefined) clone.depth = depth;
  const fanout = posInt(raw.fanout);
  if (fanout !== undefined) clone.fanout = fanout;
  if (typeof raw.keep === "boolean") clone.keep = raw.keep;
  return Object.keys(clone).length > 0 ? clone : undefined;
}

/**
 * Structural parse of `subject.localTree`, mirroring parseClone. Unlike parseClone (which
 * silently drops an out-of-range depth/fanout), an invalid exclude/maxArchiveBytes value is
 * REJECTED, never silently dropped: a caller who typed an empty exclude entry or a non-positive
 * maxArchiveBytes almost certainly meant something, and the archive-size cap is a safety knob,
 * not a cosmetic default.
 */
function parseLocalTree(
  raw: unknown,
): { ok: true; value: LabSubjectLocalTree | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid(
      "`subject.localTree` must be an object ({ keep?, exclude?, maxArchiveBytes? }).",
    );
  }
  const localTree: LabSubjectLocalTree = {};
  if (raw.keep !== undefined) {
    if (typeof raw.keep !== "boolean") {
      return invalid(
        "`subject.localTree.keep` must be a boolean (YAML true/false, not a quoted string).",
      );
    }
    localTree.keep = raw.keep;
  }
  if (raw.exclude !== undefined) {
    if (
      !Array.isArray(raw.exclude) ||
      raw.exclude.some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      return invalid(
        "`subject.localTree.exclude` must be a list of non-empty strings (extra archive excludes on top of the always-on denylist).",
      );
    }
    const exclude = strList(raw.exclude);
    if (exclude) {
      // Normalize/validate each entry at parse time so a mis-shaped exclude the
      // author believed in can never silently no-op at packing time: absolute
      // paths and glob syntax are rejected with the packing boundary's own
      // reason; "./prefix" and "prefix/" normalize to the enumeration relPath
      // shape.
      const normalized: string[] = [];
      for (const entry of exclude) {
        try {
          normalized.push(normalizeExtraExcludeEntry(entry));
        } catch (error) {
          return invalid(
            `\`subject.localTree.exclude\`: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      localTree.exclude = normalized;
    }
  }
  if (raw.maxArchiveBytes !== undefined) {
    const maxArchiveBytes = posInt(raw.maxArchiveBytes);
    if (maxArchiveBytes === undefined) {
      return invalid(
        "`subject.localTree.maxArchiveBytes` must be a positive integer number of bytes when set.",
      );
    }
    localTree.maxArchiveBytes = maxArchiveBytes;
  }
  return { ok: true, value: Object.keys(localTree).length > 0 ? localTree : undefined };
}
