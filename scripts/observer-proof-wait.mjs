/** Settle `wait` within `ms`, or reject with an error that names `step`.
 *
 * Playwright bounds its locator actions and navigations with the page's default timeout. A
 * promise awaited inside page.evaluate (an image decode, an animation frame, a running
 * animation, axe) and the browser's own lifecycle calls have no bound, so a stall there would
 * hold the CI step until its timeout and print nothing. A proof wraps each of those waits here
 * and names the case and step in `step`. The page-side promise stays pending after a timeout;
 * closing its context discards it. */
export async function bounded(step, wait, ms = 10_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${step} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([wait, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
