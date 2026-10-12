import { useEffect, useState } from "react";

const STORAGE_KEY = "humanish-player-v1";
const SPEEDS = [1, 2, 4, 8, 16] as const;
/** The inspector's resize range in CSS pixels. */
export const INSPECTOR_WIDTH = { min: 280, max: 520 } as const;

interface Preferences {
  speed: number;
  skipWaits: boolean;
  inspector: boolean;
  width: number;
}

const clampWidth = (width: number) =>
  Math.max(INSPECTOR_WIDTH.min, Math.min(INSPECTOR_WIDTH.max, width));

function readPreferences(): Preferences {
  const fallback = { speed: 1, skipWaits: false, inspector: true, width: 340 };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return fallback;
    const prefs = value as Partial<Preferences>;
    return {
      speed: typeof prefs.speed === "number" && SPEEDS.includes(prefs.speed as 1) ? prefs.speed : 1,
      skipWaits: prefs.skipWaits === true,
      inspector: prefs.inspector !== false,
      width:
        typeof prefs.width === "number" && Number.isFinite(prefs.width)
          ? clampWidth(prefs.width)
          : 340,
    };
  } catch {
    return fallback;
  }
}

/** The review player's saved view settings: playback speed, skipped waits, and the inspector's
 * visibility and width. Values outside the speed list or the width range fall back or clamp. */
export function usePlayerPreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      /* storage can be disabled in an offline artifact */
    }
  }, [preferences]);
  return {
    preferences,
    /** The next speed in 1, 2, 4, 8, 16, then back to 1. */
    cycleSpeed: () =>
      setPreferences((value) => ({
        ...value,
        speed: SPEEDS[(SPEEDS.indexOf(value.speed as 1) + 1) % SPEEDS.length] ?? 1,
      })),
    setSkipWaits: (skipWaits: boolean) => setPreferences((value) => ({ ...value, skipWaits })),
    toggleInspector: () => setPreferences((value) => ({ ...value, inspector: !value.inspector })),
    /** Sets the width `update` returns for the current width, clamped to INSPECTOR_WIDTH. */
    resizeInspector: (update: (width: number) => number) =>
      setPreferences((value) => ({ ...value, width: clampWidth(update(value.width)) })),
  };
}
