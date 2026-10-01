/** Explicit cleanup of real-email leases a run left behind, and read-only inspection of them. */
import {
  CommsAuthorityError,
  CommsLeaseStore,
  inspectCommsLeaseStore,
  sameReceivingIdentity,
  validReceivingIdentity,
  validReceivingLease,
  type CommsRecoveryEntry,
} from "./lease-store.js";
import {
  CommsReceivingError,
  errorCode,
  releaseOwned,
  REQUEST_MS,
  withDeadline,
} from "./receiving-common.js";
import { RECEIVING_SCOPE_UNSUPPORTED, type ReceivingAdapter } from "./receiving-types.js";

/** Side-effect-free local inspection: does not authenticate, enumerate provider resources or replay creation. */
export async function inspectCommsRecovery(options: {
  cwd: string;
  stateDir?: string;
}): Promise<CommsRecoveryEntry[]> {
  return inspectCommsLeaseStore(options);
}

/** Explicit mutation: may replay an uncertain original create, then immediately dispose that exact resource. */
export async function recoverCommsReceiving(options: {
  cwd: string;
  runId: string;
  connectionName: string;
  apiKeyEnv: string;
  adapter: ReceivingAdapter;
  stateDir?: string;
}): Promise<{ ok: boolean; recovered: number; unresolved: number; message: string }> {
  let store: CommsLeaseStore | undefined;
  let recovered = 0;
  let unresolved = 0;
  let result: { ok: boolean; recovered: number; unresolved: number; message: string };
  try {
    store = await CommsLeaseStore.recover(options);
    const identity = await withDeadline(
      (context) => options.adapter.authenticate(context),
      REQUEST_MS,
    ).catch((error: unknown) => {
      // Journals bind only credentials that could acquire, so a narrower one cannot match.
      throw errorCode(error, "", options.adapter.codes) === RECEIVING_SCOPE_UNSUPPORTED
        ? new CommsAuthorityError("binding_mismatch")
        : error;
    });
    if (
      !validReceivingIdentity(identity) ||
      !sameReceivingIdentity(store.snapshot().identity, identity)
    )
      throw new CommsAuthorityError("binding_mismatch");
    for (const record of store.snapshot().leases) {
      if (record.state === "absent" || record.state === "not-created") continue;
      try {
        if (record.state === "planned") {
          await store.setState(record.participantId, "not-created");
          continue;
        }
        await store.assertOwnership();
        // Use the recorded client ID even if no resource ID was received before the interruption.
        // A non-idempotent replay would create a second inbox; leave the record unresolved.
        if (!record.lease && !options.adapter.idempotentAcquire)
          throw new CommsReceivingError("comms_replay_unsupported");
        const lease =
          record.lease ??
          (await withDeadline(
            (context) => options.adapter.acquire(record.clientId, context),
            REQUEST_MS,
          ));
        if (!validReceivingLease(lease, record.clientId))
          throw new CommsAuthorityError("binding_mismatch");
        if (!record.lease) await store.bind(record.participantId, lease);
        await store.setState(record.participantId, "closing");
        const status = await releaseOwned(options.adapter, lease, store);
        await store.setState(record.participantId, status);
        if (status === "absent") recovered += 1;
        else unresolved += 1;
      } catch {
        unresolved += 1;
        try {
          await store.setState(record.participantId, "unresolved");
        } catch {
          /* Original durable intent remains. */
        }
      }
    }
    result = {
      ok: unresolved === 0,
      recovered,
      unresolved,
      message:
        unresolved === 0
          ? "Owned inbox cleanup is confirmed absent. This does not establish permanent provider data erasure."
          : "Some owned inbox cleanup is unresolved. Retry explicit recovery with the same connection; no replacement identities were requested.",
    };
  } catch (error) {
    unresolved =
      store
        ?.snapshot()
        .leases.filter((item) => item.state !== "absent" && item.state !== "not-created").length ??
      0;
    result = {
      ok: false,
      recovered,
      unresolved,
      message:
        error instanceof CommsAuthorityError
          ? error.message
          : "Communications recovery could not establish provider access. No unverified resource was deleted.",
    };
  }
  if (store) {
    try {
      await store.close();
    } catch {
      result = {
        ...result,
        ok: false,
        message:
          "Communications authority could not be finalized. Inspect local recovery status before retrying.",
      };
    }
  }
  return result;
}
