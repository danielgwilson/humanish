// The study file reference (site/content/docs/study-files.mdx) names each field the parser accepts
// as an inline code span: `route`, `caps.maxUsd`, `participants[].persona`. A field the parser
// gains without a row on that page is a field users cannot look up, so docs:check compares the two.

/** The page check-doc-study-fields.ts holds to the parser's fields. */
export const STUDY_FIELD_PAGE = "site/content/docs/study-files.mdx";

const FENCE = /^(\s*)(```|~~~)[^\n]*\n[\s\S]*?^\s*\2[^\n]*$/gm;
const CODE_SPAN = /`([^`\n]+)`/g;

/**
 * The inline code spans of a Markdown page outside fenced blocks, with list indexes removed so
 * `participants[].persona` and `participants[0].persona` both read `participants.persona`.
 */
export function documentedPaths(page: string): Set<string> {
  const prose = page.replace(FENCE, "");
  return new Set(
    [...prose.matchAll(CODE_SPAN)].map((match) => match[1]!.trim().replaceAll(/\[\d*\]/g, "")),
  );
}

/** The paths in `required` that no code span on `page` names exactly, in their given order. */
export function missingFields(page: string, required: readonly string[]): string[] {
  const documented = documentedPaths(page);
  return required.filter((path) => !documented.has(path));
}
