// Subject provenance for the bundle, the checks on the served port and the getHost URL, and the
// digest-only host and route labels.

import type { RunSubjectProvenance } from "../../run/bundle.js";
import type { LocalTreeArchive } from "../../subject/local-tree-archive.js";
import { commandDigestOf } from "../../subject/state.js";

/** Extract the in-sandbox port from the (loopback) serve.url so getHost can expose it. */
export function servePort(serveUrl: string): number {
  const url = new URL(serveUrl);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** A getHost URL must be tokenless (no userinfo and no query, so no authKey reaches evidence). */
export function isTokenlessHost(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "";
  } catch {
    return false;
  }
}

/** sha256-16 of a URL's origin: the publish-safe host identity persisted in the bundle (the raw
 *  getHost URL embeds the live sandbox id + matches the e2b-URL redaction, so it never lands raw). */
export function hostOriginDigest(url: string): string {
  try {
    return commandDigestOf(new URL(url).origin);
  } catch {
    return commandDigestOf(url);
  }
}

/** A public-safe, human-readable route label for the bundle (host redacted to a placeholder; the
 *  entry path kept). Never contains the raw getHost URL. */
export function publicSafeRouteLabel(entry: string | undefined): string {
  return `[provisioned-subject]${entry ?? "/"}`;
}

/**
 * Build the one subject sandbox's provenance: clone (repo + optional commit) or
 * local-tree (archiveSha256 + optional commit/dirty from the once-per-run host-packed archive -
 * archiveSha256 is the pin; there is only one archive, so no per-participant unanimity math applies,
 * unlike the cua fan-out route). Used for both the in-progress and final bundle: the archive
 * never changes mid-run (packed before any sandbox exists).
 */
export function buildSubjectProvenance(args: {
  localTreeRoute: boolean;
  publicRepo: string;
  subjectCommit: string | undefined;
  localTreeArchive: LocalTreeArchive | undefined;
  subjectEnvNames: string[];
  state: RunSubjectProvenance["state"];
}): RunSubjectProvenance {
  if (args.localTreeRoute) {
    return {
      source: "local-tree",
      ...(args.localTreeArchive === undefined
        ? {}
        : { archiveSha256: args.localTreeArchive.archiveSha256 }),
      ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
      ...(args.localTreeArchive?.git === undefined
        ? {}
        : { dirty: args.localTreeArchive.git.dirty }),
      envNames: args.subjectEnvNames,
      state: args.state,
    };
  }
  return {
    source: "clone",
    repo: args.publicRepo,
    ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
    envNames: args.subjectEnvNames,
    state: args.state,
  };
}
