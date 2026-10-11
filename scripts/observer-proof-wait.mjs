/** Settle `wait` within `ms`, or reject with an error that names `step`.
 *
 * Playwright bounds its locator actions and navigations with the page's default timeout. A
 * promise awaited inside page.evaluate (an image decode, an animation frame, a running
 * animation, axe) and the browser's own lifecycle calls have no bound, so a stall there would
 * hold the CI step until its timeout and print nothing. A proof wraps each of those waits here
 * and names the case and step in `step`. The page-side promise stays pending after a timeout;
 * closing its context discards it. */
export async function bounded(step, wait, ms = 10_000) {
  // Created now so its stack names the proof line that started the wait.
  const timeout = new Error(`${step} did not finish within ${ms} ms`);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeout), ms);
  });
  try {
    return await Promise.race([wait, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Close `context` (a browser context, or a browser) if the case named `label` is still running
 * after `ms`, and say so on stderr.
 *
 * A page that stops answering holds the Playwright calls that take no timeout (page.evaluate,
 * evaluateAll, keyboard and mouse input). Closing the context makes the pending call reject at
 * its own line with "Target page, context or browser has been closed", so the case fails there.
 * Call the returned function when the case ends. */
export function closeWhenOverdue(context, label, ms) {
  const timer = setTimeout(() => {
    process.stderr.write(
      `${label} did not finish within ${ms} ms; closing its pages so the pending call fails\n`,
    );
    context.close().catch(() => {});
  }, ms);
  return () => clearTimeout(timer);
}
