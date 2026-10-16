import { pageProblem } from "../evidence/trace-page.js";
import type { RunBundle } from "../run/bundle.js";
import { isRecord } from "../run/type-guards.js";

// A recorded page (`items[].page`, `finalPage`) keeps a URL's origin and path only. The text scan
// finds secret shapes in it as in any trace text, but a query string, a fragment or user info can
// carry a short token no pattern matches, so a page holding one is a public-safety finding.

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
