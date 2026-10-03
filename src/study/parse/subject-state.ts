// The state and env channels of a served subject (clone or local-tree): `subject.envValues`,
// the structural parse of `subject.state`, and subjectStateInvalidReason, the semantic check
// parseStudy and the computer-use route share.

import { containsSensitive } from "../../evidence/redaction.js";
import { ENV_NAME_PATTERN, invalid, posInt, str, strList } from "./values.js";
import type { StudyParseFailure, StudyStateStepWhen, StudySubjectState } from "../types.js";
import { isRecord } from "../../run/type-guards.js";

/**
 * Literal non-secret subject env. Real apps need configuration before they will boot: a public base
 * URL, a transport selector, a feature flag, and none of that is secret. Routing it through
 * `subject.env` would force an adopter to carry a private env file just to reproduce a public study.
 *
 * These values are recorded in evidence (they are part of how the subject was configured), so a
 * value that looks like a credential is refused here rather than committed to a public repo.
 */
export function parseEnvValues(
  raw: unknown,
): { ok: true; value?: Record<string, string> } | StudyParseFailure {
  if (raw === undefined) return { ok: true };
  if (!isRecord(raw)) {
    return invalid(
      "`subject.envValues` must map environment variable names to literal values that are not secret.",
    );
  }
  const envValues: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(raw)) {
    if (!ENV_NAME_PATTERN.test(name)) {
      return invalid(
        `subject.envValues keys must be environment variable names like NEXT_PUBLIC_APP_URL, and "${name}" is not one.`,
      );
    }
    const value =
      typeof rawValue === "number" || typeof rawValue === "boolean"
        ? String(rawValue)
        : str(rawValue);
    if (value === undefined) {
      return invalid(`\`subject.envValues.${name}\` must be a string, number, or boolean.`);
    }
    // Reuse the redaction module's own detector rather than inventing a second opinion about what
    // a secret looks like; the two must never disagree about the same string.
    if (containsSensitive(value)) {
      return invalid(
        `\`subject.envValues.${name}\` looks like a secret or a local path, and envValues are committed with the study and recorded in evidence. List the name in \`subject.env\` instead: its value then comes from your environment and is never stored.`,
      );
    }
    envValues[name] = value;
  }
  return { ok: true, value: envValues };
}

/**
 * Structural parse of `subject.state` into a candidate StudySubjectState. Deliberately keeps
 * unrecognized `when`/`timeoutMs` values in the candidate (instead of silently dropping
 * them) so subjectStateInvalidReason rejects them: a state declaration that silently does
 * less than it says would claim more than its mechanism does.
 */
export function parseState(
  raw: unknown,
): { ok: true; value: StudySubjectState | undefined } | StudyParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`subject.state` must be an object ({ seed?, external? }).");
  }
  const state: StudySubjectState = {};
  if (raw.seed !== undefined) {
    if (!Array.isArray(raw.seed) || !raw.seed.every(isRecord)) {
      return invalid(
        "`subject.state.seed` must be an array of step objects ({ name, command, when?, timeoutMs? }).",
      );
    }
    state.seed = raw.seed.map((entry) => ({
      name: typeof entry.name === "string" ? entry.name.trim() : "",
      command: typeof entry.command === "string" ? entry.command.trim() : "",
      ...(entry.when === undefined ? {} : { when: entry.when as StudyStateStepWhen }),
      ...(entry.timeoutMs === undefined
        ? {}
        : { timeoutMs: (posInt(entry.timeoutMs) ?? entry.timeoutMs) as number }),
    }));
  }
  if (raw.external !== undefined) {
    const external = strList(raw.external);
    if (!external) {
      return invalid(
        "`subject.state.external` must be a non-empty list of environment variable names when it is set.",
      );
    }
    state.external = external;
  }
  if (raw.checkpoint !== undefined) {
    if (!Array.isArray(raw.checkpoint) || !raw.checkpoint.every(isRecord)) {
      return invalid(
        "`subject.state.checkpoint` must be an array of probe objects ({ name, command, redact? }).",
      );
    }
    state.checkpoint = raw.checkpoint.map((probe) => ({
      name: typeof probe.name === "string" ? probe.name.trim() : "",
      command: typeof probe.command === "string" ? probe.command.trim() : "",
      // Preserve the redact list verbatim (literal secret values may contain commas, so do not
      // run it through the comma-splitting strList); subjectStateInvalidReason validates the shape.
      ...(probe.redact === undefined ? {} : { redact: probe.redact as string[] }),
    }));
  }
  return { ok: true, value: state };
}

// The step name interpolates into in-sandbox script/status/log paths (`subject-state-<name>`);
// so the shape is strict, exactly like the repo slug.
const STATE_STEP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const STATE_STEP_NAME_MAX_CHARS = 40;

const STATE_STEP_WHENS: readonly StudyStateStepWhen[] = [
  "before-build",
  "before-start",
  "after-ready",
];

/**
 * Semantic validation for `subject.state`, shared by parseStudy and the engine
 * (the route re-enforces it on configs that arrive through runStudyWith). Returns
 * the failure message, or null when the declaration is valid. Reads the candidate
 * defensively: library callers can hand the engine arbitrarily-shaped objects.
 */
export function subjectStateInvalidReason(
  state: StudySubjectState,
  env: readonly string[] | undefined,
): string | null {
  const seed = state.seed;
  const external = state.external;
  const checkpoint = state.checkpoint;
  if (
    (seed === undefined || seed.length === 0) &&
    (external === undefined || external.length === 0) &&
    (checkpoint === undefined || checkpoint.length === 0)
  ) {
    return "`subject.state` must declare seed steps, external env names, and/or checkpoints (an empty state block would be inert).";
  }
  if (seed !== undefined) {
    if (!Array.isArray(seed) || seed.length === 0) {
      return "`subject.state.seed` must be a non-empty array of steps when set.";
    }
    const names = new Set<string>();
    for (const [index, step] of seed.entries()) {
      const name = typeof step?.name === "string" ? step.name : "";
      if (!STATE_STEP_NAME_PATTERN.test(name) || name.length > STATE_STEP_NAME_MAX_CHARS) {
        return `subject.state.seed[${index}].name must match ${STATE_STEP_NAME_PATTERN} and be at most ${STATE_STEP_NAME_MAX_CHARS} chars (it names in-sandbox file paths); got "${name}".`;
      }
      if (names.has(name)) {
        return `subject.state.seed step names must be unique (duplicate "${name}").`;
      }
      names.add(name);
      if (typeof step.command !== "string" || step.command.trim().length === 0) {
        return `subject.state.seed[${index}].command is required (the in-sandbox shell command that seeds the state).`;
      }
      if (step.when !== undefined && !STATE_STEP_WHENS.includes(step.when)) {
        return `subject.state.seed[${index}].when must be one of: ${STATE_STEP_WHENS.join(", ")}.`;
      }
      if (
        step.timeoutMs !== undefined &&
        !(
          typeof step.timeoutMs === "number" &&
          Number.isSafeInteger(step.timeoutMs) &&
          step.timeoutMs >= 1
        )
      ) {
        return `subject.state.seed[${index}].timeoutMs must be a positive integer.`;
      }
    }
  }
  if (external !== undefined) {
    if (!Array.isArray(external) || external.length === 0) {
      return "`subject.state.external` must be a non-empty list of environment variable names when it is set.";
    }
    for (const name of external) {
      if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
        return "subject.state.external entries must be environment variable names like DATABASE_URL. Their values come from your environment and are never stored.";
      }
      if (!env?.includes(name)) {
        return "subject.state.external names must also be declared in subject.env (the declaration must name a provisioned channel).";
      }
    }
  }
  if (checkpoint !== undefined) {
    if (!Array.isArray(checkpoint) || checkpoint.length === 0) {
      return "`subject.state.checkpoint` must be a non-empty array of probes when set.";
    }
    const names = new Set<string>();
    for (const [index, probe] of checkpoint.entries()) {
      const name = typeof probe?.name === "string" ? probe.name : "";
      if (!STATE_STEP_NAME_PATTERN.test(name) || name.length > STATE_STEP_NAME_MAX_CHARS) {
        return `subject.state.checkpoint[${index}].name must match ${STATE_STEP_NAME_PATTERN} and be at most ${STATE_STEP_NAME_MAX_CHARS} chars (it names in-sandbox file paths); got "${name}".`;
      }
      if (names.has(name)) {
        return `subject.state.checkpoint names must be unique (duplicate "${name}").`;
      }
      names.add(name);
      if (typeof probe.command !== "string" || probe.command.trim().length === 0) {
        return `subject.state.checkpoint[${index}].command is required (the read-only digest probe command).`;
      }
      if (probe.redact !== undefined) {
        if (
          !Array.isArray(probe.redact) ||
          !probe.redact.every((value) => typeof value === "string" && value.length > 0)
        ) {
          return `subject.state.checkpoint[${index}].redact must be a list of non-empty literal strings when set.`;
        }
      }
    }
  }
  return null;
}
