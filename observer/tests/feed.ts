import type { ObserverData } from "../../src/observer/data";
import { splitObserverData } from "../../src/observer/participant-items";

/** The body a serving process answers observer-feed.json with: the run's data and its items. */
export function feed(data: ObserverData): string {
  const { shell, items } = splitObserverData(data);
  return JSON.stringify({ data: shell, items });
}
