import {
  DEFAULT_RUNTIME_AUTH,
  E2B_SYSTEM_CA_BUNDLE,
  OPENAI_EGRESS_PLACEHOLDER,
} from "./runtime-auth.js";
import type { StudyRuntimeAuth } from "../../study/types.js";
import { TERMINAL_PRODUCT_STUDY_PROVIDER_METADATA } from "./types.js";

/**
 * Resolve the runtime key on the host. openai-egress, the default, returns an inert command env
 * while retaining the actual value for the external transform and literal redaction; openai-env
 * passes it command-scoped. Only CODEX_API_KEY/OPENAI_API_KEY are accepted as sources. No other
 * operator credential is forwarded. The real value must never be logged or persisted in either mode.
 */
export function buildRuntimeAuth(args: {
  /** Undefined selects openai-egress, so the raw key stays out of the sandbox unless a study opts in. */
  runtimeAuth: StudyRuntimeAuth | undefined;
  /** The operator environment the key value is read from (process.env or a test fake). */
  env: Record<string, string | undefined>;
}):
  | {
      ok: true;
      mode: StudyRuntimeAuth;
      envs: Record<string, string>;
      keyName: string;
      keyValue: string;
    }
  | {
      ok: false;
      code: "HUMANISH_TERMINAL_RUNTIME_AUTH_MISSING" | "HUMANISH_TERMINAL_CREDENTIAL_DENIED";
      message: string;
    } {
  // The "openai-env" channel accepts CODEX_API_KEY or OPENAI_API_KEY as the runtime key source
  // name, read in this preference order. CODEX_API_KEY is preferred: the official Codex docs
  // (developers.openai.com/codex/noninteractive) document it as the channel for a single codex exec
  // invocation, which is exactly this route's shape (no persisted auth.json/CODEX_HOME, per-command
  // envs only). A dated in-repo receipt
  // (docs/history/goals/humanish-recursive-proof-critical-point/receipts/actor-required-attempt.md) shows a
  // job-wide OPENAI_API_KEY alone failing bearer auth for this same pinned-exec pattern. When the
  // operator only exported OPENAI_API_KEY, its value is also injected under CODEX_API_KEY below, so
  // the documented exec auth channel is always populated regardless of which name the operator
  // used. The allowlist is exactly these two names; everything else is denied by construction.
  const ALLOWED_RUNTIME_KEY_NAMES = ["CODEX_API_KEY", "OPENAI_API_KEY"] as const;
  // Tripwire (deny-by-default credentials): if a future widening of ALLOWED_RUNTIME_KEY_NAMES ever
  // added a clearly-non-runtime credential (a GitHub/payment/deploy/db secret), fail closed. The
  // generic `*_KEY` shape is deliberately left out of the tripwire, since a runtime key legitimately
  // ends in _KEY (CODEX_API_KEY/OPENAI_API_KEY), so testing it against the generic shape would
  // false-positive on the very key this route exists to inject. The positive allowlist itself is
  // the real boundary: the command env is built from exactly these names and nothing else (so
  // GITHUB_TOKEN/payment/db keys present in the operator env are never forwarded, proven by the
  // deterministic test).
  if (ALLOWED_RUNTIME_KEY_NAMES.some((name) => isNonRuntimeCredentialName(name))) {
    return {
      ok: false,
      code: "HUMANISH_TERMINAL_CREDENTIAL_DENIED",
      message:
        "Internal invariant violated: a runtime-key allowlist entry is a non-runtime credential (GitHub/payment/deploy/db).",
    };
  }
  const keyName = ALLOWED_RUNTIME_KEY_NAMES.find(
    (name) => (args.env[name]?.trim() ?? "").length > 0,
  );
  if (!keyName) {
    return {
      ok: false,
      code: "HUMANISH_TERMINAL_RUNTIME_AUTH_MISSING",
      message: `Live terminal-product studies declare runtimeAuth "${String(args.runtimeAuth)}" and need ${ALLOWED_RUNTIME_KEY_NAMES.join(" or ")} in the environment (pass via --dotenv; the selected auth mode places the value in command-scoped env or an external E2B header transform; the value is never persisted).`,
    };
  }
  const keyValue = args.env[keyName] as string;
  // The command-scoped env is the allowlist: exactly the runtime key name(s). No
  // GITHUB_TOKEN/GH_TOKEN, no payment/deploy/db/media key, excluded by construction. When the
  // source was OPENAI_API_KEY, the same value is also injected as CODEX_API_KEY so codex exec's
  // documented single-invocation auth channel is populated either way (see the comment above).
  const mode: unknown = args.runtimeAuth ?? DEFAULT_RUNTIME_AUTH;
  // Only the exact openai-env value places the raw key in the command, so a misspelled mode from a
  // config that skipped the planner is refused, never read as openai-env.
  if (mode !== "openai-egress" && mode !== "openai-env")
    return {
      ok: false,
      code: "HUMANISH_TERMINAL_CREDENTIAL_DENIED",
      message: "Runtime auth must be openai-egress or openai-env; no key was placed.",
    };
  const envs: Record<string, string> =
    mode === "openai-egress"
      ? // Codex documents this verified-TLS trust channel. The stock image's default OpenSSL CA
        // file can be absent even though E2B has installed its proxy CA in the system bundle.
        { CODEX_API_KEY: OPENAI_EGRESS_PLACEHOLDER, CODEX_CA_CERTIFICATE: E2B_SYSTEM_CA_BUNDLE }
      : keyName === "OPENAI_API_KEY"
        ? { CODEX_API_KEY: keyValue, OPENAI_API_KEY: keyValue }
        : { [keyName]: keyValue };
  return {
    ok: true,
    mode,
    envs,
    keyName,
    keyValue,
  };
}

// Clearly-non-runtime credential name shapes. Used as the runtime-key allowlist tripwire (a
// runtime key must never be one of these). Deliberately excludes the generic `*_KEY` shape: the
// runtime key this route injects (CODEX_API_KEY/OPENAI_API_KEY) legitimately ends in _KEY, so the
// generic shape would false-positive on it. The positive allowlist, not a denylist, is what
// keeps every other operator-env credential (GitHub/payment/deploy/db/media keys) out of the
// sandbox: the command env is built from exactly the allowlisted runtime key and nothing else.
const NON_RUNTIME_CREDENTIAL_NAME_PATTERNS: RegExp[] = [
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /TOKEN$/i, // deploy tokens, write tokens
  /SECRET/i, // *_SECRET, payment secrets
  /PASSWORD/i,
  /DATABASE_URL/i,
  /(^|_)DSN$/i,
  /STRIPE/i,
  /AWS_/i,
];

/** True when `name` is a clearly-non-runtime credential (cannot be a runtime-key allowlist entry). */
function isNonRuntimeCredentialName(name: string): boolean {
  return NON_RUNTIME_CREDENTIAL_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Build the sandbox metadata from a positive allowlist. This is the only
 * way metadata is set on the terminal route. It carries solely non-secret labels and rejects any
 * value that is not a plain short label. A verifier check asserts the persisted metadata has no
 * prompt/token/secret shapes; this builder makes that true by construction.
 */
export function buildSandboxMetadata(allowlist: {
  studyId: string;
  recordId: string;
  runId: string;
}): Record<string, string> {
  return {
    mode: TERMINAL_PRODUCT_STUDY_PROVIDER_METADATA.mode,
    tool: TERMINAL_PRODUCT_STUDY_PROVIDER_METADATA.tool,
    provider: "codex",
    labId: allowlist.studyId,
    recordId: allowlist.recordId,
    // The run id is a harness-minted token (terminal-<ts>-<hex>), not user data.
    runId: allowlist.runId,
  };
}
