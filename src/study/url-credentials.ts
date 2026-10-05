// Every URL a study config declares, checked for a credential. Route planners call it, since a
// library caller's config skips the parser that refuses these first.

import { rosterOf } from "./parse/actors.js";
import { entryCredentialReason, urlCredentialReason } from "./parse/url-credentials.js";
import type { StudyConfig } from "./types.js";
import { actorsOf } from "./study-fields.js";

/**
 * The first URL in `config` that carries a credential, with why: the subject's app, serve and
 * public surface URLs, and each participant's target and entry.
 */
export function studyUrlCredentialReason(config: StudyConfig): string | undefined {
  const { subject } = config;
  const reasons = [
    () =>
      subject.appUrl === undefined
        ? undefined
        : urlCredentialReason("subject.appUrl", subject.appUrl),
    () =>
      subject.serve === undefined
        ? undefined
        : urlCredentialReason("subject.serve.url", subject.serve.url),
    ...(subject.product?.publicSurfaces ?? []).map(
      (surface) => () => urlCredentialReason("subject.product.publicSurfaces", surface),
    ),
    ...actorsOf(config).flatMap((actor) =>
      (rosterOf(actor) ?? []).flatMap((participant, index) => [
        () =>
          participant.target === undefined
            ? undefined
            : urlCredentialReason(`participants[${index}].target`, participant.target),
        () =>
          participant.entry === undefined
            ? undefined
            : entryCredentialReason(`participants[${index}].entry`, participant.entry),
      ]),
    ),
  ];
  for (const reason of reasons) {
    const found = reason();
    if (found !== undefined) return found;
  }
  return undefined;
}
