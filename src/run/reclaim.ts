// `humanish reclaim`: stop an interrupted run's sandboxes and report what happened to each. It
// finds them three ways: the exact ids the run journaled at create time (sandbox-receipts.ndjson),
// the ids a create in this process reported before its receipt landed (the signal handler only),
// and E2B's list of sandboxes tagged with the run's owner tags (sandboxOwnerTags), which covers a
// sandbox whose id never reached the run. The list is filtered server-side by the run's tags and
// each result is checked against every tag again, so it can only return this run's sandboxes; an
// account-wide operation once destroyed unrelated infrastructure. Kills run concurrently, and
// reclaim-receipt.json is written before the first kill and after each one, so an exit at any
// point leaves a record of every sandbox not yet confirmed gone. `--check` asks E2B the same
// questions and kills nothing.
import {
  E2B_DEBUG_ENV,
  e2bDebugMode,
  loadE2BDesktopModule,
  type E2BDesktopModule,
} from "../substrates/e2b/sdk.js";
import {
  containedPathAbsent,
  readContainedRegularFile,
  type PreparedOutputRoot,
} from "./contained-output.js";
import {
  discardPreflightJournal,
  listPreflightJournals,
  preflightReclaimDecision,
} from "./preflight-receipts.js";
import { resolveRunPath } from "./locate.js";
import {
  parseSandboxOwners,
  parseSandboxReceipts,
  SANDBOX_RECEIPTS_ARTIFACT,
} from "./sandbox-receipts.js";
import {
  sandboxOwnerTags,
  type CreatedSandbox,
  type StoppedSandboxCreates,
} from "./sandbox-creates.js";
import {
  earlierOutcomes,
  GONE,
  RECLAIM_RECEIPT_ARTIFACT,
  RECLAIM_RESULT_SCHEMA,
  receiptWriter,
  rootState,
  searchTagSets,
  settledWithin,
  targetSet,
  type ReclaimOutcome,
  type ReclaimState,
  type ReclaimTagSearch,
} from "./reclaim-outcomes.js";
import { redactText, toErrorMessage } from "../evidence/redaction.js";
import { runIdOf, type PreparedRunArtifactPaths } from "./paths.js";

export { RECLAIM_RECEIPT_ARTIFACT };

export interface ReclaimResult {
  schema: typeof RECLAIM_RESULT_SCHEMA;
  /** True only when `state` is clean. */
  ok: boolean;
  state: ReclaimState;
  /** `check` kills nothing and writes nothing. */
  mode: "kill" | "check";
  cwd: string;
  runId: string;
  /** Receipts found in the run's journal (0 = nothing journaled, or the run predates receipts). */
  receiptCount: number;
  outcomes: ReclaimOutcome[];
  tagSearch: ReclaimTagSearch;
  /** Creates that had not returned when reclaim finished; only the signal handler sees any. */
  createsInFlight: number;
  warnings: string[];
  error?: {
    code:
      | "HUMANISH_RECLAIM_RUN_NOT_FOUND"
      | "HUMANISH_RECLAIM_E2B_DEBUG"
      | "HUMANISH_RECLAIM_MODULE_UNAVAILABLE"
      | "HUMANISH_RECLAIM_RECEIPTS_UNREADABLE";
    message: string;
  };
}

export interface ReclaimHooks {
  /** Tests inject a fake @e2b/desktop module; default loads the real one. */
  loadModule?: () => Promise<E2BDesktopModule>;
  requestTimeoutMs?: number;
  /** Ask E2B whether each sandbox still exists, and kill nothing. */
  check?: boolean;
  /** The signal handler's view of this run's creates: the ids they reported, and those still
   *  in flight, whose sandboxes are killed as their ids arrive. */
  creates?: StoppedSandboxCreates;
  /** How long to wait for in-flight creates before the tag search runs anyway. */
  createsWaitMs?: number;
}

export function reclaimRunSandboxes(
  cwd: string,
  runInput: string,
  hooks: ReclaimHooks = {},
): Promise<ReclaimResult> {
  return reclaimRun(cwd, runInput, () => resolveRunPath(cwd, runInput), hooks);
}

/**
 * Reclaim the run whose directory the caller already holds. Nothing is resolved, so an id that is
 * also an alias (a run named `latest`) cannot reach another run's receipts.
 */
export function reclaimPinnedRunSandboxes(
  cwd: string,
  runPaths: PreparedRunArtifactPaths,
  hooks: ReclaimHooks = {},
): Promise<ReclaimResult> {
  return reclaimRun(cwd, runIdOf(runPaths), () => Promise.resolve(runPaths), hooks);
}

function emptyResult(cwd: string, runId: string, hooks: ReclaimHooks, warnings: string[]) {
  return {
    schema: RECLAIM_RESULT_SCHEMA,
    ok: false,
    state: "unknown",
    mode: hooks.check === true ? "check" : "kill",
    cwd,
    runId,
    receiptCount: 0,
    outcomes: [],
    tagSearch: { status: "not-run", found: 0 },
    createsInFlight: 0,
    warnings,
  } satisfies ReclaimResult;
}

async function reclaimRun(
  cwd: string,
  runInput: string,
  locate: () => Promise<PreparedRunArtifactPaths | null>,
  hooks: ReclaimHooks,
): Promise<ReclaimResult> {
  const warnings: string[] = [];
  const base = emptyResult(cwd, runInput, hooks, warnings);
  if (e2bDebugMode()) return { ...base, error: E2B_DEBUG_REFUSAL };

  const runPaths = await locate();
  if (!runPaths) {
    return {
      ...base,
      error: {
        code: "HUMANISH_RECLAIM_RUN_NOT_FOUND",
        message: `No run found for "${runInput}" (use \`humanish runs\` to list runs).`,
      },
    };
  }
  const runId = runIdOf(runPaths);
  const reclaimed = await reclaimRoot(runPaths, runId, hooks, warnings);
  if (reclaimed.kind === "module-unavailable")
    return {
      ...base,
      runId,
      receiptCount: reclaimed.receiptCount,
      error: { code: "HUMANISH_RECLAIM_MODULE_UNAVAILABLE", message: reclaimed.message },
    };
  if (reclaimed.kind === "unreadable")
    return {
      ...base,
      runId,
      error: { code: "HUMANISH_RECLAIM_RECEIPTS_UNREADABLE", message: UNREADABLE_MESSAGE },
    };
  const { state, receiptCount, outcomes, tagSearch, createsInFlight } = reclaimed;
  return {
    ...base,
    ok: state === "clean",
    state,
    runId,
    receiptCount,
    outcomes,
    tagSearch,
    createsInFlight,
  };
}

/**
 * Kill the sandboxes left by interrupted `humanish study check` probes. A probe journals under
 * .humanish/preflight/<probe-id>/ and removes the journal after a confirmed kill, so what is left
 * belongs to a probe that died or could not confirm its teardown. A journal whose probe may still
 * be running is left alone with the reason (see preflightReclaimDecision).
 */
export async function reclaimPreflightSandboxes(
  cwd: string,
  hooks: ReclaimHooks = {},
): Promise<ReclaimResult> {
  const warnings: string[] = [];
  const base = emptyResult(cwd, "preflight", hooks, warnings);
  if (e2bDebugMode()) return { ...base, error: E2B_DEBUG_REFUSAL };
  const outcomes: ReclaimOutcome[] = [];
  let receiptCount = 0;
  const states: ReclaimState[] = [];
  // Not run until a journal is reclaimed; then done unless one journal's search was not.
  const tagSearch: ReclaimTagSearch = { status: "not-run", found: 0 };
  const journals = await listPreflightJournals(cwd);
  if (journals.length === 0) {
    warnings.push(
      "No preflight journals in .humanish/preflight: every probe's teardown was confirmed, or no probe ran here. Nothing to reclaim.",
    );
  }
  for (const journal of journals) {
    const decision = await preflightReclaimDecision(journal, Date.now());
    if (!decision.reclaim) {
      warnings.push(`Preflight ${journal.id} left alone: ${decision.reason}.`);
      states.push("unknown");
      continue;
    }
    const reclaimed = await reclaimRoot(journal.root, journal.id, hooks, warnings);
    if (reclaimed.kind === "unreadable") {
      // The receipt may name a live sandbox; the journal stays for a later reclaim.
      warnings.push(`Preflight ${journal.id} left alone: ${UNREADABLE_MESSAGE}`);
      states.push("unknown");
      continue;
    }
    if (reclaimed.kind === "module-unavailable") {
      return {
        ...base,
        receiptCount: receiptCount + reclaimed.receiptCount,
        outcomes,
        error: { code: "HUMANISH_RECLAIM_MODULE_UNAVAILABLE", message: reclaimed.message },
      };
    }
    receiptCount += reclaimed.receiptCount;
    outcomes.push(...reclaimed.outcomes);
    const { state } = reclaimed;
    states.push(state);
    tagSearch.found += reclaimed.tagSearch.found;
    if (tagSearch.status === "not-run" || reclaimed.tagSearch.status !== "done") {
      tagSearch.status = reclaimed.tagSearch.status;
      if (reclaimed.tagSearch.detail !== undefined) tagSearch.detail = reclaimed.tagSearch.detail;
    }
    // The journal stays until its sandboxes are known to be gone, so a later reclaim can try
    // again; its receipt says what happened. Elapsed time alone never removes it: a probe can
    // create later than its journal says, and a journal from before owner lines cannot show that
    // nothing it made is still running. A check never removes it.
    if (state !== "clean" || hooks.check === true) {
      if (state === "unknown" && reclaimed.exhausted && hooks.check !== true)
        warnings.push(
          `Preflight ${journal.id} is kept: humanish cannot rule out a sandbox it made. Once the E2B dashboard shows no sandbox for it, delete .humanish/preflight/${journal.id}.`,
        );
      continue;
    }
    await discardPreflightJournal(journal, [RECLAIM_RECEIPT_ARTIFACT]).catch((error: unknown) => {
      warnings.push(
        `Preflight ${journal.id} was reclaimed but its journal could not be removed: ${redactText(toErrorMessage(error))}`,
      );
    });
  }
  const state = combinedState(states);
  return { ...base, ok: state === "clean", state, receiptCount, outcomes, tagSearch };
}

function combinedState(states: readonly ReclaimState[]): ReclaimState {
  for (const worst of ["running", "unconfirmed", "unknown"] as const)
    if (states.includes(worst)) return worst;
  return "clean";
}

// In debug mode the SDK returns true from Sandbox.kill without contacting E2B, so every receipt
// would read killed and preflight journals would be discarded for sandboxes that may still run.
const E2B_DEBUG_REFUSAL = {
  code: "HUMANISH_RECLAIM_E2B_DEBUG",
  message: `${E2B_DEBUG_ENV}=true puts the E2B SDK in debug mode, where Sandbox.kill reports success without contacting E2B. Nothing was killed and the receipts were kept; unset ${E2B_DEBUG_ENV} and run reclaim again.`,
} as const;

const UNREADABLE_MESSAGE =
  "sandbox-receipts.ndjson is present but could not be read safely (not a single regular file, or a read error). Nothing was killed and the receipts were kept; check the file, then run reclaim again.";

type RootReclaim =
  | { kind: "unreadable" }
  | { kind: "module-unavailable"; receiptCount: number; message: string }
  | {
      kind: "done";
      state: ReclaimState;
      /** Everything found is gone and the search finished, so only a missing owner line keeps the
       *  state from clean. */
      exhausted: boolean;
      receiptCount: number;
      outcomes: ReclaimOutcome[];
      tagSearch: ReclaimTagSearch;
      createsInFlight: number;
    };

/**
 * Find and stop (or, for `--check`, look up) every sandbox one directory owns: its receipts, the
 * creates this process reported, and E2B's tagged list, each once by exact id.
 */
async function reclaimRoot(
  root: PreparedOutputRoot,
  label: string,
  hooks: ReclaimHooks,
  warnings: string[],
): Promise<RootReclaim> {
  const bytes = await readContainedRegularFile(root, SANDBOX_RECEIPTS_ARTIFACT);
  if (bytes === null && !(await containedPathAbsent(root, SANDBOX_RECEIPTS_ARTIFACT)))
    return { kind: "unreadable" };
  const journal = bytes === null ? "" : bytes.toString("utf8");
  const receipts = parseSandboxReceipts(journal);
  const owners = parseSandboxOwners(journal, label);
  const check = hooks.check === true;
  const requestTimeoutMs = hooks.requestTimeoutMs ?? 60_000;

  // The SDK lists by tag as well as killing by id, so it is needed even with no receipt. Without
  // it, an E2B receipt cannot be acted on; with no E2B receipt, only the tag search is lost.
  let e2b: E2BDesktopModule | undefined;
  let moduleError: string | undefined;
  try {
    e2b = await (hooks.loadModule ?? loadE2BDesktopModule)();
  } catch (error) {
    moduleError = `Cannot load @e2b/desktop to reach E2B: ${redactText(toErrorMessage(error))}`;
    if (receipts.some((receipt) => receipt.provider === "e2b") || hooks.creates !== undefined)
      return { kind: "module-unavailable", receiptCount: receipts.length, message: moduleError };
  }
  // An earlier reclaim may have killed a sandbox no receipt names (the signal handler's creates
  // and tag finds). Its outcome is carried forward, so a later reclaim never erases that record.
  const earlier = check ? [] : await earlierOutcomes(root, label);
  const set = targetSet({
    e2b,
    check,
    requestTimeoutMs,
    earlier,
    persist: receiptWriter(root, label, receipts.length, check, warnings),
  });

  // The watch replays the creates reported so far, synchronously, then each one an in-flight
  // create reports, until reclaim returns. The replayed ones are matched to receipts first, so a
  // sandbox the route already released is skipped whichever record names it.
  const replayed = new Map<string, CreatedSandbox>();
  let replaying = true;
  const unwatch = hooks.creates?.watch((sandbox) => {
    if (replaying) replayed.set(sandbox.sandboxId, sandbox);
    else set.add("e2b", sandbox.sandboxId, sandbox.participantId, "create", sandbox.released);
  });
  replaying = false;
  for (const receipt of receipts) {
    const released = receipt.provider === "e2b" && replayed.get(receipt.sandboxId)?.released;
    set.add(receipt.provider, receipt.sandboxId, receipt.laneId, "receipt", released === true);
  }
  for (const sandbox of replayed.values())
    set.add("e2b", sandbox.sandboxId, sandbox.participantId, "create", sandbox.released);
  await set.start();

  if (hooks.creates !== undefined) await settledWithin(hooks.creates.settled, hooks.createsWaitMs);
  // The tags the run recorded before each create, and this directory's own: a copied or moved
  // run directory computes other tags than the ones its sandboxes carry.
  const search = await searchTagSets(e2b, [...owners, sandboxOwnerTags(root)], {
    requestTimeoutMs,
    unavailable: moduleError ?? "no E2B SDK",
  });
  let found = 0;
  for (const listed of search.sandboxes) {
    const metadata = listed.metadata ?? {};
    const participant = metadata.participantId ?? metadata.kind ?? "unknown";
    if (set.add("e2b", listed.sandboxId, participant, "tag")) found += 1;
  }
  const tagSearch: ReclaimTagSearch = {
    status: search.status,
    found,
    ...(search.detail === undefined ? {} : { detail: search.detail }),
  };
  if (search.status !== "done")
    warnings.push(
      `Could not search E2B for sandboxes tagged with ${label}: ${search.detail ?? search.status}. A sandbox whose id never reached a receipt would not be found.`,
    );
  // A create that reports its id while the search or a kill is still running is killed too.
  await set.drain();
  unwatch?.();
  const createsInFlight = hooks.creates?.inFlight() ?? 0;

  // An empty search proves nothing for a run that never recorded its tags: one from humanish
  // 0.110 or earlier, or whose owner lines were lost. The process that made the creates knows.
  const provenance = owners.length > 0 || hooks.creates !== undefined;
  if (!provenance)
    warnings.push(
      `${label} records no owner tags, so a sandbox whose id never reached a receipt cannot be ruled out: the run predates humanish 0.111, it created no sandbox, or its journal lost those lines. Each sandbox's create-time timeout is the backstop.`,
    );
  // A carried sandbox from a create or a tag search carries this run's tags; if the finished
  // search, with the tags the run recorded, no longer lists it, it is gone. One from an older
  // receipt, or from a run with no recorded tags, is left as it was recorded.
  const covered = provenance && tagSearch.status === "done";
  const outcomes = set.snapshot(
    earlier.map((outcome) =>
      GONE.has(outcome.state) || outcome.source === "receipt" || !covered
        ? outcome
        : {
            ...outcome,
            state: "already-gone" as const,
            detail:
              "an earlier reclaim left it unconfirmed, and E2B no longer lists it with this run's tags",
          },
    ),
  );
  const searched = tagSearch.status === "done" && createsInFlight === 0;
  const state = rootState(outcomes, check, searched && provenance);
  await set.finish(outcomes, state);
  return {
    kind: "done",
    state,
    exhausted: searched && outcomes.every((outcome) => GONE.has(outcome.state)),
    receiptCount: receipts.length,
    outcomes,
    tagSearch,
    createsInFlight,
  };
}
