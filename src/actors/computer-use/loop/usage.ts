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

interface Reservation {
  input: number;
  readonly output: number;
  provisional: boolean;
}
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

/**
 * Whether an account-billed provider was given a limit it cannot honor. Dollar caps and spend
 * estimators price API tokens, which account usage is not billed by, and the account path sends
 * no output-token limit (src/actors/codex/restricted-policy.ts refuses one). Checked before the
 * run and again after each turn, since a provider may learn its billing class during startup.
 */
export function accountBillingConflicts(
  provider: CuaProvider,
  limits: {
    readonly maxUsd?: number | undefined;
    readonly overRunBudget?: unknown;
    readonly estimateTurnCostUsd?: unknown;
  },
): boolean {
  return (
    provider.executionProfile?.billing === "account-unknown" &&
    (limits.maxUsd !== undefined ||
      limits.overRunBudget !== undefined ||
      limits.estimateTurnCostUsd !== undefined ||
      provider.modelSettings?.maxOutputTokens !== undefined)
  );
}

export class UsageLedger {
  /** Settled single-dispatch requests, in order: the trace's providerRequests. */
  readonly requests: ActorProviderRequest[] = [];
  /** A continuing request returned actions and has not settled yet. */
  private requestPending = false;
  /** A request did not confirm cleanup; no further request or action is admitted. */
  cleanupUnconfirmed = false;
  /** Some usage was reported; the trace records tokenUsage only then. */
  sawUsage = false;
  private input = 0;
  private cachedInput = 0;
  private cacheWriteInput = 0;
  private output = 0;
  // Per model-inference usage, in order: the recorded fact long-context pricing tiers
  // need. A continuing native tool interaction may contain several inference requests.
  private readonly turns: UsageTurns = [];
  /** An interaction turn arrived without complete usage, or its receipt said usage is incomplete. */
  private sawIncompleteUsage = false;
  /** A request may have been billed without any usage reaching the ledger. */
  private mayHaveUnreportedUsage = false;
  /**
   * Worst-case charges booked for requests lost without a reply (a stall or a transport failure)
   * under a declared cap. The cap guards count them; the trace's tokenUsage does not.
   */
  private readonly reservations: Reservation[] = [];

  constructor(private readonly provider: CuaProvider) {}

  record(turn: CuaTurn, kind: "interaction" | "debrief"): void {
    if (turn.providerRequestPending === true) return;
    const interaction = kind === "interaction";
    const raw = turn.usage;
    const turns = raw?.turns === undefined ? undefined : normalizedUsageTurns(raw);
    if (interaction && (!isCompleteTurnUsage(raw) || turn.providerRequest?.usageComplete === false))
      this.sawIncompleteUsage = true;
    if (interaction && raw?.turns !== undefined && turns === undefined)
      this.mayHaveUnreportedUsage = true;
    // The reply answers the same request the lost attempts carried, so its reported input is theirs.
    if (interaction && isCompleteTurnUsage(raw)) {
      for (const reservation of this.reservations) {
        if (reservation.provisional) {
          reservation.input = raw.input;
          reservation.provisional = false;
        }
      }
    }
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

  /** A continuing request returned actions; its receipt and usage settle later. */
  markPending(): void {
    this.requestPending = true;
  }

  /** A request may have been billed without reporting usage. */
  markUnreported(): void {
    this.mayHaveUnreportedUsage = true;
  }

  /** The input the latest reported request carried; 0 before any was reported. */
  lastReportedInput(): number {
    return this.turns.at(-1)?.input ?? 0;
  }

  /**
   * Book a lost request at a worst case: `input` tokens at the model's highest input rate and
   * `output` tokens at its output rate. The input is provisional until the reply to the resent
   * request reports its own.
   */
  reserve(input: number, output: number): void {
    this.reservations.push({ input, output, provisional: true });
  }

  /** How many lost requests were booked at a worst case. */
  get reservedRequests(): number {
    return this.reservations.length;
  }

  /**
   * Book one settled single-dispatch request. A request that settles while a continuing request
   * is open belongs to that interaction, whatever kind the caller asked for.
   */
  settle(
    kind: "interaction" | "debrief",
    receipt: ProviderRequestReceipt,
    usage: ActorTokenUsage | undefined,
    error: CuaProviderError | undefined,
  ): "interaction" | "debrief" {
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
      this.mayHaveUnreportedUsage = true;
    this.requestPending = false;
    return settledKind;
  }

  /**
   * The running usage both spend guards price: totals plus the per-inference ledger, shaped like
   * the trace's final tokenUsage so one estimator prices both. Unlike the persisted trace, where an
   * absent field means unreported, this always carries numeric cache fields: a guard doing
   * arithmetic on an undefined field gets NaN, and NaN never trips a cap.
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

  /**
   * What the cap guards price: the running usage plus each booked worst case as one more request.
   * Booked input is recorded as cache writes, which the rate sheet prices at the highest input
   * rate it has for the model (src/run/pricing.ts: a write rate, where one exists, is 1.25x
   * the input rate).
   */
  forCap(): ActorTokenUsage {
    const settled = this.running();
    if (this.reservations.length === 0 || this.accountBilled()) return settled;
    const booked = this.reservations.map(({ input, output }) => ({
      input,
      output,
      cachedInput: 0,
      cacheWriteInput: input,
    }));
    const sum = (field: "input" | "output" | "cacheWriteInput"): number =>
      booked.reduce((total, turn) => total + turn[field], 0);
    const input = (settled.input ?? 0) + sum("input");
    const output = (settled.output ?? 0) + sum("output");
    // Per-request turns keep long-context pricing exact; add them only where the settled usage
    // has a per-request record or none at all, so the turns still add up to the totals.
    const perRequest =
      settled.turns !== undefined || (settled.input ?? 0) + (settled.output ?? 0) === 0;
    return {
      ...settled,
      input,
      output,
      cachedInput: settled.cachedInput ?? 0,
      cacheWriteInput: (settled.cacheWriteInput ?? 0) + sum("cacheWriteInput"),
      ...(perRequest ? { turns: [...(settled.turns ?? []), ...booked] } : {}),
      ...(settled.total === undefined ? {} : { total: input + output }),
    };
  }

  /** The trace's tokenUsage: absent when nothing was reported. */
  tokenUsage(): ActorTokenUsage | undefined {
    if (!this.sawUsage) return undefined;
    if (this.accountBilled()) return this.account();
    return {
      input: this.input,
      output: this.output,
      // Recorded only when the provider actually reported it, so a reader can tell "no cache
      // hits" from "this provider does not say"; same for cache writes.
      ...(this.cachedInput > 0 ? { cachedInput: this.cachedInput } : {}),
      ...(this.cacheWriteInput > 0 ? { cacheWriteInput: this.cacheWriteInput } : {}),
      ...(this.turns.length > 0 ? { turns: this.turns.map((turn) => ({ ...turn })) } : {}),
      total: this.input + this.output,
    };
  }

  /** Latest known usage of the continuing request, when it is complete. */
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

  private hasUnreportedUsage(): boolean {
    return this.mayHaveUnreportedUsage || this.provider.interactionUsageIncomplete === true;
  }

  /** A cap cannot be enforced when some request's usage is unknown. */
  unavailableForCap(): boolean {
    return (
      this.sawIncompleteUsage ||
      this.mayHaveUnreportedUsage ||
      (this.requestPending
        ? this.knownPending() === undefined
        : this.provider.interactionUsageIncomplete === true)
    );
  }

  /**
   * Whether the trace must say that some interaction usage may be missing. A booked worst case
   * bounds a lost request's cost, but its usage is still unknown.
   */
  interactionUsageIncomplete(capDeclared: boolean): boolean {
    return (
      this.requestPending ||
      this.hasUnreportedUsage() ||
      this.reservations.length > 0 ||
      (capDeclared && this.sawIncompleteUsage)
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
