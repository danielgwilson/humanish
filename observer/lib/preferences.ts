import { useCallback, useState } from "react";

/** Local preferences contain only view settings and bounded evidence identifiers.
 * Exported file contexts may deny storage; the in-memory controls still work. */
export function usePreference<T>(key: string, fallback: T, accepts: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(`humanish-observer-${key}`) ?? "null");
      return accepts(stored) ? stored : fallback;
    } catch { return fallback; }
  });
  const [saved, setSaved] = useState(true);
  const update = useCallback((next: T) => {
    setValue(next);
    try { window.localStorage.setItem(`humanish-observer-${key}`, JSON.stringify(next)); setSaved(true); }
    catch { setSaved(false); }
  }, [key]);
  return [value, update, saved] as const;
}
export type GridDensity = "comfortable" | "compact" | "large";
export const isDensity = (v: unknown): v is GridDensity => v === "comfortable" || v === "compact" || v === "large";
export const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 50 && v.every((id) => typeof id === "string" && id.length <= 256);
export interface SavedMoment { runId: string; streamId: string; itemId: string; frame: number; savedAt: string; }
export const isMoments = (v: unknown): v is SavedMoment[] => Array.isArray(v) && v.length <= 50 && v.every((entry: unknown) => {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return ["runId", "streamId", "itemId", "savedAt"].every((key) => typeof e[key] === "string" && (e[key] as string).length <= 256)
    && typeof e.frame === "number" && Number.isInteger(e.frame) && e.frame >= 0 && e.frame < 100_000;
});
