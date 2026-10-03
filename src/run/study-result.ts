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
  /**
   * The study's `id`, the same value as `studyId`.
   * @deprecated Read `studyId`. The next minor removes it.
   */
  labId: string;
}

/** The identity fields for a result of route `route` from the study `studyId`. */
export function studyResultIdentity<R extends string>(
  route: R,
  studyId: string,
): StudyResultIdentity<R> {
  return { schema: STUDY_RESULT_SCHEMA, route, studyId, labId: studyId };
}
