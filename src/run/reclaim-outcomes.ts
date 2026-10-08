// What one reclaim found and did, sandbox by sandbox: the outcome vocabulary of
// reclaim-receipt.json, the set of sandboxes a reclaim acts on (each once, with its pending record
// written before its kill starts), the tag search across the tag sets a run recorded, and the
// receipt writer. src/run/reclaim.ts decides what to find; this module records what happened.
import {
  REDACTED_SANDBOX_ID,
  redactText,
  sandboxIdDigest,
  toErrorMessage,
} from "../evidence/redaction.js";
import {
  destroyE2BSandbox,
  findE2BSandboxesByTags,
  inspectE2BSandbox,
  type E2BTagSearch,
} from "../substrates/e2b/sandbox.js";
import type { E2BDesktopModule } from "../substrates/e2b/sdk.js";
import {
  readContainedRegularFile,
  RUN_ARTIFACT_MAX_BYTES,
  writeContainedOutputFile,
  type ContainedRefusal,
  type PreparedOutputRoot,
} from "./contained-output.js";
import { scrubSandboxIds } from "./sandbox-ids.js";
import { isRecord } from "./type-guards.js";

export const RECLAIM_RESULT_SCHEMA = "humanish.reclaim-result.v1";
export const RECLAIM_RECEIPT_ARTIFACT = "reclaim-receipt.json";

/**
 * killed = kill(id) confirmed; already-gone = the server no longer knows the id (TTL or a prior
 * cleanup got it), or the run's route released it before the signal; kill-failed = the attempt
 * errored (the TTL backstop still applies); unsupported-provider = the receipt names a provider
 * this version cannot reach, so nothing was attempted; pending = the kill had not answered when
 * the receipt was written. `--check` writes running, already-gone or check-failed instead.
 */
export type ReclaimOutcomeState =
  | "killed"
  | "already-gone"
  | "kill-failed"
  | "unsupported-provider"
  | "pending"
  | "running"
  | "check-failed";

export interface ReclaimOutcome {
  /** "[redacted-sandbox-id]"; the raw id is only in the run's sandbox-receipts.ndjson. */
  sandboxId: string;
  /** The id's digest, which matches its receipt. */
  sandboxIdDigest: string;
  laneId: string;
  /** How reclaim learned of the sandbox: its receipt, a create in this process whose receipt had
   *  not landed, or E2B's list of sandboxes tagged with this run. */
  source: "receipt" | "create" | "tag";
  state: ReclaimOutcomeState;
  detail?: string;
}

/** E2B's list of sandboxes carrying the run's owner tags. */
export interface ReclaimTagSearch {
  /** not-run: the search did not start, because an earlier step failed or the run was stopping. */
  status: E2BTagSearch["status"] | "not-run";
  /** Tagged sandboxes no receipt or create named. */
  found: number;
  detail?: string;
}

/**
 * clean: every sandbox found is confirmed gone, and the tag search finished with no create still
 * in flight. unconfirmed: a kill did not confirm. running (`--check` only): a sandbox still
 * exists. unknown: nothing failed, but reclaim could not search E2B or a create was still in
 * flight, so a sandbox it never saw may still run.
 */
export type ReclaimState = "clean" | "unconfirmed" | "running" | "unknown";

/** One sandbox reclaim acts on, keyed by provider and raw id. */
export interface Target {
  provider: string;
  rawId: string;
  outcome: ReclaimOutcome;
}

/**
 * The sandboxes one reclaim acts on, each once by provider and raw id. The receipt naming every
 * sandbox found, each pending, lands before that sandbox's kill starts, so an exit during the
 * kills leaves a record of each one not yet confirmed gone.
 */
export function targetSet(options: {
  e2b: E2BDesktopModule | undefined;
  check: boolean;
  requestTimeoutMs: number;
  earlier: ReclaimOutcome[];
  persist: ReturnType<typeof receiptWriter>;
}) {
  const { e2b, check, requestTimeoutMs, earlier, persist } = options;
  const targets = new Map<string, Target>();
  const work: Promise<void>[] = [];
  const queued: Target[] = [];
  let started = false;
  const snapshot = (carried = earlier): ReclaimOutcome[] => {
    const current = [...targets.values()].map((target) => target.outcome);
    const seen = new Set(current.map((outcome) => outcome.sandboxIdDigest));
    return [...current, ...carried.filter((outcome) => !seen.has(outcome.sandboxIdDigest))];
  };
  const act = (target: Target): Promise<void> =>
    actOn(e2b, target, { check, requestTimeoutMs }).then((settled) => {
      target.outcome = settled;
      void persist.write(snapshot(), "unknown");
    });
  return {
    snapshot,
    /** Add one sandbox; false when it was already in the set. */
    add(
      provider: string,
      rawId: string,
      participant: string,
      source: ReclaimOutcome["source"],
      released = false,
    ): boolean {
      const key = JSON.stringify([provider, rawId]);
      if (targets.has(key)) return false;
      const pending = outcomeFor(sandboxIdDigest(rawId), participant, source);
      const target: Target = {
        provider,
        rawId,
        outcome: released
          ? { ...pending, state: "already-gone", detail: "its route released it before the stop" }
          : pending,
      };
      targets.set(key, target);
      if (released) return true;
      if (started) work.push(persist.write(snapshot(), "unknown").then(() => act(target)));
      else queued.push(target);
      return true;
    },
    /** Write the receipt naming every sandbox found so far, then start their kills. */
    async start(): Promise<void> {
      let size: number;
      do {
        size = targets.size;
        await persist.write(snapshot(), "unknown");
      } while (targets.size !== size);
      started = true;
      for (const target of queued) work.push(act(target));
    },
    /** Wait for every kill, including ones added while waiting. */
    async drain(): Promise<void> {
      let count: number;
      do {
        count = work.length;
        await Promise.all(work);
      } while (work.length !== count);
    },
    async finish(outcomes: readonly ReclaimOutcome[], state: ReclaimState): Promise<void> {
      await persist.write(outcomes, state);
    },
  };
}

/** Search E2B by each distinct tag set; done only when every search finished. */
export async function searchTagSets(
  e2b: E2BDesktopModule | undefined,
  tagSets: readonly Record<string, string>[],
  options: { requestTimeoutMs: number; unavailable: string },
): Promise<E2BTagSearch> {
  if (e2b === undefined)
    return { status: "unavailable", sandboxes: [], detail: options.unavailable };
  const distinct = new Map(
    tagSets.map((tags) => [
      JSON.stringify(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b))),
      tags,
    ]),
  );
  const searches = await Promise.all(
    [...distinct.values()].map((tags) =>
      findE2BSandboxesByTags(e2b, tags, { requestTimeoutMs: options.requestTimeoutMs }),
    ),
  );
  const unfinished = searches.find((search) => search.status !== "done");
  const sandboxes = new Map(
    searches.flatMap((search) => search.sandboxes).map((listed) => [listed.sandboxId, listed]),
  );
  return {
    status: unfinished?.status ?? "done",
    sandboxes: [...sandboxes.values()],
    ...(unfinished?.detail === undefined ? {} : { detail: unfinished.detail }),
  };
}

/** Kill (or look up) one sandbox, and say what happened in reclaim's vocabulary. */
async function actOn(
  e2b: E2BDesktopModule | undefined,
  target: Target,
  options: { check: boolean; requestTimeoutMs: number },
): Promise<ReclaimOutcome> {
  const { outcome, provider, rawId } = target;
  if (provider !== "e2b" || e2b === undefined)
    return {
      ...outcome,
      state: "unsupported-provider",
      detail: `provider ${JSON.stringify(provider)} is not supported by this humanish version; nothing was attempted, and that provider's own timeout is the backstop`,
    };
  const attempt = options.check
    ? await inspectE2BSandbox(e2b, rawId, options)
    : await destroyE2BSandbox(e2b, rawId, options);
  const { detail: _previous, ...rest } = outcome;
  // A provider error that quotes the id is scrubbed; the raw id stays in sandbox-receipts.ndjson.
  return "detail" in attempt
    ? { ...rest, state: attempt.state, detail: scrubSandboxIds(attempt.detail, [rawId]) }
    : { ...rest, state: attempt.state };
}

export const GONE = new Set<ReclaimOutcomeState>(["killed", "already-gone"]);
const OUTCOME_STATES = new Set<string>([
  "killed",
  "already-gone",
  "kill-failed",
  "unsupported-provider",
  "pending",
]);

/**
 * The outcomes an earlier reclaim of this directory recorded, by digest. A receipt written before
 * 0.110 names raw ids, which are digested; a missing, malformed or foreign receipt carries
 * nothing. A receipt that is there and refused is returned as the refusal, so reclaim stops
 * before its own receipt replaces one it could not read.
 */
export async function earlierOutcomes(
  root: PreparedOutputRoot,
  label: string,
): Promise<ReclaimOutcome[] | ContainedRefusal> {
  const read = await readContainedRegularFile(
    root,
    RECLAIM_RECEIPT_ARTIFACT,
    RUN_ARTIFACT_MAX_BYTES,
  );
  if (read.status === "refused") return read;
  if (read.status === "missing") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.runId !== label || !Array.isArray(parsed.outcomes)) return [];
  const carried: ReclaimOutcome[] = [];
  for (const entry of parsed.outcomes as unknown[]) {
    if (!isRecord(entry)) continue;
    const text = (key: string): string | undefined =>
      typeof entry[key] === "string" ? entry[key] : undefined;
    const state = text("state");
    const raw = text("sandboxId");
    const digest =
      text("sandboxIdDigest") ??
      (raw === undefined || raw === REDACTED_SANDBOX_ID ? undefined : sandboxIdDigest(raw));
    if (digest === undefined || state === undefined || !OUTCOME_STATES.has(state)) continue;
    const source = text("source");
    const detail = text("detail");
    carried.push({
      ...outcomeFor(
        digest,
        text("laneId") ?? "unknown",
        source === "create" || source === "tag" ? source : "receipt",
      ),
      state: state as ReclaimOutcomeState,
      ...(detail === undefined ? {} : { detail }),
    });
  }
  return carried;
}

/** A pending outcome, naming the sandbox by digest only. */
function outcomeFor(
  digest: string,
  participant: string,
  source: ReclaimOutcome["source"],
): ReclaimOutcome {
  return {
    sandboxId: REDACTED_SANDBOX_ID,
    sandboxIdDigest: digest,
    laneId: participant,
    source,
    state: "pending",
  };
}

export function rootState(
  outcomes: readonly ReclaimOutcome[],
  check: boolean,
  searched: boolean,
): ReclaimState {
  if (check && outcomes.some((outcome) => outcome.state === "running")) return "running";
  const gone = outcomes.every((outcome) => GONE.has(outcome.state));
  if (!gone) return check ? "unknown" : "unconfirmed";
  return searched ? "clean" : "unknown";
}

/** Resolves when `settled` does, or after `ms` if given, whichever is first. */
export async function settledWithin(settled: Promise<void>, ms: number | undefined): Promise<void> {
  if (ms === undefined) return settled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Writes reclaim-receipt.json in order, one write at a time, each with the latest outcomes. A
 * check writes nothing. A failed write adds one warning and leaves the result unchanged.
 */
export function receiptWriter(
  root: PreparedOutputRoot,
  runId: string,
  receiptCount: number,
  check: boolean,
  warnings: string[],
) {
  let chain: Promise<void> = Promise.resolve();
  let failed = false;
  return {
    /** Queue one write with these outcomes; resolves once it has landed or failed. */
    write(outcomes: readonly ReclaimOutcome[], state: ReclaimState): Promise<void> {
      if (check) return chain;
      const text = `${JSON.stringify({ schema: RECLAIM_RESULT_SCHEMA, at: new Date().toISOString(), runId, state, receiptCount, outcomes }, null, 2)}\n`;
      chain = chain.then(() =>
        writeContainedOutputFile(root, RECLAIM_RECEIPT_ARTIFACT, text, "utf8").catch(
          (error: unknown) => {
            if (failed) return;
            failed = true;
            warnings.push(
              `Reclaim ran but its receipt could not be written: ${redactText(toErrorMessage(error))}`,
            );
          },
        ),
      );
      return chain;
    },
  };
}
