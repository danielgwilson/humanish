// Subject checks for verify: the subject block's state claim against its recorded evidence, and the
// advisory for a provisioned env with no declared state story.

import type { RunBundle } from "../run/bundle.js";
import { COMMAND_DIGEST_PATTERN, SUBJECT_ENV_NAME_PATTERN } from "../run/shared-world-shape.js";
import { ARCHIVE_SHA256_PATTERN } from "../run/bundle-shape.js";

/**
 * The `subject state provenance` check (invariant 5 + invariant 4): a bundle's subject claim
 * must match its recorded evidence. A bundle without a subject block passes untouched.
 * Live-vs-dry-run is judged from bundle.mode, exactly like
 * noEngagementActorFindings. Covers both the state story (seed/external) and, for the
 * local-tree route, the archive content pin.
 */
export function subjectStateFindings(bundle: RunBundle): string[] {
  const subject = bundle.subject;
  if (subject === undefined) {
    return [];
  }

  const findings: string[] = [];
  const state = subject.state;
  const seed = state.seed ?? [];
  const live = bundle.mode === "live";

  // Local-tree fail-closed pin: a live local-tree subject must carry a well-formed archive
  // digest -- a dirty tree cannot be commit-pinned, so archiveSha256 is the only content pin
  // this route has. Mirrors the seeded-on-dry-run discriminator immediately below: judged by
  // bundle.mode, never by the presence/shape of other fields. Never echoes the malformed value
  // (it could itself be a leaked value, same discipline as the externalEnvNames check below).
  if (live && subject.source === "local-tree") {
    // Note: a malformed-but-present string is already rejected upstream by the
    // isRunSubjectProvenance shape gate, so in practice this branch fires for the
    // missing case; the pattern re-check stays as defense in depth for callers
    // that bypass the schema gate.
    const pin = (subject as { archiveSha256?: unknown }).archiveSha256;
    if (typeof pin !== "string" || !ARCHIVE_SHA256_PATTERN.test(pin)) {
      findings.push(
        "subject.source is local-tree on a live run but archiveSha256 is missing or malformed (a local-tree subject must carry a well-formed 64-hex archive digest)",
      );
    }
  }

  // Marker-independent rule: a passed live run can never ride on a seed step that did not
  // complete ok (closes the hollow-seeded × unpinned hole — an unpinned bundle still carries
  // its seed records, and a failed migration must not hide behind the external marker).
  if (live && bundle.review.verdict === "pass" && seed.some((record) => record.ok !== true)) {
    findings.push(
      "review verdict is pass but a recorded seed step did not complete ok — a passed live run cannot carry failed or unexecuted state steps",
    );
  }

  switch (state.provenance) {
    case "seeded": {
      if (!live) {
        findings.push(
          'state marker "seeded" on a dry-run bundle — a contract bundle cannot claim executed state',
        );
      }
      if (seed.length === 0) {
        findings.push('state marker "seeded" with zero seed step records is a hollow state claim');
      }
      for (const record of seed) {
        if (!COMMAND_DIGEST_PATTERN.test(record.commandDigest)) {
          findings.push(`seed step "${record.name}" lacks a sha256-16 commandDigest`);
        }
        if (live && record.ok !== true) {
          findings.push(`state marker "seeded" but step "${record.name}" did not complete ok`);
        }
      }
      break;
    }
    case "unpinned": {
      const externalEnvNames = state.externalEnvNames ?? [];
      if (externalEnvNames.length === 0) {
        findings.push(
          'state marker "unpinned" requires non-empty externalEnvNames (the declaration must name the external channel)',
        );
      }
      for (const name of externalEnvNames) {
        if (!SUBJECT_ENV_NAME_PATTERN.test(name)) {
          // Deliberately does not echo the entry: a malformed entry may be a value.
          findings.push(
            "externalEnvNames carries an entry that is not an env var NAME shape (values must never appear in evidence)",
          );
        }
      }
      break;
    }
    case "declared-not-run": {
      if (live && bundle.review.verdict === "pass") {
        findings.push(
          'a passed live run cannot claim its declared seed steps did not run (state marker "declared-not-run")',
        );
      }
      break;
    }
    case "undeclared":
      break;
    case "external-public": {
      // An operator-declared, operator-owned public deployment that humanish neither provisioned
      // nor seeded. It has no in-sandbox state story, so a seed record or an external channel here
      // contradicts the "no subject sandbox" invariant of this plane class.
      if (subject.source !== "app-url") {
        findings.push(
          'state marker "external-public" requires subject.source "app-url" — the external-public plane is a real public deployment, not a clone/local-tree subject',
        );
      }
      if (seed.length > 0) {
        findings.push(
          'state marker "external-public" cannot carry seed step records — the external-public plane is neither provisioned nor seeded by the harness',
        );
      }
      if ((state.externalEnvNames ?? []).length > 0) {
        findings.push(
          'state marker "external-public" cannot carry externalEnvNames — the plane is operator-owned, not an uncontrolled external channel',
        );
      }
      break;
    }
    default:
      findings.push("unknown subject state provenance marker");
  }

  return findings;
}

/**
 * Advisory (never flips ok): a live clone bundle whose subject env is provisioned while its
 * state story is undeclared probably points at state the lab does not control. Emitted at
 * most once per bundle (the subject block is bundle-level, never per stream). GITHUB_TOKEN
 * is mechanically excluded: the harness consumes that name for clone auth — it carries no
 * state implication.
 */
export function undeclaredSubjectStateWarnings(bundle: RunBundle): string[] {
  const subject = bundle.subject;
  if (subject === undefined || bundle.mode !== "live" || subject.source !== "clone") {
    return [];
  }
  if (subject.state.provenance !== "undeclared") {
    return [];
  }
  const stateRelevantEnvNames = (subject.envNames ?? []).filter((name) => name !== "GITHUB_TOKEN");
  if (stateRelevantEnvNames.length === 0) {
    return [];
  }
  return [
    `Subject env is provisioned (${stateRelevantEnvNames.join(", ")}) but no state story is declared; if any name points at external state, declare subject.state.external (recorded UNPINNED) or seed in-sandbox state with subject.state.seed.`,
  ];
}
