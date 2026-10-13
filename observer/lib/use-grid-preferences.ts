import { useState } from "react";
import { isGridFilters, NO_FILTERS, type GridFilters } from "./grid-filters";
import { isDensity, isStringList, usePreference, type GridDensity } from "./preferences";

export interface GridPreferences {
  density: GridDensity;
  setDensity: (density: GridDensity) => void;
  filters: GridFilters;
  /** Shows the first page too: the page the old filters were on may not exist. */
  changeFilters: (filters: GridFilters) => void;
  /** Pinned first; at most 50, the oldest dropped. */
  pinnedIds: string[];
  togglePin: (id: string) => void;
  page: number;
  setPage: (page: number) => void;
}

/**
 * The grid's view settings: preview size and filters for every study, pins per study, and the
 * page for the current run. The page is per run because another run may have fewer pages. Pins
 * are keyed by the run the page was rendered for (`pinsRunId`), the page by the run it shows.
 */
export function useGridPreferences(pinsRunId: string | undefined, runId: string): GridPreferences {
  const [density, setDensity] = usePreference("density", "comfortable", isDensity);
  const [filters, setFilters] = usePreference("filters", NO_FILTERS, isGridFilters);
  const [pinnedIds, setPinnedIds] = usePreference(
    `pins-${pinsRunId ?? "empty"}`,
    [] as string[],
    isStringList,
  );
  const [gridPage, setGridPage] = useState({ runId, page: 0 });
  return {
    density,
    setDensity,
    filters,
    changeFilters: (next) => {
      setFilters(next);
      setGridPage({ runId, page: 0 });
    },
    pinnedIds,
    togglePin: (id) =>
      setPinnedIds(
        pinnedIds.includes(id) ? pinnedIds.filter((v) => v !== id) : [...pinnedIds.slice(-49), id],
      ),
    page: gridPage.runId === runId ? gridPage.page : 0,
    setPage: (page) => setGridPage({ runId, page }),
  };
}
