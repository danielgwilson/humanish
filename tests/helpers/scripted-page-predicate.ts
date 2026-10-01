// Evaluate a scripted step's waitForFunction predicate as Playwright evaluates a string: as an
// expression in the page, never called, passing when the value is truthy. A fake page that ignores
// the string would hide a predicate that can never fail.

import { runInNewContext } from "node:vm";

export function evaluatePagePredicate(expression: string, bodyText: string): unknown {
  return runInNewContext(expression, { document: { body: { innerText: bodyText } } });
}
