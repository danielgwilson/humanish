// The parts both computer-use bundle shapes share: the subject-state story and provenance line,
// provider-resource records, and the public-safe app URL label, the URL digest and the
// subject-phase event id suffix. The builders are bundle.ts (the dispatcher and the judge),
// single-bundle.ts and fanout-bundle.ts. Feedback candidates from participant reports are in
// participant-feedback.ts, which the shared-world bundle reads too.

import { scanEncodedText } from "../../evidence/encoded-text.js";
import { digestText } from "../../evidence/redaction.js";
import { type RunProviderResource, type RunSubjectProvenance } from "../../run/bundle.js";
import { participantResourceIds, type ParticipantIds } from "../../run/participant-records.js";
import { type ParticipantRunOutcome } from "./types.js";
import { plural } from "../../run/text.js";

/** The human-readable state story appended to the provenance event (and review.md via it). */
export function describeSubjectState(
  state: RunSubjectProvenance["state"],
  dryRun: boolean,
): string {
  switch (state.provenance) {
    case "seeded":
      return `seeded (${plural(state.seed?.length ?? 0, "step")}: ${(state.seed ?? []).map((record) => record.name).join(", ")})`;
    case "unpinned":
      return `unpinned (external: ${(state.externalEnvNames ?? []).join(", ")})`;
    case "declared-not-run":
      return `declared, not run (${dryRun ? "dry run" : "provisioning did not complete"})`;
    case "undeclared":
      return "undeclared";
    case "external-public":
      return "external-public (operator-declared, operator-owned public deployment; neither provisioned nor seeded)";
  }
}

/** Human-readable provenance line for the single-participant subject.provenance event of a clone
 *  or local-tree subject: claims "cloned/packed and served" only when it actually happened. */
export function subjectProvenanceMessage(
  provenance: RunSubjectProvenance,
  publicAppUrl: string,
  dryRun: boolean,
  hasSession: boolean,
): string {
  if (provenance.source === "clone") {
    if (dryRun) {
      return `Subject declared: clone of ${provenance.repo}, to be served at ${publicAppUrl} in-sandbox (dry run; nothing cloned)`;
    }
    if (provenance.commit) {
      return hasSession
        ? `Subject cloned from ${provenance.repo}@${provenance.commit} and served at ${publicAppUrl} in-sandbox`
        : `Subject cloned from ${provenance.repo}@${provenance.commit}; serving at ${publicAppUrl} did not complete (see session error)`;
    }
    return `Subject clone attempted from ${provenance.repo}; commit unresolved (provisioning failed before resolution)`;
  }
  if (dryRun) {
    return `Subject declared: local working tree, to be packed and served at ${publicAppUrl} in-sandbox (dry run; nothing packed)`;
  }
  if (provenance.archiveSha256) {
    const dirtyLabel =
      provenance.dirty === true
        ? ", dirty working tree"
        : provenance.dirty === false
          ? ", clean working tree"
          : "";
    return hasSession
      ? `Subject packed (archiveSha256 ${provenance.archiveSha256}${dirtyLabel}) and served at ${publicAppUrl} in-sandbox`
      : `Subject packed (archiveSha256 ${provenance.archiveSha256}${dirtyLabel}); serving at ${publicAppUrl} did not complete (see session error)`;
  }
  return "Subject local-tree packing attempted; archive digest unresolved (provisioning failed before resolution)";
}

export function providerResourcesForOutcome(args: {
  outcome: ParticipantRunOutcome | undefined;
  createdAt: string;
  ids: ParticipantIds;
  participantId: string;
}): RunProviderResource[] {
  if (args.outcome?.sandboxId === undefined) {
    return [];
  }

  return [
    {
      schema: "humanish.provider-resource.v1",
      provider: "e2b-desktop",
      kind: "sandbox",
      id: args.outcome.sandboxId,
      owner: "humanish",
      // Only a sandbox kept on purpose is known to be running; an unconfirmed release may or may
      // not have stopped it.
      status: args.outcome.killed
        ? "killed"
        : args.outcome.sandboxRelease?.state === "retained"
          ? "running"
          : "unknown",
      ...participantResourceIds(args.ids, args.participantId),
      createdAt: args.createdAt,
      cleanup: {
        killed: args.outcome.killed,
        reason: args.outcome.killed
          ? "killed during normal participant teardown"
          : (args.outcome.sandboxRelease?.warning ??
            "not killed during normal participant teardown; cleanup may reclaim by exact recorded id"),
      },
    },
  ];
}

/**
 * The app URL as a run records it: the URL, or its digest when verify would flag it. verify reads the
 * URL decoded, so an E2B URL percent-encoded in a parameter gets the digest too.
 */
export function publicSafeAppUrlLabel(url: string): string {
  return scanEncodedText(url).sensitive ? `[target-url:${digestUrl(url)}]` : url;
}

/** Short id-safe suffix for a subject-phase RunEvent: drops the shared prefix/suffix so each
 *  phase gets a distinct bundle event id (e.g. "clone", "state-before-build"). */
export function phaseEventIdSuffix(type: string): string {
  return type
    .replace(/^cua-lab\.subject\./, "")
    .replace(/\.(started|completed)$/, "")
    .replace(/\./g, "-");
}

export function digestUrl(url: string): string {
  return digestText(url, 16);
}
