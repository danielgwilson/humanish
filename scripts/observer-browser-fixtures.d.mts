import type { ObserverData } from "../src/observer-data";
import type { LoadedStudyAnalysis } from "../src/study-analysis";
export function fixture(options?: { running?: boolean; live?: boolean; laneCount?: number; frames?: number; rows?: number; origin?: string }): ObserverData;
export function analysisFixture(data: ObserverData, options?: { status?: "complete" | "partial" | "failed" | "cancelled"; state?: "ready" | "stale"; empty?: boolean; count?: number }): LoadedStudyAnalysis;
