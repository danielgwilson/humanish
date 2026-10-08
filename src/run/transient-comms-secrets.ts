import { AsyncLocalStorage } from "node:async_hooks";

import { REDACTION_MARKERS } from "../evidence/redaction.js";
import {
  holdsSecretValue,
  scrubSecretValues,
  scrubValuesAsWritten,
} from "../evidence/secret-scrub.js";

/** Host-only, invocation-local exact values. No serializer, durable identifier or global fallback. */
type SecretScope = {
  values: Set<string>;
  bytes: number;
  /** The literal scrub of `values`, built at its first use after they change. */
  literal?: (text: string) => string;
  closed: boolean;
  failed: boolean;
};
const scopes = new AsyncLocalStorage<SecretScope>();
const MAX_VALUES = 8192;
const MAX_BYTES = 1024 * 1024;
const MAX_VALUE_BYTES = 65_536;

function usable(scope: SecretScope): void {
  if (scope.closed) throw new Error("TRANSIENT_NARRATION_SCOPE_CLOSED");
  if (scope.failed) throw new Error("TRANSIENT_NARRATION_SECRET_LIMIT");
}
function fail(scope: SecretScope): never {
  scope.failed = true;
  scope.values.clear();
  delete scope.literal;
  throw new Error("TRANSIENT_NARRATION_SECRET_LIMIT");
}

/** Enclose both participant execution and its automatic analysis in one scope. Nested runs isolate too. */
export async function withTransientCommsSecrets<T>(work: () => Promise<T>): Promise<T> {
  const scope: SecretScope = { values: new Set(), bytes: 0, closed: false, failed: false };
  try {
    return await scopes.run(scope, work);
  } finally {
    // Detached work can retain an async context after return. Clear its values and refuse future
    // scrubbing/registration there; never turn an expired scope into an unprotected analysis.
    scope.closed = true;
    scope.values.clear();
    scope.bytes = 0;
    delete scope.literal;
  }
}

export function registerTransientCommsSecrets(values: string[]): void {
  const scope = scopes.getStore();
  if (!scope) return;
  usable(scope);
  for (const value of values) {
    // Values under four characters are ordinary prose (a subject such as "Hi"). Received OTP
    // extraction starts at four characters; management keys and addresses are longer.
    if (value.length < 4 || scope.values.has(value)) continue;
    const bytes = Buffer.byteLength(value);
    if (
      bytes > MAX_VALUE_BYTES ||
      scope.values.size >= MAX_VALUES ||
      scope.bytes + bytes > MAX_BYTES
    )
      fail(scope);
    scope.values.add(value);
    scope.bytes += bytes;
    delete scope.literal;
  }
}

/** Literal, longest-first replacement in one pass; replacement text is never matched recursively. */
export function scrubTransientCommsText(text: string): string {
  const scope = scopes.getStore();
  if (!scope) return text;
  usable(scope);
  scope.literal ??= scrubValuesAsWritten([...scope.values]);
  return scope.literal(text);
}

const REDACTED = REDACTION_MARKERS.secret;

/**
 * A scrub for text a model writes: each scope value as written and in its encoded forms
 * (percent-encoded, JSON-escaped, base64, base64url, hex), and where escapes split one. Text that
 * holds a value is returned decoded with each value replaced. Text without one keeps its original
 * spelling, so an exact quote that holds an escape still matches its evidence. The literal scrub
 * runs first, before decoding can rewrite a value that itself holds an escape, and last. The
 * result is checked last of all: if it still holds a value as written or decoded, as a value
 * holding part of a marker can after the literal scrub, the whole text is replaced. Outside a
 * scope it changes nothing.
 */
export function transientCommsKnownValueScrub(): (text: string) => string {
  const scope = scopes.getStore();
  if (!scope) return scrubTransientCommsText;
  usable(scope);
  const values = [...scope.values];
  const encoded = scrubSecretValues(values);
  const holds = holdsSecretValue(values);
  return (text) => {
    const literal = scrubTransientCommsText(text);
    const result = scrubTransientCommsText(holds(literal) ? encoded(literal) : literal);
    return holds(result) ? REDACTED : result;
  };
}
