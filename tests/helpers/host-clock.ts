import type { HostClock } from "../../src/run/host-suspension.js";

/**
 * A host clock a test moves by hand. `advance` moves the wall clock without a tick, as a
 * suspended host does; `tick` runs every heartbeat once, as the timer would; `beat` advances one
 * interval and ticks, as an awake host does.
 */
export function fakeHostClock(startMs: number) {
  let wallMs = startMs;
  const beats = new Map<number, { intervalMs: number; tick: () => void }>();
  let nextId = 0;
  const clock: HostClock = {
    now: () => wallMs,
    every(intervalMs, tick) {
      const id = nextId++;
      beats.set(id, { intervalMs, tick });
      return () => {
        beats.delete(id);
      };
    },
  };
  const tick = (): void => {
    for (const { tick: run } of beats.values()) run();
  };
  return {
    clock,
    advance(ms: number): void {
      wallMs += ms;
    },
    tick,
    /** Advance one interval of the first heartbeat and tick, `times` times. */
    beat(times = 1): void {
      for (let index = 0; index < times; index++) {
        const [first] = beats.values();
        if (first === undefined) return;
        wallMs += first.intervalMs;
        tick();
      }
    },
    /** How many heartbeats are running. */
    get running(): number {
      return beats.size;
    },
  };
}
