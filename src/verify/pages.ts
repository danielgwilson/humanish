import { REDACTION_MARKERS } from "../evidence/redaction.js";
import type { RunBundle } from "../run/bundle.js";
import { isRecord } from "../run/type-guards.js";

// A recorded page (`items[].page`, `finalPage`) keeps a URL's origin and path only. The text scan
// finds secret shapes in it as in any trace text, but a query string, a fragment or user info can
// carry a short token no pattern matches, so a page holding one is a public-safety finding.

// The markers that can stand for a whole origin, such as a withheld sandbox host.
const MARKERS: ReadonlySet<string> = new Set(Object.values(REDACTION_MARKERS));
// `scheme:` alone (a non-web URL) or `scheme://host[:port]`, with nothing after the host. The URL
// parser reads a backslash there as a slash, so a backslash counts as a path too.
const ORIGIN = /^[a-z][a-z0-9+.-]*:(?:\/\/[^/\\?#@]*)?$/i;

/**
 * What is wrong with a recorded page, or undefined when it holds an origin and a path only. The
 * browser network log's record check applies it to each record's origin and path.
 */
export function pageProblem(page: unknown): string | undefined {
  if (!isRecord(page) || typeof page.origin !== "string" || typeof page.path !== "string")
    return "is not an origin and a path";
  if (/[?#]/.test(page.path)) return "has a query string or fragment in its path";
  if (!MARKERS.has(page.origin) && !ORIGIN.test(page.origin))
    return "has an origin with user info, a path, a query string or a fragment";
  return undefined;
}

/**
 * One finding per recorded page that holds more than an origin and a path, in each finished
 * trace's items and summary and each running participant's items. A finding names where the page
 * is, never what it says.
 */
export function pageFindings(bundle: RunBundle): string[] {
  const findings: string[] = [];
  const check = (where: string, page: unknown): void => {
    if (page === undefined) return;
    const problem = pageProblem(page);
    if (problem !== undefined) findings.push(`${where} ${problem}`);
  };
  // The shape guard admits items that are not records, so each is read as unknown.
  const checkItems = (where: string, items: unknown): void => {
    if (!Array.isArray(items)) return;
    items.forEach((item: unknown, index) => {
      if (isRecord(item)) check(`${where}[${index}].page`, item.page);
    });
  };
  for (const stream of bundle.streams) {
    checkItems(`${stream.id} items`, stream.actor?.items);
    check(`${stream.id} finalPage`, stream.actor?.finalPage);
    checkItems(`${stream.id} liveActor.items`, stream.liveActor?.items);
  }
  return findings;
}
