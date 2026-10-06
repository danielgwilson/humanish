// The schema every route's result carries when a study runs: preview, computer use, scripted,
// terminal and shared world. `route` says which, and route-specific fields stay on their route's
// result type.

/** The schema of a study's result on every route. */
export const STUDY_RESULT_SCHEMA = "humanish.study-result.v1";

/** The fields every route's result carries to name its route and its study. */
export interface StudyResultIdentity<R extends string> {
  schema: typeof STUDY_RESULT_SCHEMA;
  route: R;
  /** The study's `id`. */
  studyId: string;
}

/** The identity fields for a result of route `route` from the study `studyId`. */
export function studyResultIdentity<R extends string>(
  route: R,
  studyId: string,
): StudyResultIdentity<R> {
  return { schema: STUDY_RESULT_SCHEMA, route, studyId };
}

/** What every refused study's result carries besides its identity and its route's own fields. */
export interface RefusalBase<C extends string> {
  /** The study's `id`. */
  studyId: string;
  cwd: string;
  /** The caller's warnings array, kept by reference so warnings added later still show. Empty when omitted. */
  warnings?: string[];
  error: { code: C; message: string };
}

/**
 * A refused study's result on route `route`: its identity, `ok: false` and `cwd`, then `fields`
 * in the caller's order, then `warnings` and `error`. A result is written as JSON, so the key order
 * is part of the output; a site whose order differs spreads its remaining fields after this. The
 * caller keeps runId, actor, dryRun and the route's fields, whose values and order differ by site.
 */
export function refusedResult<R extends string, C extends string, F extends object>(
  route: R,
  base: RefusalBase<C>,
  fields: F,
): StudyResultIdentity<R> & { ok: false; cwd: string } & F & {
    warnings: string[];
    error: { code: C; message: string };
  } {
  return {
    ...studyResultIdentity(route, base.studyId),
    ok: false,
    cwd: base.cwd,
    ...fields,
    warnings: base.warnings ?? [],
    error: base.error,
  };
}
