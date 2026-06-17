// Bounded-concurrency map: run `mapper` over `items` with at most `concurrency` in flight at a
// time, preserving input order in the result array. Hoisted out of run.ts so every fan-out
// caller (run.ts's local-actor lanes AND cua-actor-lab.ts's multi-lane desktops) shares ONE
// implementation — three call sites across modules. Behaviour is identical to run.ts's original
// private copy: a worker pool of size min(concurrency, items.length) pulls the next index until
// the list is drained, and `results[i]` always corresponds to `items[i]`.

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      const item = items[index];
      if (item === undefined) {
        return;
      }
      results[index] = await mapper(item, index);
    }
  }));

  return results;
}
