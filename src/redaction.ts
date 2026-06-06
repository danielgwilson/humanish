import { realpathSync } from "node:fs";
import path from "node:path";

// Single source of truth for public-safety redaction patterns. Both the Codex
// actor trace (src/codex-app-server.ts) and the run-bundle scanner/redactor
// (src/run.ts) use these so the denylist cannot drift between producers and the
// verify gate. See docs/contracts/policy.md for the enforcement-scope policy.

export const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\be2b_[A-Za-z0-9]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:@/\s]+:[^@/\s]+@\S+/g,
  /_authToken\s*=\s*[A-Za-z0-9._~+/=-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b/g,
  /https?:\/\/[^/\s]*e2b[^)\s]+/gi,
  /BEGIN (RSA|OPENSSH|PRIVATE) KEY/gi
];

export const LOCAL_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/\/private\/var\/folders\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/var\/folders\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/private\/tmp\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/tmp\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/Users\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g, "[REDACTED_LOCAL_PATH]"],
  [/\/home\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g, "[REDACTED_RUNTIME_PATH]"]
];

// Sticky/global regexes carry lastIndex state across .test() calls. Always reset
// before a detection test so the shared singletons are safe to reuse.
function matchesPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/** True if the text contains any secret-shaped token or known local path. */
export function containsSensitive(text: string): boolean {
  return (
    SECRET_PATTERNS.some((pattern) => matchesPattern(pattern, text)) ||
    LOCAL_PATH_PATTERNS.some(([pattern]) => matchesPattern(pattern, text))
  );
}

/** Redact secrets to [REDACTED_SECRET] and local paths to their path labels. */
export function redactText(text: string): string {
  const withoutSecrets = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED_SECRET]"),
    text
  );
  return LOCAL_PATH_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    withoutSecrets
  );
}

/** Redact every sensitive match (secrets and paths) to a single [REDACTED_SECRET] label. */
export function redactToSecretLabel(text: string): string {
  const withoutSecrets = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED_SECRET]"),
    text
  );
  return LOCAL_PATH_PATTERNS.reduce(
    (current, [pattern]) => current.replace(pattern, "[REDACTED_SECRET]"),
    withoutSecrets
  );
}

function canonicalizePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    // Follow symlinks so an actor cwd reported in realpath form (e.g. /private/tmp
    // on macOS) matches a configured root still in its symlinked form (/tmp).
    // Without this, path.relative yields a "../"-prefixed path that escapes the
    // [target-cwd] label and leaks an absolute temp path into the trace.
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Label a path relative to the run's target cwd, or redact it. Returns
 * "[target-cwd]" for the root itself, "[target-cwd]/<rel>" for a descendant, and
 * a redacted form for anything outside the root or a non-absolute value.
 */
export function publicPathForTrace(value: string, rootCwd: string): string {
  if (!path.isAbsolute(value)) {
    return redactText(value);
  }

  const root = canonicalizePath(rootCwd);
  const absolute = canonicalizePath(value);
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (relative === "") {
    return "[target-cwd]";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `[target-cwd]/${relative}`;
  }
  return redactText(value);
}
