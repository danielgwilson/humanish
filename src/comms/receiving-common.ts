/**
 * What run-scoped receiving (receiving.ts) and its recovery (receiving-recovery.ts) share: the
 * coded error, safe-code mapping, operation deadlines, and release under the lease journal's
 * authority.
 */
import { CommsAuthorityError, type CommsLeaseStore } from "./lease-store.js";
import type { ReceivingAdapter, ReceivingContext, ReceivingLease } from "./receiving-types.js";

export const REQUEST_MS = 15_000;

export class CommsReceivingError extends Error {
  constructor(readonly code: string) {
    super(
      "Real email receiving could not complete. Inspect communications coverage and private cleanup status.",
    );
    this.name = "CommsReceivingError";
  }
}
/** Adapter codes pass through only when the adapter declares them. */
export function errorCode(error: unknown, fallback: string, safe: ReadonlySet<string>): string {
  if (error instanceof CommsReceivingError) return error.code;
  if (error instanceof CommsAuthorityError) return "comms_authority_unavailable";
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && safe.has(code) ? code : fallback;
}

/** Deadlines bound even a broken injected dependency; cancellation reaches cooperative I/O. */
export function withDeadline<T>(
  operation: (context: ReceivingContext) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (error: unknown, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const abort = (): void => {
      controller.abort();
      finish(new CommsReceivingError("comms_cancelled"));
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(new CommsReceivingError("comms_deadline_exceeded"));
    }, timeoutMs);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    // Give cooperative dependencies time to return retained partial results before our hard
    // cancellation. Equal timers make the earlier host timer discard the adapter's partial batch.
    const cooperativeTimeout = Math.max(1, timeoutMs - Math.min(500, Math.floor(timeoutMs / 10)));
    Promise.resolve()
      .then(() => operation({ signal: controller.signal, timeoutMs: cooperativeTimeout }))
      .then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
  });
}

export async function releaseOwned(
  adapter: ReceivingAdapter,
  lease: ReceivingLease,
  store: CommsLeaseStore,
): Promise<"absent" | "deleting"> {
  // Each call has an operation deadline; the small retry count bounds asynchronous deletion.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await store.assertOwnership();
    const authority = store.snapshot().leases.find((item) => item.clientId === lease.clientId);
    if (
      !authority ||
      authority.ownership !== "fresh" ||
      authority.lease?.resourceId !== lease.resourceId ||
      authority.lease.address !== lease.address
    ) {
      throw new CommsReceivingError("comms_ownership_mismatch");
    }
    const result = await withDeadline(
      (context) => adapter.release(structuredClone(lease), context),
      REQUEST_MS,
    );
    if (result.status === "absent") return "absent";
    if (result.status !== "deleting") throw new CommsReceivingError("cleanup_invalid_result");
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return "deleting";
}
