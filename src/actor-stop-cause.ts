import type { ActorStopCause, ActorTrace } from "./actor-contract.js";

export interface ActorEnding {
  cause: ActorStopCause | "unspecified_limit";
  label: string;
}

const labels: Record<ActorEnding["cause"], string> = {
  provider_output_limit: "provider output limit",
  provider_token_limit: "provider token limit",
  time_limit: "time limit",
  spend_limit: "estimated spend limit",
  study_spend_limit: "study spend limit",
  provider_incomplete: "provider response incomplete",
  provider_status: "unexpected provider status",
  harness_aborted: "stopped by harness",
  unspecified_limit: "limit reached"
};

/** Project recorded control evidence, never participant prose. Leave the actor untouched. */
export function actorEnding(actor: ActorTrace | undefined): ActorEnding | undefined {
  if (!actor) return undefined;
  const explicit = actor.stopCause;
  if (typeof explicit === "string" && Object.hasOwn(labels, explicit)) return { cause: explicit, label: labels[explicit] };
  // These exact machine-generated notices predate stopCause. Their text is not parsed and a
  // provider token notice cannot retrospectively establish output versus context exhaustion.
  const notice = (title: string) => actor.items.some((item) => item.kind === "notice" && item.title === title);
  let cause: ActorEnding["cause"] | undefined;
  if (actor.completionReason === "budget_reached") {
    cause = notice("provider token limit reached") ? "provider_token_limit" : "unspecified_limit";
  } else if (actor.completionReason === "timed_out") cause = "time_limit";
  else if (actor.completionReason === "harness_error") {
    if (notice("provider response incomplete")) cause = "provider_incomplete";
    else if (notice("unexpected provider response status")) cause = "provider_status";
  }
  return cause === undefined ? undefined : { cause, label: labels[cause] };
}
