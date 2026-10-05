// Finds humanish's own section in a project's `AGENTS.md` so init can replace it on a rerun and
// leave every other byte alone. Releases up to 0.110.1 wrote the section with a start marker and
// no end marker, so for those the section's extent is known only by matching a text init wrote.

import { createHash } from "node:crypto";
import { AGENTS_SECTION_END_MARKER, AGENTS_SECTION_MARKER } from "../cli/first-run-path.js";

/**
 * Each section text a release wrote before the end marker existed, from its `## humanish` heading
 * to its final newline: the UTF-16 length and the sha256 of its UTF-8 bytes. Comparing digests
 * keeps the retired command and key names those versions taught out of the source.
 */
const SECTIONS_WITHOUT_END_MARKER: ReadonlyArray<{
  releases: string;
  length: number;
  sha256: string;
}> = [
  {
    releases: "0.59.0 to 0.80.0",
    length: 1171,
    sha256: "3739c98204cc5b2df603238398bffc5c4a491782a3ab72475b0ad9d967698a11",
  },
  {
    releases: "0.81.0 to 0.93.1",
    length: 1191,
    sha256: "169d646f329f35af1b5e51eb02cd0454a717cf29a447a230f3aa2d5a7354729c",
  },
  {
    releases: "0.94.0 to 0.99.1",
    length: 1214,
    sha256: "68f987769893f041ab78e0b1cb4cd8db14a438511f15b58f9eaa412ea002b51f",
  },
  {
    releases: "0.100.0 to 0.105.0",
    length: 1548,
    sha256: "f60c37003d21b1d8280d002f203130c60bc3c23454b018b3207407faa01cb76f",
  },
  {
    releases: "0.106.0 to 0.107.0",
    length: 1686,
    sha256: "c2cd9d831e17021ad4477f300dbea13df1613bec8f30ebbabfabcd749b73f7f7",
  },
  {
    releases: "0.108.0",
    length: 1679,
    sha256: "6352ec71d7c5073b2bf4993293753944eaf7cfd21169a311f42d9f52bdacfead",
  },
  {
    releases: "0.109.0 to 0.110.0",
    length: 1681,
    sha256: "2559a93463cf50225aadf6753e84dd6e32b25aa3afdf8066e90d19c5d88d0ef0",
  },
  {
    releases: "0.110.1",
    length: 2014,
    sha256: "9fb4cb94400c7447ab0fece861339e50de8e9be99797cf0763d7502be0fe668d",
  },
];

export type AgentsSectionReplacement =
  /** The file has no humanish section. */
  | { kind: "absent" }
  /** A start marker with no end marker, in text no release wrote: possibly hand-edited. */
  | { kind: "unknown" }
  /** The file with humanish's section replaced; equal to the input when it was already current. */
  | { kind: "replaced"; contents: string };

/**
 * `existing` with humanish's section replaced by `section` (as `agentsSection()` returns it, with
 * its leading blank line). The replaced range runs from the start of the heading line that holds
 * the start marker to the end of the end marker's line, or, without an end marker, through the
 * text of the release that wrote it.
 */
export function replaceAgentsSection(existing: string, section: string): AgentsSectionReplacement {
  const marker = existing.indexOf(AGENTS_SECTION_MARKER);
  if (marker < 0) return { kind: "absent" };
  const start = existing.lastIndexOf("\n", marker) + 1;
  const replacement = section.replace(/^\n/, "");

  const endMarker = existing.indexOf(AGENTS_SECTION_END_MARKER, marker);
  if (endMarker >= 0) {
    const lineEnd = existing.indexOf("\n", endMarker);
    const end = lineEnd < 0 ? existing.length : lineEnd + 1;
    return {
      kind: "replaced",
      contents: existing.slice(0, start) + replacement + existing.slice(end),
    };
  }

  for (const known of SECTIONS_WITHOUT_END_MARKER) {
    const candidate = existing.slice(start, start + known.length);
    if (candidate.length !== known.length) continue;
    if (createHash("sha256").update(candidate).digest("hex") !== known.sha256) continue;
    return {
      kind: "replaced",
      contents: existing.slice(0, start) + replacement + existing.slice(start + known.length),
    };
  }
  return { kind: "unknown" };
}
