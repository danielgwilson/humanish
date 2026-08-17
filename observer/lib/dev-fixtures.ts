import type { ObserverData } from "./observer-data";

// Dev-only: the committed observer-data goldens double as dev fixtures (#429), so the
// dev server renders exactly the frozen contract. This module is reached through a
// dynamic import guarded by import.meta.env.DEV — the production artifact contains
// neither this code nor the fixture data (the smoke test asserts the absence).
const fixtures: Record<string, () => Promise<{ default: unknown }>> = {
  "first-run": () => import("../../tests/golden/observer-data/first-run.json"),
  oss: () => import("../../tests/golden/observer-data/oss.json"),
  live: () => import("../../tests/golden/observer-data/live.json")
};

export async function loadDevFixture(name: string | null): Promise<ObserverData> {
  const load = (name !== null ? fixtures[name] : undefined) ?? fixtures["first-run"];
  if (!load) throw new Error("no dev fixture registered");
  const mod = await load();
  // The goldens are schema-proven by tests/observer-data-contract.test.ts at the root.
  return mod.default as ObserverData;
}
