import type {
  ActorProviderRequest,
  ActorTokenUsage,
  ProviderRequestReceipt,
} from "../../contract.js";
import type { CuaProviderError } from "../provider-error.js";
import type { CuaLiveMetadata, CuaProvider, CuaTurn } from "./types.js";

// Token accounting for one loop session: the running usage both spend guards price, the request
// receipts a single-dispatch provider settles, and whether any usage went unreported.

type TurnUsage = NonNullable<CuaTurn["usage"]>;
type UsageTurns = NonNullable<ActorTokenUsage["turns"]>;

/** Turn usage with valid input and output counts, cache counts within input, and turns that add up. */
export type CompleteTurnUsage = TurnUsage & { input: number; output: number };

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizedUsageTurns(usage: TurnUsage): UsageTurns | undefined {
  if (!Array.isArray(usage.turns) || usage.turns.length === 0) return undefined;
  const fields = ["input", "output", "cachedInput", "cacheWriteInput"] as const;
  const turns: UsageTurns = [];
  for (const raw of usage.turns) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    if (
      fields.every((field) => raw[field] === undefined) ||
      fields.some((field) => raw[field] !== undefined && !validTokenCount(raw[field]))
    )
      return undefined;
    if ((raw.cachedInput ?? 0) + (raw.cacheWriteInput ?? 0) > (raw.input ?? 0)) return undefined;
    turns.push(
      Object.fromEntries(
        fields.flatMap((field) => (raw[field] === undefined ? [] : [[field, raw[field]]])),
      ),
    );
  }
  return fields.every(
    (field) => turns.reduce((sum, turn) => sum + (turn[field] ?? 0), 0) === (usage[field] ?? 0),
  )
    ? turns
    : undefined;
}

export function isCompleteTurnUsage(usage: CuaTurn["usage"]): usage is CompleteTurnUsage {
  return (
    usage !== undefined &&
    validTokenCount(usage.input) &&
    validTokenCount(usage.output) &&
    (usage.cachedInput === undefined || validTokenCount(usage.cachedInput)) &&
    (usage.cacheWriteInput === undefined || validTokenCount(usage.cacheWriteInput)) &&
    (usage.cachedInput ?? 0) + (usage.cacheWriteInput ?? 0) <= usage.input &&
    (usage.turns === undefined || normalizedUsageTurns(usage) !== undefined)
  );
}

const UNKNOWN_RECEIPT: ProviderRequestReceipt = {
  dispatched: "unknown",
  usageComplete: false,
  cleanup: "unconfirmed",
};

/** A receipt as the provider declared it, or unknown when the declaration is malformed. */
export function settledReceipt(raw: ProviderRequestReceipt | undefined): ProviderRequestReceipt {
  return raw &&
    (typeof raw.dispatched === "boolean" || raw.dispatched === "unknown") &&
    typeof raw.usageComplete === "boolean" &&
    ["confirmed", "unconfirmed"].includes(raw.cleanup)
    ? { dispatched: raw.dispatched, usageComplete: raw.usageComplete, cleanup: raw.cleanup }
    : { ...UNKNOWN_RECEIPT };
}

/** Only the valid token counts of a reported usage. */
export function reportedCounts(raw: ActorTokenUsage): ActorTokenUsage {
  const usage: ActorTokenUsage = {};
  for (const key of ["input", "output", "cachedInput", "cacheWriteInput", "total"] as const) {
    const value = raw[key];
    if (validTokenCount(value)) usage[key] = value;
  }
  return usage;
}

export class UsageLedger {
  /** Settled single-dispatch requests, in order: the trace's providerRequests. */
  readonly requests: ActorProviderRequest[] = [];
  /** A continuing request yielded actions and has not settled yet. */
  requestPending = false;
  /** A request did not confirm cleanup; no further request or action is admitted. */
  cleanupUnconfirmed = false;
  /** Some usage was reported; the trace records tokenUsage only then. */
  sawUsage = false;
  private input = 0;
  private cachedInput = 0;
  private cacheWriteInput = 0;
  private output = 0;
  // Per model-inference usage, in order (#334): the recorded fact long-context pricing tiers
  // need. A continuing native tool interaction may contain several inference requests.
  private readonly turns: UsageTurns = [];
  private incompleteInteraction = false;
  private unreportedInteraction = false;

  constructor(private readonly provider: CuaProvider) {}

  record(turn: CuaTurn, interaction = true): void {
    if (turn.providerRequestPending === true) return;
    const raw = turn.usage;
    const turns = raw?.turns === undefined ? undefined : normalizedUsageTurns(raw);
    if (interaction && (!isCompleteTurnUsage(raw) || turn.providerRequest?.usageComplete === false))
      this.incompleteInteraction = true;
    if (interaction && raw?.turns !== undefined && turns === undefined)
      this.unreportedInteraction = true;
    if (raw === undefined) return;
    const usage = {
      ...(validTokenCount(raw.input) ? { input: raw.input } : {}),
      ...(validTokenCount(raw.output) ? { output: raw.output } : {}),
      ...(validTokenCount(raw.cachedInput) ? { cachedInput: raw.cachedInput } : {}),
      ...(validTokenCount(raw.cacheWriteInput) ? { cacheWriteInput: raw.cacheWriteInput } : {}),
    };
    if (Object.keys(usage).length === 0) return;
    this.sawUsage = true;
    this.input += usage.input ?? 0;
    this.cachedInput += usage.cachedInput ?? 0;
    this.cacheWriteInput += usage.cacheWriteInput ?? 0;
    this.output += usage.output ?? 0;
    if (raw.turns === undefined) this.turns.push(usage);
    else if (turns !== undefined) this.turns.push(...turns);
  }

  /** A request may have been billed without reporting usage. */
  markUnreported(): void {
    this.unreportedInteraction = true;
  }

  /**
   * Book one settled single-dispatch request. A request that settles while an earlier yield is
   * pending belongs to that interaction, whatever kind the caller asked for.
   */
  settle(
    kind: "interaction" | "debrief",
    receipt: ProviderRequestReceipt,
    usage: ActorTokenUsage | undefined,
    error: CuaProviderError | undefined,
  ): "interaction" | "debrief" {
    // src/actors/codex/restricted-session.ts sets dispatched only after initialize/config/
    // account/thread/MCP admission, immediately before turn/start; it is not a success claim.
    const settledKind = this.requestPending ? "interaction" : kind;
    this.requests.push({
      ordinal: this.requests.length + 1,
      kind: settledKind,
      ...receipt,
      profileVerified: this.provider.executionProfile !== undefined && receipt.dispatched === true,
      ...(error
        ? {
            errorCode: error.code,
            ...(error.failurePhase === undefined ? {} : { failurePhase: error.failurePhase }),
          }
        : {}),
      ...(usage === undefined ? {} : { usage: { ...usage } }),
    });
    if (receipt.cleanup !== "confirmed") this.cleanupUnconfirmed = true;
    if (
      settledKind === "interaction" &&
      receipt.dispatched !== false &&
      (!receipt.usageComplete || !isCompleteTurnUsage(usage))
    )
      this.unreportedInteraction = true;
    this.requestPending = false;
    return settledKind;
  }

  /**
   * The running usage both spend guards consume: totals plus the per-request ledger, shaped
   * exactly like the trace's final tokenUsage so one estimator prices both identically. Unlike the
   * persisted trace (where absent means "unreported"), this runtime callback arg ALWAYS carries
   * numeric cache fields: pre-#334 guards received an object whose cachedInput was always a
   * number (0 included), and arithmetic on a suddenly-undefined field yields NaN, which
   * comparison operators swallow silently (red-team finding: a stale study-budget guard would run
   * uncapped without a sound).
   */
  running(): ActorTokenUsage {
    return this.withPending(
      this.accountBilled()
        ? this.account()
        : {
            input: this.input,
            output: this.output,
            cachedInput: this.cachedInput,
            cacheWriteInput: this.cacheWriteInput,
            ...(this.turns.length > 0 ? { turns: this.turns } : {}),
          },
    );
  }

  /** The trace's tokenUsage: absent when nothing was reported. */
  tokenUsage(): ActorTokenUsage | undefined {
    if (!this.sawUsage) return undefined;
    if (this.accountBilled()) return this.account();
    return {
      input: this.input,
      output: this.output,
      // Recorded only when the provider actually reported it, so a reader can tell "no cache
      // hits" from "this provider does not say" (#391); same for cache writes (#334).
      ...(this.cachedInput > 0 ? { cachedInput: this.cachedInput } : {}),
      ...(this.cacheWriteInput > 0 ? { cacheWriteInput: this.cacheWriteInput } : {}),
      ...(this.turns.length > 0 ? { turns: this.turns.map((turn) => ({ ...turn })) } : {}),
      total: this.input + this.output,
    };
  }

  /** Latest known usage of the pending continuing request, when it is complete. */
  knownPending(): CompleteTurnUsage | undefined {
    const usage = this.requestPending ? this.provider.pendingRequestUsage : undefined;
    if (!isCompleteTurnUsage(usage)) return undefined;
    const turns = usage.turns === undefined ? undefined : normalizedUsageTurns(usage);
    return {
      input: usage.input,
      output: usage.output,
      ...(usage.cachedInput === undefined ? {} : { cachedInput: usage.cachedInput }),
      ...(usage.cacheWriteInput === undefined ? {} : { cacheWriteInput: usage.cacheWriteInput }),
      ...(turns === undefined ? {} : { turns }),
    };
  }

  hasUnreported(): boolean {
    return this.unreportedInteraction || this.provider.interactionUsageIncomplete === true;
  }

  /** A cap cannot be enforced when some request's usage is unknown. */
  unavailableForCap(): boolean {
    return (
      this.incompleteInteraction ||
      this.unreportedInteraction ||
      (this.requestPending
        ? this.knownPending() === undefined
        : this.provider.interactionUsageIncomplete === true)
    );
  }

  /** Whether the trace must say that some interaction usage may be missing. */
  interactionUsageIncomplete(requiresUsage: boolean): boolean {
    return (
      this.requestPending || this.hasUnreported() || (requiresUsage && this.incompleteInteraction)
    );
  }

  liveMetadata(): CuaLiveMetadata {
    const { provider } = this;
    return {
      ...(provider.executionProfile === undefined
        ? {}
        : { executionProfile: provider.executionProfile }),
      ...(provider.requestPolicy === "fail_closed"
        ? {
            providerRequests: this.requests.map((row) => ({ ...row })),
            historyTurnsOmitted: provider.historyTurnsOmitted ?? 0,
          }
        : {}),
    };
  }

  private accountBilled(): boolean {
    return this.provider.executionProfile?.billing === "account-unknown";
  }

  private account(): ActorTokenUsage {
    const turns = this.turns;
    return {
      ...(turns.some((t) => t.input !== undefined) ? { input: this.input } : {}),
      ...(turns.some((t) => t.output !== undefined) ? { output: this.output } : {}),
      ...(turns.some((t) => t.cachedInput !== undefined) ? { cachedInput: this.cachedInput } : {}),
      ...(turns.some((t) => t.cacheWriteInput !== undefined)
        ? { cacheWriteInput: this.cacheWriteInput }
        : {}),
      ...(turns.length > 0 ? { turns: turns.map((t) => ({ ...t })) } : {}),
      ...(this.requests.length > 0 &&
      this.requests.every((r) => r.usageComplete && isCompleteTurnUsage(r.usage))
        ? { total: this.input + this.output }
        : {}),
    };
  }

  private withPending(settled: ActorTokenUsage): ActorTokenUsage {
    const pending = this.knownPending();
    if (pending === undefined) return settled;
    const input = (settled.input ?? 0) + pending.input;
    const output = (settled.output ?? 0) + pending.output;
    return {
      ...settled,
      input,
      output,
      ...(settled.cachedInput !== undefined || pending.cachedInput !== undefined
        ? { cachedInput: (settled.cachedInput ?? 0) + (pending.cachedInput ?? 0) }
        : {}),
      ...(settled.cacheWriteInput !== undefined || pending.cacheWriteInput !== undefined
        ? { cacheWriteInput: (settled.cacheWriteInput ?? 0) + (pending.cacheWriteInput ?? 0) }
        : {}),
      turns: [
        ...(settled.turns ?? []),
        ...(pending.turns ?? [
          {
            input: pending.input,
            output: pending.output,
            ...(pending.cachedInput === undefined ? {} : { cachedInput: pending.cachedInput }),
            ...(pending.cacheWriteInput === undefined
              ? {}
              : { cacheWriteInput: pending.cacheWriteInput }),
          },
        ]),
      ],
      ...(settled.total === undefined ? {} : { total: input + output }),
    };
  }
}
