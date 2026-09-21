import { AsyncLocalStorage } from "node:async_hooks";

/** Host-only, invocation-local exact values. No serializer, durable identifier or global fallback. */
type SecretScope = { values: Set<string>; bytes: number; pattern?: RegExp; closed: boolean; failed: boolean };
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
  delete scope.pattern;
  throw new Error("TRANSIENT_NARRATION_SECRET_LIMIT");
}

/** Enclose both participant execution and its automatic analysis in one scope. Nested runs isolate too. */
export async function withTransientCommsSecrets<T>(work: () => Promise<T>): Promise<T> {
  const scope: SecretScope = { values: new Set(), bytes: 0, closed: false, failed: false };
  try { return await scopes.run(scope, work); }
  finally {
    // Detached work can retain an async context after return. Clear its values and refuse future
    // scrubbing/registration there; never turn an expired scope into an unprotected analysis.
    scope.closed = true;
    scope.values.clear();
    scope.bytes = 0;
    delete scope.pattern;
  }
}

export function registerTransientCommsSecrets(values: string[]): void {
  const scope = scopes.getStore();
  if (!scope) return;
  usable(scope);
  for (const value of values) {
    // Match the existing narration registry: short subjects such as "Hi" are ordinary prose.
    // Received OTP extraction starts at four characters; management keys and addresses are longer.
    if (value.length < 4 || scope.values.has(value)) continue;
    const bytes = Buffer.byteLength(value);
    if (bytes > MAX_VALUE_BYTES || scope.values.size >= MAX_VALUES || scope.bytes + bytes > MAX_BYTES) fail(scope);
    scope.values.add(value);
    scope.bytes += bytes;
    delete scope.pattern;
  }
}

/** Literal, longest-first replacement in one pass; replacement text is never matched recursively. */
export function scrubTransientCommsText(text: string): string {
  const scope = scopes.getStore();
  if (!scope) return text;
  usable(scope);
  if (!scope.values.size) return text;
  try {
    scope.pattern ??= new RegExp([...scope.values].sort((a, b) => b.length - a.length)
      .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    return text.replace(scope.pattern, "[REDACTED_SECRET]");
  } catch { return fail(scope); }
}
