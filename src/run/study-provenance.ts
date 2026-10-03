// Which study a saved run came from. run.json and status.json write it as `study`; runs saved by
// 0.108 and earlier also carry `lab` with the same value. Every reader goes through
// studyProvenanceOf, which also reads a run older than both fields by the `study:<id>` or
// `lab:<id>` convention on its persona and scenario sources.

/** Which study a run came from, when it came from one. */
export interface RunStudyProvenance {
  /** The study id its file declares (`config.id`). */
  id: string;
  /** Project-relative path of the study file, when the run came from a file on disk. */
  path?: string;
  /**
   * `committed` = humanish/studies or humanish/labs, `ignored` = a local overlay, `explicit` = a
   * path the operator passed.
   */
  origin?: "committed" | "ignored" | "explicit";
}

const ORIGINS: readonly string[] = ["committed", "ignored", "explicit"];

/** `value` as a provenance when it has an id, keeping only its fields that are valid. */
function provenance(value: unknown): RunStudyProvenance | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return undefined;
  const origin = record.origin;
  return {
    id: record.id,
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof origin === "string" && ORIGINS.includes(origin)
      ? { origin: origin as NonNullable<RunStudyProvenance["origin"]> }
      : {}),
  };
}

/** Whether a saved record's `study` or `lab` field is absent or shaped like a provenance. */
export function isProvenanceField(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  return typeof (value as Record<string, unknown>).id === "string";
}

/**
 * A saved record's study: a valid `study`, else a valid `lab`, else the id its persona or scenario
 * source names by convention.
 */
export function studyProvenanceOf(record: {
  study?: unknown;
  lab?: unknown;
  persona?: { source?: unknown };
  scenario?: { source?: unknown };
}): RunStudyProvenance | undefined {
  const declared = provenance(record.study) ?? provenance(record.lab);
  if (declared !== undefined) return declared;
  const id = inferLegacyStudyId(record);
  return id === undefined ? undefined : { id };
}

/**
 * `study`, as run.json and status.json write it. 0.108 wrote `lab` beside it with the same value;
 * 0.109 stopped, and studyProvenanceOf still reads `lab` from those runs.
 */
export function studyFields(study: RunStudyProvenance | undefined): { study?: RunStudyProvenance } {
  return study === undefined ? {} : { study };
}

/**
 * The study id a run names by the `study:<id>` or `lab:<id>` convention on its persona or scenario
 * source, the only attribution a run written before `lab` and `study` has. A prefix with an empty
 * remainder is not an id. Ids may contain colons (`lab:oss:meta`), so only the prefix is stripped.
 * Readers keep both prefixes for good: saved runs say `lab:`.
 */
export function inferLegacyStudyId(bundle: {
  persona?: { source?: unknown };
  scenario?: { source?: unknown };
}): string | undefined {
  for (const source of [bundle.persona?.source, bundle.scenario?.source]) {
    if (typeof source !== "string") continue;
    const prefix = ["study:", "lab:"].find((candidate) => source.startsWith(candidate));
    if (prefix === undefined) continue;
    const id = source.slice(prefix.length).trim();
    if (id !== "") return id;
  }
  return undefined;
}
