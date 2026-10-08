// The closing report's limits, kept apart from its zod schema in closing-report.ts so the
// Observer can read them: it bundles this module, and zod stays out of its page.

/**
 * How much a participant's closing report may hold. Participants are asked for no more, and a
 * reply that holds more is rejected. Characters are counted as `String.length` counts them.
 */
export const CLOSING_REPORT_LIMITS = Object.freeze({
  summaryChars: 4000,
  frictionReports: 8,
  frictionReportChars: 2000,
  impressions: 6,
  impressionChars: 500,
});
